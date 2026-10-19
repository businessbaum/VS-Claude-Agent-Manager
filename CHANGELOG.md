# Changelog

## 0.3.0

**Agent rows open in place.** Clicking an agent in a workflow's table used to
drop you into its raw `.jsonl`. It now expands the row: model, start and
duration, tool breakdown, what it is running right now, and its latest message.
The transcript is still one click away, on the row's own button. Only an open
row is read from its transcript, so a finished run still costs one small JSON
read.

**The figures are the real ones.**

- Token counts were billed several times per message. One assistant message is
  written as several records — the thinking, the text, each tool call — and each
  carries that message's usage as it stood when the record was written. Each
  message is now counted once, at its highest figure.
- A finished task kept only what a tail sample could see: on real transcripts
  that was between 0 % and 48 % of the true total, printed as fact. Finished
  transcripts are now folded whole and cached against their mtime, and the tool
  count a task gathered while running is no longer thrown away when it ends.
- Anything still sampled rather than counted is marked approximate instead of
  being shown as a plain figure.

**Outcomes read correctly.**

- `stopped` was rendered as "unknown" — it now says stopped, as do `cancelled`
  and `error`.
- A run that was killed, cancelled or failed no longer shows every stage green.
  Stages carry `failed` and `stalled` states, and the pipeline stops where it
  stopped.
- Its agents no longer turn forever with no elapsed time: a run that ended
  badly leaves its unfinished agents recorded as still working, and that is now
  read as cut off, with the time they actually got.
- A task with no recorded time at all is reported as "no result" rather than
  spinning for the session.
- The outcome word is on the collapsed row when it is not a success.

**Panel.**

- Cards carry a left accent in their state's colour: blue working, green done,
  red did not finish.
- The line under the title is weighted rather than uniformly grey — the stage a
  run is in and the tool running right now stand out; ids and totals stay quiet.
- The progress bar could never appear on a workflow that grew past one agent
  after its card was built. It is now created when it becomes due, and carries
  its `done/total`.
- The empty state no longer stays on "No Claude session for this folder" after
  a session appears, and the hidden-finished count no longer freezes.
- Stage pills show how many agents belong to them; stage headings count how many
  actually returned.
- Expanded-card state is forgotten once its task is gone, instead of growing
  without bound.

**Host.**

- A watched project directory that is deleted used to spin its watcher at about
  170,000 callbacks a second, pinning a core until the window was reloaded. Dead
  watchers are dropped, and a directory that appears later is now picked up
  instead of being left to polling for the rest of the session.
- An open transcript was re-rendered on every poll, which re-read the file and
  threw away the reader's cursor, selection and scroll position every 1.5
  seconds. It is now re-rendered only when the file has changed.
- `claudeTasks.claudeConfigDir` is declared as a restricted configuration, so an
  untrusted workspace cannot point the extension at an arbitrary directory.

**Workflows.**

- The run's script was only looked for under the session's own project folder,
  while it is filed under the project folder of the workflow's working
  directory. On this machine that missed 4 of 10 real runs, leaving them with no
  stage strip at all. Sibling folders are searched too.
- An empty stage list is no longer cached, so stages appear as soon as the
  script is written rather than staying empty for the whole run.
- Agent names are derived better: across 11 real runs, 146 of 149 agents now get
  a name unique within their stage. A name already taken is not handed out
  twice, and a long line whose only distinguishing part is a path is named after
  the path.

**Reading.**

- A transcript replaced or truncated underneath the reader restarts its totals
  instead of folding the replay into figures it had already counted.
- A start time is found even when the first record is larger than the initial
  read window.
- Tool counters are prototype-free, so a tool named `toString` cannot corrupt
  them.
- Token figures above a million read as `1.5M` rather than `1500k`, and a
  truncated label no longer splits an emoji down the middle.

## 0.2.0

The panel became a webview: status rings, progress bars and card grouping, none
of which a tree view can render. Workflows are tracked as one row with their
agents beneath, with stage inference from start-time gaps and retries folded by
prompt fingerprint.

## 0.1.0

First version, as a tree view.
