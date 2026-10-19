'use strict';

/**
 * Turns store tasks into a flat, serializable shape for the webview.
 *
 * The split matters: everything here is plain data with no VS Code imports, so
 * the panel's wording and grouping can be tested without a running editor.
 */

const STATUS = {
  running: { tone: 'running', word: 'running' },
  completed: { tone: 'ok', word: 'done' },
  failed: { tone: 'bad', word: 'failed' },
  error: { tone: 'bad', word: 'failed' },
  // A run that was cut short did not deliver what it was asked for, so it reads
  // as an outcome that went wrong rather than as a quiet neutral one.  Only a
  // task we genuinely lost track of stays grey.
  cancelled: { tone: 'bad', word: 'cancelled' },
  // The store reports both of these; `killed` is what a stop request produces
  // and `stopped` is what the notification itself says.
  killed: { tone: 'bad', word: 'stopped' },
  stopped: { tone: 'bad', word: 'stopped' },
  unknown: { tone: 'muted', word: 'no result' },
};

function statusOf(status) {
  return Object.hasOwn(STATUS, status) ? STATUS[status] : STATUS.unknown;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatClock(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTokens(n) {
  if (!n) return '';
  if (n < 1000) return `${n} tokens`;
  if (n < 1000000) return `${Math.round(n / 1000)}k tokens`;
  return `${(n / 1000000).toFixed(1)}M tokens`;
}

/** Compact figure for a table cell, without the unit. */
function shortTokens(n) {
  return n ? formatTokens(n).replace(' tokens', '') : '';
}

function truncate(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max || max < 1) return flat.length <= max ? flat : flat.slice(0, Math.max(0, max));
  let cut = max - 1;
  // Never end on the first half of a surrogate pair — an emoji split down the
  // middle renders as a replacement character.
  const code = flat.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${flat.slice(0, cut)}…`;
}

function elapsedOf(task, now) {
  if (!task.startedAt) return 0;
  const end = task.status === 'running' ? now : task.endedAt || task.lastActivityAt || now;
  return Math.max(0, end - task.startedAt);
}

/** What the task is doing right now, in a few words. */
function activityOf(task) {
  const p = task.progress;
  if (!p || !p.lastTool) return '';
  const detail = p.lastTool.detail ? ` ${truncate(p.lastTool.detail, 30)}` : '';
  return `${p.lastTool.name}${detail}`;
}

/**
 * The one line under the title, as tagged pieces so the panel can weight them:
 * what changes — the stage and what is running right now — carries the eye,
 * the rest stays quiet.  Reference data such as run ids and timestamps lives in
 * the expanded detail, not here, because it never changes and only competes.
 */
function metaPartsOf(task, now) {
  const parts = [];
  const p = task.progress;
  const status = statusOf(task.status);

  // An outcome that went wrong belongs on the collapsed row, where it is read
  // without opening anything.  Success does not: the green mark already says it,
  // and the word would only crowd out the figures.
  if (task.status !== 'running' && status.tone !== 'ok') {
    parts.push({ kind: `state ${status.tone}`, text: status.word });
  }

  if (task.kind === 'workflow' && p) {
    const stage = p.stages && p.currentStage ? p.stages[p.currentStage - 1] : null;
    if (stage && task.status === 'running') {
      parts.push({ kind: 'stage', text: `${stage.title} ${p.currentStage}/${p.stages.length}` });
    }
  }

  const elapsed = formatDuration(elapsedOf(task, now));
  if (elapsed) parts.push({ kind: 'time', text: elapsed });

  if (task.kind === 'workflow' && p && p.agentsStarted) {
    const total = p.agentCount || p.agentsStarted;
    const done = p.agentsDone || 0;
    // The ratio stays visible for a run that stopped short: "3 agents" on a run
    // where none of them returned reads as work that was done.
    parts.push({
      kind: 'agents',
      text:
        task.status === 'running' || done < total
          ? `${done}/${total} agents`
          : `${total} ${total === 1 ? 'agent' : 'agents'}`,
    });
    if (p.agentsFailed) parts.push({ kind: 'bad', text: `${p.agentsFailed} failed` });
  }

  if (p && p.exact && p.toolCalls) parts.push({ kind: 'tools', text: `${p.toolCalls} tools` });

  if (task.status === 'running') {
    const activity = activityOf(task) || (task.kind === 'shell' ? truncate(task.command, 30) : '');
    if (activity) parts.push({ kind: 'now', text: activity });
  }
  return parts;
}

function metaOf(task, now) {
  return metaPartsOf(task, now)
    .map((part) => part.text)
    .join(' · ');
}

/** Rows shown only once a card is opened. */
function detailRows(task) {
  const rows = [];
  const p = task.progress;

  if (task.kind === 'workflow') {
    const bits = [task.workflowName, task.runId].filter(Boolean);
    if (bits.length) rows.push({ icon: 'workflow', text: bits.join(' · ') });

  } else if (task.kind === 'agent') {
    const bits = [task.agentType || 'agent'];
    if (task.model) bits.push(task.model);
    if (task.spawnDepth > 1) bits.push(`nested depth ${task.spawnDepth}`);
    rows.push({ icon: 'agent', text: bits.join(' · ') });
  } else if (task.command) {
    rows.push({ icon: 'shell', text: truncate(task.command, 200), mono: true });
  }

  const started = formatClock(task.startedAt);
  const ended = formatClock(task.endedAt);
  if (started) rows.push({ icon: 'clock', text: ended ? `${started} → ${ended}` : `since ${started}` });

  // Only totals we actually counted. A tail-sampled figure is a fraction of the
  // truth, and printing it plainly is worse than printing nothing.
  if (p && p.exact && p.toolCounts) {
    const counts = Object.entries(p.toolCounts).sort((a, b) => b[1] - a[1]);
    if (counts.length) rows.push({ icon: 'tools', text: counts.map(([n, c]) => `${n} ${c}`).join(', ') });
  }
  if (p && p.outputTokens) {
    rows.push({ icon: 'tokens', text: `${p.exact ? '' : '~'}${formatTokens(p.outputTokens)}` });
  }

  const outcome = task.summary || (task.status !== 'running' && p && p.lastText);
  if (outcome) rows.push({ icon: 'outcome', text: truncate(outcome, 400) });

  if (task.prompt && task.kind !== 'shell') rows.push({ icon: 'prompt', text: truncate(task.prompt, 400) });
  return rows;
}

/**
 * What one agent's expanded row shows.  The same shape as a task's detail rows,
 * so the panel renders both with one piece of code — this is what replaces
 * dropping the reader into the raw transcript to answer "what is this one
 * actually doing".
 */
function agentDetailRows(agent) {
  const rows = [];

  const what = [];
  if (agent.model) what.push(agent.model);
  if (agent.attempts > 1) what.push(`attempt ${agent.attempts}`);
  if (what.length) rows.push({ icon: 'agent', text: what.join(' · ') });

  const started = formatClock(agent.startedAt);
  if (started) {
    const ended = agent.done && agent.lastActivityAt ? formatClock(agent.lastActivityAt) : '';
    const span = formatDuration(agent.durationMs);
    rows.push({ icon: 'clock', text: `${ended ? `${started} → ${ended}` : `since ${started}`}${span ? ` · ${span}` : ''}` });
  }

  if (agent.toolCounts) {
    const counts = Object.entries(agent.toolCounts).sort((a, b) => b[1] - a[1]);
    if (counts.length) rows.push({ icon: 'tools', text: counts.map(([n, c]) => `${n} ${c}`).join(', ') });
  } else if (agent.toolCalls) {
    rows.push({ icon: 'tools', text: `${agent.toolCalls} calls` });
  }

  if (agent.tokens) rows.push({ icon: 'tokens', text: formatTokens(agent.tokens) });

  if (!agent.done && !agent.stalled && agent.lastTool) {
    const detail = agent.lastTool.detail ? ` — ${truncate(agent.lastTool.detail, 60)}` : '';
    rows.push({ icon: 'now', text: `${agent.lastTool.name}${detail}` });
  }

  if (agent.lastText) rows.push({ icon: 'outcome', text: truncate(agent.lastText, 600) });
  return rows;
}

/** One row per agent: name, tokens, time — the three figures worth comparing. */
function agentRows(task) {
  const p = task.progress;
  if (task.kind !== 'workflow' || !p || !p.agents) return [];
  return p.agents.map((a) => ({
    key: `${task.key}#${a.agentId}`,
    agentId: a.agentId,
    label: truncate(a.label, 80),
    // An agent that has not produced output yet gets a placeholder, so the
    // column reads as "nothing yet" rather than looking broken.
    tokens: a.tokens ? shortTokens(a.tokens) : '—',
    time: formatDuration(a.durationMs) || '—',
    tools: a.toolCalls ? `${a.toolCalls}` : '',
    activity: !a.done && !a.stalled && a.lastTool ? a.lastTool.name : '',
    tone: a.failed ? 'bad' : a.done ? 'ok' : a.stalled ? 'muted' : 'running',
    phase: a.phaseIndex || 0,
    file: a.file,
    rows: agentDetailRows(a),
  }));
}

function stageRows(task) {
  const p = task.progress;
  if (task.kind !== 'workflow' || !p || !p.stages) return [];
  return p.stages.map((s, i) => ({
    index: i + 1,
    title: s.title,
    detail: s.detail || '',
    state: s.state,
    agents: s.agents,
  }));
}

function actionsOf(task) {
  const actions = [];
  if (task.kind === 'shell') {
    if (task.outputFile) actions.push({ id: 'openShellOutput', label: 'Open output' });
  } else if (task.transcriptFile) {
    actions.push({ id: 'openTranscript', label: 'Open transcript' });
  }
  if (task.externalId || task.toolUseId) actions.push({ id: 'copyId', label: 'Copy id' });
  if (task.prompt || task.command) actions.push({ id: 'copyPrompt', label: 'Copy prompt' });
  return actions;
}

function tooltipOf(task, now) {
  const lines = [task.description || '(no description)'];
  const status = statusOf(task.status);
  const elapsed = formatDuration(elapsedOf(task, now));
  lines.push(`${status.word}${elapsed ? ` · ${elapsed}` : ''}`);
  if (task.workflowName) lines.push(`workflow ${task.workflowName} · ${task.runId || ''}`.trim());
  if (task.externalId) lines.push(`id ${task.externalId}`);
  if (task.sessionId) lines.push(`session ${task.sessionId}`);
  return lines.join('\n');
}

function viewTask(task, now) {
  const status = statusOf(task.status);
  const p = task.progress;
  const total = p && task.kind === 'workflow' ? p.agentCount || p.agentsStarted : 0;
  const parts = metaPartsOf(task, now);
  return {
    key: task.key,
    kind: task.kind,
    status: task.status,
    tone: status.tone,
    statusWord: status.word,
    running: task.status === 'running',
    title: truncate(task.description || task.command || task.toolUseId, 160),
    meta: parts.map((part) => part.text).join(' · '),
    metaParts: parts,
    tooltip: tooltipOf(task, now),
    progress: total > 1 ? { done: p.agentsDone || 0, total } : null,
    rows: detailRows(task),
    stages: stageRows(task),
    agents: agentRows(task),
    actions: actionsOf(task),
  };
}

/**
 * Running first and oldest-first, so the task that has been going longest sits
 * at the top; finished newest-first, because that is the one just looked for.
 */
function groupTasks(tasks, config) {
  const running = tasks
    .filter((t) => t.status === 'running')
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const finishedAll = tasks
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
  const limit = Math.max(0, config.finishedLimit);
  const finished = config.showFinished ? finishedAll.slice(0, limit) : [];
  return { running, finished, finishedTotal: finishedAll.length, hidden: finishedAll.length - finished.length };
}

function buildModel(tasks, config, now) {
  const groups = groupTasks(tasks, config);
  return {
    running: groups.running.map((t) => viewTask(t, now)),
    finished: groups.finished.map((t) => viewTask(t, now)),
    finishedTotal: groups.finishedTotal,
    hidden: groups.hidden,
    showFinished: Boolean(config.showFinished),
  };
}

module.exports = {
  buildModel,
  stageRows,
  agentRows,
  agentDetailRows,
  groupTasks,
  viewTask,
  formatDuration,
  formatTokens,
  shortTokens,
  truncate,
  statusOf,
  metaOf,
  metaPartsOf,
  detailRows,
};
