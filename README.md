# AI-Native Development Tools

A **plugin marketplace** for AI-native development agent skills, maintained by [Maxim Salnikov](https://github.com/webmaxru).

The marketplace aggregates agent skill plugins from this and other repositories into a single install point. Once installed, your coding agent gains access to every plugin and every skill each plugin provides — no per-skill setup required.

## Contents

- [Available Skills (all plugins)](#available-skills-all-plugins)
- [Website](#website)
- [Install](#install)
  - [Install via Plugin Marketplace (recommended)](#install-via-plugin-marketplace-recommended)
  - [Install Individual Skills](#install-individual-skills)
- [Skills in This Repository](#skills-in-this-repository)
  - [Agent Package Manager](#agent-package-manager)
  - [Agent Skill Deploy](#agent-skill-deploy)
  - [GitHub Agentic Workflows](#github-agentic-workflows)

## Available Skills (all plugins)

Installing the marketplace gives you the following skills across all plugins:

| Plugin | Skills | Source |
|--------|--------|--------|
| **ai-native-dev-skills** | Agent Package Manager · Agent Skill Deploy · GitHub Agentic Workflows | this repo |
| **web-ai-skills** | Prompt API · Language Detector · Translator · Writing Assistance · Proofreader · WebMCP · WebNN | [webmaxru/agent-skills](https://github.com/webmaxru/agent-skills) |
| **enonic-skills** | Enonic CMS agent skills collection | [webmaxru/enonic-agent-skills](https://github.com/webmaxru/enonic-agent-skills) |

## Website

A browsable skills catalog is published as a GitHub Pages site. It aggregates skill metadata (names, descriptions, versions) from all three plugin repositories at build time.

- **Rebuild locally:** `npm run build:website` — fetches live data from GitHub and regenerates `docs/`
- **Automatic rebuild:** a GitHub Actions workflow rebuilds the site on push to `main` (when skill or website files change) and weekly via cron to pick up changes from external repos
- **GitHub Pages:** configure the repository to serve from the `docs/` folder on the `main` branch

| Plugin | Skills | Source |
|--------|--------|--------|
| **ai-native-dev-skills** | Agent Package Manager · Agent Skill Deploy · GitHub Agentic Workflows | this repo |
| **web-ai-skills** | Prompt API · Language Detector · Translator · Writing Assistance · Proofreader · WebMCP · WebNN | [webmaxru/agent-skills](https://github.com/webmaxru/agent-skills) |
| **enonic-skills** | Enonic CMS agent skills collection | [webmaxru/enonic-agent-skills](https://github.com/webmaxru/enonic-agent-skills) |

## Install

### Install via Plugin Marketplace (recommended)

The fastest way to get all plugins at once. Add the marketplace, then install plugins by name.

**GitHub Copilot CLI**

```bash
> /plugin marketplace add webmaxru/ai-native-dev
> /copilot plugin add ai-native-dev-skills@webmaxru/ai-native-dev
> /copilot plugin add web-ai-skills@webmaxru/ai-native-dev
> /copilot plugin add enonic-skills@webmaxru/ai-native-dev
```

**VS Code (GitHub Copilot)**

Add the marketplace by running **Chat: Install Plugin From Source** from the Command Palette and entering:

```
https://github.com/webmaxru/ai-native-dev
```

Or add to your `settings.json`:

```json
"chat.plugins.marketplaces": [
    "webmaxru/ai-native-dev"
]
```

Then open **Agent Plugins** in the Extensions sidebar (`@agentPlugins`), find the plugin you want, and click **Install**.

**Claude Code**

```bash
> /plugin marketplace add webmaxru/ai-native-dev
> /plugin add ai-native-dev-skills@webmaxru/ai-native-dev
> /plugin add web-ai-skills@webmaxru/ai-native-dev
> /plugin add enonic-skills@webmaxru/ai-native-dev
```

### Install Individual Skills

Install specific skills without the marketplace using [APM](https://github.com/microsoft/apm) or npm.

**ai-native-dev-skills** (this repo)

Install with APM:

```bash
apm install webmaxru/ai-native-dev/skills/agent-package-manager
apm install webmaxru/ai-native-dev/skills/agent-skill-deploy
apm install webmaxru/ai-native-dev/skills/github-agentic-workflows
```

Install with npm:

```bash
npx skills add webmaxru/ai-native-dev --skill agent-package-manager
npx skills add webmaxru/ai-native-dev --skill agent-skill-deploy
npx skills add webmaxru/ai-native-dev --skill github-agentic-workflows
```

**web-ai-skills** ([webmaxru/agent-skills](https://github.com/webmaxru/agent-skills))

Install with APM:

```bash
apm install webmaxru/agent-skills/skills/prompt-api
apm install webmaxru/agent-skills/skills/language-detector-api
apm install webmaxru/agent-skills/skills/translator-api
apm install webmaxru/agent-skills/skills/writing-assistance-apis
apm install webmaxru/agent-skills/skills/proofreader-api
apm install webmaxru/agent-skills/skills/webmcp
apm install webmaxru/agent-skills/skills/webnn
```

Install with npm:

```bash
npx skills add webmaxru/agent-skills --skill prompt-api
npx skills add webmaxru/agent-skills --skill language-detector-api
npx skills add webmaxru/agent-skills --skill translator-api
npx skills add webmaxru/agent-skills --skill writing-assistance-apis
npx skills add webmaxru/agent-skills --skill proofreader-api
npx skills add webmaxru/agent-skills --skill webmcp
npx skills add webmaxru/agent-skills --skill webnn
```

**enonic-skills** ([webmaxru/enonic-agent-skills](https://github.com/webmaxru/enonic-agent-skills))

Install with APM:

```bash
apm install webmaxru/enonic-agent-skills/skills/enonic-api-reference
apm install webmaxru/enonic-agent-skills/skills/enonic-content-migration
apm install webmaxru/enonic-agent-skills/skills/enonic-content-type-generator
apm install webmaxru/enonic-agent-skills/skills/enonic-guillotine-query-builder
apm install webmaxru/enonic-agent-skills/skills/enonic-nextxp-integration
apm install webmaxru/enonic-agent-skills/skills/enonic-sandbox-manager
apm install webmaxru/enonic-agent-skills/skills/enonic-webhook-integrator
apm install webmaxru/enonic-agent-skills/skills/enonic-controller-generator
```

Install with npm:

```bash
npx skills add webmaxru/enonic-agent-skills --skill enonic-api-reference
npx skills add webmaxru/enonic-agent-skills --skill enonic-content-migration
npx skills add webmaxru/enonic-agent-skills --skill enonic-content-type-generator
npx skills add webmaxru/enonic-agent-skills --skill enonic-guillotine-query-builder
npx skills add webmaxru/enonic-agent-skills --skill enonic-nextxp-integration
npx skills add webmaxru/enonic-agent-skills --skill enonic-sandbox-manager
npx skills add webmaxru/enonic-agent-skills --skill enonic-webhook-integrator
npx skills add webmaxru/enonic-agent-skills --skill enonic-controller-generator
```

---

## Skills in This Repository

The `skills/` directory contains three agent skills shipped as part of the **ai-native-dev-skills** plugin.

### Agent Package Manager

Installs, configures, audits, and operates [Agent Package Manager (APM)](https://github.com/microsoft/apm) in any repository that uses agent instructions, skills, prompts, or MCP integrations.

**What the agent can do for you:**

- Initialize APM in a new or existing repo (`apm init`)
- Add, update, and remove skill and MCP-server dependencies
- Validate and repair `apm.yml` manifests
- Manage lockfiles for reproducible, team-wide dependency resolution
- Compile agent context and run project scripts
- Set up runtimes, pack bundles for CI, and distribute resolved context

### Agent Skill Deploy

Deploys agent skill collections from any GitHub repository with a `/skills` folder to one or more distribution surfaces.

**What the agent can do for you:**

- Validate git state, skill inventory, and surface readiness before release
- Analyze conventional commits and recommend a version bump
- Bump versions across all detected config files in one pass
- Publish to GitHub Releases, Claude Code marketplace, VS Code plugin marketplace, and Copilot CLI marketplace
- Run dry-run deployments to preview changes without side effects

### GitHub Agentic Workflows

Authors, reviews, installs, and debugs GitHub Agentic Workflows — markdown-based CI/CD automation powered by AI agents.

**What the agent can do for you:**

- Scaffold new agentic workflows from templates
- Configure triggers, safe outputs, network policy, and engine settings
- Set up authentication and repository prerequisites
- Compile, validate, and execute workflows with the `gh aw` CLI
- Diagnose setup, compilation, permissions, and runtime failures

## License

MIT
