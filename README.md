<p align="center">
  <img src="build/icon.png" width="120" height="120" alt="InfinityClaude logo" />
</p>

<h1 align="center">InfinityClaude</h1>

<p align="center">
  <strong>A desktop AI agent for working on projects</strong><br/>
  Reads and edits files, runs commands, searches the web, and plugs into external tools via MCP — all in one window.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  <img src="https://img.shields.io/badge/Electron-33-47848F" alt="Electron 33" />
  <img src="https://img.shields.io/badge/Platform-Windows_10%2B-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933" alt="Node.js 18+" />
</p>

---

## Features

- **Agent mode** — the model gets real tools: file operations, terminal, web search, and interactive polls to complete tasks inside your project (with permission prompts).
- **Workspaces** — each project folder keeps its own chat history.
- **MCP servers** — attach external tools via `npx ...` commands or HTTP URLs: filesystems, databases, a browser, or your own services.
- **Skills** — personal instructions (`SKILL.md`) the model applies when the situation matches.
- **Smart routing** — pick `auto` and let the gateway choose a working provider, or select a specific model manually.
- **Web access** — DuckDuckGo search and page reading right from the chat.
- **Flexible settings** — themes, accent colors, animations, Enter behavior, context budgets and more.
- **English & Russian UI** — defaults to Russian, with a selectable response language.

## Requirements

- Windows 10/11, 64-bit
- [Node.js](https://nodejs.org) 18+ (only needed to run from source)
- A running **OmniRoute** gateway with an available API key (default: `http://localhost:20128`)

## Installation

### Installer build

Download `InfinityClaude Setup 1.0.0.exe` from the [Releases](../../releases) page and run it.

### From source

```bash
npm install
npm start
```

Build the installer:

```bash
npm run dist       # creates release/InfinityClaude Setup *.exe
```

## Quick start

1. Launch the app.
2. Open **Settings → Connection**, verify the gateway Base URL and enter your OmniRoute API key. Click **"Test connection"**.
3. Click **"Add project folder"** in the sidebar and choose your folder.
4. Ask something like: *"Look at the project structure and tell me what's in it."*

> The first time you modify a file or run a command, the app will ask for permission. You can enable auto-approval in the settings.

## OmniRoute: installing and setting up the gateway

InfinityClaude does not talk to paid APIs directly — it goes through **OmniRoute**, a gateway that aggregates many providers into a single OpenAI-compatible API. Without a running OmniRoute, the chat won't respond.

### Install OmniRoute

```bash
npm install -g omniroute
```

Start the gateway:

```bash
omniroute start
```

It listens on `http://localhost:20128` by default — that's exactly what InfinityClaude uses out of the box.

### Connect a model (OAuth account)

1. Open the OmniRoute web UI (usually `http://localhost:20128`).
2. Add a provider account (e.g. **Kiro**) and authorize via OAuth.
3. Confirm working models appear in the list (e.g. `kr/claude-sonnet-4.5`).

Once an account is authorized, keep `auto` in InfinityClaude's **Settings → Connection** — routing picks a working provider on its own.

> Stale tokens cause a "Token expired" error — refresh them in the OmniRoute web UI, then hit **"Refresh models"** in InfinityClaude.

### Verify the gateway

In InfinityClaude: **Settings → Connection → "Test connection"**. Success = the model list responds in a few dozen milliseconds.

## Working with the AI: best practices

This is an **agent** with tools. It can inspect and change files, run commands, search the web, ask you via polls, and use connected MCP servers on its own.

**How to ask better:**

- Be specific: *"Look at the files in src/ and find where network errors are handled"* beats *"fix bugs"*.
- One task at a time. If you have several, list them — the agent will break them down.
- State a concrete result (format, style, constraints) up front.
- After major changes, ask for a short summary of what was modified.

**What the agent does on its own:**

- Reads and inspects the project before acting.
- Applies changes through real tools, not guesses — results are always actual.
- Sends a clarifying poll when the task is ambiguous instead of guessing.
- Honestly reports errors and proposes a fix.
- Asks permission before modifying files or running commands (until auto-approval is on).

**Approval modes** (Settings → Agent & approvals):

| Mode | Behavior |
| --- | --- |
| `Ask` | Confirm before every action (safe, default) |
| `Allow reads` | Reads and listings run without prompts; changes still confirm |
| `Allow everything` | All actions run without prompts (only for trusted projects) |

**Troubleshooting:**

- Model loops or replies off-topic → stop it, clarify the task, or switch models.
- Gateway silent → check that OmniRoute is running and the account isn't "Token expired".
- Model doesn't see tools → make sure Agent mode is enabled.

## MCP servers

In **Settings → MCP servers** add a server:

- **As a command** — e.g. `npx -y @modelcontextprotocol/server-filesystem C:\Projects`
- **By URL** — e.g. `http://localhost:3001/mcp`

Each enabled server connects automatically and its tools are exposed to the model with the `mcp__server__tool` prefix.

## Skills

Skills are folders with a `SKILL.md` (frontmatter metadata: `name`, `description`). Create one in **Settings → Skills**, enable it, and the model will apply it whenever its description matches. Custom skills live in the app's data folder (`%APPDATA%\InfinityClaude\skills\`).

## Configuration

Settings are stored in the app data folder (`%APPDATA%\InfinityClaude\config.json`). Everything is manageable from the UI, but the file can be edited by hand too.

## For developers

```
main.js        # main process: window, tools, agent loop
preload.js     # IPC bridge for the renderer
renderer/      # UI (HTML/CSS/JS)
src/           # modules: settings, gateway, workspace, fsx, shell, mcp, skills
build/         # icons and .ico generation
```

Architecture: the renderer talks to the main process over IPC; the agent loop cycles through *model → tools → result* rounds until the task is done.

## License

MIT