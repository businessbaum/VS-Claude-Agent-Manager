'use strict';

/**
 * Runs the store against the real Claude transcripts on this machine and prints
 * what the panel would show.  Usage:  node test/smoke.js [workspacePath ...]
 */

const { TaskStore } = require('../src/store');

// Without arguments, the folder the test is started from.
const DEFAULT_FOLDERS = [process.cwd()];

const folders = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FOLDERS;

const config = {
  sessionMaxAgeHours: 24 * 400,
  includeNestedSessions: true,
  claudeConfigDir: '',
};

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

for (const folder of folders) {
  const store = new TaskStore(() => config);
  store.setFolders([folder]);

  const t0 = process.hrtime.bigint();
  const first = store.refresh();
  const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const t1 = process.hrtime.bigint();
  const second = store.refresh();
  const secondMs = Number(process.hrtime.bigint() - t1) / 1e6;

  console.log('='.repeat(78));
  console.log(folder);
  console.log(
    `  projectDirs=${first.projectDirs.length} sessions=${first.sessionCount} ` +
      `tasks=${first.tasks.length} | cold ${firstMs.toFixed(0)}ms, warm ${secondMs.toFixed(1)}ms`,
  );
  if (second.tasks.length !== first.tasks.length) {
    console.log(`  !! task count changed between refreshes: ${first.tasks.length} -> ${second.tasks.length}`);
  }

  const byStatus = {};
  for (const t of first.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log('  status:', JSON.stringify(byStatus));

  const sorted = [...first.tasks].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const t of sorted.slice(0, 12)) {
    const p = t.progress;
    const dur = t.endedAt && t.startedAt ? fmtDuration(t.endedAt - t.startedAt) : '—';
    const tools = p && p.exact ? `${p.toolCalls} tools` : p ? '~' : 'no transcript';
    const last = p && p.lastTool ? `${p.lastTool.name}(${p.lastTool.detail})` : '';
    console.log(
      `  [${t.status.padEnd(9)}] ${t.kind.padEnd(5)} ${String(t.externalId).padEnd(18)} ` +
        `${dur.padStart(8)}  ${tools.padStart(11)}  ${t.description.slice(0, 42).padEnd(42)} ${last.slice(0, 34)}`,
    );
  }
  if (sorted.length > 12) console.log(`  … ${sorted.length - 12} more`);

  const orphan = first.tasks.filter((t) => !t.externalId);
  if (orphan.length) console.log(`  !! ${orphan.length} task(s) without an external id`);
  const nameless = first.tasks.filter((t) => !t.description);
  if (nameless.length) console.log(`  !! ${nameless.length} task(s) without a description`);
  const nostart = first.tasks.filter((t) => !t.startedAt);
  if (nostart.length) console.log(`  !! ${nostart.length} task(s) without a start time`);
}
