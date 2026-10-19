'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where Claude Code keeps its state.  The CLI honours CLAUDE_CONFIG_DIR, so we
 * do too, and the user can override it again from settings.
 */
function claudeHome(override) {
  if (override) return override;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

function projectsRoot(override) {
  return path.join(claudeHome(override), 'projects');
}

/**
 * Claude turns a working directory into a project folder name by replacing
 * every character that is not a letter or a digit with a dash:
 *   C:\Users\alice\Desktop  ->  C--Users-alice-Desktop
 * The drive letter keeps whatever case the CLI was launched with, which is why
 * callers match the result case-insensitively.
 */
function encodeProjectPath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Claude project directories belonging to a workspace folder.
 *
 * With `includeNested`, sessions Claude started in a subdirectory of the
 * workspace are included too — otherwise opening the repo root while running
 * Claude inside a package would show an empty panel.  The encoding maps both
 * the path separator and a literal dash to '-', so a sibling folder named
 * `app-other` is indistinguishable from `app/other`; that is the price of
 * catching the nested case, and it is why this can be turned off.
 */
function projectDirsFor(workspacePath, override, includeNested = true) {
  const root = projectsRoot(override);
  const wanted = encodeProjectPath(workspacePath).toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    if (name === wanted) dirs.unshift(path.join(root, entry.name));
    else if (includeNested && name.startsWith(`${wanted}-`)) dirs.push(path.join(root, entry.name));
  }
  return dirs;
}

/**
 * Session transcripts written within maxAgeMs, newest first.
 * Each session is `<sessionId>.jsonl` with an optional `<sessionId>/` sibling
 * directory holding its subagent transcripts.
 */
function recentSessions(projectDir, maxAgeMs) {
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeMs;
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(projectDir, e.name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    const sessionId = e.name.slice(0, -'.jsonl'.length);
    out.push({
      sessionId,
      file,
      mtimeMs: st.mtimeMs,
      subagentsDir: path.join(projectDir, sessionId, 'subagents'),
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Where a backgrounded shell streams its output.  The CLI mirrors the project
 * folder name under the OS temp directory, one level per session.
 */
function shellOutputFile(projectDirName, sessionId, taskId) {
  return path.join(os.tmpdir(), 'claude', projectDirName, sessionId, 'tasks', `${taskId}.output`);
}

module.exports = {
  claudeHome,
  projectsRoot,
  encodeProjectPath,
  projectDirsFor,
  recentSessions,
  shellOutputFile,
};
