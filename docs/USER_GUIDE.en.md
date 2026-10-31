# wax User Guide

wax splits each feature into **plan → design → implement → review → report** and keeps the documents and completion evidence in your project.

This guide describes wax 0.14.0. Check the installed version with `node bin/wax.mjs --version` in the plugin folder. What changed in each version is in `CHANGELOG.md` in the release and on the [changelog](https://wax.me2shop.com/changelog/) page (in Korean).

There are two ways to work. Run the stage commands one by one in an AI session in your terminal (sections 3 and 4; other tools in section 5), or send a one-line request from the dashboard and let the chosen tool carry it through (section 6-3). Either way the records go to the same `.wax/`.

## Contents

- [1. What do I need?](#1-what-do-i-need)
- [2. Getting the code](#2-getting-the-code)
- [3. Starting your first task in Claude Code](#3-starting-your-first-task-in-claude-code)
- [4. Moving through the stages](#4-moving-through-the-stages)
- [5. Using Gemini CLI (existing users)](#5-using-gemini-cli-existing-users)
- [5-1. Using Codex](#5-1-using-codex)
- [5-2. Using Antigravity CLI](#5-2-using-antigravity-cli)
- [5-3. Using GitHub Copilot CLI](#5-3-using-github-copilot-cli)
- [5-4. Using Grok Build](#5-4-using-grok-build)
- [6. Team dashboard: AI sessions working together and daily reports](#6-team-dashboard-ai-sessions-working-together-and-daily-reports)
- [6-1. Searching records](#6-1-searching-records)
- [6-2. MCP server (experimental)](#6-2-mcp-server-experimental)
- [6-3. One-line requests that run on their own](#6-3-one-line-requests-that-run-on-their-own)
- [6-4. Execution approvals](#6-4-execution-approvals)
- [6-5. Triggers: request proposals from schedules, local calls, GitHub issues and CI failures](#6-5-triggers-request-proposals-from-schedules-local-calls-github-issues-and-ci-failures)
- [6-6. PM loop: next-step suggestions per goal and auto mode](#6-6-pm-loop-next-step-suggestions-per-goal-and-auto-mode)
- [6-7. Project rules and wiki](#6-7-project-rules-and-wiki)
- [6-8. Project types and the B1 design studio](#6-8-project-types-and-the-b1-design-studio)
- [7. Where things are stored and resuming](#7-where-things-are-stored-and-resuming)
- [8. Troubleshooting](#8-troubleshooting)
- [9. Updating and what has been verified](#9-updating-and-what-has-been-verified)

## 1. What do I need?

Node.js 22 or later and one signed-in Claude Code, Codex, Antigravity CLI, GitHub Copilot CLI, Grok Build or Gemini CLI. Install wax from the public repository [cafein-network/wax](https://github.com/cafein-network/wax) through each tool's marketplace, or download the ZIP from the [wax site](https://wax.me2shop.com/#download). The release includes the plugin source, tests and this guide. The wax code is licensed under AGPL-3.0 (free to use, change and share; distributions must offer the source, and if you provide a modified version over a network, remote users must be able to get its corresponding source). Usage fees and limits of AI tools and APIs are separate.

**0.14.0 public repository note.** From 0.14.0 the public repository `cafein-network/wax` was recreated with a fresh history. The install address is the same. If updating a marketplace registered with 0.13.x or earlier fails because the history does not match, remove the `wax` marketplace registration in that tool and register it again (section 9, and "업데이트 및 직접 개선" in INSTALL.md). Leave `.wax` and `docs/wax` in your projects as they are. GitHub release ZIPs and provenance attestations for 0.13.x and earlier are no longer offered; the change history remains in `CHANGELOG.md` and on the [changelog](https://wax.me2shop.com/changelog/) page.

## 2. Getting the code

Unzip the archive with **Extract all**, then find the `wax` folder that contains `package.json` and `bin/wax.mjs`. It must also contain the hidden `.claude-plugin` folder. The plugin runs without `npm install`.

See `INSTALL.md` in the ZIP for Windows and WSL examples and updating. In this guide `/path/to/wax` is an example path; always replace it with the real absolute path where you extracted the plugin.

In the examples below, replace `/path/to/my-app` with **the project directory you actually code in**. That directory must already exist. Keep the plugin source directory and your project apart.

## 3. Starting your first task in Claude Code

Load the wax plugin in your project. This applies to that Claude session, so use the same option whenever you open a new session.

```sh
cd /path/to/my-app
claude --plugin-dir "/path/to/wax"
```

On another computer, change the path after `--plugin-dir` to its real location too. No npm install is needed.

To avoid adding `--plugin-dir` every time, install once: `claude plugin marketplace add "/path/to/wax"`, then `claude plugin install wax@wax`. The extracted folder is itself the marketplace, and Codex (`codex plugin marketplace add` → `codex plugin add wax@wax`) and GitHub Copilot CLI (`copilot plugin marketplace add` → `copilot plugin install wax@wax`) install once from the same folder. For updating and removing, see "Install once" in INSTALL.md.

At first, run the start command once in the Claude chat.

```text
/wax:init
```

It joins with a default name and opens the dashboard without setup questions. If exactly one task is in progress it picks that task, otherwise none. If the project has no PM, the init session becomes the PM (skip with `--no-pm`); an existing PM is kept. Name, task and PM options you pass are applied as given. When it finishes, the session has joined the team channel, appears as a character in the virtual office, and shows how other AI sessions join (`/wax:join`). init and join join in the idle state and switch to working when real stage work starts. Run `/wax:init` again later to reopen the dashboard.

Automatic runs are requested in one line on the dashboard's Requests & reports screen (`/start`, section 6-3). To manage each stage yourself from the terminal, request a feature like this:

```text
/wax:plan email-login Build sign-in with email and password
```

wax reads the existing code and sets out requirements, scope and acceptance criteria. Answer the questions that need a decision, then check the result. One command performs that stage only; it does not run every following stage at once.

## 4. Moving through the stages

| Command | What it does |
| --- | --- |
| `/wax:init` | Get started: join the team channel, choose a task, open the dashboard and set the PM in one step |
| `/wax:join` | Join another AI session to the team channel (sets only its name and task) |
| `/wax:plan email-login …` | Set out the problem, scope and acceptance criteria for a new feature |
| `/wax:design email-login` | Design the structure, data, files to change and how to verify |
| `/wax:implement email-login` | Change the real code with the host's tools and run the related checks |
| `/wax:review email-login` | Compare the design with the actual result and record test evidence and unverified items |
| `/wax:report email-login` | Summarize results, verification, usage and remaining work |
| `/wax:status email-login` | Check the current stage and completion evidence |
| `/wax:iterate email-login Handle expired tokens` | Archive the previous cycle and go back to implementation |

For example, after the first plan, run each of these once:

```text
/wax:design email-login
/wax:implement email-login
/wax:review email-login
/wax:report email-login
```

The next stage opens only when the current stage has its document and completion evidence. Implement must link a passing test (`wax test`) or commit (`wax evidence`) proof, and review must link a passing test proof together with a confirmed pass. When there is no runnable check, such as a documentation-only change, complete with `--no-proof <reason>`; the reason stays in the completion record and in the handoff context other tools read. Besides the acceptance-criteria table, review checks in the order structure → function → efficiency → presentation: role flows and permissions (blocked on the server, not just hidden on screen), confirm, cancel or edit paths for actions that cannot be undone, numbers and totals against the source data, search and speed with a realistic amount of data, and loading, error and empty screens, marking anything that does not apply as not applicable with a reason. Each finding also says who is affected and why. If problems or unverified criteria remain, review does not complete and tells you why.

A feature ID starts with a lowercase letter or digit and contains only lowercase letters, digits and hyphens, 1–64 characters. Use names like `email-login`, `dashboard` or `payment-v2`.

### Improvement cycles (iterate)

If review finds problems, improve it like this:

```text
/wax:iterate email-login Reject expired auth tokens
/wax:implement email-login
/wax:review email-login
/wax:report email-login
```

### Acceptance-criteria trace

The plan writes one acceptance criterion per line with its ID at the start of the line, such as `- AC-1: <criterion> — check: <method>` (only `AC-<number>` at the start of a line counts as an ID; mentions in the middle of a sentence are not declarations). When the plan declares AC IDs, completing review needs one `{"id": "ac-1", "status": "pass", "detail": "<what was checked>", "proofIds": ["<proof ID>"]}` item per ID in the `--checks-file` JSON array. A `pass` counts only with a passing test or commit proof from the current iteration; if any criterion is missing, `unverified` or without proof, review does not complete. Only for a criterion that truly cannot be verified, complete with `--ac-unverified <reason>`; any `fail` is refused regardless of a reason, so fix it with `wax iterate`. The trace (AC → status → proofs) appears in `acceptanceTrace` of `wax status <id>`, in `wax context <id>` and in the report-stage prompt. Plans without AC IDs work exactly as before.

### Reviewer separation

`wax complete ... --author <name>` records the session that completed a stage in the completion record (`completed`) and history. When the session that completed implement, or recorded this cycle's implement proofs (`wax test`/`wax evidence --author`), also completes review, the default (`WAX_REVIEW_SEPARATION=warn`) completes it with a warning. The warning appears in the CLI error output (`wax: 경고: …`, or `wax: warning: …` in English), the completion record's `warning`, the stage-completed entry on the dashboard timeline, the auto-run request conversation and the handoff context. Sessions and dashboards started with `WAX_REVIEW_SEPARATION=enforce` reject a review completed by the implementing session or without `--author` (dashboard auto-run uses one session for every stage, so it stops at review). `off` skips the check. To apply it to the whole team, start every session and the dashboard with the same setting. Names are self-reported by sessions, so this guards against mistakes rather than acting as a security boundary. Older records have no completing session and still load and import as before.

### Evidence freshness

`wax test` and `wax evidence` store a working-tree fingerprint (`tree`) with each proof: the HEAD commit plus the Git blob ID of every file that differs from HEAD or is untracked and not ignored (`.wax/` is left out). Afterwards `wax context` marks each proof with "N files changed since" and puts the files changed since the current cycle's review proof (or implement proof when there is none) in its header; `wax status <id>` reports the same as `evidenceFreshness`, and the report-phase prompt (`wax prompt report` and dashboard auto-run) says "N files changed since the review proof: …". Dashboard evidence cards show "N files changed since" with the file list on hover. This is an observation, not a verdict, and never blocks a phase; rerun the tests when the changed files matter to the proof. When more than 200 files are changed or untracked, they total more than 64 MB, or a Git command takes longer than 5 seconds, the fingerprint is recorded as unknown instead of stalling. Projects without Git and proofs from before this feature have no fingerprint and show "unknown"; they still load, back up and restore as before.

### Handing over a task

When a new session picks up an existing task, first read the handover context with:

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/my-app context login --budget 3000
```

`login` is the existing task ID. The output shows the goal, the current stage and next action, whiteboard decisions and questions without an answer or decision, execution evidence, improvement reasons and excerpts from stage documents. Each item carries a `.wax/features/<id>.json#/...` or `.wax/chat/board/<id>.jsonl#<note ID>` reference so you can open the source. Stage skills and `work` also tell the AI to read this before starting.

`--budget` counts Unicode characters, not tokens. The default is 3,000 and the range is 1,000–100,000. The shown/total counts and `…` at the end mark omitted items and longer originals. The output is a rule-based excerpt, so also check the latest `status`, the full stage `prompt` and any source you need. Questions are limited to that task's board, and a linked answer does not guarantee the problem is solved. Damaged board records are counted as excluded, and unsafe storage paths or damaged task files are reported as errors.

Reading this is read-only and never calls an external AI. Tests from earlier cycles are kept apart from tests in the current cycle, and each shows the commit and working-tree state at the time it ran. A recorded pass does not guarantee the current code passes, so run the tests again after changes.

### Time per stage and the run trace

wax computes the time each stage took from the task history: the real elapsed time from entering a stage until completing it, with the time spent on a revisit after an improvement cycle added to the same stage. Each task under **Task progress** on the dashboard shows the time per stage and the total, and the stage in progress shows as "12 min so far". `wax status <id>` JSON includes it as `durations`. Time while archived and the gap between a backup and its restore are not counted, and older records with missing or backward timestamps are skipped. Cost and tokens are left out because no record ties them to a task stage.

For each stage visit, see when it happened, which session and tool did it, on what evidence and what changed with `wax trace <id>` (Markdown) or `wax trace <id> --json`, or in the run trace panel on the dashboard (section 6, "Checking records on the dashboard"). Both are read-only and call no AI.

### Screen captures and design comparison

Work with a screen keeps captures as evidence. `wax capture <task-id> --check <check-id> --file <file> [-- <capture command>]` stores the capture in `.wax/artifacts/`, and each capture can carry labels for the conditions it was taken under.

- `--viewport <width>x<height>`: screen size (e.g. `1280x800`, each 16384 or less)
- `--scroll top|bottom|<pixels>`: scroll position
- `--state <name>`: screen state, a name of up to 32 characters starting with a lowercase letter (e.g. `default`, `hover`, `focus`, `open`, `loading`, `error`, `empty`)

For web projects (section 6-8) the design and review guidance captures each state at 360, 768 and 1280 and at 1920, wider than the design, and asks what caused each change: scrolling, a click, hover or time. The labels also show in the PR description draft, `wax trace` and the dashboard's run trace panel.

`wax compare <task-id> [--json]` pairs each review capture (`ui-review`) with the design capture (`design-preview`) that has the same width, scroll and state. The baseline is only design captures taken in this project. The latest capture per label is used, and the baseline comes from the latest design iteration at or before the reviewed one. Captures without a partner (no baseline, baseline not re-captured) and older unlabeled captures are listed separately instead of paired, and design-studio handoff previews show as unlabeled references. When the two PNGs have the same size, the share of differing pixels is shown as an observation, not a match verdict; when the sizes differ, it only says so. The last review visit in the dashboard's run trace panel shows the two captures side by side (stacked at phone width), and the PR description draft carries a summary. It is read-only and calls no AI. The review guidance captures with the same labels as the design captures, reads `wax compare` and writes down the remaining differences instead of hiding them.

### PR description draft

`wax pr-body <task-id> [--out <file>] [--json]` builds a Markdown PR description draft from the task records alone: a suggested PR title, the task stage and iteration, the saved report document, the acceptance-criteria table, the current iteration's test and commit proofs and screen captures, the design comparison summary, the reasons for stages completed without proof, and evidence freshness. Missing records are reported as missing, never made up. `@name` in the records is turned into code so GitHub sends no notification. It writes only to standard output or the `--out` file (an existing file is overwritten; directories and symbolic links are refused), calls neither `gh` nor the network, and never creates a PR.

After report completes, the report guidance offers to make this draft and runs `gh pr create --draft --body-file <file>` only when the user approves. Creating, pushing and merging a PR is always a person's call. The PM loop (section 6-6) likewise only offers a draft file card for tasks that finished report and leaves the PR decision to a person.

## 5. Using Gemini CLI (existing users)

Individuals are directed to Antigravity CLI (section 5-2), following Google's guidance. This section is for people who keep using Gemini CLI with API authentication or a business license.

**Authentication notice (checked 2026-10-20):** Gemini CLI access through personal Google sign-in ended on 2026-06-18, including free access and Google AI Pro and Ultra. Continued use requires supported API authentication or an existing Gemini Code Assist Standard or Enterprise license. Google's transition announcement specifies paid API key access and directs individuals to Antigravity CLI. New Standard and Enterprise subscriptions also stopped on 2026-10-09; existing subscriptions follow their contracts and a separate retirement schedule. Installing wax does not grant AI access. [Consumer retirement](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) · [API access and Antigravity transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [Business subscription schedule](https://docs.cloud.google.com/gemini/docs/codeassist/sunset)

Link the extension once.

```sh
gemini extensions link "/path/to/wax"
cd /path/to/my-app
gemini
```

In a new Gemini session, use the same commands as in Claude. Start with `/wax:init`, then run `/wax:plan`, `/wax:design` and so on. Restart the session after linking the extension or changing command files. This project checks the Gemini TOML syntax, but running inside a real Gemini host has not been verified yet.

Check the installed version with `node bin/wax.mjs --version` in the plugin folder.

## 5-1. Using Codex

Register the public marketplace and install once in your terminal. The Codex catalog is `.agents/plugins/marketplace.json`, also included in the ZIP.

```sh
codex plugin marketplace add cafein-network/wax
codex plugin add wax@wax
```

If you see `already added from a different source`, inspect the old ZIP path or Git URL with `codex plugin marketplace list`. To switch to the public repository, run the following commands one at a time and only continue after each succeeds. Removing the marketplace registration does not delete your project's source files or `.wax` records.

```sh
codex plugin marketplace remove wax
codex plugin marketplace add cafein-network/wax
codex plugin add wax@wax
```

If the source already points to the public GitHub repository but you see `plugin wax was not found in marketplace wax`, refresh with `codex plugin marketplace upgrade wax`, check for `wax@wax` with `codex plugin list --marketplace wax --available --json`, then install again. For a ZIP source, extract the new ZIP to the same path. If the plugin is still absent, collect `codex --version`, the marketplace list and the plugin list for diagnosis. Start a new Codex session after installation.

To connect only a specific project, use the project linker below. Antigravity CLI (section 5-2) and Grok Build (section 5-4) use the same linker. Keep the extracted plugin in the same place afterwards.

```sh
node "/path/to/wax/scripts/install-project.mjs" --project "/path/to/my-app"
node "/path/to/wax/scripts/install-project.mjs" --project "/path/to/my-app" --check
cd /path/to/my-app
codex
```

Find the 13 skills under `/skills` in Codex and use them in the chat. `$` calls a skill and `@` attaches a file. Run an assigned task with `$wax:work <task ID>`; don't confuse it with `@name` mentions in the wax team channel. The examples below are not shell commands.

```text
$wax:init
$wax:plan email-login Implement email sign-in
$wax:design email-login
$wax:implement email-login
$wax:review email-login
$wax:report email-login
$wax:status email-login
$wax:iterate email-login Handle expired tokens
```

The linker links the same original skills into the project's `.agents/skills/wax-*` (Codex, Antigravity CLI, GitHub Copilot CLI) and `.grok/skills/wax-*` (Grok Build). If another skill with the same name exists in either location, it stops without writing anywhere. It never overwrites other skills or tool settings, and running it again is safe. `scripts/install-codex.mjs`, documented up to 0.13.4, runs the same linker. Windows uses directory junctions; Linux and WSL use symbolic links. If the plugin path changes, the check fails, so look at the existing links and connect again. Restart Codex if new skills don't appear.

Stage documents, completion evidence and `.wax/features` records are shared with the other hosts. Codex uses its own sign-in and tool permissions.

## 5-2. Using Antigravity CLI

Antigravity CLI (`agy`) reads skills from the project's `.agents/skills`, so use the project linker from section 5-1 as is. If you already connected it for Codex, nothing else is needed. Gemini CLI users who signed in with a personal Google account can move over this way.

```sh
node "/path/to/wax/scripts/install-project.mjs" --project "/path/to/my-app" --check
cd /path/to/my-app
agy
```

Check the 13 skills under `/skills` in a new session. Antigravity CLI turns skills into slash commands, so call them by skill name, like `/plan email-login Implement email sign-in` or `/design email-login`. The names shown follow the `/skills` list; if a name clashes, ask in words, e.g. "run the wax plan stage". If the start command `/init` clashes with Antigravity CLI's own command, ask "start with the wax init skill".

`agy plugin install` and `agy plugin import gemini` copy or convert files to another place, so the skills may not find the CLI they ship with. Use the project link instead. Running in a real Antigravity CLI session has not been verified yet.

## 5-3. Using GitHub Copilot CLI

Install into GitHub Copilot CLI (`copilot`) once. It is the terminal tool used with a GitHub Copilot subscription, not Microsoft Copilot. Register the extracted wax folder as a local marketplace and the wax skills work in every project.

```sh
copilot plugin marketplace add "/path/to/wax"
copilot plugin install wax@wax
```

A local marketplace reads the folder directly instead of copying it, so replacing the folder contents at the same path applies a new version from the next session. Start with "start with the wax init skill". Ask for skills by name, like "use the wax plan skill to plan email sign-in for email-login" or "use the wax design skill to design email-login", because names such as `/status` clash with GitHub Copilot CLI's own commands. In the team channel the session kind is `copilot` and the default name is `copilot-<folder name>`.

This does not conflict with a project that also has `.agents/skills` linked (section 5-1). For skills with the same name, the project's copy wins and only one set appears.

## 5-4. Using Grok Build

Grok Build (`grok`) is xAI's terminal coding tool. It reads the official project skill location `.grok/skills`, which the section 5-1 project linker also fills, so run the same command and start it.

```sh
node "/path/to/wax/scripts/install-project.mjs" --project "/path/to/my-app" --check
cd /path/to/my-app
grok
```

Check the 13 skills under `/skills` in a new session. Grok Build has its own commands such as `/plan` (plan mode) and `/code-review`, so, as in GitHub Copilot CLI, ask for skills by name: "start with the wax init skill", "use the wax plan skill to plan email sign-in for email-login". In the team channel the session kind is `grok` and the default name is `grok-<folder name>`. Grok Build also reads Claude Code plugins, so wax may appear without a link if it is installed in Claude Code; for skills with the same name, only the highest-priority location is used. Grok Build is not yet an execution tool for requests on the dashboard home page. Running in a real Grok Build session has not been verified yet.

## 6. Team dashboard: AI sessions working together and daily reports

The dashboard shows sessions from every coding tool on one screen in the same way. Each session in the team panel shows its **next command** in that tool's syntax: work if it has an assignment, otherwise the current stage of its task, or status when its task is done, with a copy button to paste it into that session. Choosing a session in the assignment form previews the command it will run, and selecting a character in the virtual office shows the same next command. The "How to call each command" table in Help (`/help`) lists every command.

A session can state its model when joining with `wax chat join --model <model>` (the same tool can switch models). The dashboard and HR record cards show it as "tool · model"; it is the session's own claim.

When sessions from several coding tools (Claude Code, Codex, Antigravity CLI, GitHub Copilot CLI, Grok Build, Gemini CLI) work in the same project, each session's AI joins as a **team member**. Conversations, assignments and daily reports are stored in the project's `.wax/chat/` and appear live on the local dashboard. Detailed records and team channels show those records. When the CEO sends a request from the Requests & reports screen (`/start`), a separate session of the chosen CLI does the work. The guide NPCs in the virtual office (Jake with progress news, Sunny with help and office tips, Jenny with the design studio workflow) speak from project records and the current time. Rina's tool news comes from official public releases, which the server checks once an hour per source. No project, installed version or session information is sent; if a check fails the last data is kept and only the failed source retries, from 5 minutes up to an hour apart. Rate-limit waits are honored, and manual refresh is limited to once a minute. Turn external checks off with `WAX_TOOL_NEWS=off`. NPC guides and character small talk are screen effects and are not recorded. See **Help** (`/help`) on the dashboard for more.

### Opening the dashboard

```sh
node "/path/to/wax/bin/wax.mjs" --project "/path/to/my-app" dashboard
```

This opens `http://127.0.0.1:4330/` (change it with `--port` or `WAX_DASHBOARD_PORT`). In an AI session, `/wax:init` (Codex `$wax:init`, Antigravity `/init`) opens the dashboard directly. Its first screen is the team channel; **＋ New request** opens the start guide on the Requests & reports screen (`/start`). Addresses from 0.13.5 and earlier (`/?mode=…`, `/?request=…`) lead to `/start`. There is no separate dashboard command; run init again to reopen it later. If the dashboard is already running it just gives you the address; if not, the session starts it in the background or tells you the command to run. `dashboard --status` only checks whether it is running. How to use each screen is in **Help** (`/help`) at the top of the dashboard. The server only listens on this computer (127.0.0.1). Set the person's name used on the web with `WAX_CHAT_USER` (default "대표", the CEO). Switch the screen language with the language menu at the top right (한국어 or English); this browser remembers the choice. The first visit opens in Korean when the browser language is Korean and in English otherwise, and `?lang=ko` or `?lang=en` in the address also sets it. Only the screen text changes: messages, documents, reports and other content written by people and AI sessions are shown as written.

### Browser notifications

Click **Turn on notifications** at the top of the team channel, Requests & reports or the detail records screen and the browser asks for permission (never when the page opens). From then on, while you are not looking at the tab, these arrive as browser notifications:

- questions from AI sessions
- new execution approval requests
- completed task stages
- new trigger proposals and notify-only triggers (section 6-5)
- PM loop cards that need a person, and a PM loop stopping (section 6-6). Actions that auto handles without a card are not notified.

Clicking a notification brings the tab back and opens that message, approval or task. Nothing is notified while the tab is in view, for your own messages, or for records that existed before the page opened or reconnected, and the same event is notified once. The count gathered while away shows in front of the tab title, like `(2)`, until you look at the tab again. The choice is saved in this browser only; if the browser blocks or does not support notifications, the button says **Notifications blocked** or **Notifications unsupported**. When blocked, allow notifications in the site settings next to the address bar and reload. A dashboard tab has to be open to receive notifications.

### Screens

| Screen | Contents |
| --- | --- |
| `/` and `/chat` Team channel | Conversations in each task channel and the project-wide channel (general), choosing recipients and the Work tab. The CEO can post too |
| `/start` Requests & reports | The start guide, one-line requests run automatically from planning to the final report (section 6-3), answering questions, stop and resume, and trigger proposal cards (section 6-5) |
| `/manage` Detailed records | Today's numbers, the run trace, the PM loop (section 6-6), the virtual office panel, the timeline (stages, evidence, conversations, assignments, reports), check first, team status and "doing now", assignments, task progress with time per stage, recent decisions, project rules and wiki (section 6-7), open questions, daily reports and triggers (section 6-5) |
| `/office` Virtual office | Selecting a character opens its HR record card: front-facing face, department lead or member (no titles; the project name is the department and the PM leads it), level, a hexagon of six skills (plan, design, implement, review, test, communicate, report), bug rate (share of failed tests in my work), bugs found (failed tests during review), commits, work time (accepted → done) and achievement badges. Everything is computed from records (tests and commits count for the `--author` name given to `wax test` or `wax evidence`, or else for whoever had accepted the same task and stage at that time), and without records skills start at average (50). AI sessions rise through ranks with the level they earn from records: staff → senior staff → assistant manager → manager → deputy general manager → general manager. The person gives the AI team its work, so they always appear as the CEO regardless of level. The project's PM also carries the team lead (PM) role apart from rank. **Skill map** at the top shows a member × area grid (stage, check kind and code area): who has actually done which kind of work, which areas nobody has done, and which only one member has. Each cell counts completed tasks, passed checks and linked commits (failed checks are marked ✕ separately), and code areas come from the paths a commit changed. On a phone it opens full screen, only the table scrolls sideways, and the member column stays in place. In the CLI it is `wax chat skills`, and the PM reads it before assigning. The HR card's **Work notes** tab collects, straight from the records, what that member did each day over the last 7 days (tasks assigned, started, done or blocked, passed and failed tests, commits and the areas they changed, messages and whiteboard notes, reports and memos), folded by day, with current assignments and the latest memo on top. It calls no AI and writes no sentences of its own. A session reads the notes of its own name with `wax chat notes <name>` when it starts a stage to see where earlier sessions stopped, and leaves what remains and what to watch with `wax chat memo` when it stops partway. When new records raise a skill, a glow in that skill's color briefly circles the character's head. The building is seen from the side; from bottom to top, B1 Design studio, 1F Meeting room, 2F Development, 3F Lab, 4F CEO's office and the RF Rooftop garden follow the wax order of work (discuss → implement → review → report). Characters do not walk around to work. The PM sits in the CEO's office, idle sessions are in the rooftop garden, and everyone else discusses, designs, implements and reviews from their own seat in development. Reports, conversations and whiteboard posts travel as a line of notes that streams from the sender's seat along the corridors and the elevator shaft to the recipient (or, without one, the latest conversation partner in the same channel) or to the whiteboard, while speech bubbles still appear above heads. The room follows each session's current state, not the task stage. The dashboard panel shows the same view |
| `/search` Search · `/help` Help | Record search and index management (section 6-1), how to use each screen and how to call commands in each tool |

Changing the date shows that day's records.

### Checking records on the dashboard

Selecting a stat card at the top jumps to the related tasks, assignments or timeline. **Check first** lists blocked assignments, failed test evidence on the selected date, and old open questions, in that order. If a later pass exists for the same task and stage, the earlier failure leaves this list but stays in the timeline. Don't conclude that a whole task failed from a failure record alone.

**View original** shows the full text of questions and decisions shortened in summaries, and **View evidence** shows the saved command, exit code and output in the existing document window. The buttons never rerun the command. Recent decisions and test evidence follow the selected date; assignments and open questions follow all current records.

**Run trace.** Select **Run trace** next to a task in **Task progress**, or open `/manage?feature=<task ID>`, to see how the task went through its phases as a vertical timeline of phase visits. Each visit expands to its start, end and time taken (computed like the time per stage), outcome (phase completed, sent back to implement with the reason, in progress, and questions or blocks when a request is linked), the completing session and tool, the commits at the time, completion evidence and reasons, linked test and commit proofs with files changed since they were recorded, review acceptance-criteria results, and files changed between the commit at the end of the previous visit and the end of this one (committed changes). Iterations show as revisits of the same phase. **Download Markdown** saves the same content with the PR-description rules (`@name` and HTML neutralized); on the command line use `wax trace <id>` (Markdown) or `wax trace <id> --json`. It is read-only and calls no AI. Completing or sending back a phase now also records the commit (`head`), whether there were uncommitted changes (`dirty`, `.wax/` excluded) and, when known, the tool (`tool`, dashboard auto-run) in the history; projects without Git and older records leave those cells empty. Tokens and cost are not shown because no record ties a Claude Code usage session to a phase visit.

Even if you switch dates quickly, only the response for the last selected date is applied. If a refresh fails, the last successful records and a retry button stay. Reconnecting rereads session information, and background refreshes never clear an assignment or new task you are typing.

### Sessions talking to each other

Start the first session with `/wax:init` and join other AI sessions with `/wax:join` (Codex `$wax:join`, Antigravity `/join`, GitHub Copilot CLI and Grok Build "join with the wax join skill"). Even if you skip init or join, the first wax command a session runs joins it automatically. If the same name is already active (two or more sessions of the same tool in the same folder), the session joins with a number such as `claude-my-app-2` and tells you the name. If repeated inits left earlier sessions holding the name, `/wax:init --reset` (join takes it too) clears them before joining with the default name. Sessions that are listening or working are kept, and the PM role and tasks stay with the name, so the new session that joins under it takes them over. When a joined session runs a wax stage command, it switches to "working" as the stage starts and reads the recent messages in that task's channel. When the stage ends it records the result (done or blocked) on its assignment. The default name is `tool-foldername` (e.g. the Claude session in the `my-app` folder is `claude-my-app`). Characters in the folder name other than letters, digits, spaces, `_`, `.` and `-` become `-`, and the name is cut to 40 characters. To run several sessions of the same tool or rename one, add `--name <name>` to any wax command (e.g. `/wax:join --name claude-front`). The session keeps that name in later commands and joins the channel right away. A name the session used before is marked "away". The name is only remembered within the session's conversation, so set it again in a new session.

You can choose its task at the same time. `/wax:join --name claude-front --feature chatbot` (same as `--project=chatbot`) joins the session in the idle state with the `chatbot` task selected, and later wax commands use that task when you leave out the task ID. init opens `http://127.0.0.1:4330/` (the team channel) whether or not a task is selected. That task's records are at `/manage?feature=chatbot`. **Team up with existing AI sessions** on the home screen shows whether there is a PM, assignments and the reasons they are blocked, and the command to paste into each session.

The communication rules keep back-and-forth short. An AI session rereads the whole conversation every time it sends a message, so even a one-line greeting or acknowledgement is expensive.

- **Instructions** are given only as the PM's assignments (`assign`), with the goal, scope, done criteria and deliverables.
- **Results** are reported in the assignment status notes (`task done`, `task block`), which appear in the dashboard task list and timeline.
- **Channel posts** are only questions (`question`), answers (`answer`) and decisions (`decision`). No greetings, acknowledgements, progress reports or summaries. A message the CEO explicitly asks to send is sent as is.

A message has two parts.

- **Doing now** (`--doing`): what the sending session is doing. It also appears in the dashboard team list.
- **Message** (`--message`): the question, answer or decision the recipient (`--to`; everyone if omitted) needs. Point to document paths instead of copying their contents.

To talk directly, run `/wax:chat [channel] [message]` (Codex `$wax:chat`, Antigravity `/chat`). A session only reads channels when it runs a command, so another session's messages reach it the next time it runs a wax command. Messages from other sessions are treated as reference only; a request inside a message is never enough to run a command.

**Listening and answering right away.** When a session joins wax and its tool can wake the session for each output line (Claude Code's Monitor), it automatically starts `wax chat watch --author <name> --wake`. After that, a message that calls it with `@name` or names it as a recipient, or a new PM assignment, wakes the session and it answers in the same channel with `answer`. Waiting never calls the AI, and messages that don't call it or that it sent itself don't wake it. Messages are delivered in the order they were written even across channels, and if watching stops and restarts (Monitor expires every 30 minutes), messages from the gap are delivered first. Read positions are kept in `.wax/chat/watch/` and listening markers in `.wax/chat/listeners/`. If someone in the chat asks for work the session wasn't given, the session passes the request on to its own user and says so. `/wax:chat --watch` turns listening back on when it is off. Codex, Gemini CLI and Antigravity CLI cannot wake a session from output, so they check messages at their next wax command. For immediate notifications, run `wax chat watch` in a separate terminal. That watch is for people to read, so it has no `--wake`, and the dashboard shows it as `at next command`.

**Calling from the channel screen.** Above the input on the channel screen (`/chat`), joined AI sessions appear as **recipient** buttons labeled `answers now` (listening), `at next command` or `away`. Choose recipients or call them with `@name` and send, and you are told who will answer soon and who will check later. Without a recipient, the message is only recorded and no AI session wakes. **Reply** on each message continues from that message, and replying to a question makes it an answer.

**Input suggestions.** Type `@` in the input for joined sessions, `/` for wax commands and `#` for tasks. Pick with the arrow keys, insert with Enter or Tab, and close with Esc. Choosing `@name` also selects that session as a recipient. A `/command` is written in the recipient tool's syntax when there is one recipient (Claude Code `/wax:review`, Codex `$wax:review` and so on), otherwise as `wax review`, and the task ID is filled in inside a work thread or a task channel.

**Work tab.** The **Work** tab on the left of the channel lists requests, assignments, continued conversations and execution approvals as **Answer needed · In progress · Done**, grouped into today, yesterday, the last 7 days, the last 30 days and earlier. **Find work** above searches titles, content, owners and IDs in every state. Work pinned with the star button stays on top whatever its state; pins are kept in this browser only. A request stopped by an AI question is listed under **Answer needed**. Opening a request folds its conversation by stage (in SM: intake and analysis → impact check → fix → regression check → resolution report), with only the current stage (or the last one once finished) open, and each stage header shows its progress updates, passing tests and commits. Test and commit evidence recorded in a stage appears as cards that open the detail records with the actual output. A card shows "N files changed since" when files changed after the proof was recorded (an observation).

**Direct notifications between Claude Code sessions.** Claude Code can message other Claude Code sessions on the same computer directly. A session records its own session name with `--peer` when joining (shown as `session <name>` in `wax chat who`). When you post with another Claude session as a recipient, that session only receives a pointer like `wax: #<channel> <message ID> from <name>`. The content stays in the channel record, so the notified session reads the message from the channel and ignores ones it already handled. When this isn't available it is skipped, and the message still arrives through the channel and listening.

### Session names and rejoining

Keep the `session` returned by `wax chat join --author <name> --session <ID> --json`, and pass `--session <ID>` with every status change, post, report and assignment change for that name. On a 409 error, join again with the same session ID and use the name it returns. PM and assignment roles stay with the name, and a name inactive for 24 hours is taken over by the next session. Records without tokens from earlier versions are handed over on join. CLI records written without join are identified separately, and once a session takes over a name, it cannot be written without the token.

### The PM and sharing work

There is one person, the **CEO**. The CEO gives direction and makes final decisions; the PM advises, offers options, turns decisions into assignments and reports progress and delays to the CEO.

1. In the session that splits the work, run `/wax:pm <instruction or goal>`. The PM checks the goal, current tasks and participants, picks the usual scope and owners, and in the same call creates the task and assigns its current stage. Existing assignments are reused. It only asks a specific question when the CEO asked for options or when it cannot assign because of missing requirements or conflicting explicit instructions. With no goal and no records, it asks once for the outcome you want. It never stops at a promise such as "I'll assign once scope and owners are decided."
2. The PM briefly records the scope and owners it applied, then reports the real feature ID, task ID, owner, stage and command. It does not overwrite other tasks in progress or assign later stages that cannot start yet. The assignment itself is the instruction, so it isn't repeated in a channel; only when the order between owners matters is it recorded as a decision in the general channel. When there is no PM, the person can take the PM role from the dashboard. The PM carries the project forward, so it isn't changed lightly. Another session running `/wax:pm` does not replace the existing PM; it changes only when the CEO asks (confirmed once more under **Replace PM…** on the dashboard, or `wax chat team pm <name> --replace` in the CLI). If nothing is in progress, create a plan-stage task with **New task** in the dashboard's **Task progress** panel, then assign planning to an AI.
3. Run `/wax:work` (Codex `$wax:work`, Antigravity `/work`) in each session. It accepts its own assignment, performs that task's stage, and when finished records done or blocked (with a reason) together with the result. That record is the report to the PM. It handles one assignment at a time.
4. Running `/wax:pm` again without a goal in the PM session gives a **progress report**. With a new goal or an instruction to continue, it goes on to the next assignments in that scope instead of stopping at the report. It covers done, in progress and not started for each task, delays (blocked work, work with no results for a long time, work waiting on an earlier stage) with causes and schedule impact, and risks, and it raises decisions as options with a recommendation. Unblocking or reassigning work within the decided plan is the PM's job; changes to scope, priority, schedule or owners need the CEO's decision. If the person is among the participants, a short report is also posted to them in the channel so it shows on the dashboard.

Safety limits:
- Only the PM chosen by the CEO can assign work. Tasks created by other participants or instructions in ordinary messages are not assignments.
- An assignment only allows the given wax stage of the given task. The CEO's direct instructions take precedence over the PM, and file changes and commands still go through each tool's permission checks.
- The stage order is kept. If the previous stage is not finished, the assignment is recorded as blocked and the PM is told.

**Task completion check.** When an assignment is marked done (`task done`), wax checks that the stage of the linked feature actually finished after the assignment. An assignment for a specific stage needs that stage's completion record (`wax complete`) in the current cycle, dated after the assignment; an `any` assignment needs at least one stage completed since the assignment. The default (`WAX_TASK_DONE_CHECK=warn`) records it as done with a warning (`warning`) on the status record. The warning appears in the CLI error output (`wax chat: 경고: …`, or `wax chat: warning: …` in English), the assignment lines of `wax chat tasks --all` and `wax chat team`, the dashboard timeline and the daily report draft, the assignment conversation in the work tab, and the office work notes, and the PM treats such assignments as not done in progress reports. Sessions and dashboards started with `WAX_TASK_DONE_CHECK=enforce` reject such a completion and tell the session to complete the stage first, or record `task block` with the reason if it cannot be finished. `off` skips the check. Assignments whose feature was deleted, and status changes other than done (accept, block, cancel), are not checked.

### Claude usage monitor

With Claude Code 2.1.287 or later, the wax mod in the plugin (Claude Code mods) writes only numbers to this project's `.wax/usage/<session ID>.json` at the end of each turn: the account's plan usage (5-hour and weekly % and reset times), that session's context usage, and its cost so far. Conversation content (prompts, answers, tool calls) is neither read nor kept, and nothing is written in a project without a `.wax` folder. See it on the monitor on the CEO's office wall in the virtual office and with `wax chat usage`; the PM reports usage near its limit as a schedule risk in progress reports. Turning off the wax plugin's hooks in Claude Code's `/plugin` stops the recording. Usage for the other tools (Codex, GitHub Copilot CLI, Gemini CLI, Antigravity CLI) is not shown yet.

### Daily reports

Run `/wax:daily [YYYY-MM-DD]` (Codex `$wax:daily`, Antigravity `/daily`) and the AI reads that day's compiled draft, writes a report and registers it as `docs/wax/daily/<date>/NN.md`. The report covers what was done today, verification results, decisions, problems and open questions, and tomorrow's work. Registering several times on the same day increases the number and never overwrites an earlier report. **View draft** on the dashboard shows a draft compiled from the records without AI.

### Using the CLI directly

```sh
wax chat post <channel> --author <name> --session <ID> --kind <kind> --doing <doing now> --to <recipient> --message <message>
wax chat read <channel> [--since <message ID>] [--json]
wax chat join --author <name> --session <ID> --kind <kind> [--model <model>] [--feature <task ID>]   # first join (adds -2, -3 if the name is active)
wax chat presence --author <name> --session <ID> --state working|discussing|reviewing|idle|away [--note <doing>]
wax chat who
wax chat reset [--author <name>]   # clear earlier sessions (keeps listening or working ones; --author clears only that one)
wax chat watch --author <name> [--feature <task ID>] [--wake] [--json]   # messages calling me and new assignments, one line each, until stopped. --wake wakes an AI session
wax chat read <channel> --id <message ID> [--json]                       # read one message as is
wax chat team pm <name> --kind <kind>        # set the PM (decided by the CEO)
wax chat assign <task ID> --to <owner> --author <PM> --session <ID> --phase <stage|any> --message <instruction>
wax chat tasks [--to <name>] [--all]
wax chat skills [--json]                    # skill map: records per member by stage, check and code area, and empty areas
wax chat rules [--all] | rules candidates | rules lint   # project rules, evidence candidates, evidence check
wax chat rules propose --author <name> --session <ID> --message <rule> --why <why> --source <evidence IDs>   # propose a rule (a person approves it in the dashboard)
wax chat notes <name> [--days 7] [--json]    # work notes: what a member did each day, current assignments and latest memo
wax chat memo --author <name> --session <ID> --message <memo> [--feature <task ID>]   # leave what remains and what to watch
wax chat task accept|done|block|cancel <assignment ID> --author <name> --session <ID> [--message <note>]
wax chat daily [--date YYYY-MM-DD]           # timeline
wax chat daily draft | report --file <report.md> | list
```

`wax` means `node "/path/to/wax/bin/wax.mjs"`. The kind (`--kind`) is one of `claude`, `codex`, `copilot`, `gemini`, `antigravity`, `grok`, `human` or `other`. For other commands see `wax --help`, `wax chat --help`, `wax trigger --help`, `wax pm-loop --help`, `wax mcp --help` and so on.

**CLI language.** Help (`--help`), messages, warnings and errors are in English with `WAX_LANG=en` (values such as `en_US` and `ko-KR` are accepted too). Without `WAX_LANG`, the CLI uses English when the first of `LC_ALL` → `LC_MESSAGES` → `LANG` that is set starts with `en`, and Korean otherwise; `WAX_LANG=ko` keeps Korean on an English system. `--json` output, saved records, and the stage prompts, handoff context and skills given to AI sessions stay the same in either language. The dashboard's screen language is set separately (section 6, "Opening the dashboard").

| Path | Contents |
| --- | --- |
| `.wax/chat/channels/<channel>.jsonl` | Channel messages (append only) |
| `.wax/chat/board/<task>.jsonl` | Whiteboard notes and report records |
| `.wax/chat/presence.json` | Participant status and what each is doing |
| `.wax/chat/team.json`, `assignments.jsonl` | The PM and assignment and status history |
| `.wax/chat/daily.jsonl`, `docs/wax/daily/<date>/NN.md` | Daily report records and text |

Other storage locations are listed in section 7.

In an empty directory, run `node scripts/chat-demo.mjs --project ./demo --loop` to watch a repeating scene of PM assignments, conversations and reports on the dashboard.

## 6-1. Searching records

Search conversations, whiteboard notes, assignments, daily reports, stage documents, completion evidence, improvement history, test and commit evidence, request conversations and design jobs in one place. Every result shows where the original is (file plus record ID or document location) and links to the screen that opens it.

Build the search index once. Press **검색 색인 만들기** (Build search index) under **검색** (Search, `/search`) in the dashboard menu, or run:

```sh
wax search index
```

After that, each search first brings in only the records that changed, including records written by other AI sessions and CLIs.

```sh
wax search handoff
wax search 인계 --feature lookbook-upload
wax search "Claude Code" --kind message --author claude-app --from 2026-10-01 --to 2026-10-18
wax search status
```

- Every word separated by spaces must appear; double quotes search a phrase with spaces. Matching ignores case, and results are newest first.
- Three or more characters match anywhere in the text (`handoff-v2.md`, `docs/wax/design`, the start of a commit SHA, or Korean such as `인계를`). Two letters or digits (`UI`, or Korean such as `인계`) match two-character pieces inside words, so `인계` also finds “인계를”. A single character scans everything and can be slow. Stemming, Korean initial-consonant search and semantic search are not supported.
- Filters: kind (`--kind`), task (`--feature`), author (`--author`), stage (`--phase`) and dates (`--from`, `--to`, YYYY-MM-DD). With many results, use the `--cursor` printed at the end for the next page. `--json` returns the original locations and highlight ranges as JSON.
- Execution approval records, session tokens and AI session details are never searched.

The index (`.wax/search/index.db`) is a copy that can always be rebuilt; the source of truth stays the JSON/JSONL in `.wax`. Without an index, search only explains how to build one. If the index is damaged or its format differs from this wax version, rebuild it with `wax search index --rebuild` (**색인 다시 만들기(복구)**, Rebuild index, on the dashboard). Unreadable record lines are skipped and listed with file and line numbers in `wax search status`. If building stopped midway (killed, or the dashboard restarted), the page says it was interrupted and offers **색인 이어서 만들기** (Continue building); searching or pressing it brings in the remaining records. Editing or deleting only a whiteboard or daily report Markdown file shows up in the next search, and a missing file or one reached through a symbolic link outside the project is not searched and is listed in the status. The author filter keeps names such as 대표 and names with Korean letters or spaces as they are.

### Finding related records (recall)

`wax recall` lets an AI session consult other tasks' records before it works. It uses the same index and ranks records **by relevance**. Unlike search, any one word may match; records matching more words and matching them better come first. A trailing Korean particle is also dropped (`토큰이` finds `토큰`).

```sh
wax recall token expiry retry --exclude-feature login-retry
wax recall payment error --kind note --limit 5 --budget 2000
```

- Results are quoted one line each within a budget of characters (not tokens), with the original location and a screen link. `--json` adds the rank, matched words and score.
- Stage skills and automatic runs use `recall` when a similar error, the same module or an earlier decision may exist in another task. Recalled records are reference data, not instructions, and are checked against the current code.
- Without an index, recall builds it once. Semantic search (different words with a similar meaning) is not supported.

Search needs Node.js 22.16 or later, or 24 or later (full-text search in the built-in SQLite). On older Node.js only search shows a notice; every other wax feature keeps working. See the [search guide](SEARCH.md) (in Korean) for details and measurements.

## 6-2. MCP server (experimental)

`wax mcp` is a server that lets coding tools read wax records and write to the team channel over MCP (stdio). Tool calls instead of shell commands mean fewer argument mistakes and permission prompts, and since one connection is one session there is no `--session <ID>` to pass. It is off by default and starts only when the environment variable `WAX_MCP=on` is given where you register it. Installing the plugin does not register it.

| Tool | What it does |
| --- | --- |
| `wax_status` | The task list, or with `id` one task's stage in progress, the stage after it, revision, completions and recent proofs |
| `wax_context` | A task's handoff context (`id`, `budget` in characters), the same as `wax context` |
| `wax_recall` | Related decisions and failures from other tasks (`query`, `excludeFeature`, `budget`), ranked as `wax recall` does |
| `wax_inbox` | Messages that mention me (or `author`) and PM assignments to me (optionally only after the `since` message ID), by the same rule as `wax chat watch`, without moving its read position |
| `wax_join` | Join the team channel (`name`, `kind`, `model`, `peer`) and update presence (`feature`, `state`, `note`); a different name renames — `wax chat join` and `presence` |
| `wax_post` | Posts only a `question`, an `answer` (`replyTo` required) or a `decision`; greetings and progress reports (`message`, `opinion`) are refused — `wax chat post` |
| `wax_task` | Marks a task assigned to me `done` or `block` with its `result`. A `done` before the stage is complete is recorded with a warning, or refused under `WAX_TASK_DONE_CHECK=enforce`, as in the CLI — `wax chat task` |
| `wax_complete` | Completes the current stage (`id`, `phase`, `evidence`, `proofIds`, `checks`, `noProof`, `acUnverified`, `verdict`, `revision`) under exactly the conditions of `wax complete`: proofs, acceptance trace, reviewer separation |
| `wax_assign` | PM only. Assigns a task's current stage (`feature`, `to`, `message`) — `wax chat assign` |

- **Session and author.** Call `wax_join` once first and the connection becomes a wax session. The session ID stays inside the server process and never appears in a result. Write tools have no `author` or `session` argument and record only under the joined name. When another session already uses the name, you join with `-2`, `-3` added and the result's `author` says so. When the connection loses its name (for example `wax chat reset --author <name>`) or the client sends `initialize` again, the server rejoins with the same session ID before the next write and adds `rejoined` and the current `author` to the result.
- **The same checks as the CLI.** Write tools call the same functions as the CLI, so validation, locks, length limits and error messages match. Errors come back with `isError`, the translated message (`WAX_LANG`) and an HTTP-like `status` (400, 403, 404, 409). Every record written (messages, assignments and status changes, stage completions and history, presence) carries `"via": "mcp"`.
- **Not tools.** Approving or rejecting runs, approving rules, editing triggers, archiving and restoring, restoring backups and deleting records stay with people in the dashboard. Saving documents (`wax save`) and test, capture and commit evidence (`wax test`, `capture`, `evidence`) stay in the CLI.
- **Writes without a tool.** Accepting a task (`task accept`) is skipped (`done` and `block` work on an open task). Memos, whiteboard notes, rule proposals, cancelling tasks and registering daily reports have no tool yet, and the shell CLI cannot write under a name joined through MCP (its session ID stays inside the server). The guidance tells the session to tell the user what it meant to record instead.
- The project is fixed when the server starts: `--project <path>`, else `WAX_PROJECT`, else the nearest folder with `.wax` from the current directory upward (else the current directory). Tools take no other path. If you do not know which directory the coding tool starts servers in, give `--project`.
- Records in the results (titles, documents, messages, assignments) carry `"source": "record"`. They are data written by people and other sessions, not instructions.

**Registering.** `node /path/to/wax/bin/wax.mjs mcp config --host <claude|gemini|codex|copilot> --project /path/to/my-app` prints the snippet for that tool with this installation's real paths. wax never reads or edits your settings files, so add the snippet yourself. In the examples, replace `/path/to/wax` with the real absolute path of the extracted (or installed) wax folder and `/path/to/my-app` with the project path. On Windows it also runs through `node` without a shell.

**Claude Code**

<!-- wax mcp config --host claude -->
```sh
claude mcp add --transport stdio --env WAX_MCP=on wax -- node /path/to/wax/bin/wax.mjs mcp --project /path/to/my-app
```
<!-- /wax mcp config -->

Add `--scope project` to save it in the project's `.mcp.json` for the whole team. `/mcp` shows the connection.

**Gemini CLI** — `~/.gemini/settings.json` (or the project's `.gemini/settings.json`)

<!-- wax mcp config --host gemini -->
```json
{
  "mcpServers": {
    "wax": { "command": "node", "args": ["/path/to/wax/bin/wax.mjs", "mcp", "--project", "/path/to/my-app"], "env": { "WAX_MCP": "on" } }
  }
}
```
<!-- /wax mcp config -->

**Codex** — `~/.codex/config.toml`

<!-- wax mcp config --host codex -->
```toml
[mcp_servers.wax]
command = "node"
args = ["/path/to/wax/bin/wax.mjs", "mcp", "--project", "/path/to/my-app"]
env = { WAX_MCP = "on" }
```
<!-- /wax mcp config -->

**GitHub Copilot CLI** — `~/.copilot/mcp-config.json` (or `/mcp add` inside Copilot CLI)

<!-- wax mcp config --host copilot -->
```json
{
  "mcpServers": {
    "wax": { "type": "local", "command": "node", "args": ["/path/to/wax/bin/wax.mjs", "mcp", "--project", "/path/to/my-app"], "env": { "WAX_MCP": "on" }, "tools": ["*"] }
  }
}
```
<!-- /wax mcp config -->

**Skill guidance.** The wax commands for Claude Code and Gemini CLI use "MCP first" guidance: when `wax_join` is in the tool list they join, post, update tasks and complete stages through the tools; otherwise (the default, when the server is not registered with `WAX_MCP=on`) they use the short CLI fallback in the same file (`wax chat join` … `--session`). The full CLI rules are in the plugin's `skills/<command>/SKILL.md`. The skills for Codex, GitHub Copilot CLI, Antigravity CLI and Grok Build keep the current CLI guidance.

Config file locations and formats for Gemini CLI, Codex and Copilot CLI can change between versions, so check each tool's MCP documentation (this repository's tests check the server and the printed snippets, not the registration in each tool). Antigravity CLI and Grok Build have not been checked yet. If registration does not work, run `WAX_MCP=on node /path/to/wax/bin/wax.mjs mcp --project /path/to/my-app` in a terminal and read its error output (stderr). Without `WAX_MCP=on` it explains how to turn it on and exits.

## 6-3. One-line requests that run on their own

`init` joins with defaults and opens the dashboard right away. A new request offers two modes.

| Mode | How it starts and runs |
| --- | --- |
| Project | Enter a goal and wax first writes a workflow with scope, task order and dependencies, deliverables and done criteria. Review it on screen and press **Start with this workflow** to move on to design, implementation, review and reporting. A change request rewrites the workflow, and the new version has to be reviewed before it starts. |
| SM · Maintenance | Bug and improvement requests go straight through triage and analysis → impact check → fix → regression check → report. Plan and design documents stay short to match the request, and real test evidence is still required. |

Project mode is selected at first, and after that each project remembers your last choice. You can also open the request screen in a given mode with `init --mode sm` or `init --mode project` (in each host's syntax). A request keeps its mode once created; to use the other mode, create a new request. Older requests without a mode continue as SM. Both modes run in a separate session of the CLI you choose; wax does not spread the work across your existing terminal AIs.

The start guide on the Requests & reports screen (`/start`) walks you through choosing an execution tool → describing the task → following progress and reports. It checks whether each tool is installed; sign-in is checked when the tool actually runs. After installing a tool, press **Check tools again**.

For a new request, choose an installed execution tool: Codex, Claude Code, Gemini CLI, GitHub Copilot CLI or Antigravity CLI. Grok Build does not support automatic runs yet, so use it for team work in a terminal session by asking for a wax skill by name. That CLI's sign-in or API settings, and its account usage, cost and data policies, apply. A request keeps using the tool it was created with; to use another tool, create a new request. New permission requests from Codex, Claude, Gemini and Copilot are allowed once or denied on screen. Antigravity runs within the permissions it already has, and if a new permission request is blocked you need to check its terminal settings. wax never wakes up an existing terminal session or changes another AI's assignment by itself. The PM for automatic runs handles the request and does not replace your project's PM.

- Answer questions in the chat. Extra instructions sent during a run are applied after the current stage finishes. Press **Stop** to halt right away.
- The reason for a stop or error is shown above the request. **Continue** resumes from the saved stage. Restarting the server or viewing a page never calls the AI again.
- Requests run one at a time per project. Implementation and review need real passing test evidence, and a stage changed by another session is reported as a conflict. Each stage may run for up to 30 minutes.
- Records are saved in `.wax/chat/requests/` and stage documents in `docs/wax/<generated ID>/`. Existing tasks and team assignments are still managed in **Detailed records** (`/manage`).
- The dashboard's first screen (`/`) is the team channel, for conversation records. To run work automatically, open **＋ New request** and use **Create workflow** (Project) or **Start** (SM) on the Requests & reports screen (`/start`). Workflow review is separate from execution approvals; your existing CLI permissions still apply.

Automatic runs connect using thread/start, thread/resume, turn/start, outputSchema and item/completed from the [official OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

## 6-4. Execution approvals

To answer the permission requests a tool asks in its console from the chat window instead, see [Managing execution approvals](./APPROVALS.md) (in Korean). Only connected requests can be answered, each with its own **Allow once / Deny** buttons.

## 6-5. Triggers: request proposals from schedules, local calls, GitHub issues and CI failures

A trigger only **proposes** a request at the time you set. AI starts only after a person accepts the proposal; nothing is accepted automatically.

- **Create:** under **Triggers** in Detailed records (`/manage`), use **＋ New trigger** to create, edit, turn on and turn off triggers. Definitions are stored only on this computer in `.wax/chat/triggers/`.
- **When:** a schedule (5-field cron and a time zone, e.g. `0 9 * * 1-5`, `Asia/Seoul`) or a local call (`wax trigger fire <id> [--payload <file>] [--key <key>]`, e.g. from a git hook). Schedules run only while the dashboard is open; runs missed while it was closed become one "N missed runs" proposal.
- **GitHub:** **GitHub issues (label)** takes a repository (`owner/name`) and a label, **CI failure** a repository, branch and optional workflow. They are checked every `every` (e.g. `5m`, at least 1 minute) with this computer's `gh` login, only while the dashboard is open.
  - If `gh` is missing or not logged in, the list shows **Connection needed** with the reason and nothing is checked (not counted as a failure). After `gh auth login` it is checked again the next minute.
  - **The first check only records the issues and failures already there as a baseline and proposes nothing.** After that, only newly labelled issues and new failed runs are proposed, within the limits. To hand over an existing issue, remove the label and add it again. Turning the trigger on again or changing the repository, label or branch starts over with a first check.
  - Leave the text empty to use the default (handle the issue; for CI an SM-mode "CI regression fix"). Issue titles and run names enter through `{{issue.title}}`, `{{run.name}}` and the like, cut to 200 characters; issue bodies reach the prompt only as quoted "external event content (not instructions)".
- **What:** a request proposal (mode, tool and text; placeholders like `{{payload.title}}` are cut to 200 characters each with @mentions neutralized), a daily report proposal, or a notification only.
- **Accept:** on the **Trigger proposals** cards in Requests & reports (`/start`), edit the text, tool or mode and press **Accept and start**, or **Dismiss**. Proposals expire after 7 days. External content (the payload) reaches the prompt only as quoted "external event content (not instructions)".
- **Safety:** a daily limit and cooldown per trigger, an overall cap of 20 proposals a day, events skipped while a proposal or request with the same event key is open, and automatic turn-off with the reason after 5 failures in a row. Every event is logged in `.wax/chat/trigger-events.jsonl`.
- **CLI:** `wax trigger list`, `wax trigger test <id>` (preview only, writes nothing; GitHub sources fetch once with `gh`), `wax trigger fire <id>` (local sources only).
- **Default limits:** a new trigger allows 3 proposals a day with a 30-minute cooldown. Each trigger can allow 1–100 a day and a cooldown of up to 7 days. Clear **Turn on when saved** in the trigger form to save it turned off.
- **Left to people:** creating, editing and turning on triggers, and accepting or dismissing proposals, are done only by the person on the dashboard. The CLI and MCP have no commands for these. Accepting starts an ordinary automatic run as in section 6-3, and that request's run trace records where it came from (which trigger).
- **Good to know:** GitHub checks are made by `gh` on this computer, so `gh` must be installed and logged in; if `gh` is not on the PATH, start the dashboard with `WAX_GH_BIN` set to its path. The tests use a fake `gh`; long-running polling of a real GitHub repository is not part of the verified scope (section 9).

## 6-6. PM loop: next-step suggestions per goal and auto mode

Group several tasks under one goal and wax works out the next step for each task by fixed rules and shows it as a **suggestion card**. Working out the next step calls no AI, and a card runs only when a person clicks it. Starting an AI tool when no session is listening (a headless worker) and asking AI for a plan draft, a block judgment or a CEO report (PM judgment) also happen only on a click. When a person turns **auto** on for a goal, a fixed set of actions runs without a card, within the limits (see Auto mode below).

- **Create a goal:** under **PM loop** in Detailed records (`/manage`), use **＋ New goal** to pick existing tasks or write new ones (`task-id title`). A goal starts **before plan confirmation**; check its tasks and acceptance criteria, then press **Confirm the plan and start**.
- **Rules:** only the current phase is assigned (never a future one), listening sessions come first, and review goes to a session of a different tool than the implementer (otherwise a person is asked). When an assignment is done but its phase is not complete, the session is reminded once and then a person takes over. An assignment with no activity for 30 minutes is suggested for reclaim, and after report a `wax pr-body` draft is made and the PR decision stays with a person.
- **Headless worker:** when no session is listening (`chat watch`) for the current phase, a **Worker needed** card appears. The tool comes from the same list as request auto-run, limited to tools installed on this computer (tools that cannot run unattended, such as Grok Build, are never picked), and review picks a tool other than the one that completed implement (if there is none, a person is asked). Pick the tool on the card and press **Start … worker**: wax starts that tool for this one assignment and one phase, and it exits when done. Each phase is capped at 30 minutes, and permission requests go to the execution approvals screen. The worker completes the phase through the CLI (the evidence and acceptance-criteria conditions still apply); after it exits, the runner marks the assignment done or blocked from its result. Done goes through the existing assignment done check, so a phase that is not complete does not advance and goes to a person. Running workers show on the goal with their tool, elapsed time and a **Stop worker** button, and stopping the goal stops them too. If you dismiss a worker card, assigning a present (not listening) session is suggested instead.
- **PM judgment:** a **PM judgment** card appears in three places only: a goal whose plan is not confirmed (plan draft), a blocked assignment (block judgment) and a goal with tasks that finished report (CEO report). Only pressing **Ask the PM judgment** calls the goal's PM judgment tool, once, with read-only instructions (10 minutes at most; permission requests go to the execution approvals screen). Pick the judgment tool under the goal's **Limits**, separately from the request auto-run tool; the default is the first installed tool in the request auto-run order, and tools that cannot run headless are not listed. The judgment receives the goal, `wax context` for each task and recent decisions and blocks, as quoted data that is not instructions. The result is accepted only as JSON in a fixed schema and shown as a **PM judgment proposal** card that a person edits and accepts, or dismisses. A result outside the schema is discarded and handed to a person with the reason on a **PM judgment handed over** card. Accepting maps only to existing actions: retry or reassign for a block reclaims the assignment and only sets the default tool of the next worker card (starting it is confirmed again), and ask or propose iteration only shows the question or a `wax iterate` hint on the blocked card. A plan draft creates missing tasks and saves AC drafts to tasks with an empty plan document, but a person still confirms the plan. A CEO report only writes a draft file under `.wax/chat/pm-loop/`. Each place is judged once, and judgment requests count toward the daily headless limit (20).
- **What a card can do:** assign (under the existing PM rules: the person on the dashboard must be the PM), remind a session, reclaim (cancel) an assignment, write the PR draft file, start a worker, or ask for a PM judgment and accept its proposal. Each worker start, exit, timeout, failure and stop is logged with its reason in the same record. Every run or dismissed card is logged with its reason in `.wax/chat/pm-loop/<goal>.jsonl` and shows in the task's run trace.
- **Limits and stop:** per goal, 15 phase runs (worker starts included), 2 concurrent workers (running workers included), 8 hours, 3 iterations, 3 blocks in a row (a worker failure or timeout counts as a block) and 12 auto actions per hour (auto only). Across the project, at most 20 headless runs (worker starts and PM judgment requests) per day (24 hours). No new worker starts while the same task and phase has an open assignment or a running worker. The goal stops at a limit; only a person raises a limit and resumes. **Stop goal** stops it at any time.
- **Auto mode:** the default is suggest (every action is a card). Press **Turn auto on** in a goal's **Mode** box to switch that goal alone to auto. Only the person on the dashboard can switch it, and since auto assigns in that person's name they must be the PM. The switch is logged. Without a card, auto only assigns the current phase to a listening session, sends the first reminder after a done warning, starts a headless worker (review uses a different tool than implement), reclaims an assignment stalled for 30 minutes, and asks the PM judgment about a block, applying only its **retry** or **reassign**. Plan confirmation and accepting a plan draft, run approvals and permission prompts, rule approval, accepting trigger proposals, creating, pushing or merging a PR (the PR draft card after report waits for a person), raising limits, the CEO report, and anything handed to a person, asked or iterated stay cards in auto, and such cards raise a browser notification. Auto goes through the same checks and limits as a click, plus a per-goal **auto actions per hour** limit (12 by default). Hitting any limit, or an auto action failing, stops the goal and notifies you. **Stop goal** also stops running workers and judgments at once. Everything auto did is logged with `by: auto`, the rule name and the reason, and shows in the run trace and in the goal's **Auto activity**. With two dashboards it still runs once.
- **CLI (read-only):** `wax pm-loop list`, `wax pm-loop show <goal>` (including the mode and auto usage), `wax pm-loop next <goal>` (shows the suggestions computed now and writes nothing). The CLI cannot switch the mode.
- **Changing limits and resuming:** under the goal's **Limits**, a person sets the per-goal limits and the PM judgment tool (phase runs 1–200, concurrent workers 1–10, hours 1–168, iterations 0–50, blocks in a row 1–20, auto actions per hour 1–120). The 20 headless runs a day are a project-wide limit and cannot be changed. A goal stopped at a limit continues after a person checks the limits under **Resume goal**.
- **Verified scope:** unit tests and browser checks replace the worker and PM judgment runners with fakes. A full PM loop round trip with real AI tools (a worker actually finishing a stage, a judgment tool keeping to the read-only instructions and answering in the fixed JSON schema, auto going all the way with real tools) has not been checked yet. Read-only is enforced only by the instructions, not by changing the tool's permission settings, so deny any write permission request that arrives during a judgment on the execution approvals screen.

## 6-7. Project rules and wiki

### Project rules

**Project rules** are short rules that keep the next session from repeating an AI's mistake. When a review finds a real defect, or when the PM reviews progress, an AI session proposes one with `wax chat rules propose`, citing records of mistakes (tests that failed in review, iteration reasons, blocked tasks). Proposals without evidence and duplicate rules are refused. Once a person approves it in the **Project rules** panel of the dashboard (`/manage`), it goes into every stage prompt (`wax prompt` and the dashboard runner) and into `wax context`; it can be rejected, or retired later. The CLI has no approve command, so an AI never confirms its own rules. The prompt also says to report, not follow, a rule that no longer fits the current code. `wax chat rules lint` lists applied rules whose evidence can no longer be found.

`wax chat rules` lists the applied rules, `--all` adds pending, rejected and retired ones, and `rules candidates` shows mistake records that no rule cites yet. Prompts carry the 20 most recent approved rules. The dashboard panel lists pending approval → applied, with rejected and retired rules folded away, and a rule proposed from the CLI shows up in the panel within a second or two. Records are only ever appended to `.wax/chat/rules.jsonl`.

### Project wiki

The original records stay untouched while AI sessions organize topic pages in `docs/wax/wiki/<page>.md`. A page saves only when every paragraph and list item carries `[근거: <record IDs>]` and every cited record exists. Citable evidence is the record IDs `wax wiki ingest` shows (task `feature:`, stage document `doc:`, decision `note:`/`msg:`, test failed in review `proof:`, iteration reason `iterate:`, blocked task `blocked:`, project rule `rule:`) plus `commit:<hash>` and `file:<path>[#L10-L20]`. wax calls no AI; an AI session organizes the wiki after the daily report or when the CEO asks.

```sh
wax wiki ingest --batch 20          # records not yet in the wiki, oldest first
wax wiki save auth --file auth.md   # save after checking evidence; an existing page needs --base <hash>
wax wiki skip doc:login/plan        # records not worth keeping
wax wiki lint                       # uncited paragraphs and missing evidence (errors), retired rules and files changed since saving (to check)
```

An existing page changes only with the hash read by `wax wiki show` as `--base`, so one session never overwrites another's edit. Cited records count as included and leave the next batch. `lint` reports evidence that disappeared when an iteration replaced a stage document, and cited files changed by a commit after the page was saved. `wax context` lists pages that cite the task, the **Project wiki** panel of the dashboard (`/manage`) shows pages with their check results, and `wax search` and `wax recall` find wiki pages too. The wiki is reference material, so check it against the current code. A test that was not actually run must never be recorded as passed.

## 6-8. Project types and the B1 design studio

Choose a project type on the Requests & reports screen to see the current mission, room, required deliverables and checks. Roblox games and AI lookbooks require checks that fit real play or real generation, storage and product links. **Web service** is chosen automatically from the request or the repository's `package.json` (React, Next.js, Vite, Vue, Svelte, `@playwright/test` and similar), including workspace packages (`workspaces`, `pnpm-workspace.yaml`). React Native, Expo, Electron and Tauri apps are not chosen as web services. It requires screen captures in design, a Playwright test of the core flow (`e2e-smoke`) in implementation, and acceptance tests (`e2e-acceptance`) plus a review of loading, error, empty and mobile screens (`ui-review`) in review. The AI opens screens with `playwright-cli` to explore, reproduce and capture; only `node node_modules/@playwright/test/cli.js test` runs recorded with `wax test` count as evidence. wax runs commands without a shell, so this path works on Windows where `npx` does not. On Windows `playwright-cli` cannot run after `wax capture`'s `--`; capture first and pass only `--file`. `wax capture <task-id> --check <check-id> --file <file> [-- <capture command>]` keeps captures in `.wax/artifacts/`. `wax doctor` shows whether the tools are installed under `browser`. Open the moodboard or Design deliverables in the B1 design studio to see registered previews. When review fails, **Fix and verify again** continues from the implementation stage. Connect a Figma frame or a Blender collection in Design deliverables, and the MCP of the execution tool you choose (Codex or Claude Code) makes the real design; the CEO's revision notes become the next version of the same target, and the approved version is handed off to development. The connection is checked for real in that execution tool. See the [design studio guide](DESIGN_STUDIO.md) (in Korean) for details.

For capture labels (`--viewport`, `--scroll`, `--state`) and same-condition design comparison (`wax compare`), see "Screen captures and design comparison" in section 4.

## 7. Where things are stored and resuming

```text
my-app/
├── .wax/features/email-login.json    # stages, deliverables, evidence, improvement history
└── docs/wax/email-login/             # stage documents written by the coding plugin
```

The source of truth is `.wax/features/*.json`. Don't edit the JSON by hand; use wax commands or the CLI.

Other records live in these places, all inside this project.

| Path | Contents |
| --- | --- |
| `.wax/artifacts/` | Screen captures stored with `wax capture`, with their labels |
| `.wax/chat/` | Team channels, whiteboards, assignments, the PM, presence and the daily report list (section 6) |
| `.wax/chat/requests/` | Automatic-run requests and their conversations (section 6-3) |
| `.wax/chat/triggers/`, `proposals/`, `trigger-state.json`, `trigger-events.jsonl` | Trigger definitions, proposals, check state and every trigger event (section 6-5) |
| `.wax/chat/pm-loop/` | PM loop goals and decision records, PR draft and CEO report draft files (section 6-6) |
| `.wax/chat/rules.jsonl`, `memos.jsonl` | Project rules and work-note memos |
| `.wax/wiki/`, `docs/wax/wiki/` | Wiki ingest state and wiki pages (section 6-7) |
| `.wax/search/index.db` | The search index (a rebuildable copy, section 6-1) |
| `.wax/usage/` | Claude Code usage numbers (section 6, "Claude usage monitor") |
| `docs/wax/daily/<date>/NN.md` | Daily reports |

In a new AI session, load the plugin, check the current state with `/wax:status email-login` (Codex `$wax:status email-login`) and continue from the remaining stage. Saved records stay even after you close each program.

### Backup and restore

Back up with `wax backup > wax-backup.json`, preview the restore with `wax import --file wax-backup.json`, then restore by passing the preview's fingerprint as `--apply <fingerprint>`.

`wax backup` carries the task records (`.wax/features`) together with project rules, work-note memos, assignments, the PM, channels, whiteboards, the daily report list (`.wax/chat`) and the wiki state (`.wax/wiki`). Session presence, running requests, the search index and run approvals are not included. Wiki pages and report documents (`docs/wax`) are repository files, so keep them with git. `wax import` skips a task or record file that already exists in the target project instead of overwriting or merging it, and the preview lists each file's status under `files`. With `--prefix`, only tasks are restored, because record files point to the original task IDs. Record files are kept up to 128 MB in total; beyond that only their size is kept. Backups from earlier versions (task records only) still restore.

Damaged backup originals are kept up to 1 MB per file, 1,000 files and 64 MB of original text in the JSON. Files over the limit keep their size and the reason they were left out, and healthy work keeps being backed up.

### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `WAX_LANG` | system language | CLI language, `en` or `ko` (section 6, "Using the CLI directly") |
| `WAX_CHAT_USER` | 대표 (the CEO) | The person's name used on the dashboard |
| `WAX_DASHBOARD_PORT` | 4330 | Dashboard port (same as `--port`) |
| `WAX_PROJECT` | current directory | The project when `--project` is not given |
| `WAX_TASK_DONE_CHECK` | `warn` | Task done before its stage completes: `warn`, `enforce` or `off` (section 6, "Task completion check") |
| `WAX_REVIEW_SEPARATION` | `warn` | Review completed by the implementing session: `warn`, `enforce` or `off` (section 4, "Reviewer separation") |
| `WAX_MCP` | off | `on` starts the `wax mcp` server (section 6-2) |
| `WAX_APPROVALS` | off | Sends permission requests from a Claude Code session started with `on` to the dashboard ([Managing execution approvals](./APPROVALS.md), in Korean) |
| `WAX_TOOL_NEWS` | on | `off` stops Rina's tool news from checking external releases |
| `WAX_GH_BIN` | `gh` | The `gh` executable GitHub triggers call (section 6-5) |

`WAX_TASK_DONE_CHECK` and `WAX_REVIEW_SEPARATION` follow the value each session and dashboard was started with, so start them all with the same value to apply it to the whole team.

## 8. Troubleshooting

| Symptom | What to check |
| --- | --- |
| `/wax:` commands don't appear | Check that `wax@wax` is enabled in `claude plugin list` (install once), or check the absolute `--plugin-dir` path or the Gemini extension link, then start a new session. |
| Skills don't appear in Antigravity CLI | Check the `.agents/skills` link with `install-project.mjs --project <path> --check`, then start a new `agy` session. |
| Skills don't appear in Grok Build | Check the `.grok/skills` link with `install-project.mjs --project <path> --check` (rerun the link command for projects linked before 0.13.5), then start a new `grok` session. |
| Skills don't appear in Codex | Check the link and the original folder with `install-project.mjs --project <path> --check`, then start a new session. |
| A stage won't move on | Check the current stage document, completion evidence and whether review passed. Implement and review need a linked passing test or commit proof (`--proofs`). |
| Grok Build is missing from the dashboard's execution tools | Grok Build does not support automatic runs or PM loop workers. Ask for skills by name in a terminal session (section 5-4). |
| Browser notifications don't arrive | Check that you pressed **Turn on notifications**, that you allowed notifications in the site settings if the button says **Notifications blocked**, and that a dashboard tab is open. Nothing is notified while you are looking at the tab. |
| A trigger shows **Connection needed** | Check `gh auth status` on this computer; after `gh auth login` it is checked again the next minute. If `gh` is not on the PATH, give its path with `WAX_GH_BIN` and restart the dashboard. |
| Existing GitHub issues are not proposed | The first check only records what is already there as a baseline. Remove the label and add it again (section 6-5). |
| A trigger turned itself off | It turns off after 5 failures in a row. Fix the reason shown in the list, then turn it on again. |
| A PM loop goal stopped | Check the reason on the goal (a limit, blocks in a row, a failed auto action), fix the cause, then check the limits under **Resume goal**. |
| `wax mcp` doesn't start | Check that the registered settings' env has `WAX_MCP=on`, and read the error output of `WAX_MCP=on node /path/to/wax/bin/wax.mjs mcp --project <path>` in a terminal (section 6-2). |
| The CLI speaks English (or Korean) | Set `WAX_LANG=ko` or `WAX_LANG=en`. Without it the CLI follows `LC_ALL`, `LC_MESSAGES` and `LANG`. |
| It still says saving after a crash | wax reclaims a save lock whose owner process has ended at the next save. If one remains, find the lock path with `doctor`, make sure all wax work in that project has finished, then remove the `.wax/features/<id>.lock` directory. |
| (Web service) AI buttons are disabled | Set the provider, model ID and key, then restart the server. |
| (Web service) An AI request shows 401, 403 or 404 | Check the API key, the model name and access to the model. |
| (Web service) An AI request shows 429 | Check the provider's usage limits and billing, then try again later. |
| (Web service) A save conflict appears | Download the draft from the recovery panel or compare it with the latest record, then bring it in again. The server never overwrites the original by itself. |

Rows marked "(Web service)" apply when you also use the wax web service (wax-service).

Check records in one go with `node "/path/to/wax/bin/wax.mjs" doctor --project "/path/to/project"`. It prints the number of healthy records and the problem files and lock paths as JSON. It never changes files or removes locks, and it exits with code 1 if there is a problem.

## 9. Updating and what has been verified

Close the host sessions, back up the existing plugin, and put the new ZIP at the same plugin path. If you installed through a marketplace, use each tool's update command (INSTALL.md). Keep `.wax` and `docs/wax` in your projects. If you changed the plugin yourself, compare and merge your changes before updating.

If you registered the public repository as a marketplace with 0.13.x or earlier, updating may fail because the repository history started over in 0.14.0. Remove the registration and register again (section 1, "0.14.0 public repository note"). For Codex use the switch commands in section 5-1 as they are; for other tools, remove the marketplace with that tool's command, then register and install as on the first install.

Automated checks cover state storage, stage transitions, concurrent-edit conflicts, the CLI, Codex installation and the skill runner, read-only diagnostics, and running after extracting the ZIP. The Claude plugin format and the Gemini command syntax are checked too. Marketplace installation and real command runs were confirmed in Claude Code 2.1, Codex 0.162 and GitHub Copilot CLI 1.0.97. Junction installs, linked runs, Korean paths, stage transitions, test evidence and backups were verified on Windows with Node.js 22.17.0; reproduce them with `npm run test:windows` on Windows. Only versions that pass the checks on Ubuntu, macOS and Windows with Node 22 and 24 are published.

Not verified yet:

- The full process from code changes to final review with a real AI account, real Gemini CLI, Antigravity CLI and Grok Build sessions, and paid API calls.
- A PM loop round trip with real tools (headless workers, PM judgment, auto mode). The tests use fake workers and fake judgments (section 6-6).
- Registering the MCP server in each tool for real. The tests check only the server and the printed snippets (section 6-2).
- Trigger polling against a real GitHub repository. The tests use a fake `gh` (section 6-5).
- Automatic runs with each provider's real account. Approve, deny, stop, continue and report handling were verified with simulated runs of the official CLI protocols (section 6-3).
