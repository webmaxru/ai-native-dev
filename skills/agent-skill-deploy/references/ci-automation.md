# CI Release Automation

The reusable workflows live in `webmaxru/ai-native-dev` and are called by the hub and skill-collection repositories. The caller checks out its own repository as the release target and checks out the trusted hub at `hub_ref`; the hub checkout supplies the engine, metadata validator, and ship gate.

## Release

`reusable-skill-release.yml` accepts `bump` (`auto`, `patch`, `minor`, or `major`), `dry_run`, `debounce_minutes`, and `hub_ref`. It reports `released`, `version`, and `tag`. A normal push waits five minutes, then serializes publication and checks out the latest `main`; the scheduled safety net and manual dispatch use no debounce by default. Pull requests run a read-only preview.

`scripts/deploy-auto.mjs` compares publishable content with the latest reachable semver tag, validates skill/plugin versions, bumps changed skills that have not already been bumped, and derives the plugin bump from relevant conventional commits. Release notes are grouped by skill and use merged PR details when available, with commit subjects as fallback. It commits the version changes and release marker separately, atomically pushes the main update and tag, then creates the GitHub Release. A rerun repairs a missing GitHub Release for an existing tag. Push races are recalculated in an isolated worktree up to three times.

The exact `[skip release]` text in the current head commit suppresses a push-triggered release. Scheduled and manual runs ignore the directive, so the weekly safety net can release pending content. Version-only commits made by the engine do not create another release.

## Approve to Ship

`reusable-skill-ship.yml` processes only submitted approvals. It re-queries the pull request and review before merge, and requires a same-repository `github-actions[bot]` update PR titled `[skill-update] ...`, based on `main`, approved by an `OWNER`, `MEMBER`, or `COLLABORATOR` other than the bot. It checks the current reviewed SHA, validates metadata with hub tooling, rejects symlinks/non-file skill entries, and permits changes only under `skills/NAME/`.

When a diff touches other paths, the bot leaves `manual merge required: touches PATHS` and does not merge. A valid draft is marked ready and merged with `--match-head-commit` so a changed head cannot slip through. Ship runs are serialized; GitHub keeps one pending run, and a newer pending approval can replace it. The PR approval remains recorded and can be retried with a new approval. After the merge, the ship workflow explicitly dispatches `release.yml` with `auto_ship=true` only when `AUTO_RELEASE` is enabled; if disabled, it reports that publication was suppressed. The release caller blocks bot-triggered dispatches while disabled but keeps intentional human manual dispatch available. Dispatch failures are reported so the weekly safety net can recover. It never approves on a human's behalf or bypasses repository protections.

## Health and Website

`reusable-repo-health.yml` re-enables local workflows disabled for inactivity, checks the last two scheduled skill-update runs, and flags skill content older than three days without a newer release. It creates or updates one health issue and closes it after recovery. The hub monitors the two public spoke repositories, including disabled schedules. A health workflow that is completely disabled cannot revive itself; the hub's scheduled monitor is the cross-repository backstop, not a guarantee of perpetual execution.

The website builder authenticates GitHub API reads with `GITHUB_TOKEN`, fails rather than publishing an incomplete catalog, and preserves `generatedAt` when catalog content has not changed. Its workflow refreshes every six hours and serializes pushes to `main`, rebuilding after a bounded rebase retry.

## Controls and Recovery

- Set repository variable `AUTO_RELEASE=false` to stop push, scheduled, and approve-to-ship releases; intentional human manual dispatch and read-only previews remain available.
- Set repository variable `AUTO_SHIP=false` to disable approve-to-ship. Human approvals are never bypassed.
- To preview manually, dispatch `release.yml` with `dry_run=true`; for an actual manual dispatch choose the bump and debounce explicitly and leave `auto_ship=false` (the default).
- If a tag exists but its Release does not, rerun `release.yml` or dispatch it manually. The engine repairs the release without adding another version bump.
- For a repeated workflow/API failure, inspect the deduplicated `Automatic skill release failed` issue and workflow run before taking manual action.
