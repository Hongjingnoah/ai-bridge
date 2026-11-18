# ai-bridge

**Let Claude Code, OpenAI Codex and DeepSeek Harness (DSH) call each other as tools — no copy-pasting between windows.**

> 中文简介：让 Claude、Codex、DeepSeek 三个 AI 助手在本机互相提问、互相派活。程序级调用，不靠模拟键盘鼠标。安装说明见 [setup/INSTALL.md](setup/INSTALL.md)（中文）。

I use three AI assistants on one Windows machine, and I was tired of being the messenger between them: copy a question from one window, paste it into another, copy the answer back. ai-bridge connects them directly. Each assistant can ask another one a question, or hand it a task, through a normal program call and get the real answer back.

```
Claude Code ──claude-ask──► DeepSeek / Codex      (questions or tasks)
DSH         ──codex-bridge-mcp──► Codex           (MCP tools)
Codex       ──dsh-bridge-mcp────► DSH             (MCP tools)
Codex / DSH ──ask-claude────► Claude Code         (questions only)
```

## What it does

| Direction | Entry point | Notes |
|---|---|---|
| Claude → DeepSeek / Codex | `bin/claude-ask.mjs deepseek\|codex\|both` | One-shot question by default. `--task --cwd <dir>` lets the other side write files inside that directory. `--out <file>` saves long answers to a file. |
| DSH → Codex | MCP server `bin/codex-bridge-mcp.mjs` | Tools `codex_ask`, plus `codex_start` / `codex_result` / `codex_cancel` for long jobs. Talks to Codex through its official `app-server` protocol. |
| Codex → DSH | MCP server `bin/dsh-bridge-mcp.mjs` | Tool `dsh_ask`. Runs `dsh headless` and returns the answer, session id and tool-call log. |
| Codex / DSH → Claude | `bin/ask-claude.mjs` | Question and answer only. Claude runs with no tools, so it cannot be told to run commands or edit files. |
| Any → DSH (plain CLI) | `bin/dispatch-dsh.mjs` | For hosts that have not loaded the MCP tools. |

## Safety design

Letting AI agents call each other can go wrong in a few obvious ways. These are handled in code and covered by tests:

- **No infinite loops.** Every call carries a depth counter in `AI_BRIDGE_DEPTH`. Calls stop at depth 2, and the reverse direction stops at depth 1 by default.
- **No shell injection.** The task text is passed as a separate argument to the child process and never goes through `cmd.exe`, so characters like `&` or `|` in a prompt cannot run commands.
- **Timeouts settle once.** A job that times out cannot later be reported as a success because a late "completed" event arrives.
- **Consultation is read-only.** Plain questions run Codex in a read-only sandbox. Only `--task` mode allows writing, and only inside the given directory.
- **Claude cannot be given work** through the reverse channel, only questions.

## Requirements

- Windows 10/11
- Node.js 20+ (the Node runtime bundled with DSH works)
- Whichever assistants you want to connect, installed and logged in:
  - [Claude Code](https://claude.com/claude-code)
  - [OpenAI Codex](https://openai.com/codex) desktop app (includes the CLI)
  - DeepSeek Harness desktop app

## Setup

```powershell
git clone https://github.com/Hongjingnoah/ai-bridge.git
cd ai-bridge
node setup/setup.mjs
```

`setup.mjs` looks for `codex.exe`, `dsh.cmd` and the DSH Node runtime in their default install locations and checks that everything is reachable.

If your programs live somewhere else, copy `local.config.example.json` to `local.config.json` and fill in the paths. Environment variables with the same names (`DSH_CMD`, `BRIDGE_PYTHON`, plus `CODEX_CLI`, `CLAUDE_CLI`, `DSH_NODE`) take priority over the file. `local.config.json` is git-ignored.

Registering the MCP servers with Codex and DSH is described step by step in [setup/INSTALL.md](setup/INSTALL.md).

## Usage

Ask both assistants the same question and compare:

```powershell
echo "Explain the difference between a pointer and an array in C in two sentences." | node bin/claude-ask.mjs both
```

Hand Codex a task that writes files in one folder:

```powershell
node bin/claude-ask.mjs codex --task --cwd D:\my-project --out report.md < task.txt
```

Once the MCP servers are registered, Codex and DSH see the bridge as ordinary tools (`dsh_ask`, `codex_ask`, ...) and use them on their own.

## Tests

```powershell
node --test "test/*.test.mjs"
```

The tests use fake child processes, so they do not call any real model. One test (`async-tools`) needs DSH installed because it loads DSH's MCP client.

## Limitations

- Windows only for now.
- DSH's `headless` mode needs an account-routing overlay so that it uses your logged-in account. `setup.mjs` generates it.
- Some newer DSH builds do not allow logged-in account calls from the command line. In that case point `DSH_CMD` at an older runtime in `local.config.json`.
- Each round trip costs a few seconds (about 5 s for a short question to both assistants on my machine), so it is meant for consultation and delegation, not chatty back-and-forth.

## License

[MIT](LICENSE)
