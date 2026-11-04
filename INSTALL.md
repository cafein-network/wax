# wax installation guide

**English** · [한국어](./INSTALL.ko.md)

1. If you are online, just follow "One-time install" below. To install from a ZIP, download the plugin ZIP from the [wax site](https://wax.me2shop.com/#download).
2. Run **Extract All** and find the `wax` folder that contains `package.json`, `bin` and `.claude-plugin`. Keep this folder in the same location.
3. Prepare Node.js 22 or newer and a signed-in Codex, Claude Code, Antigravity CLI, GitHub Copilot CLI, Grok Build or Gemini CLI. The plugin works without `npm install`.

## One-time install (recommended)

wax provides the public repository [cafein-network/wax](https://github.com/cafein-network/wax) as a plugin marketplace. Register and install it once per tool, and you can use wax in every project from then on. There is no need to link each project or add options every time you run a tool. Run only the commands for the tools you use.

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

# Gemini CLI (existing users)
gemini extensions install https://github.com/cafein-network/wax
```

- **Update**: Claude Code `claude plugin marketplace update wax` → `claude plugin update wax@wax`, Codex `codex plugin marketplace upgrade wax` → `codex plugin add wax@wax`, GitHub Copilot CLI `copilot plugin update wax@wax`, Gemini CLI `gemini extensions update wax`.
- **Uninstall**: `claude plugin uninstall wax@wax`, `codex plugin remove wax@wax`, `copilot plugin uninstall wax@wax`, `gemini extensions uninstall wax`.
- Each tool installs into its own configuration location, so they do not conflict. Antigravity CLI and Grok Build use [project linking](#project-linking-antigravity-cli--grok-build--codex) below.

### Offline (ZIP) install

The extracted `wax` folder is itself a marketplace. Put the folder path in place of `cafein-network/wax` in the commands above (for example `claude plugin marketplace add "/absolute/path/to/wax"`). For a new version, replace the folder at the same path with the new ZIP, then run `claude plugin update wax@wax` again in Claude Code or `codex plugin add wax@wax` in Codex. GitHub Copilot CLI reads the folder directly, so the change applies from the next session. If you moved the folder, run `plugin marketplace remove wax` in each tool and register the new path again.

## Codex

The Codex marketplace is defined in `.agents/plugins/marketplace.json`; both the repository and the ZIP point to the wax plugin at the same root. Listings for Claude and Copilot are included as well.

### Marketplace registration and lookup errors

`marketplace 'wax' is already added from a different source` means an earlier ZIP path or a different Git address is registered under the name `wax`. First check the source with `codex plugin marketplace list`. To switch to the public GitHub repository, run the commands below one line at a time. If a command fails, do not move on to the next one; check the error first.

```sh
codex plugin marketplace remove wax
codex plugin marketplace add cafein-network/wax
codex plugin add wax@wax
```

Removing the marketplace registration does not delete `.wax` or source files in your work projects.

If the registered source is already `cafein-network/wax` but you get `plugin wax was not found in marketplace wax`, refresh the listing and check that `wax@wax` is among the installable plugins.

```sh
codex plugin marketplace upgrade wax
codex plugin list --marketplace wax --available --json
codex plugin add wax@wax
```

If `wax@wax` is not in the listing, do not keep retrying the install; check `codex --version`, `codex plugin marketplace list` and the listing output above together. For a ZIP source, instead of a Git refresh, extract a new ZIP that contains this definition to the same path. After installing, start a new Codex session.

### Linking a single project only

The one-time install above is recommended. To link only a specific project, run [project linking](#project-linking-antigravity-cli--grok-build--codex) below and then start `codex` in that project.

Check `/skills` in a new Codex session, then use the commands in the chat. The examples below starting with `$` are not terminal commands.

```text
$wax:init
$wax:plan hello Add a welcome message to the first screen
$wax:design hello
$wax:implement hello
$wax:review hello
$wax:report hello
$wax:status hello
$wax:iterate hello Improve edge-case handling
```

Records are stored in the target project's `.wax/features`, so they are shared with Claude, Gemini and the web service. If the new skills don't appear, restart Codex. On versions that cannot find the skills, update Codex and then run the install check command.

## Claude Code

The one-time install above (`claude plugin marketplace add` → `claude plugin install wax@wax`) is recommended. To try it in a single session without installing, run it from the project directory you are coding in, specifying the plugin path.

```sh
claude --plugin-dir "/absolute/path/to/wax"
```

Windows PowerShell example:

```powershell
cd "C:\Projects\my-app"
claude --plugin-dir "C:\Tools\wax"
```

If you run Claude Code in WSL, use a WSL path such as `/mnt/c/Tools/wax` instead of the Windows path `C:\Tools\wax`.

`--plugin-dir` loads the plugin for that session only. If you did the one-time install, start with plain `claude` and run the commands in order in the chat.

```text
/wax:init
/wax:plan hello Add a welcome message to the first screen
/wax:design hello
/wax:implement hello
/wax:review hello
/wax:report hello
```

The first time, `/wax:init` asks for the session name, the work it will take on, whether to open the dashboard and who the PM is (press Enter for the defaults), then joins the team channel. In a project without a PM, the session that ran init becomes the PM by default. Other AI sessions in the same project join with `/wax:join`.

Each command runs one stage. Actual edits and tests use the host's tools and permissions.

## Project linking (Antigravity CLI · Grok Build · Codex)

Antigravity CLI and Grok Build use skills linked into the project instead of a marketplace. Specify the real paths of the extracted plugin (or a repository clone) and of the project you will use. Running it once makes Codex, Antigravity CLI, GitHub Copilot CLI and Grok Build all read the same link.

```sh
node "/absolute/path/to/wax/scripts/install-project.mjs" --project "/absolute/path/to/your-project"
node "/absolute/path/to/wax/scripts/install-project.mjs" --project "/absolute/path/to/your-project" --check
```

| Link location | Tools that read it |
|---|---|
| `.agents/skills/wax-*` | Codex, Antigravity CLI, GitHub Copilot CLI |
| `.grok/skills/wax-*` | Grok Build |

Both locations are links to the 13 skills in the same plugin folder. Linux, macOS and WSL use symbolic links and Windows uses directory junctions, so you must keep the original plugin folder. If either location already has a different skill with the same name, the linker writes to neither location and stops. It does not overwrite other existing skills, `AGENTS.md` or tool settings. `--check` only reads the install state and returns exit code 1 if anything is missing or conflicting. In Windows PowerShell, use the same Node command with Windows paths such as `C:\Tools\wax` and `C:\Projects\my-app`; in WSL, use `/mnt/c/...` paths.

Work records are stored in the project's `.wax/` from any tool and shared. Where each tool installs plugins is decided by that tool, and wax does not change it.

## Antigravity CLI

Antigravity CLI (`agy`) reads skills from the project's `.agents/skills`. Run [project linking](#project-linking-antigravity-cli--grok-build--codex) above, then start it in that project. Projects already linked for Codex do not need to be linked again.

```sh
cd "/absolute/path/to/your-project"
agy
```

Check the 13 skills in `/skills` in a new session. Start with `/init` the first time (if it clashes with the built-in `/init`, say "start with the wax init skill"). Antigravity CLI turns skills into slash commands, so call them by skill name, as in `/plan hello Add a welcome message to the first screen`. Follow the `/skills` list for the actual display names. If a built-in command or another skill has the same name, you can also ask, for example, "run the wax plan stage". Running real Antigravity CLI sessions has not been verified for this release.

`agy plugin install` and `agy plugin import gemini` move or convert the plugin files to a separate location. The wax skills may then fail to find the CLI shipped with them (`bin`, `src`), so use the project linking method above.

## GitHub Copilot CLI

GitHub Copilot CLI (`copilot`, GitHub's coding tool, not Microsoft Copilot) uses the 13 wax skills in every project after the one-time install above (`copilot plugin marketplace add` → `copilot plugin install wax@wax`). It is ready when `wax@wax` appears under Live Plugins in `copilot plugin list`.

Ask for skills by name, as in "use the wax plan skill to plan email sign-in for login". GitHub Copilot CLI has built-in commands such as `/status`, so typing just `/status` may run something other than wax. If an approval prompt to read files in the plugin folder appears on the first run, allow it. Even if you also link `.agents/skills` into the project, the project copy takes precedence for the same names, so they do not appear twice.

## Grok Build

Grok Build (`grok`, xAI's terminal coding tool) reads `.grok/skills`, its official project skill location. Run [project linking](#project-linking-antigravity-cli--grok-build--codex) above, then start it in that project.

```sh
cd "/absolute/path/to/your-project"
grok
```

Check the 13 skills in `/skills` in a new session. Grok Build has built-in commands such as `/plan` (plan mode) and `/code-review`, so typing just `/plan` runs something other than wax. As with GitHub Copilot CLI, name the skill in your request, for example "start with the wax init skill" or "use the wax plan skill to add a welcome message to the first screen for hello". Grok Build also reads Claude Code plugins, so if you installed wax in Claude Code, it may appear without linking. For skills with the same name, only the one in the highest-priority location is used. Grok Build is not yet among the auto-run tools for dashboard requests and reports, so use it for team work in terminal sessions. To update, upgrade Grok Build with `grok update`; for wax, just replace the original folder with the new version. Running real Grok Build sessions has not been verified for this release.

## Gemini CLI (existing users)

Following Google's guidance, [Antigravity CLI](#antigravity-cli) is recommended for individual users. If you already use Gemini CLI with API authentication or an enterprise license, link it as below.

**Authentication notice (checked 2026-10-20):** Gemini CLI access through personal Google sign-in ended on 2026-06-18 (including free, Google AI Pro and Ultra). You need supported API authentication or an existing Gemini Code Assist Standard or Enterprise license; Google's transition notice points to paid API key use and to individual users moving to Antigravity CLI. Sales of new Standard and Enterprise subscriptions also stopped on 2026-10-09. Existing subscriptions follow their contracts and separate end dates. [Individual account sunset](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) · [Transition notice](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [Enterprise subscription schedule](https://docs.cloud.google.com/gemini/docs/codeassist/sunset)

```sh
gemini extensions link "/absolute/path/to/wax"
cd "/absolute/path/to/your-project"
gemini
```

Use the same `/wax:` commands in a new session. Running real Gemini sessions has not been verified for this release.

## Team dashboard

```sh
node "/absolute/path/to/wax/bin/wax.mjs" --project "/absolute/path/to/your-project" dashboard
```

Open `http://127.0.0.1:4330/` in your browser. In an AI session, starting with `/wax:init` joins the team channel and opens the dashboard right away (the first screen is the team channel; requests go through `/start` under **＋ New request**), and other sessions join with `/wax:join`. In each tool you can use `/wax:pm` (advise the CEO, assign work and report progress), `/wax:work` (do assigned work), `/wax:chat` (talk between sessions) and `/wax:daily` (daily work report). In the Codex CLI AI chat, use the `$wax:<command>` form, as in `$wax:work <assignment ID>`. `$` invokes a skill and `@` attaches a file, distinct from `@name` notifications in the wax channel. Antigravity CLI uses the `/<command>` form, and GitHub Copilot CLI and Grok Build take requests that name the skill, as in "use the wax pm skill to …". Run `/wax:init` also to reopen the dashboard or check its address (the former `/wax:dashboard` was merged into init). For Codex, Antigravity CLI and Grok Build, the project linker links 13 skills, so for projects linked earlier, run the linker again to add the new skills and the new location, and delete any remaining `.agents/skills/wax-dashboard` link. See section 6 of the [user guide](docs/USER_GUIDE.en.md) for details.

## Updating and improving it yourself

In 0.16.0 the public repository `cafein-network/wax` was recreated with a new history. The install address is the same, and `.wax` and `docs/wax` in your work projects stay as they are. Release ZIPs from before 0.16.0 are no longer available from GitHub; see the [changelog](https://wax.me2shop.com/changelog/) for the change history. If you installed before 0.16.0, reconnect once as below.

- **Marketplace registration (Claude Code, Codex, GitHub Copilot CLI, Gemini CLI):** if updating fails because of the history mismatch, remove the `wax` marketplace registration (the extension, for Gemini CLI) in that tool, then register and install it again following the "One-time install" section above. For example: `claude plugin marketplace remove wax` → `claude plugin marketplace add cafein-network/wax` → `claude plugin install wax@wax`. `wax update` also recognises this failure and shows that tool's re-register commands (it does not run them for you).
- **Project linking (Antigravity CLI, Grok Build, and Codex or GitHub Copilot CLI when linked):** if `git pull` in the linked clone of the public repository fails because of the history mismatch, delete that clone, clone it again to the same path with `git clone https://github.com/cafein-network/wax.git`, and re-run `node "<clone>/scripts/install-project.mjs" --project "<project>"`. With the same path the existing links point to the new clone as they are; with a different path the linker points the links to the new path.

`node "/path/to/wax/bin/wax.mjs" update` finds every installed tool, compares it with the latest release and runs the update commands below in turn. `--check` only compares (exit code 2 when an update is available), `--tool claude,codex` picks tools, and `--yes` answers the Gemini CLI extension consent prompt for you. Tools installed from a local folder (ZIP) and project links only get instructions; no command is run for them. Antigravity CLI and Grok Build use project links, so the folder you run the command in (or `--project <path>`) is checked. When the program (`agy`, `grok`) is installed but that project has no link, it says "installed, wax not linked in this project" and shows the link command. Restart open sessions after updating.

If you installed from the GitHub marketplace (`cafein-network/wax`), a single update command per tool upgrades it: Claude Code `claude plugin marketplace update wax` → `claude plugin update wax@wax`, Codex `codex plugin marketplace upgrade wax` → `codex plugin add wax@wax`, GitHub Copilot CLI `copilot plugin update wax@wax`, Gemini CLI `gemini extensions update wax`. For project linking (Antigravity CLI, Grok Build), update the linked original folder.

If you installed from a ZIP folder, close the host sessions, back up the existing folder, place the `wax` folder from the new ZIP at the same path, and follow the update steps in the "One-time install" section above. Leave `.wax` and `docs/wax` in your work projects as they are. If you linked skills into a project, check the link with `install-project.mjs --project <project> --check`.

If records cannot be read or you get a storage lock error, check with `node "/path/to/wax/bin/wax.mjs" doctor --project "/path/to/project"`. It lists problem files in `issues` in the JSON and returns exit code 1 if there are problems. A lock does not by itself mean the operation has ended; check for running save operations first.

The source and tests are included in the ZIP. You can improve task state handling in `src/workflow.mjs` and the instructions passed to coding tools in `scripts/build-commands.mjs`.

```sh
npm run build
npm run check
npm test
```

To rebuild the ZIP, run `npm run package` with Python 3.11 or newer. On Windows you can also use `py -3 scripts/package-release.py`. The output is created in `dist/`. To include new files in the release, update the explicit file list in the script.

In Windows PowerShell, `npm run test:windows` checks project-linking junction installs, linked runs, Korean paths, stage transitions, test evidence and backups. It runs in a temporary project inside the plugin and cleans up afterwards, and it passed on Windows with Node.js 22.17.0.

## Cost and verification scope

wax itself is free (AGPL-3.0: anyone can use, modify and distribute it; distribution must follow the source-availability terms, and if you offer a modified version over a network, you must provide the corresponding source to remote users). Claude Code signed in with a subscription follows the host's subscription limits and extra-usage settings. The web service supports the Anthropic, Gemini and OpenAI APIs, and the usage charges and limits of the chosen model and account apply. This ZIP does not include the web service.

Automated checks verify task records, stage transitions, the CLI and running after extracting the ZIP. A real AI editing code end to end and paid API calls were not verified in this release.

More: [User guide](docs/USER_GUIDE.en.md) · [한국어 사용 매뉴얼](docs/USER_GUIDE.md).
