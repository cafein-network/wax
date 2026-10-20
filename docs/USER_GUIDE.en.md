# wax User Guide

wax splits each feature into **plan → design → implement → review → report** and keeps the documents and completion evidence in your project.

## One-line requests that run on their own (0.12.0)

`init` joins with defaults and opens the dashboard right away. A new request offers two modes.

| Mode | How it starts and runs |
| --- | --- |
| Project | Enter a goal and wax first writes a workflow with scope, task order and dependencies, deliverables and done criteria. Review it on screen and press **Start with this workflow** to move on to design, implementation, review and reporting. A change request rewrites the workflow, and the new version has to be reviewed before it starts. |
| SM · Maintenance | Bug and improvement requests go straight through triage and analysis → impact check → fix → regression check → report. Plan and design documents stay short to match the request, and real test evidence is still required. |

Project mode is selected at first, and after that each project remembers your last choice. You can also open the home screen in a given mode with `init --mode sm` or `init --mode project` (in each host's syntax). A request keeps its mode once created; to use the other mode, create a new request. Older requests without a mode continue as SM. Both modes run in a separate session of the CLI you choose; wax does not spread the work across your existing terminal AIs.

The start guide on the home screen walks you through choosing an execution tool → describing the task → following progress and reports. It checks whether each tool is installed; sign-in is checked when the tool actually runs. After installing a tool, press **Check tools again**.

For a new request, choose an installed execution tool: Codex, Claude Code, Gemini CLI, GitHub Copilot CLI or Antigravity CLI. That CLI's sign-in or API settings, and its account usage, cost and data policies, apply. A request keeps using the tool it was created with; to use another tool, create a new request. New permission requests from Codex, Claude, Gemini and Copilot are allowed once or denied on screen. Antigravity runs within the permissions it already has, and if a new permission request is blocked you need to check its terminal settings. wax never wakes up an existing terminal session or changes another AI's assignment by itself. The PM for automatic runs handles the request and does not replace your project's PM.

- Answer questions in the chat. Extra instructions sent during a run are applied after the current stage finishes. Press **Stop** to halt right away.
- The reason for a stop or error is shown above the request. **Continue** resumes from the saved stage. Restarting the server or viewing a page never calls the AI again.
- Requests run one at a time per project. Implementation and review need real passing test evidence, and a stage changed by another session is reported as a conflict. Each stage may run for up to 30 minutes.
- Records are saved in `.wax/chat/requests/` and stage documents in `docs/wax/<generated ID>/`. Existing tasks and team assignments are still managed in **Detailed records** (`/manage`).
- The general team channel (`/chat`) is for conversation records. To run work automatically, use **Create workflow** (Project) or **Start** (SM) on the home screen. Workflow review is separate from execution approvals; your existing CLI permissions still apply.


## Execution approvals

To answer the permission requests a tool asks in its console from the chat window instead, see [Managing execution approvals](./APPROVALS.md) (in Korean). Only connected requests can be answered, each with its own **Allow once / Deny** buttons.

## Handing over a task

When a new session picks up an existing task, first read the handover context with:

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/my-app context login --budget 3000
```

`login` is the existing task ID. The output shows the goal, the current stage and next action, whiteboard decisions and questions without an answer or decision, execution evidence, improvement reasons and excerpts from stage documents. Each item carries a `.wax/features/<id>.json#/...` or `.wax/chat/board/<id>.jsonl#<note ID>` reference so you can open the source. Stage skills and `work` also tell the AI to read this before starting.

`--budget` counts Unicode characters, not tokens. The default is 3,000 and the range is 1,000–100,000. The shown/total counts and `…` at the end mark omitted items and longer originals. The output is a rule-based excerpt, so also check the latest `status`, the full stage `prompt` and any source you need. Questions are limited to that task's board, and a linked answer does not guarantee the problem is solved. Damaged board records are counted as excluded, and unsafe storage paths or damaged task files are reported as errors.

Reading this is read-only and never calls an external AI. Tests from earlier cycles are kept apart from tests in the current cycle, and each shows the commit and working-tree state at the time it ran. A recorded pass does not guarantee the current code passes, so run the tests again after changes. Archived and completed tasks are never resumed automatically.

## 1. What do I need?

Node.js 22 or later and one signed-in Claude Code, Codex, GitHub Copilot CLI, Gemini CLI or Antigravity CLI. Install wax from the public repository [cafein-network/wax](https://github.com/cafein-network/wax) through each tool's marketplace, or download the ZIP from the [wax site](https://wax.me2shop.com/#download). The release includes the plugin source, tests and this guide. The wax code is licensed under AGPL-3.0 (free to use, change and share; distributions must offer the source, and if you provide a modified version over a network, remote users must be able to get its corresponding source). Usage fees and limits of AI tools and APIs are separate.

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

It joins with a default name and opens the dashboard without setup questions. If exactly one task is in progress it picks that task, otherwise none, and it keeps the existing PM. Name, task and PM options you pass are applied as given. When it finishes, the session has joined the team channel, appears as a character in the virtual office, and shows how other AI sessions join (`/wax:join`). init and join join in the idle state and switch to working when real stage work starts. Run `/wax:init` again later to reopen the dashboard.

Automatic runs are requested in one line on the dashboard home screen. To manage each stage yourself from the terminal, request a feature like this:

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

The next stage opens only when the current stage has its document and completion evidence. Review also needs a confirmed pass. If problems or unverified criteria remain, review does not complete and tells you why. A test that was not actually run must never be recorded as passed.

If review finds problems, improve it like this:

```text
/wax:iterate email-login Reject expired auth tokens
/wax:implement email-login
/wax:review email-login
/wax:report email-login
```

A feature ID starts with a lowercase letter or digit and contains only lowercase letters, digits and hyphens, 1–64 characters. Use names like `email-login`, `dashboard` or `payment-v2`.

## 5. Using Gemini CLI

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

To connect only a specific project, use the installer below. Keep the extracted plugin in the same place afterwards.

```sh
node "/path/to/wax/scripts/install-codex.mjs" --project "/path/to/my-app"
node "/path/to/wax/scripts/install-codex.mjs" --project "/path/to/my-app" --check
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

The installer links the original skills into the project's `.agents/skills/wax-*`. It never overwrites other skills or Codex settings, and running it again is safe. Windows uses directory junctions; Linux and WSL use symbolic links. If the plugin path changes, the check fails, so look at the existing links and connect again. Restart Codex if new skills don't appear.

Stage documents, completion evidence and `.wax/features` records are shared with the other hosts. Codex uses its own sign-in and tool permissions.

## 5-2. Using Antigravity CLI

Antigravity CLI (`agy`) reads skills from the project's `.agents/skills`, so use the installer from section 5-1 as is. If you already connected it for Codex, nothing else is needed.

```sh
node "/path/to/wax/scripts/install-codex.mjs" --project "/path/to/my-app" --check
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

## 6. Team dashboard: AI sessions working together and daily reports

The dashboard shows sessions from every coding tool on one screen in the same way. Each session in the team panel shows its **next command** in that tool's syntax: work if it has an assignment, otherwise the current stage of its task, or status when its task is done, with a copy button to paste it into that session. Choosing a session in the assignment form previews the command it will run, and selecting a character in the virtual office shows the same next command. The "How to call each command" table in Help (`/help`) lists every command.

A session can state its model when joining with `wax chat join --model <model>` (the same tool can switch models). The dashboard and HR record cards show it as "tool · model"; it is the session's own claim.

When sessions from several coding tools (Claude Code, Codex, Gemini CLI, Antigravity CLI, GitHub Copilot CLI) work in the same project, each session's AI joins as a **team member**. Conversations, assignments and daily reports are stored in the project's `.wax/chat/` and appear live on the local dashboard. Detailed records and team channels show those records. When the CEO sends a request from Requests & reports on the home screen, a separate session of the chosen CLI does the work. The guide NPCs in the virtual office (Jake with progress news, Sunny with help and office tips, Jenny with the design studio workflow) speak from project records and the current time. Rina's tool news comes from official public releases, which the server checks once an hour per source. No project, installed version or session information is sent; if a check fails the last data is kept and only the failed source retries, from 5 minutes up to an hour apart. Rate-limit waits are honored, and manual refresh is limited to once a minute. Turn external checks off with `WAX_TOOL_NEWS=off`. NPC guides and character small talk are screen effects and are not recorded. See **Help** (`/help`) on the dashboard for more.

### Opening the dashboard

```sh
node "/path/to/wax/bin/wax.mjs" --project "/path/to/my-app" dashboard
```

This opens `http://127.0.0.1:4330/` (change it with `--port` or `WAX_DASHBOARD_PORT`). In an AI session, `/wax:init` (Codex `$wax:init`, Antigravity `/init`) opens the start guide directly. There is no separate dashboard command; run init again to reopen it later. If the dashboard is already running it just gives you the address; if not, the session starts it in the background or tells you the command to run. `dashboard --status` only checks whether it is running. How to use each screen is in **Help** (`/help`) at the top of the dashboard. The server only listens on this computer (127.0.0.1). Set the person's name used on the web with `WAX_CHAT_USER` (default "대표", the CEO). Switch the screen language with the language menu at the top right (한국어 or English); this browser remembers the choice. The first visit opens in Korean when the browser language is Korean and in English otherwise, and `?lang=ko` or `?lang=en` in the address also sets it. Only the screen text changes: messages, documents, reports and other content written by people and AI sessions are shown as written.

| Screen | Contents |
| --- | --- |
| `/` Requests & reports | One-line requests, automatic runs from planning to the final report, answering questions, stop and resume |
| `/manage` Detailed records | Today's numbers, the virtual office panel, the timeline (stages, evidence, conversations, assignments, reports), team status and "doing now", assignments, task stages, open questions and daily reports |
| `/chat` Channels | Conversations in each task channel and the project-wide channel (general). The CEO can post too |
| `/office` Virtual office | Selecting a character opens its HR record card: front-facing face, department lead or member (no titles; the project name is the department and the PM leads it), level, a hexagon of six skills (plan, design, implement, review, test, communicate, report), bug rate (share of failed tests in my work), bugs found (failed tests during review), commits, work time (accepted → done) and achievement badges. Everything is computed from records (tests and commits count for whoever had accepted the same task and stage at that time), and without records skills start at average (50). AI sessions rise through ranks with the level they earn from records: staff → senior staff → assistant manager → manager → deputy general manager → general manager. The person gives the AI team its work, so they always appear as the CEO regardless of level. The project's PM also carries the team lead (PM) role apart from rank. When new records raise a skill, a glow in that skill's color briefly circles the character's head. The building is seen from the side; from bottom to top, B1 Design studio, 1F Meeting room, 2F Development, 3F Lab, 4F CEO's office and the RF Rooftop garden follow the wax order of work (discuss → implement → review → report). Sessions discussing the same task meet in the meeting room, reviewers go to the lab, the PM sits in the CEO's office, anyone reporting to the PM stands at the desk there, idle sessions chat in the rooftop garden, sessions designing work in the design studio, and everyone else works in development. The room follows each session's current state, not the task stage. The dashboard panel shows the same view |

Changing the date shows that day's records.

### Sessions talking to each other

Start the first session with `/wax:init` and join other AI sessions with `/wax:join` (Codex `$wax:join`, Antigravity `/join`, GitHub Copilot CLI "join with the wax join skill"). Even if you skip init or join, the first wax command a session runs joins it automatically. If the same name is already active (two or more sessions of the same tool in the same folder), the session joins with a number such as `claude-my-app-2` and tells you the name. If repeated inits left earlier sessions holding the name, `/wax:init --reset` (join takes it too) clears them before joining with the default name. Sessions that are listening or working are kept, and the PM role and tasks stay with the name, so the new session that joins under it takes them over. When a joined session runs a wax stage command, it switches to "working" as the stage starts and reads the recent messages in that task's channel. When the stage ends it records the result (done or blocked) on its assignment. The default name is `tool-foldername` (e.g. the Claude session in the `my-app` folder is `claude-my-app`). Characters in the folder name other than letters, digits, spaces, `_`, `.` and `-` become `-`, and the name is cut to 40 characters. To run several sessions of the same tool or rename one, add `--name <name>` to any wax command (e.g. `/wax:join --name claude-front`). The session keeps that name in later commands and joins the channel right away. A name the session used before is marked "away". The name is only remembered within the session's conversation, so set it again in a new session.

You can choose its task at the same time. `/wax:join --name claude-front --feature chatbot` (same as `--project=chatbot`) joins the session in the idle state with the `chatbot` task selected, and later wax commands use that task when you leave out the task ID. init opens the start guide at `http://127.0.0.1:4330/` whether or not a task is selected. That task's records are at `/manage?feature=chatbot`. **Team up with existing AI sessions** on the home screen shows whether there is a PM, assignments and the reasons they are blocked, and the command to paste into each session.

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

**Direct notifications between Claude Code sessions.** Claude Code can message other Claude Code sessions on the same computer directly. A session records its own session name with `--peer` when joining (shown as `session <name>` in `wax chat who`). When you post with another Claude session as a recipient, that session only receives a pointer like `wax: #<channel> <message ID> from <name>`. The content stays in the channel record, so the notified session reads the message from the channel and ignores ones it already handled. When this isn't available it is skipped, and the message still arrives through the channel and listening.

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
wax chat task accept|done|block|cancel <assignment ID> --author <name> --session <ID> [--message <note>]
wax chat daily [--date YYYY-MM-DD]           # timeline
wax chat daily draft | report --file <report.md> | list
```

`wax` means `node "/path/to/wax/bin/wax.mjs"`. The kind (`--kind`) is one of `claude`, `codex`, `copilot`, `gemini`, `antigravity`, `human` or `other`.

| Path | Contents |
| --- | --- |
| `.wax/chat/channels/<channel>.jsonl` | Channel messages (append only) |
| `.wax/chat/board/<task>.jsonl` | Whiteboard notes and report records |
| `.wax/chat/presence.json` | Participant status and what each is doing |
| `.wax/chat/team.json`, `assignments.jsonl` | The PM and assignment and status history |
| `.wax/chat/daily.jsonl`, `docs/wax/daily/<date>/NN.md` | Daily report records and text |

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

Search needs Node.js 22.16 or later, or 24 or later (full-text search in the built-in SQLite). On older Node.js only search shows a notice; every other wax feature keeps working. See the [search guide](SEARCH.md) (in Korean) for details and measurements.

## 7. Where things are stored and resuming

```text
my-app/
├── .wax/features/email-login.json    # stages, deliverables, evidence, improvement history
└── docs/wax/email-login/             # stage documents written by the coding plugin
```

The source of truth is `.wax/features/*.json`. Don't edit the JSON by hand; use wax commands or the CLI.

In a new AI session, load the plugin, check the current state with `/wax:status email-login` (Codex `$wax:status email-login`) and continue from the remaining stage. Saved records stay even after you close each program.

## 8. Troubleshooting

| Symptom | What to check |
| --- | --- |
| `/wax:` commands don't appear | Check that `wax@wax` is enabled in `claude plugin list` (install once), or check the absolute `--plugin-dir` path or the Gemini extension link, then start a new session. |
| Skills don't appear in Antigravity CLI | Check the `.agents/skills` link with the same `install-codex.mjs --project <path> --check` used for Codex, then start a new `agy` session. |
| Skills don't appear in Codex | Check the link and the original folder with `install-codex.mjs --project <path> --check`, then start a new session. |
| A stage won't move on | Check the current stage document, completion evidence and whether review passed. |
| AI buttons are disabled | Set the provider, model ID and key, then restart the server. |
| An AI request shows 401, 403 or 404 | Check the API key, the model name and access to the model. |
| An AI request shows 429 | Check the provider's usage limits and billing, then try again later. |
| A save conflict appears | Download the draft from the recovery panel or compare it with the latest record, then bring it in again. The server never overwrites the original by itself. |
| It still says saving after a crash | Make sure all wax work in that project has finished, then remove the `.wax/features/<id>.lock` directory. |


Check records in one go with `node "/path/to/wax/bin/wax.mjs" doctor --project "/path/to/project"`. It prints the number of healthy records and the problem files and lock paths as JSON. It never changes files or removes locks, and it exits with code 1 if there is a problem.

## 9. Updating and what has been verified

Close the host sessions, back up the existing plugin, and put the new ZIP at the same plugin path. Keep `.wax` and `docs/wax` in your projects. If you changed the plugin yourself, compare and merge your changes before updating.

Automated checks cover state storage, stage transitions, concurrent-edit conflicts, the CLI, Codex installation and the skill runner, read-only diagnostics, and running after extracting the ZIP. The Claude plugin format and the Gemini command syntax are checked too. Marketplace installation and real command runs were confirmed in Claude Code 2.1, Codex 0.162 and GitHub Copilot CLI 1.0.97. Junction installs, linked runs, Korean paths, stage transitions, test evidence and backups were verified on Windows with Node.js 22.17.0; reproduce them with `npm run test:windows` on Windows. The full process from code changes to final review with a real AI account, a real Gemini session and paid API calls have not been verified yet.



### Checking records on the dashboard

The floors and characters of the office are shown as before. Selecting a stat card at the top jumps to the related tasks, assignments or timeline. **Check first** lists blocked assignments, failed test evidence on the selected date, and old open questions, in that order. If a later pass exists for the same task and stage, the earlier failure leaves this list but stays in the timeline. Don't conclude that a whole task failed from a failure record alone.

**View original** shows the full text of questions and decisions shortened in summaries, and **View evidence** shows the saved command, exit code and output in the existing document window. The buttons never rerun the command. Recent decisions and test evidence follow the selected date; assignments and open questions follow all current records.

Even if you switch dates quickly, only the response for the last selected date is applied. If a refresh fails, the last successful records and a retry button stay. Reconnecting rereads session information, and background refreshes never clear an assignment or new task you are typing.


### Session names and rejoining

Keep the `session` returned by `wax chat join --author <name> --session <ID> --json`, and pass `--session <ID>` with every status change, post, report and assignment change for that name. On a 409 error, join again with the same session ID and use the name it returns. PM and assignment roles stay with the name, and a name inactive for 24 hours is taken over by the next session. Records without tokens from earlier versions are handed over on join. CLI records written without join are identified separately, and once a session takes over a name, it cannot be written without the token.

Damaged backup originals are kept up to 1 MB per file, 1,000 files and 64 MB of original text in the JSON. Files over the limit keep their size and the reason they were left out, and healthy work keeps being backed up.

Automatic runs connect using thread/start, thread/resume, turn/start, outputSchema and item/completed from the [official OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
## Project types and the B1 design studio

Choose a project type on the home screen to see the current mission, room, required deliverables and checks. Roblox games and AI lookbooks require checks that fit real play or real generation, storage and product links. Open the moodboard or Design deliverables in the B1 design studio to see registered previews. When review fails, **Fix and verify again** continues from the implementation stage. Connect a Figma frame or a Blender collection in Design deliverables, and the MCP of the execution tool you choose (Codex or Claude Code) makes the real design; the CEO's revision notes become the next version of the same target, and the approved version is handed off to development. The connection is checked for real in that execution tool. See the [design studio guide](DESIGN_STUDIO.md) (in Korean) for details.
