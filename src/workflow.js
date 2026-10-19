'use strict';

const fs = require('fs');
const path = require('path');

const { Tailer, readHead } = require('./tailer');
const { AgentProbe } = require('./probe');

/**
 * Workflows are stored apart from ordinary subagents:
 *
 *   <session>/subagents/workflows/<runId>/journal.jsonl   started / result per agent
 *   <session>/subagents/workflows/<runId>/agent-*.jsonl   one transcript per agent
 *   <session>/workflows/scripts/<name>-<runId>.js         the script, written at launch
 *   <session>/workflows/<runId>.json                      full run state, written at the end
 *
 * Only the last of those carries phases and per-agent totals, and it is written
 * once the run finishes — so while a run is in flight the stage list is read
 * from the script and per-agent figures are folded from the transcripts.
 */

const HEAD_BYTES = 8 * 1024;

/** A prompt larger than this is not worth reading just to name a row. */
const PROMPT_CAP_BYTES = 1024 * 1024;

/**
 * How many prompt lines to keep for naming. Generous on purpose: what separates
 * one agent from its siblings often sits near the end of a long shared brief —
 * in one real run it was line 53 of 56.
 */
const PROMPT_LINE_WINDOW = 200;

/**
 * Agents of one phase start together; the next phase only starts once the
 * previous one has returned. A gap this size therefore means a phase boundary.
 * Measured against two real runs it placed 16 of 16 agents correctly, with the
 * within-phase spread at 0s and the between-phase gaps at 18 and 31 minutes.
 */
const PHASE_GAP_MS = 5000;

/**
 * A gap only counts as a stage boundary if it is at least this share of the
 * largest gap seen. Keeps the minutes-long waits between stages and discards
 * the seconds-long stagger of agents spawned one after another.
 */
const PHASE_GAP_RATIO = 0.25;

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'killed', 'error']);

// An agent whose transcript has been silent this long is not working: the run
// it belonged to is gone.  Without this its ring turns and its elapsed time
// climbs for as long as the panel is open.
const AGENT_SILENT_MS = 10 * 60 * 1000;

/** Ignore writes this close to the state file: they are part of finishing. */
const STATE_SLACK_MS = 2000;

function runsDir(sessionDir) {
  return path.join(sessionDir, 'subagents', 'workflows');
}

function runStateFile(sessionDir, runId) {
  return path.join(sessionDir, 'workflows', `${runId}.json`);
}

/** Run directories present on disk, whether or not we saw them launched. */
function listRuns(sessionDir) {
  let entries;
  try {
    entries = fs.readdirSync(runsDir(sessionDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * The run's script, which is the only source of stage titles while the run is
 * in flight.
 *
 * It is filed under the project directory of the *workflow's* working directory,
 * which is not always the one the session lives in — a workflow launched from a
 * package inside a repo lands in a sibling project folder under the same session
 * id.  So the session's own folder is tried first and every sibling after it.
 */
function findScript(sessionDir, runId) {
  const inDir = (scriptsDir) => {
    try {
      const name = fs.readdirSync(scriptsDir).find((n) => n.includes(runId) && n.endsWith('.js'));
      if (name) return path.join(scriptsDir, name);
    } catch {
      /* no scripts directory here */
    }
    return null;
  };

  const own = inDir(path.join(sessionDir, 'workflows', 'scripts'));
  if (own) return own;

  const sessionId = path.basename(sessionDir);
  const projectsRoot = path.dirname(path.dirname(sessionDir));
  let siblings;
  try {
    siblings = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    const found = inDir(path.join(projectsRoot, entry.name, sessionId, 'workflows', 'scripts'));
    if (found) return found;
  }
  return null;
}

/**
 * The script's `meta` block is required to be a plain literal, so the stage list
 * can be read without running anything. This is the only source of phases while
 * a run is still going.
 */
function parsePhases(file) {
  if (!file) return [];
  const text = readHead(file, HEAD_BYTES);
  const marker = text.indexOf('phases:');
  if (marker === -1) return [];
  const open = text.indexOf('[', marker);
  if (open === -1) return [];

  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  const block = text.slice(open, close);
  const quoted = (key) => new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g');
  const phases = [];
  let match = quoted('title').exec(block);
  const titles = quoted('title');
  while ((match = titles.exec(block)) !== null) phases.push({ title: match[2] });

  const details = quoted('detail');
  let i = 0;
  let detail;
  while ((detail = details.exec(block)) !== null && i < phases.length) {
    phases[i].detail = detail[2];
    i += 1;
  }
  return phases;
}

/**
 * The first record holds the prompt and can be very large — 120 KB is normal for
 * a workflow agent — so the window grows until the line ends.
 *
 * @returns {string|null} the line, `null` while the record is still being
 *   written, or `''` when it is too large to be worth reading.
 */
function readFirstLine(file, maxBytes) {
  let fileSize;
  try {
    fileSize = fs.statSync(file).size;
  } catch {
    return null;
  }
  let size = HEAD_BYTES;
  for (;;) {
    const head = readHead(file, size);
    const newline = head.indexOf('\n');
    if (newline > 0) return head.slice(0, newline);
    // Compare against the file, not the decoded string: multi-byte characters
    // make the character count smaller than the bytes requested.
    if (size >= fileSize) return null;
    if (size >= maxBytes) return '';
    size = Math.min(size * 4, maxBytes);
  }
}

/** FNV-1a over the whole prompt: equal prompts mean the same piece of work. */
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * An agent's prompt: its opening lines for naming, and a fingerprint of the
 * whole thing for recognising a retry. The lines alone cannot serve as identity
 * — workflow prompts open with pages of shared preamble.
 *
 * @returns {{lines: string[], hash: string}|null} `null` means "not written
 *   yet, ask again".
 */
function readPrompt(file) {
  const line = readFirstLine(file, PROMPT_CAP_BYTES);
  if (line === null) return null;
  let text = '';
  try {
    const record = JSON.parse(line);
    const content = record.message && record.message.content;
    if (typeof content === 'string') text = content;
  } catch {
    return { lines: [], hash: '' };
  }
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[\s>*#-]+/, '').replace(/[*`_]/g, '').trim())
    // Bare punctuation from an embedded JSON payload can never name anything.
    .filter((l) => l.length > 0 && !/^[{}[\],]+$/.test(l))
    .slice(0, PROMPT_LINE_WINDOW);
  return { lines, hash: text ? fingerprint(text) : '' };
}

/** Opening lines only, for callers that just want to name something. */
function promptLines(file) {
  const prompt = readPrompt(file);
  return prompt === null ? null : prompt.lines;
}

/** Openers that say what the agent is, not what it is working on. */
const LEAD_IN = /^(?:you are(?: an?| the)?(?: \w+)?|your (?:job|task|slice|role|focus)(?: is)?|research|investigate|design|build)\b[\s:,—–-]*/i;

/** A quoted key with a quoted value, as embedded JSON payloads produce. */
const JSON_PAIR = /^"[\w .-]{1,40}"\s*:\s*"?([\w\p{Emoji}][^"]*?)"?,?$/u;

/** The leaf of the last path-like token in a line, if it has one. */
function pathLeaf(text) {
  const tokens = String(text || '')
    .split(/\s+/)
    .filter((t) => /[\\/]/.test(t) && t.length > 3);
  if (!tokens.length) return '';
  const leaf = tokens[tokens.length - 1]
    .replace(/["'.,;:)\]]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return leaf && leaf.length >= 3 ? leaf : '';
}

/**
 * Compresses a prompt line into something that fits a column. A line that opens
 * with a short heading — "LOSS AVERSION & SOCIAL DRAMA. The strongest…" — keeps
 * just that heading, which is normally the agent's actual subject. Prompts that
 * embed a JSON object are reduced to the value rather than the field name.
 */
function titleFromLine(line) {
  let text = String(line || '').trim();
  const pair = JSON_PAIR.exec(text);
  if (pair) text = pair[1];
  text = text.replace(LEAD_IN, '');

  // "AUFGABE: …", "DEIN ORDNER: …" — a prefix of a word or two labels the line
  // rather than naming it, so the half after the colon is the interesting one.
  // A drive letter is not such a prefix.
  const colon = text.indexOf(':');
  if (colon > 0 && colon <= 40 && !/^[a-z]$/i.test(text.slice(0, colon))) {
    const prefix = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    // Only when something worth reading follows — "…": {" is not a name.
    if (prefix.split(/\s+/).length <= 2 && rest.length >= 3 && /[\w]/.test(rest)) text = rest;
  }

  const stop = text.search(/[.:—–]\s/);
  if (stop > 0 && stop <= 60) text = text.slice(0, stop);

  // Only once the sentence has been cut: what is left may still be one long
  // clause whose sole distinguishing word is a path — "Ein anderer Agent hat
  // die Texte in …\modules\uninstaller geprüft" is shared boilerplate wrapped
  // around a single name.  A clause that already reads as a title is left be.
  const leaf = pathLeaf(text);
  if (leaf && (/^\S+$/.test(text) || text.length > 45)) text = leaf;

  return text.trim().replace(/[.,;:]+$/, '');
}

/** Whether a candidate title actually says something. */
function isNameable(title) {
  return title.length >= 4 && /[a-z]/i.test(title) && !/^["'{[]/.test(title);
}

/**
 * Running agents carry no label — those are only written into the run state
 * when the run ends. Workflow prompts share a preamble and differ only in the
 * task lines, so the line unique to one agent is the closest thing to its
 * label. Falls back to the opening line when nothing distinguishes them.
 */
function distinctiveLabels(linesByAgent) {
  const ids = [...linesByAgent.keys()];
  const frequency = new Map();
  for (const id of ids) {
    for (const line of new Set(linesByAgent.get(id))) {
      frequency.set(line, (frequency.get(line) || 0) + 1);
    }
  }
  const labels = new Map();
  const taken = new Set();
  for (const id of ids) {
    const lines = linesByAgent.get(id);
    // Walk the candidates rather than taking the first: a unique line can still
    // reduce to a bare field name like "input", which names nothing — or to a
    // phrase every sibling also reduces to, which names nothing either.  A
    // label that does not tell two rows apart has not done its job.
    let title = '';
    let fallback = '';
    for (const line of lines) {
      if (frequency.get(line) !== 1 || line.length < 8) continue;
      const candidate = titleFromLine(line);
      if (!isNameable(candidate)) continue;
      if (!fallback) fallback = candidate;
      if (!taken.has(candidate)) {
        title = candidate;
        break;
      }
    }
    if (!title) title = fallback || titleFromLine(lines[0] || '');
    title = title ? title.slice(0, 100) : '';
    if (title) taken.add(title);
    labels.set(id, title);
  }
  return labels;
}

/** Identifies the work an agent was given, so a retry can be recognised. */
function promptKey(lines) {
  return lines && lines.length ? lines.slice(0, 12).join('') : '';
}

/**
 * Folds retries into one row.
 *
 * A run stopped by a usage limit restarts its unfinished agents with the very
 * same prompt, so the directory ends up holding several transcripts for one
 * piece of work. Only the newest attempt is live; the abandoned ones would
 * otherwise inflate the agent count and the stage totals.
 */
function collapseRetries(agents, keyOf) {
  const groups = new Map();
  for (const agent of agents) {
    const key = keyOf(agent.agentId) || `id:${agent.agentId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const latest = { ...group[group.length - 1] };
    latest.attempts = group.length;
    latest.members = group.map((a) => a.agentId);
    out.push(latest);
  }
  return out;
}

/**
 * Splits agents into stages at the largest gaps between their start times.
 *
 * A stage boundary means the whole previous stage had to finish first, so it
 * shows up as a gap far larger than the spread inside a stage — minutes against
 * seconds. Taking only gaps within a quarter of the largest keeps the real
 * boundaries and ignores the stagger of agents that a `pipeline()` spawns one
 * after another. Checked against three runs it reproduced the recorded stages
 * exactly: 9 of 9, 7 of 7, and the live 4/5/5 split.
 */
function assignPhases(agents, phaseCount) {
  const ordered = agents
    .filter((a) => Number.isFinite(a.startedAt))
    .sort((a, b) => a.startedAt - b.startedAt);
  const map = new Map();
  if (ordered.length < 2 || phaseCount < 2) {
    for (const agent of ordered) map.set(agent.agentId, ordered.length ? 1 : 0);
    return map;
  }

  const gaps = ordered.slice(1).map((agent, i) => ({ before: i + 1, gap: agent.startedAt - ordered[i].startedAt }));
  const largest = Math.max(...gaps.map((g) => g.gap));
  const floor = Math.max(PHASE_GAP_MS, largest * PHASE_GAP_RATIO);
  const boundaries = new Set(
    gaps
      .filter((g) => g.gap >= floor)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, phaseCount - 1)
      .map((g) => g.before),
  );

  let phase = 1;
  ordered.forEach((agent, index) => {
    if (boundaries.has(index)) phase += 1;
    map.set(agent.agentId, phase);
  });
  return map;
}

/**
 * done / running / failed / pending per stage, from the agents placed in each.
 *
 * A run that ended badly must not read as finished work: only a run that
 * actually completed marks everything done.  Where it stopped, the stage it was
 * in is `failed` and the stages it never reached stay `pending`.
 */
function stageStates(phases, agents, settled, failed) {
  const byPhase = new Map();
  for (const agent of agents) {
    if (!agent.phaseIndex) continue;
    if (!byPhase.has(agent.phaseIndex)) byPhase.set(agent.phaseIndex, []);
    byPhase.get(agent.phaseIndex).push(agent);
  }
  const lastWithAgents = Math.max(0, ...byPhase.keys());

  return phases.map((phase, index) => {
    const position = index + 1;
    const mine = byPhase.get(position) || [];
    let state;
    if (settled && !failed) state = 'done';
    else if (mine.some((a) => a.failed)) state = 'failed';
    else if (mine.length) {
      if (mine.every((a) => a.done)) state = 'done';
      else if (settled) state = 'failed';
      // Something here never reported back and has gone quiet.  Saying it is
      // still working would be the spinning-forever bug one level down.
      else if (mine.every((a) => a.done || a.stalled)) state = 'stalled';
      else state = 'running';
    }
    // A stage with no agents of its own is over once a later one has started;
    // otherwise it simply has not been reached yet.
    else state = position < lastWithAgents ? 'done' : 'pending';
    return { title: phase.title, detail: phase.detail || '', state, agents: mine.length };
  });
}

function agentIdFromFile(name) {
  return name.slice('agent-'.length, -'.jsonl'.length);
}

class WorkflowProbe {
  constructor(sessionDir, runId, scriptPath) {
    this.runId = runId;
    this.sessionDir = sessionDir;
    this.dir = path.join(runsDir(sessionDir), runId);
    this.stateFile = runStateFile(sessionDir, runId);
    this.scriptPath = scriptPath || findScript(sessionDir, runId);
    this.journal = new Tailer(path.join(this.dir, 'journal.jsonl'));

    this.started = new Set();
    this.finished = new Set();
    this.probes = new Map(); // agentId -> AgentProbe
    this.labels = new Map(); // agentId -> label, from the finished run state
    this.promptLines = new Map(); // agentId -> opening prompt lines, read once
    this.promptHashes = new Map(); // agentId -> fingerprint of the whole prompt
    this.derived = new Map(); // agentId -> label inferred while running
    this.scriptPhases = null; // read once
    this.state = null; // parsed <runId>.json
    this.stateMtime = -1;
  }

  readJournal() {
    for (const line of this.journal.read()) {
      if (line.length < 2) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry.agentId) continue;
      if (entry.type === 'started') this.started.add(entry.agentId);
      else if (entry.type === 'result') this.finished.add(entry.agentId);
    }
  }

  /** Agent transcripts on disk, in case the journal lags behind. */
  readAgentFiles() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('agent-') && name.endsWith('.jsonl')) this.started.add(agentIdFromFile(name));
    }
  }

  /**
   * Whether the run has moved on since its state file was written.
   *
   * A run stopped by a usage limit gets a state file saying it finished; when it
   * is picked up again later, that file stays behind while the journal and the
   * transcripts keep growing. Without this check the panel would keep showing
   * the old outcome — and could never return a task to Running.
   */
  stateIsStale() {
    if (this.stateMtime < 0) return false;
    const newerThanState = (file) => {
      try {
        return fs.statSync(file).mtimeMs > this.stateMtime + STATE_SLACK_MS;
      } catch {
        return false;
      }
    };
    return newerThanState(path.join(this.dir, 'journal.jsonl')) || newerThanState(this.dir);
  }

  /** The run state, if it has appeared. Authoritative for everything it holds. */
  readState() {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(this.stateFile).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === this.stateMtime) return;
    try {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.stateMtime = mtimeMs;
    } catch {
      return;
    }
    for (const entry of this.state.workflowProgress || []) {
      if (entry.type === 'workflow_agent' && entry.agentId && entry.label) {
        this.labels.set(entry.agentId, entry.label);
      }
    }
  }

  /**
   * The stage list.  While the run is live this comes from the script, which is
   * written at launch but not always before the run directory appears — so an
   * empty result is retried rather than cached, and the script is looked for
   * again each time it is still missing.  Only a real list is kept.
   */
  phases() {
    if (this.state && this.state.phases && this.state.phases.length) return this.state.phases;
    if (this.scriptPhases && this.scriptPhases.length) return this.scriptPhases;
    if (!this.scriptPath) this.scriptPath = findScript(this.sessionDir, this.runId);
    this.scriptPhases = parsePhases(this.scriptPath);
    return this.scriptPhases;
  }

  agentTranscript(agentId) {
    return path.join(this.dir, `agent-${agentId}.jsonl`);
  }

  /**
   * Re-derived on every pass: a line that looks unique with two agents running
   * may turn out to be boilerplate once the rest start.
   */
  refreshLabels() {
    for (const agentId of this.started) {
      if (this.promptLines.has(agentId)) continue;
      // A transcript is created before its prompt is flushed; null means "not
      // written yet", so ask again next pass rather than freezing the raw id as
      // the agent's name for the rest of the run.
      const prompt = readPrompt(this.agentTranscript(agentId));
      if (prompt === null) continue;
      this.promptLines.set(agentId, prompt.lines);
      this.promptHashes.set(agentId, prompt.hash);
    }

    // Retries carry the same prompt, so counting them once keeps the line that
    // distinguishes an agent from actually looking distinctive.
    const byPrompt = new Map();
    const keyFor = new Map();
    for (const [agentId, lines] of this.promptLines) {
      const key = this.promptKeyFor(agentId);
      keyFor.set(agentId, key);
      if (!byPrompt.has(key)) byPrompt.set(key, lines);
    }
    const labelled = distinctiveLabels(byPrompt);
    this.derived = new Map();
    for (const [agentId, key] of keyFor) this.derived.set(agentId, labelled.get(key) || '');
  }

  /** Same key for two agents means one of them is a retry of the other. */
  promptKeyFor(agentId) {
    return this.promptHashes.get(agentId) || `id:${agentId}`;
  }

  labelFor(agentId) {
    return this.labels.get(agentId) || this.derived.get(agentId) || agentId.slice(0, 8);
  }

  /**
   * Exact per-agent figures, straight out of the finished run state.
   *
   * A run that was killed leaves its agents recorded as `progress`: they never
   * reported back and never will.  Read literally that says "still working",
   * which is how a stopped run ends up with three turning rings and no elapsed
   * time — the state file records a duration only for an agent that finished.
   */
  agentsFromState(cutOff) {
    const entries = (this.state.workflowProgress || []).filter((e) => e.type === 'workflow_agent');
    const endedAt = this.state.timestamp ? Date.parse(this.state.timestamp) : null;
    return entries.map((e) => {
      const done = e.state === 'done';
      const failed = e.state === 'failed' || e.state === 'error';
      const stalled = cutOff && !done && !failed;
      return {
      agentId: e.agentId,
      label: e.label || this.labelFor(e.agentId),
      file: this.agentTranscript(e.agentId),
      done,
      failed,
      stalled,
      tokens: e.tokens || 0,
      toolCalls: e.toolCalls || 0,
      // How long it got, for one that was cut off mid-flight.
      durationMs: e.durationMs || (stalled && endedAt && e.startedAt ? Math.max(0, endedAt - e.startedAt) : 0),
      startedAt: e.startedAt || null,
      phaseIndex: e.phaseIndex || 0,
      lastTool: e.lastToolName ? { name: e.lastToolName, detail: e.lastToolSummary || '' } : null,
      model: e.model || '',
      };
    });
  }

  /** Live per-agent figures, folded from the transcripts. */
  agentsFromTranscripts(now) {
    const out = [];
    for (const agentId of this.started) {
      let probe = this.probes.get(agentId);
      if (!probe) {
        probe = new AgentProbe(this.agentTranscript(agentId));
        this.probes.set(agentId, probe);
      }
      const progress = probe.update();
      const done = this.finished.has(agentId);
      const silent = Boolean(progress.lastActivityAt) && now - progress.lastActivityAt > AGENT_SILENT_MS;
      const end = done || silent ? progress.lastActivityAt || now : now;
      out.push({
        agentId,
        label: this.labelFor(agentId),
        file: this.agentTranscript(agentId),
        done,
        stalled: !done && silent,
        failed: false,
        tokens: progress.outputTokens,
        toolCalls: progress.toolCalls,
        durationMs: progress.startedAt ? Math.max(0, end - progress.startedAt) : 0,
        startedAt: progress.startedAt,
        phaseIndex: 0,
        lastTool: progress.lastTool,
        model: progress.model || '',
        toolCounts: progress.toolCounts,
        lastActivityAt: progress.lastActivityAt,
        lastText: progress.lastText,
        exact: progress.exact,
      });
    }
    return out;
  }

  /**
   * Everything the expanded row of one agent shows.  A settled run is served
   * from its state file and never touches the transcripts, so the figures an
   * open row needs beyond that — the tool breakdown, the closing message — are
   * folded here, for that one agent only.
   */
  detailFor(agent) {
    if (agent.toolCounts && agent.lastText !== undefined) return agent;
    const id = agent.agentId;
    let probe = this.probes.get(id);
    if (!probe) {
      probe = new AgentProbe(this.agentTranscript(id));
      this.probes.set(id, probe);
    }
    const progress = probe.update();
    return {
      ...agent,
      toolCounts: progress.toolCounts,
      lastText: progress.lastText,
      model: agent.model || progress.model || '',
      toolCalls: agent.toolCalls || progress.toolCalls,
      exact: progress.exact,
    };
  }

  /**
   * Gives every agent its stage.
   *
   * A stale state file still knows the stage of every agent it saw, and a retry
   * belongs to the same stage as the attempt it replaces — that survives a
   * resume, where the hours-long interruption would otherwise swamp the gaps
   * that separate the stages. Only agents the state never saw are inferred.
   */
  placePhases(agents, phaseCount) {
    const fromState = new Map();
    for (const entry of (this.state && this.state.workflowProgress) || []) {
      if (entry.type === 'workflow_agent' && entry.agentId && entry.phaseIndex) {
        fromState.set(entry.agentId, entry.phaseIndex);
      }
    }

    const unknown = [];
    for (const agent of agents) {
      const known = agent.members.map((id) => fromState.get(id)).find(Boolean);
      agent.phaseIndex = known || 0;
      if (!known) unknown.push(agent);
    }
    if (!unknown.length) return;

    // Nothing was known: infer across the whole run. Otherwise the unseen
    // agents can only belong to stages at or after the last one on record.
    const highest = Math.max(0, ...agents.map((a) => a.phaseIndex));
    const placement = assignPhases(unknown, Math.max(1, phaseCount - highest));
    for (const agent of unknown) agent.phaseIndex = highest + (placement.get(agent.agentId) || 1);
  }

  /**
   * @param {number} [now]
   * @param {Set<string>} [openAgents] agent row keys the panel currently has
   *   expanded; those rows are folded from their transcripts so the detail has
   *   something to show even after the run settled.
   */
  update(now = Date.now(), openAgents = null) {
    this.readJournal();
    this.readAgentFiles();
    this.readState();
    this.refreshLabels();

    const status = this.state ? this.state.status : null;
    const resumed = this.stateIsStale();
    const settled = Boolean(status && TERMINAL.has(status)) && !resumed;
    const cutOff = settled && status !== 'completed';
    const raw = settled ? this.agentsFromState(cutOff) : this.agentsFromTranscripts(now);
    const phases = this.phases();

    const agents = collapseRetries(raw, (id) => this.promptKeyFor(id));
    for (const agent of agents) {
      const known = agent.members.map((id) => this.labels.get(id)).find(Boolean);
      if (known) agent.label = known;
    }
    if (!settled) this.placePhases(agents, phases.length);

    const badly = cutOff;
    const stages = stageStates(phases, agents, settled, badly);
    // Where the pipeline stands: the stage still working, or — between stages —
    // the last one that completed.  A run that ended badly stands where it
    // stopped, not at the end.
    const lastRunning = Math.max(
      0,
      ...stages.map((s, i) => (s.state === 'running' || s.state === 'stalled' ? i + 1 : 0)),
    );
    const lastDone = Math.max(0, ...stages.map((s, i) => (s.state === 'done' ? i + 1 : 0)));
    const lastFailed = Math.max(0, ...stages.map((s, i) => (s.state === 'failed' ? i + 1 : 0)));
    const currentStage = badly ? lastFailed || lastDone : settled ? phases.length : lastRunning || lastDone;

    let toolCalls = 0;
    let outputTokens = 0;
    let lastTool = null;
    let lastActivityAt = null;
    let startedAt = null;
    const toolCounts = Object.create(null);

    for (const agent of agents) {
      toolCalls += agent.toolCalls;
      outputTokens += agent.tokens;
      if (agent.startedAt && (startedAt === null || agent.startedAt < startedAt)) startedAt = agent.startedAt;
      if (agent.toolCounts) {
        for (const [name, n] of Object.entries(agent.toolCounts)) toolCounts[name] = (toolCounts[name] || 0) + n;
      }
      if (agent.lastActivityAt && (lastActivityAt === null || agent.lastActivityAt > lastActivityAt)) {
        lastActivityAt = agent.lastActivityAt;
      }
      if (!agent.done && agent.lastTool) lastTool = agent.lastTool;
    }

    if (settled) {
      toolCalls = this.state.totalToolCalls || toolCalls;
      outputTokens = this.state.totalTokens || outputTokens;
      startedAt = this.state.startTime || startedAt;
      if (this.state.timestamp) lastActivityAt = Date.parse(this.state.timestamp);
      lastTool = null;
    }

    agents.sort((a, b) => (a.phaseIndex - b.phaseIndex) || (a.startedAt || 0) - (b.startedAt || 0));

    // Only the rows the user actually opened pay for a transcript read.
    const detailed = openAgents && openAgents.size
      ? agents.map((a) => (openAgents.has(a.agentId) ? this.detailFor(a) : a))
      : agents;

    return {
      kind: 'workflow',
      exact: true,
      startedAt,
      lastActivityAt,
      toolCalls,
      toolCounts,
      lastTool,
      lastText: (this.state && this.state.summary) || '',
      outputTokens,
      agents: detailed,
      stages,
      currentStage,
      agentsStarted: agents.length,
      agentsDone: agents.filter((a) => a.done).length,
      agentsFailed: agents.filter((a) => a.failed).length,
      agentCount: (this.state && this.state.agentCount) || agents.length,
      phases,
      dir: this.dir,
      resumed,
      finalStatus: settled ? status : null,
      durationMs: this.state ? this.state.durationMs : null,
    };
  }
}

module.exports = {
  WorkflowProbe,
  listRuns,
  runsDir,
  runStateFile,
  findScript,
  parsePhases,
  promptLines,
  readPrompt,
  fingerprint,
  collapseRetries,
  readFirstLine,
  titleFromLine,
  distinctiveLabels,
  assignPhases,
  stageStates,
};
