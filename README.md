<div align="center">

<img src="resources/icon.png" width="72" alt="Claude Background Tasks icon">

# Claude Background Tasks
# NOTE: This Project is outdated and the Function itself was added by Claude
**A panel for VS Code that shows what Claude Code is doing in the background: which agents and commands are running, how far they are and what they returned.**

![VS Code](https://img.shields.io/badge/VS%20Code-1.94%20or%20newer-007ACC?logo=visualstudiocode&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-no%20dependencies-F7DF1E?logo=javascript&logoColor=black)
[![Download](https://img.shields.io/badge/download-latest%20release-2EA44F?logo=github)](https://github.com/businessbaum/VS-Claude-Agent-Manager/releases/latest)

</div>

## Download

You can download the extension file from the [latest release](https://github.com/businessbaum/VS-Claude-Agent-Manager/releases/latest). Install it with this command:

```
code --install-extension claude-tasks-panel-0.3.0.vsix
```

Or open the Extensions view in VS Code, click the three dots at the top and choose "Install from VSIX".

## Why I made it

Claude Code can start agents and long commands in the background. The desktop app shows them in a list, but the VS Code extension doesn't. I often didn't know if something was still running or already finished, so I made this panel.

## What it shows

- **Running:** every background agent, workflow and command that is still working, with the time, the number of tool calls and what it is doing right now.
- **Finished:** what came back, how long it took and if it worked.
- A counter in the status bar, so you see at a glance if something is still running.

You can click on any entry to see more, for example the model, the tokens or the last message.

## How it works

The panel only reads the files Claude Code already writes, like the transcripts of each session and agent. It doesn't change the official extension, so an update of Claude Code can't break it.

Some things were harder than they looked:

- **Reading fast.** Transcripts can be very big. The panel only reads the new part of a file each time. The first read of a 23 MB file takes about 60 ms, every update after that about 1 ms.
- **Counting tokens correctly.** One message is saved as several records, and each one repeats the token count. At first I counted it several times. Now each message is counted once.
- **Guessing the stages of a workflow.** While a workflow runs, nobody writes down which agent belongs to which stage. The panel guesses it from the pauses between start times. I checked it against three finished runs and it matched every time.

## Tests

```bash
node test/lifecycle.js
node test/ui.js
node test/panel.js
```

## License

MIT, see [LICENSE](LICENSE).
