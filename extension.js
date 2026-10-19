'use strict';

const fs = require('fs');
const vscode = require('vscode');

const { TaskStore } = require('./src/store');
const { TasksViewProvider } = require('./src/webview');
const { SCHEME, TranscriptProvider, transcriptUri } = require('./src/transcript');

const DEBOUNCE_MS = 200;
const IDLE_MULTIPLIER = 6;

function readConfig() {
  const c = vscode.workspace.getConfiguration('claudeTasks');
  return {
    sessionMaxAgeHours: c.get('sessionMaxAgeHours', 24),
    includeNestedSessions: c.get('includeNestedSessions', true),
    showFinished: c.get('showFinished', true),
    finishedLimit: c.get('finishedLimit', 25),
    pollIntervalMs: c.get('pollIntervalMs', 1500),
    statusBar: c.get('statusBar', true),
    claudeConfigDir: c.get('claudeConfigDir', ''),
  };
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

/** Context-menu targets and detail-row arguments both carry the task. */
function taskFrom(arg) {
  if (!arg) return null;
  if (arg.task) return arg.task;
  if (arg.kind && arg.key) return arg;
  return null;
}

function activate(context) {
  const store = new TaskStore(readConfig);
  const provider = new TasksViewProvider(store, readConfig, context.extensionUri);
  const transcripts = new TranscriptProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeTasks.view', provider, {
      // Keeps which cards are open when the panel is hidden behind another view.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, transcripts));

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = 'claudeTasks.view.focus';
  statusBar.name = 'Claude Background Tasks';
  context.subscriptions.push(statusBar);

  let watchers = [];
  let pollTimer = null;
  let debounceTimer = null;
  let disposed = false;
  let runningContext = null;

  /**
   * Drives which icon the editor title bar shows. Menu contributions are static,
   * so the idle and running icons are two commands switched by this context key.
   */
  function publishRunningState(running) {
    const isRunning = running > 0;
    if (runningContext === isRunning) return;
    runningContext = isRunning;
    vscode.commands.executeCommand('setContext', 'claudeTasks.running', isRunning);
  }

  function updateStatusBar(running) {
    if (!readConfig().statusBar || running === 0) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(loading~spin) ${running} background ${running === 1 ? 'task' : 'tasks'}`;
    statusBar.tooltip = 'Claude background tasks still running — click to show the panel';
    statusBar.show();
  }

  /**
   * Re-renders an open transcript only once the file behind it has actually
   * changed.  Re-rendering unconditionally replaces the whole document text,
   * which throws away the reader's cursor, selection and scroll position — and
   * on a large session it re-reads megabytes, every poll, forever.
   */
  const transcriptMtimes = new Map(); // uri string -> mtimeMs
  function refreshVisibleTranscripts() {
    const seen = new Set();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri;
      if (uri.scheme !== SCHEME) continue;
      const key = uri.toString();
      seen.add(key);
      const file = new URLSearchParams(uri.query).get('file');
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue; // gone; leave what is on screen rather than blanking it
      }
      if (transcriptMtimes.get(key) === mtimeMs) continue;
      transcriptMtimes.set(key, mtimeMs);
      transcripts.refresh(uri);
    }
    for (const key of [...transcriptMtimes.keys()]) {
      if (!seen.has(key)) transcriptMtimes.delete(key);
    }
  }

  function tick() {
    if (disposed) return;
    syncWatchers();
    let running = 0;
    try {
      running = provider.update();
    } catch (err) {
      console.error('[claude-tasks] refresh failed', err);
    }
    updateStatusBar(running);
    publishRunningState(running);
    provider.setBadge(running);
    refreshVisibleTranscripts();

    clearTimeout(pollTimer);
    const base = Math.max(300, readConfig().pollIntervalMs);
    pollTimer = setTimeout(tick, running > 0 ? base : base * IDLE_MULTIPLIER);
  }

  /** Collapse a burst of filesystem events into one refresh. */
  function bump() {
    if (debounceTimer || disposed) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      tick();
    }, DEBOUNCE_MS);
  }

  function closeWatchers() {
    for (const entry of watchers) {
      try {
        entry.watcher.close();
      } catch {
        /* already closed */
      }
    }
    watchers = [];
  }

  function drop(entry) {
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
    watchers = watchers.filter((w) => w !== entry);
  }

  /**
   * Brings the set of watchers in line with the directories we care about.
   *
   * Idempotent, and called on every pass, because both ends of the set move:
   *
   * A directory deleted while it is being watched does not end the watch — on
   * Windows the handle keeps firing, and a recursive watcher spins at roughly
   * 170,000 callbacks a second, pinning a core until something closes it. So a
   * watcher is dropped as soon as its directory is gone, or on its first error.
   *
   * A directory that did not exist yet is simply retried later, which is how a
   * session Claude starts after the window opened ever gets watched at all.
   */
  function syncWatchers() {
    const wanted = store.resolveProjectDirs();
    for (const entry of [...watchers]) {
      if (!wanted.includes(entry.dir) || !fs.existsSync(entry.dir)) drop(entry);
    }
    for (const dir of wanted) {
      if (watchers.some((w) => w.dir === dir)) continue;
      let watcher;
      try {
        watcher = fs.watch(dir, { recursive: true, persistent: false }, bump);
      } catch {
        continue; // polling covers us; try again next pass
      }
      const entry = { dir, watcher };
      watcher.on('error', () => drop(entry));
      watchers.push(entry);
    }
  }

  function resync() {
    store.setFolders(workspaceFolders());
    closeWatchers();
    tick();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(resync),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeTasks')) return;
      if (e.affectsConfiguration('claudeTasks.showFinished')) provider.showFinished = readConfig().showFinished;
      resync();
    }),
  );

  const openTranscript = async (arg) => {
    const task = taskFrom(arg);
    if (!task) return;
    if (task.kind === 'shell') return vscode.commands.executeCommand('claudeTasks.openShellOutput', arg);
    if (!task.transcriptFile || !fs.existsSync(task.transcriptFile)) {
      vscode.window.showInformationMessage('This agent has not written a transcript yet.');
      return;
    }
    // The virtual URI ends in .md, so the language is inferred from the path.
    const doc = await vscode.workspace.openTextDocument(transcriptUri(task));
    await vscode.window.showTextDocument(doc, { preview: true });
  };

  const openRaw = async (arg) => {
    const task = taskFrom(arg);
    if (!task) return;
    const file = task.kind === 'agent' && task.transcriptFile ? task.transcriptFile : task.sessionFile;
    if (!file || !fs.existsSync(file)) {
      vscode.window.showInformationMessage('No transcript file on disk for this task.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: true });
  };

  const openShellOutput = async (arg) => {
    const task = taskFrom(arg);
    if (!task) return;
    if (!task.outputFile || !fs.existsSync(task.outputFile)) {
      vscode.window.showInformationMessage('No output file for this background shell (it may have been cleaned up).');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(task.outputFile));
    await vscode.window.showTextDocument(doc, { preview: true });
  };

  const copy = (field, label) => async (arg) => {
    const task = taskFrom(arg);
    if (!task) return;
    const value = field === 'prompt' ? task.prompt || task.command : task.externalId || task.toolUseId;
    if (!value) {
      vscode.window.showInformationMessage(`Nothing to copy for this task.`);
      return;
    }
    await vscode.env.clipboard.writeText(value);
    vscode.window.setStatusBarMessage(`${label} copied`, 2000);
  };

  // Revealing the view also opens the secondary sidebar when it is closed.
  const showPanel = () => vscode.commands.executeCommand('claudeTasks.view.focus');

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTasks.show', showPanel),
    vscode.commands.registerCommand('claudeTasks.showRunning', showPanel),
    vscode.commands.registerCommand('claudeTasks.refresh', tick),
    vscode.commands.registerCommand('claudeTasks.toggleFinished', () => provider.toggleFinished()),
    vscode.commands.registerCommand('claudeTasks.openTranscript', openTranscript),
    vscode.commands.registerCommand('claudeTasks.openRaw', openRaw),
    vscode.commands.registerCommand('claudeTasks.openShellOutput', openShellOutput),
    vscode.commands.registerCommand('claudeTasks.copyPrompt', copy('prompt', 'Prompt')),
    vscode.commands.registerCommand('claudeTasks.copyId', copy('id', 'Task id')),
  );

  provider.onAction = (id, key) => {
    const task = provider.findTask(key);
    if (task) vscode.commands.executeCommand(`claudeTasks.${id}`, task);
  };

  context.subscriptions.push({
    dispose() {
      disposed = true;
      clearTimeout(pollTimer);
      clearTimeout(debounceTimer);
      closeWatchers();
    },
  });

  resync();
}

function deactivate() {}

module.exports = { activate, deactivate };
