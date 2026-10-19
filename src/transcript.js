'use strict';

const fs = require('fs');
const vscode = require('vscode');

const SCHEME = 'claude-task';

// Agent transcripts can run to thousands of turns; render the most recent slice.
const MAX_RECORDS = 600;
const MAX_RESULT_CHARS = 1200;
const MAX_INPUT_CHARS = 900;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function slug(text) {
  return (
    String(text || 'agent')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'agent'
  );
}

/** A read-only markdown rendering of one agent's transcript. */
function transcriptUri(task) {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${slug(task.description)}.md`,
    query: new URLSearchParams({ file: task.transcriptFile, id: task.externalId || '' }).toString(),
  });
}

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

function clock(timestamp) {
  if (!timestamp) return '';
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? '' : new Date(ms).toLocaleTimeString();
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function renderRecord(record, out) {
  const message = record.message;
  if (!message || typeof message !== 'object') return;
  const content = message.content;
  const when = clock(record.timestamp);

  if (typeof content === 'string') {
    if (record.type === 'user') {
      out.push(`### ${when} · prompt\n`);
      out.push(clip(content, MAX_RESULT_CHARS));
      out.push('');
    }
    return;
  }
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && String(block.text || '').trim()) {
      out.push(`### ${when} · assistant\n`);
      out.push(block.text.trim());
      out.push('');
    } else if (block.type === 'thinking' && String(block.thinking || '').trim()) {
      out.push(`> *thinking* — ${clip(block.thinking.trim().split('\n')[0], 200)}`);
      out.push('');
    } else if (block.type === 'tool_use') {
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      out.push(`**▸ ${block.name}** — \`${when}\``);
      const rendered = JSON.stringify(input, null, 1);
      out.push('```json');
      out.push(clip(rendered, MAX_INPUT_CHARS));
      out.push('```');
    } else if (block.type === 'tool_result') {
      const text = resultText(block.content).trim();
      if (!text) continue;
      out.push('```text');
      out.push(clip(text, MAX_RESULT_CHARS));
      out.push('```');
      out.push('');
    }
  }
}

function renderTranscript(file, agentId) {
  let raw;
  try {
    // Only the tail of a very large transcript is worth rendering, and reading
    // the whole thing would stall the editor.
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) {
      const buf = Buffer.allocUnsafe(MAX_FILE_BYTES);
      const fd = fs.openSync(file, 'r');
      try {
        const read = fs.readSync(fd, buf, 0, MAX_FILE_BYTES, size - MAX_FILE_BYTES);
        const slice = buf.subarray(0, read);
        const firstNewline = slice.indexOf(0x0a);
        raw = slice.subarray(firstNewline + 1).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch (err) {
    return `# Transcript unavailable\n\nCould not read \`${file}\`.\n\n\`\`\`\n${err.message}\n\`\`\`\n`;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      /* skip half-written lines */
    }
  }

  const shown = records.slice(-MAX_RECORDS);
  const out = [];
  const first = records[0] || {};
  out.push(`# Agent transcript${agentId ? ` · ${agentId}` : ''}`);
  out.push('');
  const meta = [];
  if (first.cwd) meta.push(`\`${first.cwd}\``);
  if (first.version) meta.push(`CLI ${first.version}`);
  meta.push(`${records.length} records`);
  out.push(meta.join(' · '));
  out.push('');
  if (shown.length < records.length) {
    out.push(`> Showing the last ${shown.length} of ${records.length} records.`);
    out.push('');
  }
  out.push('---');
  out.push('');

  for (const record of shown) renderRecord(record, out);
  return out.join('\n');
}

/** Serves `claude-task:` documents. Content is re-read on every open. */
class TranscriptProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  provideTextDocumentContent(uri) {
    const params = new URLSearchParams(uri.query);
    return renderTranscript(params.get('file'), params.get('id'));
  }

  /** Ask VS Code to re-render an open transcript. */
  refresh(uri) {
    this._onDidChange.fire(uri);
  }
}

module.exports = { SCHEME, TranscriptProvider, transcriptUri, renderTranscript };
