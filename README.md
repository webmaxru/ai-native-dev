# AI-Native Development Tools

Plugin marketplace for AI-native development agent skills, maintained by [Maxim Salnikov](https://github.com/webmaxru).

This marketplace aggregates agent skill plugins from multiple repositories into a single install point.

## Install

### Claude Code

```bash
/plugin marketplace add webmaxru/ai-native-dev
```

### VS Code (GitHub Copilot)

Run **Chat: Install Plugin From Source** from the Command Palette and enter:

```
https://github.com/webmaxru/ai-native-dev
```

Or add to your `settings.json`:

```json
"chat.plugins.marketplaces": [
    "webmaxru/ai-native-dev"
]
```

Then browse **Agent Plugins** in the Extensions sidebar (`@agentPlugins`).

### GitHub Copilot CLI

```bash
copilot plugin marketplace add webmaxru/ai-native-dev
```

## Available Plugins

| Plugin | Description | Source |
|--------|-------------|--------|
| `ai-native-dev-skills` | Agent skills for package management, skill deployment, and GitHub Agentic Workflows (this repo) | [webmaxru/ai-native-dev](https://github.com/webmaxru/ai-native-dev) |
| `web-ai-skills` | Browser Web AI APIs (Prompt API, Language Detector, Translator, Writing Assistance, Proofreader, WebMCP, WebNN) and AI-native workflows | [webmaxru/agent-skills](https://github.com/webmaxru/agent-skills) |
| `enonic-skills` | Enonic agent skills collection | [webmaxru/enonic-agent-skills](https://github.com/webmaxru/enonic-agent-skills) |

## Included Skills

Skills shipped in this repository under `skills/`:

### Agent Package Manager

`skills/agent-package-manager` — Installs, configures, audits, and operates [Agent Package Manager (APM)](https://github.com/microsoft/apm) in repositories that use agent instructions, skills, prompts, or MCP integrations.

It covers:

- Assessing existing APM state across `apm.yml`, `apm.lock.yaml`, tool config folders, and installed modules before making changes
- Shaping or repairing `apm.yml` deliberately, including package dependencies, MCP servers, scripts, and reproducible dependency forms
- Using `apm install`, `apm deps`, and dry-run flows to manage packages and lockfiles without guesswork
- Validating when `apm compile` is useful, when install-only flows are sufficient, and how explicit targets affect generation
- Operating scripts, runtimes, pack and unpack workflows, and CI-oriented distribution paths

Support files: `references/manifest-and-lockfile.md`, `references/command-workflows.md`, `references/troubleshooting.md`, `assets/apm.yml.template`.

### Agent Skill Deploy

`skills/agent-skill-deploy` — Deploys agent skill collections from any GitHub repository with a `/skills` folder to one or more distribution surfaces: GitHub releases, Claude Code marketplace, VS Code plugin marketplace, and Copilot CLI plugin marketplace.

It covers:

- Pre-flight validation of git state, skills inventory, and surface readiness
- Conventional commit analysis with version bump recommendation
- Version bumping across all detected surface configuration files
- Surface-specific deployment with dry-run capability
- User approval gates before irreversible operations

Supported surfaces: GitHub releases (`gh`), Claude Code (`.claude-plugin/`), VS Code (`package.json` / `vsce`), Copilot CLI.

Support files: `references/surfaces.md`, `scripts/deploy-analyze.mjs`, `scripts/deploy-execute.mjs`, `scripts/deploy-preflight.mjs`.

### GitHub Agentic Workflows

`skills/github-agentic-workflows` — Authors, reviews, installs, debugs, and operates GitHub Agentic Workflows in repositories, including workflow markdown, frontmatter, `gh aw` compile and run flows, safe outputs, security guardrails, and operational patterns.

It covers:

- Identifying whether a repository already uses GH-AW and locating its active workflow surfaces
- Creating or revising workflow markdown, frontmatter, and compile-time configuration
- Choosing safe outputs, network policy, authentication, and lockdown settings with least privilege
- Validating, compiling, running, and auditing workflows with the `gh aw` CLI
- Diagnosing common setup, compilation, permissions, network, and engine failures

Support files: `references/authoring.md`, `references/examples.md`, `references/security-and-operations.md`, `references/troubleshooting.md`, `assets/workflow.template.md`, `scripts/find-gh-aw-targets.mjs`.

## Adding More Plugins

To add a plugin from another repository, add an entry to `.claude-plugin/marketplace.json`:

```json
{
  "name": "your-plugin-name",
  "description": "...",
  "source": {
    "source": "github",
    "repo": "owner/repo"
  }
}
```

## License

MIT
