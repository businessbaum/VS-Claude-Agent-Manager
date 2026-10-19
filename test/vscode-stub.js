'use strict';

/**
 * Just enough of the `vscode` module to render the tree outside the editor.
 * Installed into the module loader so `require('vscode')` resolves to it.
 */

const Module = require('module');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const l of this.listeners) l(value);
  }
  dispose() {}
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class MarkdownString {
  constructor() {
    this.value = '';
    this.supportThemeIcons = false;
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
  appendCodeblock(code, lang) {
    this.value += `\n\`\`\`${lang || ''}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const Uri = {
  from({ scheme, path, query }) {
    return { scheme, path, query, toString: () => `${scheme}:${path}?${query}` };
  },
  file(p) {
    return { scheme: 'file', path: p, fsPath: p, toString: () => p };
  },
};

const vscode = {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  MarkdownString,
  TreeItem,
  Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), workspaceFolders: [] },
  window: {},
  commands: {},
  languages: {},
  env: {},
};

function install() {
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return original.call(this, request, parent, isMain);
  };
}

module.exports = { install, vscode };
