'use strict';

const vscode = require('vscode');

const { buildModel } = require('./model');

/** Random per-load value so the CSP can allow exactly our own script. */
function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

class TasksViewProvider {
  /**
   * @param {import('./store').TaskStore} store
   * @param {() => object} readConfig
   * @param {vscode.Uri} extensionUri
   */
  constructor(store, readConfig, extensionUri) {
    this.store = store;
    this.readConfig = readConfig;
    this.extensionUri = extensionUri;
    this.view = null;
    this.snapshot = { tasks: [], sessionCount: 0, projectDirs: [] };
    this.model = { running: [], finished: [], hidden: 0 };
    this.showFinished = readConfig().showFinished;
    this.agentFiles = new Map(); // agent row key -> transcript path
    this.agentIds = new Map(); // agent row key -> agent id
    // Rows the panel has expanded.  The store folds those agents' transcripts
    // even after a run has settled, so the detail has figures to show.
    this.openAgents = new Set();
    this.onAction = () => {};
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message.type !== 'string') return;
      switch (message.type) {
        case 'ready':
          this.post();
          break;
        case 'refresh':
          vscode.commands.executeCommand('claudeTasks.refresh');
          break;
        case 'toggleFinished':
          this.toggleFinished();
          break;
        case 'action':
          this.onAction(message.id, message.key);
          break;
        case 'openAgent':
          this.openAgent(message.key);
          break;
        case 'toggleAgent':
          this.toggleAgent(message.key);
          break;
        default:
          break;
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) this.post();
    });
  }

  html(webview) {
    const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const key = nonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${key}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('panel.css')}" rel="stylesheet">
<title>Claude Agents</title>
</head>
<body>
<div id="root"></div>
<script nonce="${key}" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }

  /** Re-read the transcripts and push the result. @returns {number} running count. */
  update() {
    this.snapshot = this.store.refresh();
    const config = { ...this.readConfig(), showFinished: this.showFinished };
    this.model = buildModel(this.snapshot.tasks, config, Date.now());
    this.model.sessionCount = this.snapshot.sessionCount;
    this.model.watching = this.snapshot.projectDirs.length > 0;

    this.agentFiles.clear();
    this.agentIds.clear();
    for (const task of [...this.model.running, ...this.model.finished]) {
      for (const agent of task.agents) {
        this.agentFiles.set(agent.key, agent.file);
        this.agentIds.set(agent.key, agent.agentId);
      }
    }
    this.syncOpenAgents();

    this.post();
    return this.model.running.length;
  }

  /** Tell the store which agents are worth reading in full this pass. */
  syncOpenAgents() {
    const ids = new Set();
    for (const key of this.openAgents) {
      const id = this.agentIds.get(key);
      if (id) ids.add(id);
    }
    this.store.openAgents = ids;
  }

  toggleAgent(key) {
    if (!key) return;
    if (this.openAgents.has(key)) this.openAgents.delete(key);
    else this.openAgents.add(key);
    this.syncOpenAgents();
    this.update();
  }

  post() {
    if (this.view) this.view.webview.postMessage({ type: 'state', model: this.model });
  }

  toggleFinished() {
    this.showFinished = !this.showFinished;
    this.update();
  }

  async openAgent(key) {
    const file = this.agentFiles.get(key);
    if (!file) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  findTask(key) {
    return this.snapshot.tasks.find((t) => t.key === key) || null;
  }

  setBadge(running) {
    if (!this.view) return;
    this.view.badge = running ? { value: running, tooltip: `${running} running` } : undefined;
  }
}

module.exports = { TasksViewProvider };
