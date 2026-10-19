'use strict';

/**
 * Drives a synthetic session through the whole task lifecycle — launch, live
 * progress, completion — because historical transcripts only ever show the
 * finished state.  Usage:  node test/lifecycle.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskStore, dedupeByExternalId } = require('../src/store');
const { Tailer } = require('../src/tailer');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tasks-test-'));
const workspace = ['C:', 'fake', 'ws'].join(String.fromCharCode(92));
const projectDir = path.join(root, 'projects', 'C--fake-ws');
const sessionId = 'sess-1';
const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
const subagentsDir = path.join(projectDir, sessionId, 'subagents');
fs.mkdirSync(subagentsDir, { recursive: true });
fs.writeFileSync(sessionFile, '');

const AGENT_ID = 'aaa111bbb222ccc33';
const AGENT_TOOL_USE = 'toolu_agent_1';
const SHELL_TOOL_USE = 'toolu_shell_1';
const SHELL_ID = 'bshell123';

const now = () => new Date().toISOString();
const appendJson = (file, record) => fs.appendFileSync(file, `${JSON.stringify(record)}\n`);

const store = new TaskStore(() => ({ sessionMaxAgeHours: 24, includeNestedSessions: true, claudeConfigDir: root }));
store.setFolders([workspace]);

const byId = (result, id) => result.tasks.find((t) => t.externalId === id);

// --- 1. nothing yet -------------------------------------------------------
check('empty session yields no tasks', store.refresh().tasks.length, 0);

// --- 2. agent launched ----------------------------------------------------
appendJson(sessionFile, {
  type: 'assistant',
  timestamp: now(),
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: AGENT_TOOL_USE,
        name: 'Agent',
        input: { description: 'Audit the parser', subagent_type: 'general-purpose', prompt: 'Look at everything.' },
      },
    ],
  },
});
appendJson(sessionFile, {
  type: 'user',
  timestamp: now(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT_TOOL_USE, content: 'launched' }] },
  toolUseResult: {
    isAsync: true,
    status: 'async_launched',
    agentId: AGENT_ID,
    description: 'Audit the parser',
    resolvedModel: 'claude-opus-5',
    prompt: 'Look at everything.',
  },
});
fs.writeFileSync(
  path.join(subagentsDir, `agent-${AGENT_ID}.meta.json`),
  JSON.stringify({ agentType: 'general-purpose', description: 'Audit the parser', toolUseId: AGENT_TOOL_USE, spawnDepth: 1 }),
);
const agentTranscript = path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`);
fs.writeFileSync(agentTranscript, '');

let result = store.refresh();
let agent = byId(result, AGENT_ID);
check('one task after launch', result.tasks.length, 1);
check('agent is running', agent.status, 'running');
check('agent description', agent.description, 'Audit the parser');
check('agent type', agent.agentType, 'general-purpose');
check('agent model', agent.model, 'claude-opus-5');
check('agent is async', agent.isAsync, true);
check('no duplicate task from meta.json', result.tasks.filter((t) => t.kind === 'agent').length, 1);

// --- 3. the agent does some work -----------------------------------------
const agentTurn = (tool, input) => ({
  type: 'assistant',
  isSidechain: true,
  agentId: AGENT_ID,
  timestamp: now(),
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    usage: { output_tokens: 120 },
    content: [{ type: 'tool_use', id: `t${Math.random()}`, name: tool, input }],
  },
});
appendJson(agentTranscript, agentTurn('Read', { file_path: 'C:/x/parser.js' }));
appendJson(agentTranscript, agentTurn('Grep', { pattern: 'TODO' }));

result = store.refresh();
agent = byId(result, AGENT_ID);
check('two tool calls counted', agent.progress.toolCalls, 2);
check('counts are exact', agent.progress.exact, true);
check('last tool is Grep', agent.progress.lastTool.name, 'Grep');
check('last tool detail', agent.progress.lastTool.detail, 'TODO');
check('tokens accumulated', agent.progress.outputTokens, 240);

// --- 4. more work, read incrementally ------------------------------------
appendJson(agentTranscript, agentTurn('Edit', { file_path: 'C:/x/parser.js' }));
appendJson(agentTranscript, {
  type: 'assistant',
  timestamp: now(),
  message: { role: 'assistant', usage: { output_tokens: 60 }, content: [{ type: 'text', text: 'Found three bugs.' }] },
});

result = store.refresh();
agent = byId(result, AGENT_ID);
check('three tool calls counted', agent.progress.toolCalls, 3);
check('tokens keep accumulating', agent.progress.outputTokens, 420); // 3 tool turns at 120 + one 60-token reply
check('last assistant text captured', agent.progress.lastText, 'Found three bugs.');
check('still running before notification', agent.status, 'running');

// --- 5. background shell --------------------------------------------------
appendJson(sessionFile, {
  type: 'assistant',
  timestamp: now(),
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: SHELL_TOOL_USE, name: 'Bash', input: { command: 'npm run dev', description: 'Start dev server', run_in_background: true } },
    ],
  },
});
appendJson(sessionFile, {
  type: 'user',
  timestamp: now(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SHELL_TOOL_USE, content: '' }] },
  toolUseResult: { stdout: '', stderr: '', backgroundTaskId: SHELL_ID },
});

result = store.refresh();
const shell = byId(result, SHELL_ID);
check('shell task appears', Boolean(shell), true);
check('shell is running', shell.status, 'running');
check('shell description', shell.description, 'Start dev server');
check('shell command', shell.command, 'npm run dev');
check('shell output path ends in .output', shell.outputFile.endsWith(`${SHELL_ID}.output`), true);
check('two tasks now', result.tasks.length, 2);

// --- 6. completion notification ------------------------------------------
appendJson(sessionFile, {
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: now(),
  sessionId,
  content: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<status>completed</status>\n<summary>Audited the parser and fixed three bugs.</summary>\n</task-notification>`,
});

result = store.refresh();
agent = byId(result, AGENT_ID);
check('agent completed', agent.status, 'completed');
check('summary captured', agent.summary, 'Audited the parser and fixed three bugs.');
check('end time recorded', typeof agent.endedAt === 'number', true);
check('shell unaffected', byId(result, SHELL_ID).status, 'running');

// --- 7. one notification carrying several ids ----------------------------
appendJson(sessionFile, {
  type: 'user',
  timestamp: now(),
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>${SHELL_ID}</task-id>\n<task-id>ghost999</task-id>\n<status>failed</status>\n<summary>Port already in use.</summary>\n</task-notification>`,
  },
});

result = store.refresh();
check('shell failed', byId(result, SHELL_ID).status, 'failed');
check('unknown id does not invent a task', result.tasks.length, 2);
check('completed agent keeps its status', byId(result, AGENT_ID).status, 'completed');

// --- 8. a half-written line must not be parsed twice or corrupt state ----
const partialFile = path.join(root, 'partial.jsonl');
fs.writeFileSync(partialFile, '{"a":1}\n{"b":');
const tailer = new Tailer(partialFile);
check('partial line withheld', tailer.read(), ['{"a":1}']);
fs.appendFileSync(partialFile, '2}\n');
check('partial line completed on next read', tailer.read(), ['{"b":2}']);
check('nothing new when idle', tailer.read(), []);

// A multi-byte character split across two writes must survive.
const splitFile = path.join(root, 'split.jsonl');
const emDash = Buffer.from('—', 'utf8');
fs.writeFileSync(splitFile, Buffer.concat([Buffer.from('{"t":"a'), emDash.subarray(0, 1)]));
const splitTailer = new Tailer(splitFile);
check('split character withheld', splitTailer.read(), []);
fs.appendFileSync(splitFile, Buffer.concat([emDash.subarray(1), Buffer.from('b"}\n')]));
check('split character reassembled', splitTailer.read(), ['{"t":"a—b"}']);

// --- 9. a stale running task is reported as unknown ----------------------
const oldSessionId = 'sess-old';
const oldFile = path.join(projectDir, `${oldSessionId}.jsonl`);
const oldSubagents = path.join(projectDir, oldSessionId, 'subagents');
fs.mkdirSync(oldSubagents, { recursive: true });
const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
fs.writeFileSync(
  oldFile,
  `${JSON.stringify({
    type: 'user',
    timestamp: longAgo,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: '' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'old111', description: 'Never finished' },
  })}\n`,
);

const staleStore = new TaskStore(() => ({ sessionMaxAgeHours: 24, includeNestedSessions: true, claudeConfigDir: root }));
staleStore.setFolders([workspace]);
const staleResult = staleStore.refresh();
check('abandoned task reported as unknown', byId(staleResult, 'old111').status, 'unknown');

// --- 10. a resumed session must not list the same task twice -------------
const copies = [
  { externalId: 'dup1', startedAt: 1000, endedAt: null, reportedStatus: null, progress: null, note: 'old copy' },
  { externalId: 'dup1', startedAt: 1000, endedAt: 5000, reportedStatus: 'completed', progress: null, note: 'resumed copy' },
  { externalId: null, startedAt: 1000, endedAt: null, reportedStatus: null, progress: null, note: 'unidentified' },
];
const deduped = dedupeByExternalId(copies);
check('duplicate task collapsed', deduped.length, 2);
check('richer copy survives', deduped.find((t) => t.externalId === 'dup1').note, 'resumed copy');
check('task without an id is kept', deduped.some((t) => t.note === 'unidentified'), true);

// --- 11. workflows: launched, live agents, then a finished run state -----
const RUN_ID = 'wf_test123-abc';
const WF_TOOL_USE = 'toolu_wf_1';
const WF_TASK_ID = 'wtask9zz';
const wfDir = path.join(projectDir, sessionId, 'subagents', 'workflows', RUN_ID);
fs.mkdirSync(wfDir, { recursive: true });

appendJson(sessionFile, {
  type: 'user',
  timestamp: now(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: WF_TOOL_USE, content: 'launched' }] },
  toolUseResult: {
    status: 'async_launched',
    taskId: WF_TASK_ID,
    taskType: 'local_workflow',
    workflowName: 'build-everything',
    runId: RUN_ID,
    summary: 'Build the pipeline end to end',
    transcriptDir: wfDir,
  },
});

const WF_A = 'awf00000000000001';
const WF_B = 'awf00000000000002';
const journal = path.join(wfDir, 'journal.jsonl');
const wfPrompt = (task) =>
  `You are building part of a system.
Read the contract first.
YOUR SLICE: ${task}
Report when done.`;
const wfAgentFile = (id) => path.join(wfDir, `agent-${id}.jsonl`);
const startAgent = (id, task) => {
  fs.appendFileSync(journal, `${JSON.stringify({ type: 'started', key: `v2:${id}`, agentId: id })}
`);
  fs.writeFileSync(
    wfAgentFile(id),
    `${JSON.stringify({ type: 'user', agentId: id, timestamp: now(), message: { role: 'user', content: wfPrompt(task) } })}
`,
  );
};
startAgent(WF_A, 'the render core');
startAgent(WF_B, 'the caption lane');
appendJson(wfAgentFile(WF_A), {
  type: 'assistant',
  agentId: WF_A,
  timestamp: now(),
  message: { role: 'assistant', usage: { output_tokens: 90 }, content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'C:/x/render.js' } }] },
});
appendJson(wfAgentFile(WF_B), {
  type: 'assistant',
  agentId: WF_B,
  timestamp: now(),
  message: { role: 'assistant', usage: { output_tokens: 30 }, content: [{ type: 'tool_use', id: 'w2', name: 'Read', input: { file_path: 'C:/x/captions.js' } }] },
});

// The script is written at launch and is the only source of stages while the
// run is live; `meta` is required to be a literal, so it can be read as text.
const scriptsDir = path.join(projectDir, sessionId, 'workflows', 'scripts');
fs.mkdirSync(scriptsDir, { recursive: true });
fs.writeFileSync(
  path.join(scriptsDir, `build-everything-${RUN_ID}.js`),
  [
    'export const meta = {',
    "  name: 'build-everything',",
    "  description: 'Build the pipeline end to end',",
    '  phases: [',
    "    { title: 'Core', detail: 'foundations first' },",
    "    { title: 'Build', detail: 'slices in parallel' },",
    '  ],',
    '}',
    "phase('Core')",
  ].join('\n'),
);

result = store.refresh();
let wf = byId(result, WF_TASK_ID);
check('workflow task appears', Boolean(wf), true);
check(
  'stages read from the script while running',
  wf.progress.stages.map((s) => s.title),
  ['Core', 'Build'],
);
check('both agents land in the first stage', wf.progress.agents.map((a) => a.phaseIndex), [1, 1]);
check('stage one is running', wf.progress.stages[0].state, 'running');
check('stage two is still pending', wf.progress.stages[1].state, 'pending');
check('current stage is the first', wf.progress.currentStage, 1);
check(
  'per-agent tokens are folded live',
  wf.progress.agents.map((a) => a.tokens).sort((x, y) => x - y),
  [30, 90],
);
check('per-agent time is measured', wf.progress.agents.every((a) => a.durationMs >= 0), true);
check('workflow kind', wf.kind, 'workflow');
check('workflow is running', wf.status, 'running');
check('workflow labelled by its goal', wf.description, 'Build the pipeline end to end');
check('workflow name kept', wf.workflowName, 'build-everything');
check('both agents seen', wf.progress.agentsStarted, 2);
check('none finished yet', wf.progress.agentsDone, 0);
check('tool calls summed across agents', wf.progress.toolCalls, 2);
check('tokens summed across agents', wf.progress.outputTokens, 120);
check(
  'labels drop the shared preamble and the lead-in',
  wf.progress.agents.map((a) => a.label).sort(),
  ['the caption lane', 'the render core'],
);

// A start burst well after the others is the next stage beginning.
const WF_C = 'awf00000000000003';
const later = new Date(Date.now() + 5 * 60 * 1000).toISOString();
fs.appendFileSync(journal, `${JSON.stringify({ type: 'started', key: `v2:${WF_C}`, agentId: WF_C })}
`);
fs.writeFileSync(
  wfAgentFile(WF_C),
  `${JSON.stringify({ type: 'user', agentId: WF_C, timestamp: later, message: { role: 'user', content: wfPrompt('the integration test') } })}
`,
);
result = store.refresh();
wf = byId(result, WF_TASK_ID);
check('the late starter opens stage two', wf.progress.agents.find((a) => a.agentId === WF_C).phaseIndex, 2);
check('earlier agents stay in stage one', wf.progress.agents.filter((a) => a.phaseIndex === 1).length, 2);
check('current stage advances', wf.progress.currentStage, 2);
// Stage one still counts as working: neither of its agents has reported, which
// is what an interleaved run looks like. Only their results close it.
check('stage one stays open until its agents report', wf.progress.stages[0].state, 'running');
for (const id of [WF_A, WF_B]) {
  fs.appendFileSync(journal, `${JSON.stringify({ type: 'result', key: `v2:${id}`, agentId: id, result: 'ok' })}\n`);
}
result = store.refresh();
wf = byId(result, WF_TASK_ID);
check('stage one closes once both report', wf.progress.stages[0].state, 'done');
check('stage two is the one working', wf.progress.stages[1].state, 'running');

check('two of three agents finished', wf.progress.agentsDone, 2);
check('three agents in flight', wf.progress.agentsStarted, 3);
check('workflow still running', wf.status, 'running');

// The run state settles the outcome even with no completion notification.
fs.mkdirSync(path.join(projectDir, sessionId, 'workflows'), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, sessionId, 'workflows', `${RUN_ID}.json`),
  JSON.stringify({
    runId: RUN_ID,
    taskId: WF_TASK_ID,
    status: 'completed',
    agentCount: 2,
    totalToolCalls: 44,
    totalTokens: 5000,
    durationMs: 61000,
    startTime: Date.parse(new Date().toISOString()) - 61000,
    timestamp: now(),
    summary: 'Built the pipeline end to end',
    phases: [{ title: 'Core' }, { title: 'Slices' }],
    workflowProgress: [
      { type: 'workflow_agent', index: 1, agentId: WF_A, label: 'core' },
      { type: 'workflow_agent', index: 2, agentId: WF_B, label: 'captions' },
    ],
  }),
);

result = store.refresh();
wf = byId(result, WF_TASK_ID);
check('run state completes the workflow', wf.status, 'completed');
check('finished run takes its stages from the state', wf.progress.stages.map((s) => s.state), ['done', 'done']);
check('authoritative tool count', wf.progress.toolCalls, 44);
check('authoritative token count', wf.progress.outputTokens, 5000);
check('phases picked up', wf.progress.phases.map((p) => p.title), ['Core', 'Slices']);
check('real labels replace the guesses', wf.progress.agents.map((a) => a.label).sort(), ['captions', 'core']);

// --- 11b. a run stopped by a usage limit and then picked up again ---------
// The state file says the run finished, but the journal has moved on since.
const stateFile = path.join(projectDir, sessionId, 'workflows', `${RUN_ID}.json`);
const staleStamp = new Date(Date.now() - 6 * 60 * 60 * 1000);
fs.utimesSync(stateFile, staleStamp, staleStamp);
const WF_RETRY = 'awf00000000000004';
fs.appendFileSync(journal, `${JSON.stringify({ type: 'started', key: `v2:${WF_RETRY}`, agentId: WF_RETRY })}\n`);
// Same prompt as WF_A: this is that agent being run again, not a new one.
fs.writeFileSync(
  wfAgentFile(WF_RETRY),
  `${JSON.stringify({ type: 'user', agentId: WF_RETRY, timestamp: now(), message: { role: 'user', content: wfPrompt('the render core') } })}\n`,
);

result = store.refresh();
wf = byId(result, WF_TASK_ID);
check('a resumed run is detected', wf.progress.resumed, true);
check('and leaves the finished list', wf.status, 'running');
check('its outcome is dropped', wf.summary, '');
check('the stale state no longer settles it', wf.progress.finalStatus, null);
check('a retry does not add an agent', wf.progress.agents.length, 3);
check(
  'it folds into the attempt it replaces',
  wf.progress.agents.find((a) => a.label === 'core').attempts,
  2,
);
check(
  'and keeps that agent’s stage',
  wf.progress.agents.find((a) => a.label === 'core').phaseIndex,
  1,
);
check('unrelated agents stay separate', wf.progress.agents.filter((a) => a.attempts === 1).length, 2);

// A prompt bigger than one read window must still name its agent, and a
// transcript that exists before its prompt is flushed must not freeze the id.
const { titleFromLine, readFirstLine, promptLines } = require('../src/workflow');
check('a heading line becomes the title', titleFromLine('LOSS AVERSION & DRAMA. The strongest force is fear.'), 'LOSS AVERSION & DRAMA');
check('a role lead-in is dropped', titleFromLine('You are researching the Roblox genre as it stands'), 'the Roblox genre as it stands');
check('an assignment lead-in is dropped', titleFromLine('Your job: find mechanics that work'), 'find mechanics that work');
check('a long line survives whole', titleFromLine('find game mechanics that work elsewhere but have not reached this genre yet'), 'find game mechanics that work elsewhere but have not reached this genre yet');

check('a quoted field yields its value', titleFromLine('"name": "LET HIM COOK"'), 'LET HIM COOK');
check('a field with no value is not a name', titleFromLine('"input": {'), '"input"');

// Stage boundaries are the big gaps; the stagger of a pipeline is not one.
const { assignPhases } = require('../src/workflow');
const at = (...offsets) => offsets.map((s, i) => ({ agentId: `x${i}`, startedAt: s * 1000 }));
const placed = (agents, phases) => agents.map((a) => assignPhases(agents, phases).get(a.agentId));
check('two clear waves split in two', placed(at(0, 1, 600, 601), 2), [1, 1, 2, 2]);
check(
  'a staggered wave stays one stage',
  placed(at(0, 1, 613, 615, 615, 986, 999, 1049), 4),
  [1, 1, 2, 2, 2, 3, 3, 3],
);
check('a single wave is one stage', placed(at(0, 1, 2), 3), [1, 1, 1]);
check('one agent needs no split', placed(at(0), 3), [1]);
check('no agents, no placement', assignPhases([], 3).size, 0);

const bigFile = path.join(wfDir, 'agent-abig.jsonl');
const bigPrompt = `UNIQUE SUBJECT. tail\n${'padding line that repeats\n'.repeat(2000)}`;
appendJson(bigFile, { type: 'user', message: { role: 'user', content: bigPrompt } });
check('the record is past the first read window', fs.statSync(bigFile).size > 16 * 1024, true);
check('its lines are still read', promptLines(bigFile).length > 0, true);
check('and the subject survives', titleFromLine(promptLines(bigFile)[0]), 'UNIQUE SUBJECT');

const partial = path.join(wfDir, 'agent-apartial.jsonl');
fs.writeFileSync(partial, '{"type":"user","message":{"role":"user","content":"half written');
check('an unfinished record asks to be re-read', promptLines(partial), null);
check('a missing file asks to be re-read', readFirstLine(path.join(wfDir, 'nope.jsonl'), 1024), null);

// A run found on disk with no launch record must still be listed.
const ORPHAN_RUN = 'wf_orphan-999';
fs.mkdirSync(path.join(projectDir, sessionId, 'subagents', 'workflows', ORPHAN_RUN), { recursive: true });
result = store.refresh();
check('orphan run discovered from disk', result.tasks.some((t) => t.runId === ORPHAN_RUN), true);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nall lifecycle checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
