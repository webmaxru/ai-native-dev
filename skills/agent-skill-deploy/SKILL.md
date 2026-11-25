---
name: agent-skill-deploy
description: >
  Deploys agent skill collections from any GitHub repository with a /skills folder
  to one or more distribution surfaces: GitHub releases, Claude Code marketplace,
  VS Code plugin marketplace, and Copilot CLI plugin marketplace. Handles pre-flight
  validation, conventional commit analysis, version bumping across surface configs,
  and surface-specific publishing with dry-run support. Use when releasing, publishing,
  or deploying a skills collection to any supported marketplace or creating a GitHub
  release for a skills repository. Don't use for deploying non-skill packages, npm
  modules, Docker images, or Azure resources.
license: MIT
compatibility: Claude Code, VS Code Copilot, Copilot CLI
allowed-tools: Bash Read Glob Task AskUserQuestion
metadata:
  author: webmaxru
  version: "1.5"
---

# Agent Skill Collection Deploy

## Purpose

Release a skill collection consistently across its configured plugin manifests and GitHub release. The central CI engine automatically validates, versions, tags, and publishes supported repositories after content changes reach `main`. Review-approved bot update PRs can be merged and released automatically when repository variables allow it.

Read [CI automation](references/ci-automation.md) for workflow behavior, safety controls, and recovery. Use the manual procedure below only when automation is unavailable or a maintainer explicitly requests a manual release.

## When to Use

Use this skill to inspect release readiness, understand version selection, prepare release notes, or perform a manual fallback. Do not start a manual release merely because a normal CI release is queued.

## Manual Fallback

1. Run `node scripts/deploy-preflight.mjs` and stop if the repository is dirty, on a non-main branch, or has invalid or inconsistent versions.
2. Run `node scripts/deploy-analyze.mjs` and review the content changes since the latest reachable release tag.
3. Choose a semver bump: breaking changes use major, features use minor, and other publishable changes use patch. Do not bump a skill already advanced since the latest tag.
4. Build concise per-skill notes from merged PR titles and bodies; use commit subjects when PR details are unavailable. Sanitize notes as plain text.
5. Run `node scripts/deploy-execute.mjs VERSION --surfaces github,claude-code,vscode,copilot-cli --dry-run`. Confirm the changes before executing.
6. Only after explicit user approval, run the corresponding command with `--push` and `--notes-file PATH`. Stop and report any push or release failure; do not retry destructive operations in the current checkout.

## Version Invariants

- Keep all plugin version fields and the release tag synchronized.
- Do not bump marketplace `metadata.version`; it versions the marketplace collection independently.
- Bump each changed skill's `metadata.version` unless it already advanced since the last tag.
- Keep marketplace local-plugin `plugins[].version` fields aligned with the plugin manifests.
- Never infer a release from unrelated documentation or website-only changes.

## Error Handling

Stop on malformed metadata, manifests, inconsistent versions, dirty worktrees, or an unexpected branch. Report release API failures clearly; a missing GitHub Release can be repaired by rerunning the central workflow after the tag exists. See [CI automation](references/ci-automation.md) for the approved retry and recovery paths.
