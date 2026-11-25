# Skill Ops Center

A Copilot canvas that puts the weekly-update, approve-to-ship, release, health, validation and website flows of every connected repository in one panel: status, runs, pull requests, issues, releases, kill switches and one-click controls. The flows themselves are described in the [skill automation overview](../../automation/README.md).

It has no dependencies and no build step. It talks to GitHub only through your own `gh` login and keeps its settings outside any repository.

## Where to install it

`<copilot-home>` below is `$COPILOT_HOME` when that variable is set, otherwise `~/.copilot` (`%USERPROFILE%\.copilot` on Windows).

| Scope | Folder | Available in |
| --- | --- | --- |
| User (recommended) | `<copilot-home>/extensions/skill-ops-center/` | Every session, in any repository |
| Project | `<repo>/.github/extensions/skill-ops-center/` | Sessions started in that repository, for everyone who has it checked out |

Use the user scope to get the canvas in every repository you work in. It does not depend on the folder you are in: the repositories it monitors are chosen in its own Settings tab ([connect more repositories](#connect-more-repositories)), so one install covers all of them.

This repository carries a project copy, so sessions started here load that copy. Copilot ignores a user copy that has the same name as a project copy, so the two never run together. They share one settings file; keep both on the same version ([update](#install-or-update)). To give another repository's contributors the canvas, copy the folder to `.github/extensions/skill-ops-center/` there and commit it.

## Requirements

- A Copilot client with canvas support, such as the GitHub Copilot app.
- [GitHub CLI](https://cli.github.com/) (`gh`) on the `PATH` of the Copilot process, signed in (`gh auth status`). Every read and write goes through `gh`, so the canvas sees what your login sees. A `GH_TOKEN` or `GITHUB_TOKEN` environment variable overrides the stored login.
- Read access to each connected repository. Writes (dispatching a workflow, approving a pull request, and so on) need the matching permission; GitHub refuses them otherwise and the canvas shows the error. Reading Actions secrets and variables can need extra permission. When GitHub refuses, Needs attention lists an info note ("Could not load secrets"), the matching cells in Settings show "—", the pause toggles of that repository are hidden, and everything else keeps working.

## Install or update

Run from the root of a clone of this repository. The commands copy the extension to the user scope, keep your saved settings (`artifacts/`) and remove files that no longer exist in the source, so the same commands update an existing install.

### PowerShell (Windows)

Windows PowerShell 5.1 or PowerShell 7 on Windows. On macOS or Linux use the bash version, even from PowerShell.

```powershell
$src  = ".github\extensions\skill-ops-center"
$root = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
$dest = Join-Path $root "extensions\skill-ops-center"
New-Item -ItemType Directory -Force $dest | Out-Null
Get-ChildItem $dest -Force | Where-Object Name -ne "artifacts" | Remove-Item -Recurse -Force
Copy-Item "$src\*" $dest -Recurse -Force
```

### bash or zsh

Linux, macOS, or Git Bash on Windows.

```bash
src=.github/extensions/skill-ops-center
dest="${COPILOT_HOME:-$HOME/.copilot}/extensions/skill-ops-center"
mkdir -p "$dest"
find "$dest" -mindepth 1 -maxdepth 1 ! -name artifacts -exec rm -rf {} +
cp -R "$src"/. "$dest"/
```

### Without a full clone

Fetch only the extension folder, then run the command for your shell from the clone root:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/webmaxru/ai-native-dev.git
cd ai-native-dev
git sparse-checkout set .github/extensions/skill-ops-center
```

To update, run `git pull` in that clone and repeat the install command. Then reload extensions (next section). If you also keep a project copy, `git pull` updates it too.

## Reload and verify

Ask Copilot to reload extensions (or start a new session), then to list or inspect `skill-ops-center`. A working install shows ID `user:skill-ops-center`, Source `user`, Status `running`, and a log that ends with `=== ready ===`. Inside this repository the ID is `project:skill-ops-center`.

Then ask Copilot to open the Skill Ops Center canvas. It can open on a given tab: `overview`, `workflows`, `runs`, `prs`, `issues`, `releases`, `skills` or `settings`.

## Use it

| Tab | Shows | Controls |
| --- | --- | --- |
| Overview | Everything that needs attention, the latest result of each flow per repository, upcoming scheduled runs (UTC cron, shown in local time) | Buttons on each finding, such as Release dry run, Resume, Re-run failed jobs |
| Workflows | Triggers, schedule, next and last run, and state of every workflow | Run (with inputs), Enable, History |
| Runs | Recent runs, filterable; the details drawer lists the jobs | Cancel run, Re-run all jobs, Re-run failed jobs |
| Pull requests | Author, state, review and checks, size, age | Mark ready, Approve & ship, Close |
| Issues | Labels, comments, age | Close |
| Releases | Releases, unreleased commits since the latest tag, version-file alignment | Release dry run, Release now |
| Skills | Skills and the weekly update prompts of each repository | Run a weekly update prompt |
| Settings | Kill switches, connected repositories, dashboard options | Pause or resume everything, connect or disconnect a repository, refresh interval |

Ask Copilot buttons post a ready-made prompt, with the repository and link included, into the chat session that opened the canvas. The header button asks for an overview of every connected repository.

From chat, Copilot can use four actions on an open canvas (open one first):

| Action | What it does |
| --- | --- |
| `refresh` | Reloads live status for every connected repository and returns the health summary |
| `get_snapshot` | Compact status of every repository: latest release, unreleased commits, last result of each flow, open pull requests and issues, kill switches, and everything that needs attention |
| `get_attention` | Lists the findings that need attention, with repository, severity, title, detail and link |
| `dispatch_workflow` | Starts a workflow: `repo`, `workflow`, optional `inputs`. A real release needs `confirm` set to the short repository name, so prefer `dry_run=true` |

Example prompts: "What needs attention across my skill repositories?", "Run a release dry run on ai-native-dev", "Open the Skill Ops Center on the Pull requests tab."

## Connect more repositories

Settings > Connected repositories > **Connect repository...** takes `owner/name` and a role:

- **hub** hosts the shared workflows and the release engine.
- **spoke** calls the hub's workflows (the default). A spoke whose callers pin the hub to a ref other than `main` gets a warning.

The canvas checks that the repository is reachable with your `gh` login before it saves it. **Disconnect** only removes it from the dashboard; nothing changes in the repository. At least one repository stays connected.

Flows are recognised by workflow file name: `weekly-skill-updates.yml`, `auto-ship.yml`, `release.yml`, `repo-health.yml`, `validate-skills.yml` and `deploy-website.yml` (`.yaml` works too). A repository that uses other names can still be connected: its workflows, runs, pull requests, issues and releases show up, but without flow labels and flow health checks. Three things to know when you connect repositories that do not run this automation:

- **Release buttons.** Release dry run and Release now appear (on the repository card, the Releases tab and the unreleased-changes finding) only where the repository has a dispatchable `release.yml`. The unreleased-changes finding and its compare link work for any repository that has a regular (not draft, not pre-release) release to compare against.
- **Health issues.** An open issue counts as a health issue only when a bot opened it and its title contains "health", "failure", "failed" or "skill-update"; the health monitor, the weekly failure report and the release failure report all match. Such an issue gets a *health* badge on the Issues tab and a warning with a Close button in Needs attention. Issues opened by people are only listed.
- **Pause everything.** *Pause everything…* and *Resume everything…* (Settings > Kill switches; the header has the same control as Pause automation / Resume automation) set the repository variables `AUTO_RELEASE` and `AUTO_SHIP` to `false` or `true` in every connected repository, whether or not it uses them. A repository where you cannot write variables is reported as a failed update. If you use them, connect only repositories that run this automation. The Pause and Resume buttons on a single repository change one variable in that repository only.

Settings are saved to `<copilot-home>/extensions/skill-ops-center/artifacts/config.json` the first time you change something in Settings. Both the user and the project copy read this one file. Until then, these defaults apply:

```json
{
  "refreshSec": 90,
  "repos": [
    { "repo": "webmaxru/ai-native-dev", "role": "hub" },
    { "repo": "webmaxru/web-ai-agent-skills", "role": "spoke" },
    { "repo": "webmaxru/enonic-agent-skills", "role": "spoke" }
  ]
}
```

Invalid values are dropped: `repo` must look like `owner/name`, any role other than `hub` becomes `spoke`, and `refreshSec` must be 30 to 900 or it becomes 90. If no valid repository is left, the defaults above return. To reset, delete `config.json`. A `config.json` that is not valid JSON is ignored, and the next save from Settings replaces it.

## Uninstall

Removes the user copy. This also deletes your saved settings; to keep them, delete everything in that folder except `artifacts`. Reload extensions afterwards.

### PowerShell (Windows)

```powershell
$root = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
Remove-Item -Recurse -Force (Join-Path $root "extensions\skill-ops-center")
```

### bash or zsh

```bash
rm -rf "${COPILOT_HOME:-$HOME/.copilot}/extensions/skill-ops-center"
```

## What it can and cannot do

- The UI is served on `127.0.0.1` only, on a random port. Every API call needs a per-panel token, and closing the panel stops the server.
- The extension does nothing until a canvas is opened. An open panel refreshes on the interval set in Settings > Dashboard (default 90 s), and each refresh makes `gh` calls.
- `gh` is its only network path. Only the names of Actions secrets are read.
- Writes are limited to: dispatch or enable a workflow; cancel or re-run a workflow run; mark a pull request ready, approve it, or close it (optionally deleting its branch); close an issue; set the `AUTO_RELEASE` and `AUTO_SHIP` repository variables. It never merges, pushes or edits files itself. The workflows it starts do that.
- Guards: a real release and Approve & ship need the short repository name typed in (for example `ai-native-dev`); pause and resume everything need `PAUSE` or `RESUME`; other writes ask for confirmation. Dispatch is limited to dispatchable workflows with validated inputs, and `auto_ship` is rejected because it is reserved for the approve-to-ship automation.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The canvas is not listed after installing | Reload extensions or start a new session. Check that `extension.mjs` sits directly in `<copilot-home>/extensions/skill-ops-center/`, not in a nested `skill-ops-center/skill-ops-center/`. Ask Copilot to inspect `skill-ops-center`; a failed start shows the log tail |
| An update is not visible in sessions started in this repository | The project copy wins here. `git pull` updates it. The user copy only applies outside this repository |
| "Repository could not be loaded": `Not Found` | The name is wrong, or the active `gh` account cannot see the repository |
| "Repository could not be loaded": `spawn gh ENOENT` | `gh` is not on the `PATH` of the Copilot process. Install it, then restart the Copilot app |
| "Repository could not be loaded": `Bad credentials` | A `GH_TOKEN` or `GITHUB_TOKEN` environment variable holds an invalid token and overrides your stored login. Fix or unset it, then restart the Copilot app |
| "Could not load secrets" or "Could not load variables" | Your account cannot read them. Informational; the rest works. The note is listed in Needs attention. Without secrets, the token cell in Settings shows "—". Without variables, the kill-switch cells show "—" and the pause toggles of that repository are hidden |
| Wrong GitHub account | Settings > Dashboard shows the account in use. `gh auth status` shows the active login and `gh auth switch` changes it. An environment token wins over both |
| Rate-limit errors | Settings > Dashboard shows the REST and GraphQL quota. Raise the auto-refresh interval there |
| Settings look wrong | Delete `config.json` (see above) |

## Development scripts

Run from the extension folder. They need Node and a signed-in `gh`, and they use temporary settings folders, so they never touch your real settings.

| Command | Purpose |
| --- | --- |
| `node scripts/serve.mjs` | Serves the UI standalone against live GitHub and prints `READY <url>`. Ask Copilot prompts print as `ASK: ...`. `XSS=1` injects hostile strings. Stop with Ctrl+C |
| `node scripts/smoke-ui.mjs <url> [xss]` | Drives the UI in headless Edge; needs `serve.mjs` running. Set `EDGE_PATH` to `msedge.exe` when Edge is not in its default Windows location |
| `node scripts/smoke-server.mjs` | End-to-end test of the loopback server and the action layer; read-only against GitHub. `LIVE_DRY_RUN=1` also dispatches one real release dry run on the hub |
| `node scripts/smoke-data.mjs` | Prints cron descriptions and live collection timing for the default repositories |
