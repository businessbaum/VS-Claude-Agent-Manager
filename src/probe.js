'use strict';

const fs = require('fs');
const { Tailer, readHead, readTailLines } = require('./tailer');

// A running agent's transcript is read from the beginning so tool counts are
// exact.  Past this size we give up on exact counts and only report the tail,
// which is all a progress display really needs.
const FULL_PARSE_LIMIT = 12 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 16 * 1024;

// The head window has to hold the whole first record for its timestamp to be
// found.  A large pasted file or system prompt pushes well past 16 KB, and a
// transcript whose start time is unknown shows no elapsed time at all.
const HEAD_RETRY_BYTES = 512 * 1024;

/** Pick the most telling argument of a tool call for a one-line summary. */
function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  const first = (v) => String(v).split('\n')[0].trim();
  if (input.file_path) return first(require('path').basename(String(input.file_path)));
  if (input.command) return first(input.command);
  if (input.pattern) return first(input.pattern);
  if (input.url) return first(input.url);
  if (input.query) return first(input.query);
  if (input.description) return first(input.description);
  if (input.prompt) return first(input.prompt);
  if (input.skill) return first(input.skill);
  return '';
}

function emptyProgress() {
  return {
    startedAt: null,
    lastActivityAt: null,
    toolCalls: 0,
    // Prototype-free: a tool named `toString` or `__proto__` would otherwise
    // either concatenate onto an inherited member or never become an own key.
    toolCounts: Object.create(null),
    lastTool: null,
    lastText: '',
    outputTokens: 0,
    model: null,
    exact: true,
    spawnedToolUseIds: [],
    // One assistant message is written as several records — thinking, text and
    // each tool call — and each carries that message's usage as it stood when
    // the record was written.  Summing over records therefore bills one message
    // several times; what it really produced is the largest of those figures.
    billed: new Map(), // message id -> output tokens already added
  };
}

/**
 * Folds one transcript record into a progress accumulator.
 * Tolerates unknown record types — the transcript format grows over time.
 */
function applyRecord(progress, record) {
  if (!record || typeof record !== 'object') return;
  const ts = record.timestamp ? Date.parse(record.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    if (progress.startedAt === null || ts < progress.startedAt) progress.startedAt = ts;
    if (progress.lastActivityAt === null || ts > progress.lastActivityAt) progress.lastActivityAt = ts;
  }

  const message = record.message;
  if (!message || typeof message !== 'object') return;
  if (message.model) progress.model = message.model;
  if (message.usage && typeof message.usage.output_tokens === 'number') {
    // Bill each message once, at its highest reported figure.  Only the delta
    // is added, so this stays correct when the records arrive one refresh at a
    // time.  Without an id there is no way to tell a repeat from a genuine
    // second message, so such a record is counted rather than silently dropped.
    const id = message.id;
    const tokens = message.usage.output_tokens;
    if (!id) {
      progress.outputTokens += tokens;
    } else {
      const already = progress.billed.get(id) || 0;
      if (tokens > already) {
        progress.outputTokens += tokens - already;
        progress.billed.set(id, tokens);
      }
    }
  }

  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      progress.toolCalls += 1;
      progress.toolCounts[block.name] = (progress.toolCounts[block.name] || 0) + 1;
      progress.lastTool = {
        name: block.name,
        detail: toolDetail(block.name, block.input),
        at: Number.isNaN(ts) ? null : ts,
      };
      if (block.name === 'Agent' || block.name === 'Task') progress.spawnedToolUseIds.push(block.id);
    } else if (block.type === 'text' && record.type === 'assistant' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) progress.lastText = text;
    }
  }
}

function parseLines(progress, lines) {
  for (const line of lines) {
    if (line.length < 2) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // half-written line; the tailer will not hand it to us twice
    }
    applyRecord(progress, record);
  }
}

/** The start time from a transcript's first record, widening the read if needed. */
function startTimeOf(file) {
  for (const bytes of [HEAD_BYTES, HEAD_RETRY_BYTES]) {
    const head = readHead(file, bytes);
    const firstNewline = head.indexOf('\n');
    if (firstNewline <= 0) {
      if (head.length < bytes) return null; // the whole file, and still no newline
      continue;
    }
    try {
      const record = JSON.parse(head.slice(0, firstNewline));
      const ms = record.timestamp ? Date.parse(record.timestamp) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cheap read for a transcript too large to fold whole: first record for the
 * start time, last records for the outcome.  Totals stay unknown — both the
 * tool counts and the token sum would otherwise be a fraction of the truth
 * presented as fact, and `exact` is what tells the view to say so.
 */
function quickProbe(file) {
  const progress = emptyProgress();
  progress.exact = false;

  progress.startedAt = startTimeOf(file);
  parseLines(progress, readTailLines(file, TAIL_BYTES));
  progress.toolCalls = 0;
  progress.toolCounts = Object.create(null);
  return progress;
}

/**
 * Folds a whole transcript in one pass.  Used for a task that has finished:
 * its totals are worth having exactly, and the result is cached against the
 * file's mtime so the cost is paid once.
 */
function fullProbe(file) {
  const progress = emptyProgress();
  const tailer = new Tailer(file);
  parseLines(progress, tailer.read());
  return progress;
}

/**
 * Follows one agent transcript, keeping exact running totals across refreshes.
 * Reused between refreshes so each poll only parses the newly appended bytes.
 */
class AgentProbe {
  constructor(file) {
    this.file = file;
    this.progress = emptyProgress();
    this.tailer = null;
  }

  /** @returns {object} the progress snapshot, refreshed from disk. */
  update() {
    if (!this.tailer) {
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        return this.progress;
      }
      if (size > FULL_PARSE_LIMIT) {
        // Too big to fold from the start; summarise the tail and follow from there.
        this.progress = quickProbe(this.file);
        this.tailer = new Tailer(this.file, size);
        return this.progress;
      }
      this.tailer = new Tailer(this.file);
    }
    const lines = this.tailer.read();
    // The file was replayed from the start, so the totals we hold describe
    // bytes that are about to be counted again.
    if (this.tailer.rewound) {
      const exact = this.progress.exact;
      this.progress = emptyProgress();
      this.progress.exact = exact;
    }
    parseLines(this.progress, lines);
    return this.progress;
  }
}

module.exports = { AgentProbe, quickProbe, fullProbe, emptyProgress, applyRecord, toolDetail, startTimeOf };
