'use strict';

/*
 * Drives media/panel.js against a stub DOM, so the rendering can be checked
 * without VS Code.  Usage:  node test/panel.js
 *
 * The stub implements only what the panel actually uses; querySelectorAll
 * matches class tokens and the one attribute selector the panel relies on.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.title = '';
    this._text = '';
    this.listeners = {};
  }

  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  set innerHTML(html) {
    // Only ever used for the inline icons; one placeholder child is enough.
    this.children = [];
    if (html) this.children.push(new Element('svg'));
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get classList() {
    const self = this;
    const tokens = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(name) {
        if (!tokens().includes(name)) self.className = [...tokens(), name].join(' ');
      },
      remove(name) {
        self.className = tokens().filter((t) => t !== name).join(' ');
      },
      contains: (name) => tokens().includes(name),
      toggle(name, on) {
        if (on) this.add(name);
        else this.remove(name);
      },
    };
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    this._text = '';
    return child;
  }

  replaceChild(next, previous) {
    const at = this.children.indexOf(previous);
    if (at === -1) throw new Error('replaceChild: node is not a child');
    next.parent = this;
    this.children[at] = next;
    return previous;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }

  tokens() {
    return this.className.split(/\s+/).filter(Boolean);
  }

  walk(out = []) {
    for (const child of this.children) {
      out.push(child);
      child.walk(out);
    }
    return out;
  }

  querySelectorAll(selector) {
    const all = this.walk();
    if (selector === '.row .value') {
      return all.filter((n) => n.tokens().includes('value') && n.parent && n.parent.tokens().includes('row'));
    }
    if (selector === '.stage') return all.filter((n) => n.tokens().includes('stage'));
    if (selector === '.agent[data-key]') {
      return all.filter((n) => n.tokens().includes('agent') && n.dataset.key !== undefined);
    }
    throw new Error(`stub does not implement selector ${selector}`);
  }
}

const root = new Element('div');
const document = {
  createElement: (tag) => new Element(tag),
  getElementById: () => root,
};

let onMessage = null;
const window = {
  addEventListener(name, fn) {
    if (name === 'message') onMessage = fn;
  },
};

let state = null;
const posted = [];
const acquireVsCodeApi = () => ({
  postMessage: (m) => posted.push(m),
  setState: (s) => {
    state = s;
  },
  getState: () => state,
});

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
vm.runInNewContext(source, { document, window, acquireVsCodeApi, console, JSON, Date, Math, Set, Map });

check('the panel asks for state on load', posted.map((m) => m.type), ['ready']);

// --- a workflow whose second stage starts while the first is finishing -----
const agent = (id, phase, tokens, time, tone) => ({
  key: `wf1#${id}`,
  label: id,
  tokens,
  time,
  tools: '3',
  activity: '',
  tone,
  phase,
  file: `C:/${id}.jsonl`,
});

const task = (agents, stages, meta) => ({
  key: 'wf1',
  kind: 'workflow',
  status: 'running',
  tone: 'running',
  statusWord: 'running',
  running: true,
  title: 'Shorten every user-facing text',
  meta,
  tooltip: 'tip',
  progress: { done: 1, total: 4 },
  rows: [{ icon: 'workflow', text: 'texte-straffen · wf_1' }],
  stages,
  agents,
  actions: [],
});

const STAGES_ONE = [
  { index: 1, title: 'Umschreiben', detail: '', state: 'running', agents: 2 },
  { index: 2, title: 'Nachlesen', detail: '', state: 'pending', agents: 0 },
];
const STAGES_TWO = [
  { index: 1, title: 'Umschreiben', detail: '', state: 'done', agents: 2 },
  { index: 2, title: 'Nachlesen', detail: '', state: 'running', agents: 2 },
];

const send = (model) => onMessage({ data: { type: 'state', model } });
const model = (tasks) => ({ running: tasks, finished: [], hidden: 0, finishedTotal: 0, showFinished: true, watching: true });

const rowsByKey = () => {
  const map = new Map();
  for (const node of root.querySelectorAll('.agent[data-key]')) map.set(node.dataset.key, node);
  return map;
};
const cells = (key) => {
  const row = rowsByKey().get(key);
  if (!row) return null;
  return { tokens: row.children[2].textContent, time: row.children[3].textContent, tone: row.children[0].className };
};

// Stage one only, card opened.
send(model([task([agent('text:host', 1, '5k', '1m 0s', 'running')], STAGES_ONE, 'Umschreiben 1/2 · 1m')]));
const card = root.walk().find((n) => n.dataset.key === 'wf1');
check('a card is rendered', Boolean(card), true);
card.listeners.click ? null : null;
const head = card.children[0];
head.listeners.click[0]();
check('opening the card shows its agents', rowsByKey().size, 1);
check('the first agent renders', cells('wf1#text:host'), { tokens: '5k', time: '1m 0s', tone: 'status running' });

// Same agents, new numbers — the structure has not changed, so this patches.
send(model([task([agent('text:host', 1, '9k', '1m 30s', 'running')], STAGES_ONE, 'Umschreiben 1/2 · 1m 30s')]));
check('a running agent keeps updating', cells('wf1#text:host'), { tokens: '9k', time: '1m 30s', tone: 'status running' });

// Stage two begins: new rows appear alongside the old ones.
send(
  model([
    task(
      [agent('text:host', 1, '12k', '2m 0s', 'ok'), agent('nachlesen:host', 2, '1k', '50s', 'running')],
      STAGES_TWO,
      'Nachlesen 2/2 · 2m',
    ),
  ]),
);
check('the new stage adds its agent', rowsByKey().size, 2);
check('the finished agent is marked done', cells('wf1#text:host').tone, 'status ok');
check('the new agent renders', cells('wf1#nachlesen:host'), { tokens: '1k', time: '50s', tone: 'status running' });

// The crux: once both stages are on screen, do the new rows still advance?
send(
  model([
    task(
      [agent('text:host', 1, '12k', '2m 0s', 'ok'), agent('nachlesen:host', 2, '3k', '1m 10s', 'running')],
      STAGES_TWO,
      'Nachlesen 2/2 · 2m 20s',
    ),
  ]),
);
check('the second stage keeps updating', cells('wf1#nachlesen:host'), {
  tokens: '3k',
  time: '1m 10s',
  tone: 'status running',
});

send(
  model([
    task(
      [agent('text:host', 1, '12k', '2m 0s', 'ok'), agent('nachlesen:host', 2, '4k', '1m 20s', 'ok')],
      STAGES_TWO,
      'Nachlesen 2/2 · 2m 30s',
    ),
  ]),
);
check('and reaches its finished state', cells('wf1#nachlesen:host').tone, 'status ok');

// A broken patch must degrade to a rebuild, never to a frozen panel. This is
// the failure that froze the second stage: patchDetail threw, and everything
// after it in the update silently stopped.
const broken = task([agent('text:host', 1, '99k', '9m 9s', 'ok')], STAGES_TWO, 'Nachlesen 2/2 · 9m');
let thrown = false;
Object.defineProperty(broken.agents[0], 'tools', {
  get() {
    // Fails the patch pass; the rebuild that follows must get through.
    if (thrown) return '3';
    thrown = true;
    throw new Error('boom');
  },
});
send(model([broken]));
check('a patch error still leaves the values current', cells('wf1#text:host').tokens, '99k');

console.log(failures ? `\n${failures} panel check(s) FAILED` : '\nall panel checks passed');
process.exit(failures ? 1 : 0);
