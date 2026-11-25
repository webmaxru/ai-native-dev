# Release operations

## Automatic release

Changes to skills or declared plugin content on `main` start `release.yml`. Pushes wait five minutes to collect related merges; the scheduled safety net and manual dispatch use a zero-minute delay unless overridden. Debounce runs are replaceable, while publication is serialized and not cancelled mid-push. The publisher checks out the latest `main` after the wait.

The trusted `deploy-auto.mjs` engine compares publishable file changes with the latest reachable semver tag. It ignores unrelated documentation and website-only changes, increments the plugin version from content-touching conventional commits, and increments changed skill versions unless they are already ahead of the tag. The `[skip release]` directive suppresses a push-triggered release only; scheduled and manual runs ignore it and can publish accumulated content.

The engine creates a version-bump commit followed by a release marker commit, pushes the branch and tag atomically, and creates a GitHub Release with per-skill notes. A non-fast-forward race causes a fresh calculation in an isolated worktree, up to three attempts. A failure after the tag push is visible and retryable: if the tag already exists but its Release does not, the next run repairs the Release without bumping versions again. Failed runs update one open `Automatic skill release failed` issue.

Approve-to-ship runs are serialized per repository. GitHub Actions supports one active and one pending run per concurrency group; a newer pending approval can replace an older pending run. If that occurs, the approval remains recorded on its PR and can be retried by submitting a new approval after the active run finishes.

After a successful merge, approve-to-ship dispatches `release.yml` with `auto_ship=true` only while `AUTO_RELEASE` is enabled. The release caller also treats bot-triggered dispatches as automatic and blocks them when the switch is false. A blocked post-ship release is reported on the merged PR; an intentional human `workflow_dispatch` remains available. The hub dispatches its existing website workflow after a successful release. Spoke releases do not need a cross-repository secret; the hub website's six-hour schedule refreshes their public content.

The dispatch classifier treats `auto_ship=true`, non-`User` senders, and missing sender types as automatic. Automation using a human's personal access token is indistinguishable from that human; it must set `auto_ship=true` to honor this switch.

## Approval gate

Approve-to-ship only handles a newly submitted human approval. The PR must be authored by `github-actions[bot]`, use the `[skill-update] ` title prefix, target `main` in the same repository, and contain only regular-file changes under `skills/NAME/`. The reviewer must be an owner, organization member, or collaborator and cannot be the bot. The gate rechecks the latest approval and reviewed SHA immediately before merging with an explicit head match.

Any out-of-scope path causes the bot to comment `manual merge required: touches PATHS`; the PR remains for a human. After merge, the workflow explicitly dispatches `release.yml`, because a `GITHUB_TOKEN`-created merge does not trigger a push workflow. Dispatch failure is reported; the weekly safety net remains a recovery path.

## Manual fallback

1. Inspect the failed run and its deduplicated issue. Never rerun against a dirty user checkout.
2. For a read-only preview, dispatch `release.yml` with `dry_run=true`.
3. For an existing tag with no Release, rerun or dispatch the release workflow; it repairs only the missing Release.
4. If automation remains unavailable, use the manual steps in [agent-skill-deploy](../../skills/agent-skill-deploy/SKILL.md) after confirming the latest main and tag state.

## Operational limits

`AUTO_RELEASE=false` stops automatic push, scheduled, and approve-to-ship publication but not an intentional human manual dispatch. `AUTO_SHIP=false` stops automatic PR merging. Neither switch grants approval or bypasses branch protections.

Scheduled GitHub Actions workflows can be disabled after prolonged inactivity. The local health workflow re-enables workflows disabled for inactivity, but cannot wake if it is itself completely disabled. The hub health workflow checks the spokes' public workflow state and run history; it cannot enable workflows in another repository using the hub's `GITHUB_TOKEN`.
