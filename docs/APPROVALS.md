# Managing wax execution approvals

**English** · [한국어](./APPROVALS.ko.md)

The **Execution approval** cards on the dashboard and channel screens show permission requests sent by connected AI tools. Check the command to run, the file changes, the working path, the session and the expiry time, then choose **Allow this time only** or **Deny**. An "allow" written as an ordinary message or a work assignment by an agent is not treated as a permission approval.

## Connecting

First, start the dashboard for the working project.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project dashboard
```

### Claude Code

In the session where you want GUI approvals, set `WAX_APPROVALS=on` and load this version of the wax plugin. The default is off, which keeps the console approval flow. A PowerShell example:

```powershell
$env:WAX_APPROVALS = 'on'
claude
```

`PermissionRequest` and `SessionEnd` are registered in the standard `hooks/hooks.json`, and usage mode is loaded separately from `claude-mods/hooks.json`. After changing the plugin, check with `/reload-plugins` or `/hooks` in a new session that `PermissionRequest` is listed. The hook finds the nearest `.wax` project from the request's working path and checks that the dashboard on the default port 4330 belongs to the same project. If it uses another port, set `WAX_APPROVAL_PORT` to that value in the environment where you start Claude Code. To name the project explicitly, set `WAX_PROJECT`; the request's working path must be inside that project.

If there is no dashboard or it points to a different project, the existing console approval flow is kept. The hook waits up to 30 seconds for a GUI response. It reports the address it is waiting on and the time limit on stderr, and how that is displayed depends on the Claude runtime environment. On expiry or connection errors it never produces an allow response. Starting with `WAX_APPROVALS=off` turns off the wax approval connection. Only the tool-use arguments are stored in the local approval record; the full conversation and transcript files are not read.

The `SessionEnd` hook closes any remaining requests from the same session. Ordinary tool approval requests are supported; requests that do not trigger the `PermissionRequest` hook, such as Claude's sandbox network questions, must be handled in the console. Other hooks and the host's deny policies still apply. [Official Claude approval hook specification](https://code.claude.com/docs/en/hooks#permissionrequest)

### Codex

Run the work with an App Server session that wax connects. This command uses the installed Codex with its sign-in, model and permission settings, and starts real AI work.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project approvals codex --prompt "Run the login tests and find the cause of the failure"
```

Responses are shown in the terminal where you ran it, and execution approvals are handled in the GUI. Use the session ID printed at the end to continue with the next task.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project approvals codex --thread SESSION_ID --prompt "Fix the problem you found"
```

If the executable can't be found, use `--executable` to give the path to `codex.exe`, `codex.js` or an executable Codex binary. With an npm install on Windows, `codex.js` is run with Node instead of a shell string.

Approval requests for command execution and file changes are supported. File changes are shown together with the changes the App Server sent, and are not allowed if there are no changes. Session-wide directory write requests that include `grantRoot` are denied. Network requests show the original request scope, such as host and protocol. Network operations that Codex bundled into one request may be affected together. Allowing a whole session or adding permission rules is not offered.

wax does not attach to separately open Codex TUI or IDE sessions or change their permission settings. For unsupported protocol requests, such as user questions, MCP input and new kinds of permission requests, it never returns an allow and tells you to continue in the original interface. [Official OpenAI App Server specification](https://developers.openai.com/codex/app-server/)

Execution approvals for Gemini CLI, GitHub Copilot CLI and Antigravity CLI are not connected yet. Answer these tools' approval questions in their consoles.

## Status and reconnection

| Display | Meaning |
| --- | --- |
| Awaiting approval | The user has not chosen yet |
| Awaiting response delivery | The choice is saved and waiting for the tool connection to pick it up |
| Delivering response | The tool connection has picked up this response once |
| Response delivered to the tool connection | Writing the response over the host connection finished. Separate from whether the run succeeded |
| Wait expired | The time to respond has passed and it can no longer be approved |
| Request closed | It can no longer be approved because the session, request or connection ended |

Requests and decisions survive a refresh. If you respond from several tabs, only the first saved decision applies. If the screen is stale or there is a network error, check the status again before choosing. When the server restarts, the page reloads the new token and approval state. Buttons are disabled while the connection can't be confirmed.

Claude returns to its original permission flow after 30 seconds without a response. A Codex connection started by wax waits up to 120 seconds and then denies the request. Work started by the request dashboard or the design studio waits for approval for that stage's time limit (30 minutes for requests, 20 minutes for designs) and, with no response in that time, denies without running. If the user stops Codex work with Ctrl+C or the host withdraws the request, the waiting request is closed too. Nothing is re-approved automatically.

To only view approvals from the terminal, use this command.

```sh
node /path/to/wax/bin/wax.mjs --project /path/to/project approvals list
```

## Per-goal allowance in the PM loop

When creating a PM loop goal, if a person checks fixed kinds (wax commands, test commands, writes under `.wax/tmp`, reading project files) under "Allow the same requests during this goal", requests of the same shape from headless workers (Claude Code, Codex) that the goal starts are allowed without going through this screen. They are recorded with `goal-allow:<goal ID>` and the kind and gathered in the **Allowed by the goal allowance n times** group. When a request from that goal's worker matches a kind that is not turned on, an **Allow and allow the same requests during this goal** button appears as well. The test command kind only matches `wax test <task ID> -- <test command>`, so a worker request to run the test command on its own comes to this screen as a normal card without that button. It never applies to hook requests from interactive sessions or to other sessions or goals, and the allowance lives only in the dashboard process memory, so it turns off on restart. The matching rules for each kind are in section 6-6 of the user guide and in the "2c 구현" (2c implementation) section of `docs/design/RECIPES.md`.

## Repeated requests

When a PM loop worker sends the same request within one run as many times as the goal limit **Repeat threshold** (3 by default) or more, the card shows **Same request #3** next to its title and one line with the earlier same request's decision (allowed or denied and by whom, or that it ended without a decision). The same request means the same tool, action and request content (the tool input for Claude Code, the command and folder or the file changes for Codex, the tool call's title and input for Gemini CLI and GitHub Copilot CLI); the session, request ID and time are not compared. Requests allowed by the goal allowance count too. The counts live in the dashboard's memory, and the approval record keeps only `repeatKey` (a hash of the content) and `repeat` (which time it is). Neither is part of the decision fingerprint (`fingerprint`), so they do not change what a decision means. It only shows; nothing is stopped or denied automatically. A dashboard started with `WAX_STUCK_CHECK=off` does not count. Repeated failing tests are described in section 6 of the user guide, "Repeat check".

## Change preview

Cards for file-write requests (Claude Code `Write`, `Edit` and `MultiEdit`, and Codex file changes) carry a collapsed **Change preview**. The summary line shows the number of files and the added and removed line counts; expanding it shows the changed lines with three lines of context. The dashboard computes it when it lists the requests, from the path and content in the request and the current project file (the time is shown, and it is recomputed when the file changes); no AI is called. For Codex requests the received diff is shown as is. Only active requests get a preview, and it is not stored in the approval record.

The current file is read only when its real path is inside the project and it is a regular text file of 256 KB or less. Paths outside the project, link escapes, `.git/`, `.wax/chat/`, `.env*`, binary or large files, `NotebookEdit`, and `Edit` text that is not found or appears in several places show "No preview: <reason>". The preview is never used for allow, deny or goal allowance decisions.

## Deny reason

Under the **Deny** button of an active card there is a collapsed **Add a reason for denying (optional)** field. Denying with it empty works as before. If you write a reason and press **Deny**, the text is stored in the approval record as `denyReason` and shown on the decided card as **Deny reason: …**. Leading and trailing spaces are removed, line breaks and tabs become spaces, other control characters and invisible format characters are removed, and the text is cut at 500 characters. Allow never carries a reason.

- **Claude Code** (the interactive `PermissionRequest` hook, and headless runs from the request dashboard and the PM loop): the reason is added to the deny response `message` after the fixed text as `사람이 남긴 이유: "…"` ("the reason a person left"). It goes in as quoted data, with a note that it is a person's text and not a wax instruction.
- **Codex, Gemini CLI, GitHub Copilot CLI:** their deny responses (`decline`, `reject_once`) have no place for text, so the reason is not delivered. The card and the record show **Reason is recorded only (not delivered to this tool)** (`denyReasonSent: false`).

The reason only enters through the same decision API as allow and deny (`POST /api/approvals/<id>/decision`), with the same Host, Origin and session token checks. Workers and the CLI have no way to write it.

## Storage and permission scope

The original request, the user's choice and the status history are kept in `.wax/approvals/`. At startup and every 60 seconds the dashboard trims completed records to the latest 100, and the screen shows 50 of them. In-progress requests and damaged or other-project records are not deleted automatically. Expired records become eligible for cleanup after a 5-second grace period so they don't conflict with response delivery. Listing itself is read-only, and only records whose file metadata signature changed are re-read and verified. Approval decisions use no cache and re-verify the original inside a lock.

The original arguments may contain sensitive values, so don't push this folder to a public repository. Current work backups do not include approval records. Restoring history never reuses past approvals.

The file snapshots per PM loop worker run (`.wax/chat/snapshots/`) contain uncommitted file contents, so don't push that folder to a public repository either. Only the engine and the dashboard write snapshots; the goal allow kinds `read` and `write` and the approval preview never read or write `.wax/chat/`, so a worker needs a person's run approval to change that folder. It is still not a security boundary within the same OS account (below), so the "Restore to before this run" preview shows the diff of what will actually be written, and a person confirms after reading it. Restore is only available through the dashboard's person API; like run approvals, the CLI and MCP have no way to do it.

GUI responses go through the dashboard's existing Host, Origin and session token checks and a fingerprint of the request content. Each adapter picks up only its own response, once, using a per-request secret. Read APIs never return the secret or its hash. Approval and execution are separate, and wax does not lift a filesystem or administrator forced deny.

wax is a single-user local tool. It provides no separate security boundary between processes that can access the files and the loopback server under the same OS account. Exposing it as an approval server with remote user authentication and role management is not supported.

## Verification

`node --test test/approvals.test.mjs test/approvals-ui.test.mjs test/approval-retention.test.mjs` verifies per-request approval, duplicates, expiry and cancellation, tampering with the original and project separation, HTTP authentication, input and output of a real hook process, the run flow of a mock Codex App Server, the 500-record cache and the retention limit. The UI state checks cover lost responses, double clicks, disconnections, server token renewal and page restoration. Automated tests make no paid model calls.

In the 2026-10-16 verification, registration of both events of the local plugin was confirmed in `/hooks` of real Claude Code 2.1.301. The run check with the installed Codex ended before starting because of a home directory detection error in the runtime environment, so the path from a real model's approval request through execution has not been confirmed yet. The real browser check could not be completed because the Chromium child process exited in the verification environment.

In an environment with an existing Puppeteer and a Chromium-based browser, `node scripts/verify-approvals-browser.mjs <puppeteer module path> <browser executable>` checks the GUI buttons, refresh, expiry, response delivery display and mobile width. Puppeteer is not a runtime dependency of wax.

## Choosing a tool on the request dashboard (0.12.0)

For a new request's execution tool, choose one of the installed tools among Codex, Claude Code, Gemini CLI, GitHub Copilot CLI and Antigravity CLI. Grok Build does not support automatic runs yet, so use it for team work requested from a terminal session by naming the skill. The CLI's sign-in or API settings and the account's usage, cost and data policies apply. A request keeps running with its saved tool; to use another tool, create a new request. New permission requests from Codex, Claude, Gemini and GitHub Copilot CLI are allowed once or denied on screen. Antigravity runs within the scope already allowed, and if a new permission request blocks it, check the settings in the terminal.

The connection methods are the Codex App Server, the Claude Code stream-json control protocol, ACP for Gemini CLI and GitHub Copilot CLI, and Antigravity CLI stream-json. The ACP client provides no file or terminal execution features and uses the CLI's own tools and permission settings. If the tool version does not support the protocol, a connection error is shown and it does not switch to another account.

- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [ACP approvals](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Antigravity headless](https://www.antigravity.google/docs/cli/headless/)
