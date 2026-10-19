'use strict';

/*
 * Checks the view model the webview renders, and prints a text mock of the
 * resulting panel so the layout can be judged without launching VS Code.
 *
 *   node test/ui.js                 # every workspace folder passed, or none
 *   node test/ui.js "C:\\path\\to\\project"
 */

const assert = require('assert');

const { TaskStore } = require('../src/store');
const { buildModel, viewTask, metaOf, detailRows, groupTasks } = require('../src/model');

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       actual   ${JSON.stringify(err.actual)}`);
  }
}

const NOW = 1700000000000;

// --- 1. a running workflow -------------------------------------------------
const workflow = {
  key: 'wf1',
  kind: 'workflow',
  status: 'running',
  description: 'Build the video pipeline end to end',
  workflowName: 'editing-infra-build',
  runId: 'wf_abc-123',
  startedAt: NOW - 5 * 60 * 1000,
  endedAt: null,
  toolUseId: 'toolu_1',
  externalId: 'wuh3amaxo',
  prompt: '',
  progress: {
    exact: true,
    toolCalls: 150,
    toolCounts: { Bash: 98, Edit: 14 },
    outputTokens: 125000,
    agentsStarted: 8,
    agentsDone: 1,
    agentCount: 8,
    phases: [{ title: 'Core' }, { title: 'Build' }],
    lastTool: { name: 'PowerShell', detail: '$sp="C:/Users/alice/AppData/Local/Temp/claude"' },
    lastText: '',
    currentStage: 2,
    stages: [
      { title: 'Core', detail: 'foundations', state: 'done', agents: 1 },
      { title: 'Build', detail: 'slices in parallel', state: 'running', agents: 1 },
      { title: 'Integrate', detail: 'smoke test', state: 'pending', agents: 0 },
    ],
    agents: [
      { agentId: 'a1', label: 'core', file: 'C:/a1.jsonl', done: true, failed: false, toolCalls: 53,
        tokens: 168742, durationMs: 1081575, phaseIndex: 1, lastTool: null },
      { agentId: 'a2', label: 'build:render', file: 'C:/a2.jsonl', done: false, failed: false, toolCalls: 18,
        tokens: 94000, durationMs: 432000, phaseIndex: 2, lastTool: { name: 'Bash' } },
    ],
  },
};

const wf = viewTask(workflow, NOW);
check('title is the goal, not the run id', wf.title, 'Build the video pipeline end to end');
check(
  'the stage leads the line',
  wf.meta,
  'Build 2/3 · 5m 0s · 1/8 agents · 150 tools · PowerShell $sp="C:/Users/alice/AppData/L…',
);
check('meta has no run id', wf.meta.includes('wf_abc-123'), false);
check('meta has no token count', wf.meta.includes('tokens'), false);
check('progress bar reflects agents', wf.progress, { done: 1, total: 8 });
check('tone drives the spinner', wf.tone, 'running');
check('agents are listed for the detail', wf.agents.length, 2);
check('agent carries its transcript', wf.agents[0].file, 'C:/a1.jsonl');
check('agent key is namespaced', wf.agents[0].key, 'wf1#a1');
check(
  'reference data moved into the detail',
  detailRows(workflow).map((r) => r.icon),
  ['workflow', 'clock', 'tools', 'tokens'],
);
check(
  'stages carry their state',
  wf.stages.map((s) => `${s.title}:${s.state}`),
  ['Core:done', 'Build:running', 'Integrate:pending'],
);
check('agent row is name, tokens, time', [wf.agents[0].label, wf.agents[0].tokens, wf.agents[0].time], [
  'core',
  '169k',
  '18m 1s',
]);
check('running agent has a tone of its own', wf.agents[1].tone, 'running');
check('agents keep their stage', wf.agents.map((a) => a.phase), [1, 2]);
check(
  'actions offered',
  wf.actions.map((a) => a.id),
  ['copyId'],
);

// --- 2. a finished shell ---------------------------------------------------
const shell = {
  key: 'sh1',
  kind: 'shell',
  status: 'completed',
  description: 'Render full scene frame sequence',
  command: 'python render.py --scene 4',
  outputFile: 'C:/out.log',
  startedAt: NOW - 48000,
  endedAt: NOW,
  toolUseId: 'toolu_2',
  externalId: 'bash_9',
  summary: 'Rendered 240 frames',
  progress: null,
};

const sh = viewTask(shell, NOW);
check('finished shell keeps its duration', sh.meta, '48s');
check('finished shell has no spinner', sh.tone, 'ok');
check('no progress bar without a total', sh.progress, null);
check(
  'shell offers its output',
  sh.actions.map((a) => a.id),
  ['openShellOutput', 'copyId', 'copyPrompt'],
);
check(
  'command and result are detail, not headline',
  detailRows(shell).map((r) => r.icon),
  ['shell', 'clock', 'outcome'],
);

// --- 3. grouping and hiding ------------------------------------------------
const tasks = [shell, workflow, { ...shell, key: 'sh2', endedAt: NOW - 60000, description: 'Older render' }];
let model = buildModel(tasks, { showFinished: true, finishedLimit: 25 }, NOW);
check('running listed apart', model.running.map((t) => t.key), ['wf1']);
check('finished newest first', model.finished.map((t) => t.key), ['sh1', 'sh2']);

model = buildModel(tasks, { showFinished: false, finishedLimit: 25 }, NOW);
check('hiding finished empties the list', model.finished.length, 0);
check('but the total is still known', model.finishedTotal, 2);

model = buildModel(tasks, { showFinished: true, finishedLimit: 1 }, NOW);
check('limit applies', model.finished.length, 1);
check('overflow is counted', model.hidden, 1);

check('empty input is safe', groupTasks([], { showFinished: true, finishedLimit: 5 }).running, []);
check('unknown status falls back', viewTask({ ...shell, status: 'weird' }, NOW).tone, 'muted');
check('missing progress is safe', metaOf({ ...shell, progress: undefined, startedAt: null }, NOW), '');

// --- 4. text mock of the real panel ---------------------------------------
const folders = process.argv.slice(2);
const store = new TaskStore(() => ({
  sessionMaxAgeHours: 24,
  includeNestedSessions: true,
  finishedLimit: 25,
  claudeConfigDir: '',
}));
store.setFolders(folders);
const snapshot = store.refresh();
const live = buildModel(snapshot.tasks, { showFinished: true, finishedLimit: 25 }, Date.now());

const MARK = { running: '◐', ok: '✓', bad: '✕', muted: '–' };
function bar(progress) {
  if (!progress) return '';
  const width = 16;
  const filled = Math.round((progress.done / progress.total) * width);
  return `\n         [${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${progress.done}/${progress.total}`;
}
const STAGE_MARK = { done: '✓', running: '◐', pending: '·' };
function draw(section, list, deep) {
  if (!list.length) return;
  console.log(`\n  ${section.toUpperCase()}  ${list.length}`);
  for (const task of list) {
    console.log(`   ${MARK[task.tone]}  ${task.title}`);
    if (task.meta) console.log(`      ${task.meta}`);
    const drawn = bar(task.progress);
    if (drawn) console.log(drawn.replace('\n', ''));
    if (!deep) continue;
    if (task.stages.length) {
      console.log(`      ${task.stages.map((s) => `${STAGE_MARK[s.state]} ${s.title}`).join('   ')}`);
    }
    if (task.agents.length) {
      console.log(`      ${'AGENT'.padEnd(30)}${'TOKENS'.padStart(8)}${'TIME'.padStart(10)}`);
      let stage = -1;
      for (const agent of task.agents) {
        if (agent.phase !== stage) {
          stage = agent.phase;
          const title = (task.stages[stage - 1] || {}).title || 'unassigned';
          console.log(`      ${title.toLowerCase()}`);
        }
        console.log(
          `       ${MARK[agent.tone]} ${agent.label.slice(0, 27).padEnd(28)}${agent.tokens.padStart(7)}${agent.time.padStart(10)}`,
        );
      }
    }
  }
}

console.log('\n' + '='.repeat(78));
console.log(`panel preview — ${folders.length ? folders.join(', ') : 'no workspace folder'}`);
draw('running', live.running, true);
draw('finished', live.finished, true);
if (!live.running.length && !live.finished.length) console.log('\n  (nothing to show)');
console.log('='.repeat(78));

console.log(failures ? `\n${failures} ui check(s) failed` : '\nall ui checks passed');
process.exit(failures ? 1 : 0);
