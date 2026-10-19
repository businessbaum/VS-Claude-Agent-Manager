'use strict';

/* Renders the task model posted by the extension.
   Cards are patched in place while the set of tasks is unchanged, so a refresh
   every second or two does not clear hover, focus or a text selection. */

(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  const ICONS = {
    check: '<path d="M3.5 8.4l3 3 6-6.6"/>',
    cross: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    dash: '<circle cx="8" cy="8" r="5.4"/><path d="M5.4 8h5.2"/>',
    file: '<path d="M9.2 1.8H4.6A1.6 1.6 0 003 3.4v9.2a1.6 1.6 0 001.6 1.6h6.8a1.6 1.6 0 001.6-1.6V5.6z"/><path d="M9.2 1.8v3.8H13"/>',
    terminal: '<path d="M3.2 4.4L6.6 7.9 3.2 11.4"/><path d="M8.4 11.6H12.8"/>',
    copy: '<rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.4"/><path d="M10.4 3.6a1.4 1.4 0 00-1.4-1.4H4.2a1.4 1.4 0 00-1.4 1.4v4.8a1.4 1.4 0 001.4 1.4"/>',
    hash: '<path d="M6.2 2.8L4.8 13.2M11.2 2.8L9.8 13.2M2.8 5.8h10.4M2.4 10.2h10.4"/>',
  };

  const LABELS = {
    workflow: 'workflow',
    phases: 'phases',
    agent: 'agent',
    shell: 'command',
    clock: 'time',
    tools: 'tools',
    tokens: 'tokens',
    now: 'now',
    outcome: 'result',
    prompt: 'prompt',
  };

  const TONE_ICON = { ok: 'check', bad: 'cross', muted: 'dash' };

  const STAGE_MARK = { done: '✓', failed: '✕', running: '', stalled: '–', pending: '·' };

  /** Must match the spin animation in panel.css. */
  const SPIN_MS = 900;

  const saved = vscode.getState() || {};
  let model = { running: [], finished: [], hidden: 0, showFinished: true };
  const expanded = new Set(saved.expanded || []);
  const openAgents = new Set(saved.openAgents || []);
  let cards = new Map(); // task key -> nodes
  let layout = '';

  function svg(name) {
    const holder = document.createElement('span');
    holder.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return holder.firstChild;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * A CSS animation restarts from zero on a freshly created element, so a new
   * spinner would visibly jump out of step with the ones already turning. A
   * negative delay derived from the clock starts it at the shared phase.
   */
  function alignSpin(node) {
    node.style.animationDelay = `-${(Date.now() % SPIN_MS) / 1000}s`;
  }

  function statusNode(tone) {
    const node = el('span', `status ${tone}`);
    if (tone === 'running') alignSpin(node);
    else node.appendChild(svg(TONE_ICON[tone] || 'dash'));
    return node;
  }

  /** Swap a status dot between spinner and glyph without rebuilding the row. */
  function setTone(node, tone) {
    if (node.className === `status ${tone}`) return;
    node.className = `status ${tone}`;
    node.textContent = '';
    if (tone === 'running') alignSpin(node);
    else node.appendChild(svg(TONE_ICON[tone] || 'dash'));
  }

  function saveState() {
    vscode.setState({ expanded: [...expanded], openAgents: [...openAgents] });
  }

  /* ---------- detail rows -------------------------------------------------- */

  /** The label/value pairs shared by a task's detail and an agent's. */
  function rowsInto(container, rows) {
    for (const row of rows) {
      const line = el('div', `row ${row.icon}`);
      line.appendChild(el('span', 'label', LABELS[row.icon] || row.icon));
      line.appendChild(el('span', `value${row.mono ? ' mono' : ''}`, row.text));
      container.appendChild(line);
    }
    return container;
  }

  function detailNode(task) {
    const detail = el('div', 'detail');
    const rows = el('div', 'rows');
    rowsInto(rows, task.rows);
    detail.appendChild(rows);
    if (task.stages.length) detail.appendChild(stepperNode(task));
    if (task.agents.length) detail.appendChild(agentsNode(task));
    detail.refs = { rows: [...rows.children], stages: [], agents: new Map() };
    collectRefs(detail);
    return detail;
  }

  /**
   * References are kept as the tree is built rather than queried back out of it,
   * so patching never depends on a selector engine.
   */
  function collectRefs(detail) {
    const refs = detail.refs;
    refs.rows = [];
    refs.stages = [];
    refs.agents = new Map();
    const walk = (node) => {
      for (const child of node.children) {
        const cls = String(child.className || '').split(/\s+/);
        if (cls.includes('row') && child.children.length > 1) refs.rows.push(child.children[1]);
        else if (cls.includes('stage') && !cls.includes('stages')) refs.stages.push(child);
        else if (cls.includes('agent') && child.dataset && child.dataset.key) refs.agents.set(child.dataset.key, child);
        walk(child);
      }
    };
    walk(detail);
  }

  /* ---------- pipeline stages ---------------------------------------------- */

  function stageTick(state) {
    const tick = el('span', 'tick', STAGE_MARK[state] === undefined ? '·' : STAGE_MARK[state]);
    if (state === 'running') alignSpin(tick);
    return tick;
  }

  /** The pipeline's stages, with the one it is in marked. */
  function stepperNode(task) {
    const strip = el('div', 'stages');
    for (const stage of task.stages) {
      const pill = el('span', `stage ${stage.state}`);
      pill.appendChild(stageTick(stage.state));
      pill.appendChild(el('span', 'name', stage.title));
      if (stage.agents) pill.appendChild(el('span', 'n', String(stage.agents)));
      pill.title = [`${stage.title} — ${stage.state}`, stage.detail].filter(Boolean).join('\n');
      strip.appendChild(pill);
    }
    return strip;
  }

  /* ---------- agents -------------------------------------------------------- */

  function agentTitle(agent) {
    return [
      agent.label,
      agent.activity ? `now: ${agent.activity}` : '',
      agent.tools ? `${agent.tools} tool calls` : '',
      'Click for details',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function agentRowNode(agent) {
    const open = openAgents.has(agent.key);
    const row = el('div', `agent ${agent.tone}${open ? ' open' : ''}`);
    row.dataset.key = agent.key;
    row.appendChild(statusNode(agent.tone));
    row.appendChild(el('span', 'name', agent.label));
    row.appendChild(el('span', 'num tokens', agent.tokens));
    row.appendChild(el('span', 'num time', agent.time));

    // Opening the transcript stays available, but it is no longer what a click
    // on the row does — the row now answers the question in place.
    const open2 = el('button', 'rowaction');
    open2.title = 'Open transcript';
    open2.appendChild(svg('file'));
    open2.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'openAgent', key: agent.key });
    });
    row.appendChild(open2);

    row.title = agentTitle(agent);
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openAgents.has(agent.key)) openAgents.delete(agent.key);
      else openAgents.add(agent.key);
      saveState();
      // The extension folds an open agent's transcript, so tell it before we
      // re-render — the fuller rows arrive with the next state.
      vscode.postMessage({ type: 'toggleAgent', key: agent.key });
      apply(model, true);
    });
    return row;
  }

  function agentDetailNode(agent) {
    const box = el('div', 'agent-detail');
    const rows = agent.rows && agent.rows.length ? agent.rows : [{ icon: 'now', text: 'nothing recorded yet' }];
    rowsInto(box, rows);
    return box;
  }

  function appendAgent(list, agent) {
    list.appendChild(agentRowNode(agent));
    if (openAgents.has(agent.key)) list.appendChild(agentDetailNode(agent));
  }

  /** Agents as a table, grouped under the stage each belongs to. */
  function agentsNode(task) {
    const list = el('div', 'agents');
    const head = el('div', 'agent head-row');
    head.appendChild(el('span'));
    head.appendChild(el('span', 'name', 'Agent'));
    head.appendChild(el('span', 'num', 'Tokens'));
    head.appendChild(el('span', 'num', 'Time'));
    list.appendChild(head);

    // Stage placement is a guess while a run is live, and absent when the run
    // interleaves stages — then the agents are simply listed flat.
    if (!task.agents.some((a) => a.phase > 0)) {
      for (const agent of task.agents) appendAgent(list, agent);
      return list;
    }
    for (const stage of task.stages) {
      const mine = task.agents.filter((a) => a.phase === stage.index);
      if (!mine.length) continue;
      const label = el('div', `stage-label ${stage.state}`);
      label.appendChild(el('span', 'name', stage.title));
      // Only an agent that actually returned counts as done — one that was cut
      // off is neither working nor finished.
      label.appendChild(el('span', 'n', `${mine.filter((a) => a.tone === 'ok').length}/${mine.length}`));
      list.appendChild(label);
      for (const agent of mine) appendAgent(list, agent);
    }
    const loose = task.agents.filter((a) => !a.phase);
    if (loose.length) {
      const label = el('div', 'stage-label');
      label.appendChild(el('span', 'name', 'unassigned'));
      list.appendChild(label);
      for (const agent of loose) appendAgent(list, agent);
    }
    return list;
  }

  function detailStructure(task) {
    return JSON.stringify([
      task.rows.map((r) => r.icon),
      task.stages.map((s) => s.title),
      task.agents.map((a) => `${a.key}:${a.phase}:${openAgents.has(a.key) ? 1 : 0}`),
    ]);
  }

  /**
   * Updates the open detail in place. Replacing it wholesale would restart every
   * spinner inside it on each refresh, which is what made the sub-task rings
   * jump once a second.
   */
  function patchDetail(task, detail) {
    const refs = detail.refs;
    let index = 0;
    const patchRows = (rows) => {
      for (const row of rows) {
        const node = refs.rows[index];
        index += 1;
        if (node && node.textContent !== row.text) node.textContent = row.text;
      }
    };
    patchRows(task.rows);

    task.stages.forEach((stage, i) => {
      const pill = refs.stages[i];
      if (!pill) return;
      const className = `stage ${stage.state}`;
      if (pill.className !== className) {
        pill.className = className;
        const tick = pill.firstChild;
        tick.textContent = STAGE_MARK[stage.state] === undefined ? '·' : STAGE_MARK[stage.state];
        if (stage.state === 'running') alignSpin(tick);
      }
    });

    for (const agent of task.agents) {
      const row = refs.agents.get(agent.key);
      if (!row) continue;
      const [status, name, tokens, time] = row.children;
      setTone(status, agent.tone);
      const className = `agent ${agent.tone}${openAgents.has(agent.key) ? ' open' : ''}`;
      if (row.className !== className) row.className = className;
      if (name.textContent !== agent.label) name.textContent = agent.label;
      if (tokens.textContent !== agent.tokens) tokens.textContent = agent.tokens;
      if (time.textContent !== agent.time) time.textContent = agent.time;
      const title = agentTitle(agent);
      if (row.title !== title) row.title = title;
      if (openAgents.has(agent.key) && agent.rows) patchRows(agent.rows);
    }
  }

  /* ---------- card ------------------------------------------------------- */

  function actionIcon(id) {
    if (id === 'openTranscript') return 'file';
    if (id === 'openShellOutput') return 'terminal';
    if (id === 'copyId') return 'hash';
    return 'copy';
  }

  function metaParts(task) {
    if (task.metaParts && task.metaParts.length) return task.metaParts;
    return task.meta ? [{ kind: 'time', text: task.meta }] : [];
  }

  function metaSignature(task) {
    return metaParts(task)
      .map((p) => p.kind)
      .join('|');
  }

  /** The line under the title, as weighted chips rather than one grey string. */
  function fillMeta(node, task) {
    node.textContent = '';
    metaParts(task).forEach((part, i) => {
      if (i) node.appendChild(el('span', 'sep', '·'));
      node.appendChild(el('span', `chip ${part.kind}`, part.text));
    });
  }

  function progressNode(task) {
    const wrap = el('div', 'progress');
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.width = `${percent(task.progress)}%`;
    bar.appendChild(fill);
    wrap.appendChild(bar);
    wrap.appendChild(el('span', 'barnum', `${task.progress.done}/${task.progress.total}`));
    return wrap;
  }

  function percent(progress) {
    if (!progress || !progress.total) return 0;
    const share = (progress.done || 0) / progress.total;
    return Math.max(0, Math.min(100, Math.round(share * 100)));
  }

  function cardNode(task) {
    const card = el('div', `card ${task.tone}`);
    card.dataset.key = task.key;

    const head = el('div', 'head');
    const status = statusNode(task.tone);
    const text = el('div', 'text');
    const title = el('div', 'title', task.title);
    const meta = el('div', 'meta');
    fillMeta(meta, task);
    text.appendChild(title);
    text.appendChild(meta);

    let progress = null;
    if (task.progress) {
      progress = progressNode(task);
      text.appendChild(progress);
    }

    const actions = el('div', 'actions');
    for (const action of task.actions) {
      const button = el('button');
      button.title = action.label;
      button.appendChild(svg(actionIcon(action.id)));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'action', id: action.id, key: task.key });
      });
      actions.appendChild(button);
    }

    head.appendChild(status);
    head.appendChild(text);
    head.appendChild(actions);
    head.title = task.tooltip;
    head.addEventListener('click', () => {
      if (expanded.has(task.key)) expanded.delete(task.key);
      else expanded.add(task.key);
      saveState();
      apply(model, true);
    });

    card.appendChild(head);

    const nodes = {
      card,
      head,
      status,
      title,
      meta,
      metaSig: metaSignature(task),
      text,
      progress,
      detail: null,
      structure: '',
    };
    if (expanded.has(task.key)) {
      card.className = `card ${task.tone} open`;
      nodes.detail = detailNode(task);
      nodes.structure = detailStructure(task);
      card.appendChild(nodes.detail);
    }
    cards.set(task.key, nodes);
    return card;
  }

  function patchCard(task) {
    const nodes = cards.get(task.key);
    if (!nodes) return;

    if (nodes.title.textContent !== task.title) nodes.title.textContent = task.title;
    const sig = metaSignature(task);
    if (sig !== nodes.metaSig) {
      nodes.metaSig = sig;
      fillMeta(nodes.meta, task);
    } else {
      const parts = metaParts(task);
      let at = 0;
      for (const child of nodes.meta.children) {
        if (String(child.className || '').indexOf('chip') !== 0) continue;
        const part = parts[at];
        at += 1;
        if (part && child.textContent !== part.text) child.textContent = part.text;
      }
    }
    setTone(nodes.status, task.tone);
    if (nodes.head.title !== task.tooltip) nodes.head.title = task.tooltip;

    // A workflow's bar only becomes due once a second agent starts. Creating it
    // here as well as at build time is what makes it appear at all.
    if (task.progress && !nodes.progress) {
      nodes.progress = progressNode(task);
      nodes.text.appendChild(nodes.progress);
    } else if (!task.progress && nodes.progress) {
      nodes.progress.remove();
      nodes.progress = null;
    } else if (task.progress && nodes.progress) {
      const [bar, num] = nodes.progress.children;
      bar.firstChild.style.width = `${percent(task.progress)}%`;
      const label = `${task.progress.done}/${task.progress.total}`;
      if (num.textContent !== label) num.textContent = label;
    }

    const open = expanded.has(task.key);
    const className = `card ${task.tone}${open ? ' open' : ''}`;
    if (nodes.card.className !== className) nodes.card.className = className;
    if (!open && nodes.detail) {
      nodes.detail.remove();
      nodes.detail = null;
      nodes.structure = '';
      return;
    }
    if (!open) return;

    const structure = detailStructure(task);
    if (!nodes.detail) {
      nodes.detail = detailNode(task);
      nodes.structure = structure;
      nodes.card.appendChild(nodes.detail);
    } else if (structure !== nodes.structure) {
      const replacement = detailNode(task);
      nodes.card.replaceChild(replacement, nodes.detail);
      nodes.detail = replacement;
      nodes.structure = structure;
    } else {
      patchDetail(task, nodes.detail);
    }
  }

  /* ---------- sections ---------------------------------------------------- */

  function sectionNode(label, tasks, extra) {
    const section = el('div', `section ${label.toLowerCase()}`);
    const head = el('div', 'section-head');
    head.appendChild(el('span', 'title', label));
    head.appendChild(el('span', 'count', String(tasks.length)));
    head.appendChild(el('div', 'spacer'));
    if (extra) head.appendChild(extra);
    section.appendChild(head);
    for (const task of tasks) section.appendChild(cardNode(task));
    return section;
  }

  function emptyNode() {
    const box = el('div', 'empty');
    if (!model.watching) {
      box.appendChild(el('strong', null, 'No Claude session for this folder'));
      box.appendChild(document.createTextNode('Open Claude Code here and start a background agent — it will show up.'));
    } else {
      box.appendChild(el('strong', null, 'Nothing running'));
      box.appendChild(
        document.createTextNode(
          model.finishedTotal && !model.showFinished
            ? `${model.finishedTotal} finished ${model.finishedTotal === 1 ? 'task is' : 'tasks are'} hidden.`
            : 'Background agents, workflows and shells will appear here while they work.',
        ),
      );
    }
    return box;
  }

  function toggleButton() {
    const button = el('button', null, model.showFinished ? 'hide' : 'show');
    button.title = model.showFinished ? 'Hide finished tasks' : 'Show finished tasks';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'toggleFinished' });
    });
    return button;
  }

  /* ---------- top level --------------------------------------------------- */

  /**
   * Everything that changes what is on screen rather than what a node says.
   * The empty state and the hidden-finished count belong here too: with both
   * lists empty, nothing else in the key ever moves.
   */
  function layoutKey(next) {
    return JSON.stringify([
      next.running.map((t) => `${t.key}:${t.kind}`),
      next.finished.map((t) => `${t.key}:${t.kind}`),
      next.showFinished,
      Boolean(next.watching),
      next.finishedTotal || 0,
      [...expanded].sort(),
      [...openAgents].sort(),
    ]);
  }

  function rebuild() {
    cards = new Map();
    root.textContent = '';
    if (model.running.length) root.appendChild(sectionNode('Running', model.running, null));
    if (model.showFinished && model.finished.length) {
      root.appendChild(sectionNode('Finished', model.finished, toggleButton()));
    }
    if (!model.running.length && !model.finished.length) root.appendChild(emptyNode());
    else if (!model.showFinished && model.finishedTotal) {
      const section = el('div', 'section finished');
      const head = el('div', 'section-head');
      head.appendChild(el('span', 'title', 'Finished'));
      head.appendChild(el('span', 'count', String(model.finishedTotal)));
      head.appendChild(el('div', 'spacer'));
      head.appendChild(toggleButton());
      section.appendChild(head);
      root.appendChild(section);
    }
  }

  /**
   * Forget which cards were open once their tasks are gone. Kept keys are
   * written back to the host on every toggle, and a set that only ever grows
   * would also silently re-open a card whose id came round again.
   */
  function pruneOpen(next) {
    const tasks = new Set();
    const agents = new Set();
    for (const task of [...next.running, ...next.finished]) {
      tasks.add(task.key);
      for (const agent of task.agents) agents.add(agent.key);
    }
    if (!tasks.size) return; // nothing on screen yet; keep what we have
    let changed = false;
    for (const key of [...expanded]) if (!tasks.has(key)) (expanded.delete(key), (changed = true));
    for (const key of [...openAgents]) if (!agents.has(key)) (openAgents.delete(key), (changed = true));
    if (changed) saveState();
  }

  function apply(next, force) {
    model = next;
    pruneOpen(next);
    const key = layoutKey(next);
    if (force || key !== layout) {
      layout = key;
      rebuild();
      return;
    }
    try {
      for (const task of next.running) patchCard(task);
      for (const task of next.finished) patchCard(task);
    } catch (err) {
      // A failed patch must never freeze the panel: a full render costs a
      // little churn and gets every card back to the current state.
      console.error('[claude-tasks] patch failed, rebuilding', err);
      rebuild();
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'state') apply(message.model, false);
  });

  vscode.postMessage({ type: 'ready' });
})();
