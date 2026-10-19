'use strict';

const fs = require('fs');
const path = require('path');

const { Tailer } = require('./tailer');
const { AgentProbe, quickProbe, fullProbe } = require('./probe');
const { projectDirsFor, recentSessions, shellOutputFile } = require('./paths');
const { WorkflowProbe, listRuns } = require('./workflow');

// Past this, the main transcript is followed from near its end instead of being
// folded from the start.  Anything older is finished work the subagent metadata
// still describes.
const MAIN_FULL_PARSE_LIMIT = 48 * 1024 * 1024;
const MAIN_TAIL_ON_OVERSIZE = 8 * 1024 * 1024;

// A task with no completion record and no transcript activity for this long is
// reported as unknown rather than spinning forever — the CLI process it belonged
// to has most likely exited.
const STALE_MS = 10 * 60 * 1000;

// A finished agent's transcript is folded whole so its totals are exact, and the
// result is cached against the file's mtime, so it costs one pass per task ever.
// Past this size the tail summary is used instead and the figures are marked
// approximate rather than shown as fact.
const FINISHED_FULL_LIMIT = 16 * 1024 * 1024;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

// How many recent shell invocations to keep so an auto-backgrounded command can
// still be named after the fact.
const SHELL_CALL_HISTORY = 400;

function firstLine(text, max = 120) {
  if (typeof text !== 'string') return '';
  const line = text.split('\n').find((l) => l.trim().length > 0) || '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Cheap pre-filter so JSON.parse only runs on records we actually consume. */
function isInteresting(line) {
  return (
    line.indexOf('task-notification') !== -1 ||
    line.indexOf('agentId') !== -1 ||
    line.indexOf('backgroundTaskId') !== -1 ||
    line.indexOf('run_in_background') !== -1 ||
    line.indexOf('local_workflow') !== -1 ||
    line.indexOf('"Agent"') !== -1 ||
    line.indexOf('"Task"') !== -1 ||
    line.indexOf('"Bash"') !== -1 ||
    line.indexOf('"PowerShell"') !== -1
  );
}

/** The `<task-notification>` payload of a record, wherever it is carried. */
function notificationText(record) {
  if (record.type === 'queue-operation' && typeof record.content === 'string') {
    return record.content.indexOf('<task-notification>') !== -1 ? record.content : null;
  }
  const content = record.message && record.message.content;
  if (typeof content === 'string' && content.indexOf('<task-notification>') !== -1) return content;
  return null;
}

function toolResultId(record) {
  const content = record.message && record.message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && block.type === 'tool_result' && block.tool_use_id) return block.tool_use_id;
  }
  return null;
}

function newTask(toolUseId, session) {
  return {
    key: `${session.sessionId}:${toolUseId}`,
    toolUseId,
    externalId: null,
    kind: 'agent',
    description: '',
    agentType: null,
    prompt: '',
    command: '',
    model: null,
    isolation: null,
    spawnDepth: 1,
    isAsync: false,
    startedAt: null,
    endedAt: null,
    reportedStatus: null,
    summary: '',
    transcriptFile: null,
    outputFile: null,
    autoBackgrounded: false,
    workflowName: null,
    runId: null,
    workflowDir: null,
    scriptPath: null,
    goal: '',
    sessionId: session.sessionId,
    sessionFile: session.file,
    progress: null,
  };
}

/** Per-session parse state; each refresh only consumes newly appended bytes. */
class SessionState {
  constructor(session, projectDirName) {
    this.sessionId = session.sessionId;
    this.file = session.file;
    this.subagentsDir = session.subagentsDir;
    this.projectDirName = projectDirName;

    let startAt = 0;
    try {
      const size = fs.statSync(this.file).size;
      if (size > MAIN_FULL_PARSE_LIMIT) startAt = size - MAIN_TAIL_ON_OVERSIZE;
    } catch {
      /* handled on read */
    }
    this.tailer = new Tailer(this.file, startAt);

    this.tasks = new Map(); // toolUseId -> task
    this.externalIds = new Map(); // agentId | backgroundTaskId -> toolUseId
    this.pendingStatuses = new Map(); // external id seen before its launch
    this.probes = new Map(); // toolUseId -> AgentProbe
    this.finishedCache = new Map(); // transcript file -> { mtimeMs, progress }
    this.subagentsMtime = -1;
    // A foreground shell that outruns its timeout is moved to the background
    // after the fact, so its launch record carries no run_in_background flag.
    // Keep the last few shell invocations around to name those retroactively.
    this.shellCalls = new Map(); // toolUseId -> { command, description }
    this.sessionDir = path.dirname(session.subagentsDir);
    this.workflowRuns = new Map(); // runId -> toolUseId
    this.workflowProbes = new Map(); // toolUseId -> WorkflowProbe
  }

  task(toolUseId) {
    let task = this.tasks.get(toolUseId);
    if (!task) {
      task = newTask(toolUseId, this);
      this.tasks.set(toolUseId, task);
    }
    return task;
  }

  bindExternalId(task, externalId) {
    if (!externalId || task.externalId === externalId) return;
    task.externalId = externalId;
    this.externalIds.set(externalId, task.toolUseId);
    const pending = this.pendingStatuses.get(externalId);
    if (pending) {
      this.applyStatus(task, pending.status, pending.summary, pending.at);
      this.pendingStatuses.delete(externalId);
    }
  }

  rememberShellCall(toolUseId, input) {
    if (!toolUseId) return;
    this.shellCalls.set(toolUseId, {
      command: typeof input.command === 'string' ? input.command.slice(0, 2000) : '',
      description: input.description || '',
    });
    if (this.shellCalls.size > SHELL_CALL_HISTORY) {
      this.shellCalls.delete(this.shellCalls.keys().next().value);
    }
  }

  applyStatus(task, status, summary, at) {
    task.reportedStatus = status;
    if (summary) task.summary = summary;
    if (task.endedAt === null && at) task.endedAt = at;
  }

  /** Fold every `<task-notification>` block in a record's text. */
  handleNotification(text, at) {
    for (const chunk of text.split('</task-notification>')) {
      if (chunk.indexOf('<task-notification>') === -1) continue;
      const statusMatch = /<status>([a-z_]+)<\/status>/.exec(chunk);
      if (!statusMatch) continue;
      const status = statusMatch[1];
      const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(chunk);
      const summary = summaryMatch ? summaryMatch[1].trim() : '';
      const ids = [...chunk.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1]);
      for (const id of ids) {
        const toolUseId = this.externalIds.get(id);
        if (toolUseId && this.tasks.has(toolUseId)) this.applyStatus(this.tasks.get(toolUseId), status, summary, at);
        else this.pendingStatuses.set(id, { status, summary, at });
      }
    }
  }

  handleRecord(record) {
    const at = record.timestamp ? Date.parse(record.timestamp) : null;

    const notification = notificationText(record);
    if (notification) this.handleNotification(notification, at);

    const content = record.message && record.message.content;
    if (record.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== 'tool_use') continue;
        const input = block.input || {};
        if (block.name === 'Agent' || block.name === 'Task') {
          const task = this.task(block.id);
          task.kind = 'agent';
          task.description = input.description || task.description || '(agent)';
          task.agentType = input.subagent_type || task.agentType || 'agent';
          task.prompt = input.prompt || task.prompt;
          task.isolation = input.isolation || null;
          if (input.model) task.model = input.model;
          if (task.startedAt === null) task.startedAt = at;
        } else if (block.name === 'Bash' || block.name === 'PowerShell') {
          this.rememberShellCall(block.id, input);
          if (input.run_in_background) {
            const task = this.task(block.id);
            task.kind = 'shell';
            task.command = input.command || '';
            task.description = input.description || firstLine(task.command) || '(background shell)';
            if (task.startedAt === null) task.startedAt = at;
          }
        }
      }
    }

    const result = record.toolUseResult;
    if (result && typeof result === 'object') {
      const id = toolResultId(record);
      if (result.agentId) {
        const task = this.task(id || `agent:${result.agentId}`);
        task.kind = 'agent';
        task.isAsync = result.isAsync === true || result.status === 'async_launched';
        if (result.description) task.description = result.description;
        if (result.resolvedModel) task.model = result.resolvedModel;
        if (result.prompt) task.prompt = result.prompt;
        if (task.startedAt === null) task.startedAt = at;
        this.bindExternalId(task, result.agentId);
      } else if (result.taskType === 'local_workflow' && result.runId) {
        const task = this.task(this.workflowRuns.get(result.runId) || id || `wf:${result.runId}`);
        task.kind = 'workflow';
        task.isAsync = true;
        task.workflowName = result.workflowName || 'workflow';
        task.runId = result.runId;
        task.goal = result.summary || '';
        task.scriptPath = result.scriptPath || null;
        task.description = result.summary || task.workflowName;
        if (task.startedAt === null) task.startedAt = at;
        this.workflowRuns.set(result.runId, task.toolUseId);
        this.bindExternalId(task, result.taskId);
      } else if (result.backgroundTaskId) {
        const task = this.task(id || `shell:${result.backgroundTaskId}`);
        task.kind = 'shell';
        if (!task.command && id) {
          const call = this.shellCalls.get(id);
          if (call) {
            task.command = call.command;
            task.description = call.description || firstLine(call.command);
          }
        }
        if (!task.description) task.description = '(background shell)';
        if (result.timedOutAfterMs) task.autoBackgrounded = true;
        if (task.startedAt === null) task.startedAt = at;
        this.bindExternalId(task, result.backgroundTaskId);
        task.outputFile = shellOutputFile(this.projectDirName, this.sessionId, result.backgroundTaskId);
      } else if (id) {
        // A foreground agent returning its result: no agentId, but the tool call
        // it answers is one we are tracking.
        const task = this.tasks.get(id);
        if (task && task.kind === 'agent' && !task.isAsync && !task.reportedStatus) {
          this.applyStatus(task, 'completed', task.summary, at);
        }
      }
    }
  }

  /**
   * Subagent metadata is the authoritative list of agents: nested agents are
   * launched inside another agent's transcript and never appear in this one.
   */
  scanSubagents() {
    let stat;
    try {
      stat = fs.statSync(this.subagentsDir);
    } catch {
      return;
    }
    if (stat.mtimeMs === this.subagentsMtime) return;
    this.subagentsMtime = stat.mtimeMs;

    let entries;
    try {
      entries = fs.readdirSync(this.subagentsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue;
      const agentId = name.slice('agent-'.length, -'.meta.json'.length);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(this.subagentsDir, name), 'utf8'));
      } catch {
        continue;
      }
      const toolUseId = meta.toolUseId || `agent:${agentId}`;
      const task = this.task(toolUseId);
      task.kind = 'agent';
      task.spawnDepth = meta.spawnDepth || 1;
      task.agentType = task.agentType || meta.agentType || 'agent';
      if (!task.description) task.description = meta.description || '(agent)';
      task.transcriptFile = path.join(this.subagentsDir, `agent-${agentId}.jsonl`);
      this.bindExternalId(task, agentId);
    }
  }

  /**
   * Workflow runs are found on disk as well as from launch records, so a run
   * whose launch scrolled out of the parsed window is still listed.
   */
  scanWorkflows() {
    for (const runId of listRuns(this.sessionDir)) {
      if (this.workflowRuns.has(runId)) continue;
      const task = this.task(`wf:${runId}`);
      task.kind = 'workflow';
      task.isAsync = true;
      task.runId = runId;
      task.workflowName = task.workflowName || runId;
      if (!task.description) task.description = runId;
      this.workflowRuns.set(runId, task.toolUseId);
    }
  }

  /** Attach live progress: exact and incremental while running, cheap once done. */
  updateProgress(task, openAgents) {
    if (task.kind === 'workflow') {
      this.updateWorkflowProgress(task, openAgents);
      return;
    }
    if (task.kind !== 'agent' || !task.transcriptFile) return;
    const finished = TERMINAL_STATUSES.has(task.reportedStatus);

    if (!finished) {
      let probe = this.probes.get(task.toolUseId);
      if (!probe) {
        probe = new AgentProbe(task.transcriptFile);
        this.probes.set(task.toolUseId, probe);
      }
      task.progress = probe.update();
    } else {
      let stat;
      try {
        stat = fs.statSync(task.transcriptFile);
      } catch {
        this.probes.delete(task.toolUseId);
        return;
      }
      // The probe that followed this task while it ran already holds exact
      // totals.  Hand them to the cache and let the probe go: recomputing them
      // from the tail is what used to make the tool count vanish on completion.
      const live = this.probes.get(task.toolUseId);
      if (live && live.progress && live.progress.exact) {
        this.finishedCache.set(task.transcriptFile, { mtimeMs: stat.mtimeMs, progress: live.progress });
      }
      this.probes.delete(task.toolUseId);

      const cached = this.finishedCache.get(task.transcriptFile);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        task.progress = cached.progress;
      } else {
        const progress =
          stat.size <= FINISHED_FULL_LIMIT ? fullProbe(task.transcriptFile) : quickProbe(task.transcriptFile);
        this.finishedCache.set(task.transcriptFile, { mtimeMs: stat.mtimeMs, progress });
        task.progress = progress;
      }
    }

    if (task.progress) {
      if (task.startedAt === null) task.startedAt = task.progress.startedAt;
      if (!task.model && task.progress.model) task.model = task.progress.model;
      if (finished && task.endedAt === null) task.endedAt = task.progress.lastActivityAt;
    }
  }

  updateWorkflowProgress(task, openAgents) {
    if (!task.runId) return;
    let probe = this.workflowProbes.get(task.toolUseId);
    if (!probe) {
      probe = new WorkflowProbe(this.sessionDir, task.runId, task.scriptPath);
      this.workflowProbes.set(task.toolUseId, probe);
    }
    // The launch record can be parsed after the run directory was found on
    // disk; when it finally names the script, hand it over rather than leaving
    // the probe without a stage list for the rest of the run.
    if (task.scriptPath && !probe.scriptPath) probe.scriptPath = task.scriptPath;
    task.progress = probe.update(Date.now(), openAgents);
    task.workflowDir = task.progress.dir;
    if (task.startedAt === null) task.startedAt = task.progress.startedAt;
    // A finished run writes its own state file, which settles the outcome even
    // when no completion notification reached the session.
    if (task.progress.finalStatus) {
      if (!task.reportedStatus) {
        task.reportedStatus = task.progress.finalStatus;
        if (task.endedAt === null) task.endedAt = task.progress.lastActivityAt;
      }
      return;
    }
    // A run stopped by a usage limit and then picked up again has to leave the
    // finished list, whatever it or a notification reported the first time.
    if (task.progress.resumed && TERMINAL_STATUSES.has(task.reportedStatus)) {
      task.reportedStatus = null;
      task.endedAt = null;
      task.summary = '';
    }
  }

  refresh(openAgents) {
    const lines = this.tailer.read();
    for (const line of lines) {
      if (line.length < 2 || !isInteresting(line)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        this.handleRecord(record);
      } catch {
        // One malformed record must not take the whole panel down.
      }
    }
    this.scanSubagents();
    this.scanWorkflows();

    for (const task of this.tasks.values()) this.updateProgress(task, openAgents);
    return [...this.tasks.values()];
  }
}

/** Most recent moment we know anything about a task. */
function lastKnownActivity(task) {
  return Math.max(
    task.endedAt || 0,
    (task.progress && task.progress.lastActivityAt) || 0,
    task.startedAt || 0,
  );
}

/**
 * Resuming a session copies the earlier transcript into the new session file,
 * so one task can be recorded under several session ids.  Keep the copy that
 * knows the most: the freshest activity, and a reported outcome over none.
 */
function dedupeByExternalId(tasks) {
  const best = new Map();
  const unidentified = [];
  for (const task of tasks) {
    if (!task.externalId) {
      unidentified.push(task);
      continue;
    }
    const rival = best.get(task.externalId);
    if (!rival) {
      best.set(task.externalId, task);
      continue;
    }
    // A recorded outcome outranks a fresher copy that never saw one: the copy
    // carried into the resumed session keeps being written to, so on activity
    // alone it always wins and a finished agent comes back as running.
    const mine = Boolean(task.reportedStatus);
    const theirs = Boolean(rival.reportedStatus);
    const better = mine !== theirs ? mine : lastKnownActivity(task) > lastKnownActivity(rival);
    if (better) best.set(task.externalId, task);
  }
  return [...best.values(), ...unidentified];
}

/** Final status shown in the tree, including the "no completion record" case. */
function statusOf(task, now) {
  if (task.reportedStatus) return task.reportedStatus;
  const last = (task.progress && task.progress.lastActivityAt) || task.startedAt || 0;
  // Nothing about this task carries a time — no launch record, no transcript
  // activity.  It cannot be shown as working, or it spins for the session.
  if (!last) return 'unknown';
  if (now - last > STALE_MS) return 'unknown';
  return 'running';
}

/**
 * Watches every Claude session belonging to the open workspace folders and
 * exposes the background tasks it finds.
 */
class TaskStore {
  /** @param {() => object} readConfig */
  constructor(readConfig) {
    this.readConfig = readConfig;
    this.folders = [];
    this.sessions = new Map(); // session file -> SessionState
    this.projectDirs = [];
    this.lastError = null;
    // Agent ids whose row the panel has expanded.  Only those are folded from
    // their transcripts once a run has settled.
    this.openAgents = new Set();
  }

  setFolders(folders) {
    this.folders = folders;
    this.sessions.clear();
    this.projectDirs = [];
  }

  /** Project directories backing the current workspace, for the file watcher. */
  resolveProjectDirs() {
    const config = this.readConfig();
    const dirs = [];
    for (const folder of this.folders) {
      for (const dir of projectDirsFor(folder, config.claudeConfigDir || undefined, config.includeNestedSessions)) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    }
    this.projectDirs = dirs;
    return dirs;
  }

  /** @returns {{tasks: object[], sessionCount: number, projectDirs: string[]}} */
  refresh() {
    const config = this.readConfig();
    const hours = Number(config.sessionMaxAgeHours);
    const maxAge = Math.max(1, Number.isFinite(hours) ? hours : 24) * 3600 * 1000;
    const dirs = this.resolveProjectDirs();

    const live = new Set();
    const tasks = [];
    for (const dir of dirs) {
      for (const session of recentSessions(dir, maxAge)) {
        live.add(session.file);
        let state = this.sessions.get(session.file);
        if (!state) {
          state = new SessionState(session, path.basename(dir));
          this.sessions.set(session.file, state);
        }
        try {
          tasks.push(...state.refresh(this.openAgents));
        } catch (err) {
          this.lastError = err;
        }
      }
    }
    for (const file of [...this.sessions.keys()]) {
      if (!live.has(file)) this.sessions.delete(file);
    }

    const unique = dedupeByExternalId(tasks);
    const now = Date.now();
    for (const task of unique) task.status = statusOf(task, now);
    return { tasks: unique, sessionCount: live.size, projectDirs: dirs };
  }
}

module.exports = { TaskStore, statusOf, firstLine, dedupeByExternalId, TERMINAL_STATUSES, STALE_MS };
