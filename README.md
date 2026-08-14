<p align="center">
  <img src="build/icon.png" width="128" height="128" alt="InfinityClaude logo" />
</p>

<h1 align="center">InfinityClaude</h1>

<p align="center">
  <strong>A desktop AI agent for working on real projects.</strong><br/>
  Reads and edits files, runs terminal commands, searches the web, connects external tools via MCP and works through a free OmniRoute gateway — all in one window.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  <img src="https://img.shields.io/badge/Electron-33-47848F" alt="Electron 33" />
  <img src="https://img.shields.io/badge/Platform-Windows_10%2B-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/free-OmniRoute-8B5CF6" alt="Uses OmniRoute gateway" />
</p>

---

## Table of contents

1. [What is InfinityClaude](#what-is-infinityclaude)
2. [Features](#features)
3. [Requirements](#requirements)
4. [Installation](#installation)
5. [Quick start](#quick-start)
6. [OmniRoute: installing and setting up the gateway](#omniroute-installing-and-setting-up-the-gateway)
7. [Working with the agent](#working-with-the-agent)
8. [MCP servers](#mcp-servers)
9. [Skills](#skills)
10. [Interface and themes](#interface-and-themes)
11. [Configuration](#configuration)
12. [Troubleshooting](#troubleshooting)
13. [For developers](#for-developers)
14. [License](#license)

---

## What is InfinityClaude

InfinityClaude is a desktop chat UI built around **agents with real tools**. Instead of just replying, the model can inspect your project, edit files, execute commands, search the web, and hand work back to you with questions when it is stuck — then keep going until the job is done.

It talks to models through **OmniRoute**, a free gateway that aggregates many OpenAI-compatible providers behind a single local API — no paid API keys required.

> **Heads-up:** image attachments are shown as labeled attachments and are **not** sent to the model for vision analysis. Text files are inserted directly into the message.

## Features

- **Tool-using agent** — file read/write/edit/delete, directory listings, terminal, web search and page reading, and interactive polls (with per-path permission prompts).
- **Workspaces** — each project folder keeps its own chat history in the sidebar.
- **MCP servers** — attach external tools via `npx ...` commands or HTTP URLs: filesystems, databases, a browser, or your own services.
- **Skills** — personal instructions (`SKILL.md`) the model applies automatically when the situation matches their description.
- **Smart routing** — pick `auto` and let the gateway choose a working provider, or select a specific model by hand.
- **Web access** — DuckDuckGo search and page reading right from the chat.
- **Agent loop protection** — max tool rounds and retries on empty replies keep runaway sessions in check.
- **Flexible UI** — light/dark themes, accent colors (terracotta, ocean, forest, violet, gold, mono), density, font size, rounding, message width.
- **Bilingual interface** — English and Russian UI that follows your system language by default, with a separate selectable response language for the model.
- **Onboarding cutscene** — a short animated first-run flow that boots the "agent", lets you pick the interface and reply language, and shows a live demo of how it works.

## Requirements

- Windows 10/11, 64-bit
- [Node.js](https://nodejs.org) 18+ (only needed to run from source)
- A running **OmniRoute** gateway with an authorized provider (default: `http://localhost:20128`)

## Installation

### Installer build

Download `InfinityClaude Setup 1.0.0.exe` from the [Releases](../../releases) page and run it. No extra runtime is required.

### From source

```bash
npm install
npm start
```

Build the installer:

```bash
npm run dist        # creates release/InfinityClaude Setup *.exe
npm run dist:dir    # just the unpacked app in release/win-unpacked
```

## Quick start

1. Launch the app. On the first run a short onboarding walks you through the language setup and a live example.
2. Open **Settings → Connection**, verify the gateway Base URL and enter your OmniRoute API key. Click **"Test connection"**.
3. Click **"Add project folder"** in the sidebar and choose your folder.
4. Ask something like: *"Look at the project structure and tell me what's in it."*

> The first time the agent modifies a file or runs a command, the app asks for permission. You can relax this in **Settings → Agent & approvals**.

## OmniRoute: installing and setting up the gateway

InfinityClaude does not talk to paid APIs directly — it goes through **OmniRoute**, a gateway that aggregates many providers into a single OpenAI-compatible API. Without a running OmniRoute, the chat won't respond.

### Install and start OmniRoute

```bash
npm install -g omniroute
omniroute start
```

It listens on `http://localhost:20128` by default — exactly what InfinityClaude uses out of the box.

### Connect a model (OAuth account)

1. Open the OmniRoute web UI (usually `http://localhost:20128`).
2. Add a provider account (e.g. **Kiro**) and authorize via OAuth.
3. Confirm working models appear in the list (e.g. `kr/claude-sonnet-4.5`).

Once an account is authorized, keep `auto` in InfinityClaude's **Settings → Connection** — routing picks a working provider on its own.

> Stale tokens cause a "Token expired" error — refresh them in the OmniRoute web UI, then hit **"Refresh models"** in InfinityClaude.

### Verify the gateway

In InfinityClaude: **Settings → Connection → "Test connection"**. Success = the model list responds in a few dozen milliseconds.

## Working with the agent

This is an **agent** with tools. It can inspect and change files, run commands, search the web, ask you via polls, and use connected MCP servers on its own.

**How to ask better:**

- Be specific: *"Look at the files in src/ and find where network errors are handled"* beats *"fix bugs"*.
- Split large tasks into a numbered list — the agent will work through them one by one.
- State the expected result, format and constraints up front.
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

## MCP servers

In **Settings → MCP servers** add a server:

- **As a command** — e.g. `npx -y @modelcontextprotocol/server-filesystem C:\Projects`
- **By URL** — e.g. `http://localhost:3001/mcp`

Each enabled server connects automatically and its tools are exposed to the model with the `mcp__server__tool` prefix.

## Skills

Skills are folders with a `SKILL.md` (frontmatter metadata: `name`, `description`). Create one in **Settings → Skills**, enable it, and the model will apply it whenever its description matches. Custom skills live in the app's data folder (`%APPDATA%\InfinityClaude\skills\`).

## Interface and themes

The UI language follows your system by default and can be pinned explicitly (**Settings → System → Interface language**). The model's **response language** is a separate setting, so the interface can be English while the agent answers in Russian (and vice versa).

Visual options: light/dark theme, accent color, density, font size, window rounding, message width, smooth animations, auto-scroll, and code wrapping.

## Configuration

Settings are stored in the app data folder (`%APPDATA%\InfinityClaude\config.json`). Everything is manageable from the UI, but the file can be edited by hand too.

## Troubleshooting

- **Model loops or replies off-topic** — stop it, clarify the task, or switch models.
- **Gateway silent** — check that OmniRoute is running and the account isn't "Token expired".
- **"Token expired"** — reauthorize the provider in the OmniRoute web UI, then refresh models.
- **Model doesn't see tools** — make sure Agent mode is enabled in Settings → Agent.
- **SmartScreen warning on Windows** — the installer is unsigned; click "More info → Run anyway".

## For developers

```
main.js        # main process: window, tools, agent loop
preload.js     # IPC bridge for the renderer
renderer/      # UI (HTML/CSS/JS) + i18n dictionaries
src/           # modules: settings, gateway, workspace, fsx, shell, mcp, skills
build/         # icons and .ico generation
```

Architecture: the renderer talks to the main process over IPC; the agent loop cycles through *model → tools → result* rounds until the task is done. All tool execution (bash, files, web) happens in the main process; the renderer only streams and displays results.

## License

MIT