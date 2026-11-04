# wax

**English** · [한국어](./README.ko.md)

[![Public checks](https://github.com/cafein-network/wax/actions/workflows/public.yml/badge.svg)](https://github.com/cafein-network/wax/actions/workflows/public.yml)

**Switch AI coding tools without losing the work.** wax is a plugin that adds a **plan → design → implement → review → report** workflow to Claude Code, Codex, Antigravity CLI, GitHub Copilot CLI, Grok Build and Gemini CLI. Phase documents, completion evidence (tests actually run, linked Git commits) and iteration history are stored in the project's `.wax/`, so a session in any tool picks up the same records.

- Homepage: https://wax.me2shop.com
- Release ZIPs and provenance attestations: [GitHub Releases](https://github.com/cafein-network/wax/releases/latest). Only versions that pass checks on Ubuntu, macOS and Windows with Node 22 and 24 are published.
- This repository contains **only the AGPLv3 distribution**. **History restarted at 0.16.0** (earlier changes are in the [changelog](https://wax.me2shop.com/changelog/), in Korean) and is updated with every release since. The changes in this release are in `RELEASE_NOTES.md` in the distribution.

## Requests and reports

For a new request, choose the execution tool from the ones you have installed: Codex, Claude Code, Gemini CLI, GitHub Copilot CLI or Antigravity CLI. Grok Build does not support automatic execution yet, so use it for team work by naming the skill in a terminal session. The selected CLI's sign-in or API settings apply, along with your account's usage, cost and data policies. A request keeps running with the tool it was saved with; to use a different tool, create a new request. New permission requests from Codex, Claude, Gemini and Copilot are allowed once or denied on screen. Antigravity runs within the scope it already has; if a new permission request is blocked, check the settings in its terminal.

Approval, denial, stopping, resuming and report handling were verified with simulated runs of each official CLI protocol. Full automatic runs with real provider accounts need to be checked separately. Just opening the screen does not run any AI.

## Installation (once)

Node.js 22 or later is required. Run the two lines for each tool you use, and wax is available in every project from then on.

```sh
# Claude Code
claude plugin marketplace add cafein-network/wax
claude plugin install wax@wax

# Codex
codex plugin marketplace add cafein-network/wax
codex plugin add wax@wax

# GitHub Copilot CLI
copilot plugin marketplace add cafein-network/wax
copilot plugin install wax@wax

# Gemini CLI (existing users; individuals should use Antigravity CLI)
gemini extensions install https://github.com/cafein-network/wax
```

**Antigravity CLI** and **Grok Build** use skills linked into the project. Download this repository, then link it once per project. The linker links the same skills into `.agents/skills` (Codex, Antigravity CLI, GitHub Copilot CLI) and `.grok/skills` (Grok Build).

```sh
git clone https://github.com/cafein-network/wax
node wax/scripts/install-project.mjs --project "/path/to/your-project"
```

To install without an internet connection, download the ZIP from the [homepage](https://wax.me2shop.com/#download) and use the extracted folder path in place of `cafein-network/wax` (for example, `claude plugin marketplace add "/path/to/wax"`). See the [installation guide](./INSTALL.md) for details.

### Updating and removing

The public repository was recreated with a new history at 0.16.0. If updating a previously registered marketplace fails, remove the registration and add it again. If you linked a clone of the public repository into a project (Antigravity CLI, Grok Build) and `git pull` fails in that clone, clone it again and re-run `install-project.mjs` ([INSTALL.md](INSTALL.md)).

To check and update every installed tool at once, run `node "/path/to/wax/bin/wax.mjs" update` (`--check` only checks; add `--yes` to also answer the Gemini CLI extension consent). Antigravity CLI and Grok Build use project links, so the folder you run the command in (or `--project <path>`) is checked. When the program (`agy`, `grok`) is installed but that project has no link, it says "installed, wax not linked in this project" and shows the link command. The per-tool commands are below.

| Tool | Update | Remove |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace update wax` → `claude plugin update wax@wax` | `claude plugin uninstall wax@wax` |
| Codex | `codex plugin marketplace upgrade wax` → `codex plugin add wax@wax` | `codex plugin remove wax@wax` |
| GitHub Copilot CLI | `copilot plugin update wax@wax` | `copilot plugin uninstall wax@wax` |
| Gemini CLI | `gemini extensions update wax` | `gemini extensions uninstall wax` |
| Antigravity CLI, Grok Build | Update the linked wax folder (`git pull` or a new ZIP) | Delete the `.agents/skills/wax-*` and `.grok/skills/wax-*` links in the project |

## Usage

The simplest start is `init`. It joins right away with the defaults and opens the dashboard. The dashboard opens on the team channel. Click **＋ New request** to open the Requests & reports screen (`/start`), choose **Project** or **SM · Maintenance**, and enter your goal under **What should we do?**. Project mode drafts a workflow for you to confirm before running it; SM mode takes a maintenance request straight from analysis through the fix, verification and resolution report. Answer questions in the same chat, and change direction by talking. The Stop and Continue buttons control the run.

**Project mode** first lays out the scope, task order, deliverables and acceptance criteria. Review them and click **Start with this workflow** to continue through design, implement, review and report. Send what you want changed and the workflow is rewritten. **SM mode** handles bug and improvement requests for an existing service as intake and analysis → impact check → fix → regression verification → resolution report. The mode is saved per request, and existing requests continue in SM mode.

In the **Start guide** on the Requests & reports screen (`/start`), choose an installed execution tool and enter what to do. Automatic execution starts a separate work session using the selected CLI's sign-in or API settings. No PM is needed. Your account's usage and existing permission settings apply. Viewing the screen or posting an ordinary message in the team channel does not run any AI. Existing terminal sessions of Claude, Codex and other tools and the project's PM stay as they are. Manual assignments and full records are in **Detailed records** (`/manage`).

If joined AI sessions are waiting, expand **Team work with existing AI sessions** on the Requests & reports screen. It shows whether there is a PM, the assignment status and the command to run in each session. Ask the PM session `pm <goal>`, and it checks the current members, creates the task and assigns the first phase right away. Once a goal is given, it does not keep asking about the usual scope and owner choices. In the assigned session, run the displayed `work <task ID>`. Posting a message in the team channel alone does not assign work.

Each tool calls the same commands in its own way.

Codex CLI skill calls start with `$`, as in `$wax:work <task ID>`. In the Codex input, `@` attaches a file; in the wax channel, `@name` notifies the recipient.

| Tool | Example |
| --- | --- |
| Claude Code, Gemini CLI | `/wax:plan login Implement email login` |
| Codex | `$wax:plan login Implement email login` |
| Antigravity CLI | `/plan login Implement email login` |
| GitHub Copilot CLI, Grok Build | "Use the wax plan skill to plan login: email login" (name the skill so it does not collide with the tool's own `/status`, `/plan` and similar commands) |

| Command | What it does |
| --- | --- |
| `init` | Joins right away with the defaults and opens the Requests & reports screen. If there is no PM, the session that ran init becomes PM (skip with `--no-pm`). Name and task options change only when you specify them. |
| `join` | Another AI session joins in a waiting state. Running work is separate; if the same name is active, a number such as `-2` is appended. |
| `plan` · `design` · `implement` · `review` · `report` | Performs that phase and records documents and completion evidence. The phase is not completed if requirements or verification are missing. |
| `status` | Shows the current phase, completion evidence, remaining work and the next command. |
| `iterate` | Records the reason for an improvement and restarts from the implement phase. Earlier records are kept. |
| `chat` · `pm` · `work` · `daily` | Channel conversation, PM task assignment and daily reports so sessions from different tools work as one team. `init` opens the local dashboard. |

One command runs one phase. Actual code changes and tests go through each tool's permission checks.

## Team dashboard

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/your-project dashboard   # http://127.0.0.1:4330/
```

Sessions from every tool appear the same way on one screen. For each session, the team panel shows **the next command in that tool's syntax** (for example, Codex `$wax:work t-1`, GitHub Copilot CLI "Use the wax plan skill to continue login") with a copy button, and when you assign work it previews the command to run in that session. Help lists how to call every command in each tool in one table. The model a session reports (for example, Codex · gpt-5-codex) is shown as well. The dashboard also shows a timeline, PM task assignment, daily reports and a pixel-art virtual office. Click a character to see an HR card (stats and badges) calculated from the project records. The dashboard opens on `127.0.0.1` and runs only the requests the user sends from the Requests & reports screen with the selected CLI. A Claude Code session can use `/wax:chat --watch` to wake up and reply only when an `@name` message arrives.

Rina's tool news checks official public releases once an hour. It shows when and where it checked, and keeps the last data if a check fails. Installed versions are read separately every 10 minutes. Both checks can be rerun immediately with the buttons on Rina's card. To run the dashboard without external lookups, start it with `WAX_TOOL_NEWS=off`.

## Data and security

On the **Execution approval** card in the dashboard and channel, check the request and its paths, then choose **Allow this time only / Deny**. Claude Code connects to the same project's dashboard from sessions started with `WAX_APPROVALS=on`, waits up to 30 seconds, then falls back to console approval. Codex connects from an App Server session started with `node bin/wax.mjs --project /path/to/project approvals codex --prompt "request"`. A standalone Codex console does not connect automatically. See the [approvals guide](./docs/APPROVALS.md) for how to connect and what is supported.

- **Records are stored locally.** Tasks are kept in `.wax/features/`, team conversations and automatic-run requests in `.wax/chat/`, and phase documents in `docs/wax/`. When you send an automatic run, the selected tool sends the request and task context to its account's model service. wax itself collects no usage statistics.
- **Each tool makes its own AI calls.** wax itself does not call any AI API; each tool's sign-in, terms and pricing apply as usual.
- **The dashboard** listens only on `127.0.0.1`, and write requests are checked against a token issued when the page opens.
- **Command execution**: when recording test evidence, wax runs only the command the user specifies, without a shell.
- `.wax/` and `docs/wax/` contain your work, so decide whether to commit them as fits your project. Do not put API keys or passwords in phase documents or messages.

Report security issues as described in [SECURITY.md](./SECURITY.md).

## Running the CLI directly

```sh
node bin/wax.mjs start login --title "Email login"
node bin/wax.mjs status login
node bin/wax.mjs context login --budget 3000
node bin/wax.mjs prompt plan login
node bin/wax.mjs save plan login --file docs/wax/login/plan.md
node bin/wax.mjs complete plan login --evidence "Wrote 4 acceptance criteria and how to verify them"
node bin/wax.mjs test login -- node --test   # implement and review link passing tests or commit evidence
node bin/wax.mjs complete implement login --evidence "Login tests pass" --proofs <evidence ID>
node bin/wax.mjs doctor
```

Set the target directory with `--project /path/to/your-project`. There are no external runtime dependencies, so it works without `npm install`. Help (`--help`), guidance and errors are in English when `WAX_LANG=en`. Without `WAX_LANG`, they are in English when `LC_ALL`, `LC_MESSAGES` or `LANG` starts with `en`; the default is Korean. `--json` output and the instructions given to AI sessions are the same in every language. Full usage is in the [user guide](./docs/USER_GUIDE.en.md) ([한국어](./docs/USER_GUIDE.md)).

`context` shows the current task's goal, status and next action, whiteboard decisions and unanswered questions, test and commit evidence, iteration reasons and document excerpts, with references to the originals. The default length is 3,000 characters; `--budget` counts Unicode characters (1,000–100,000), not tokens. Check the shown/total counts for omissions and read the originals you need. Phase skills and `work` read this context before working. Reading it does not modify files or call any AI, and test results record the code as it was when they ran.

## Development and verification

```sh
npm run check   # check that command and skill files are up to date
npm test        # node --test
npm run test:browser   # check the dashboard, office, design studio, search, threads and run approvals in a real browser
```

`test:browser` uses Playwright and puppeteer-core, which are not runtime dependencies. Point to the installed modules and browser with `WAX_PLAYWRIGHT_MODULE` (playwright's `index.mjs`), `WAX_PUPPETEER_MODULE` (puppeteer-core's `lib/esm/puppeteer/puppeteer-core.js`) and `WAX_CHROMIUM_EXECUTABLE`. It uses only sample records and calls no AI. CI runs these checks with Chromium on pull requests and manual runs.

Public releases run only from a version tag (`vX.Y.Z`). CI checks that the tag matches the current version and, after all operating-system checks and a real Codex installation check pass, publishes the ZIP, checksums and provenance attestation. Ordinary commits only run checks.

## Reference specifications

- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Gemini CLI extensions](https://geminicli.com/docs/extensions/reference/)
- [Antigravity skills](https://antigravity.google/docs/skills)
- [GitHub Copilot CLI plugins](https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins)
- [Grok Build skills and plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces)

## License

Copyright (C) 2026 cafein-network

wax is free software distributed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0-only). Anyone may use, modify and redistribute it at no cost. When you distribute wax or a modified version, you must follow the AGPLv3 source-availability terms. If you offer a modified version over a network, you must let remote users obtain the Corresponding Source of that version (section 13). This program comes with no warranty of any kind (see LICENSE for details).

Developed by cafein-network
