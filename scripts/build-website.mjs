#!/usr/bin/env node

/**
 * Build script for the skills catalog website.
 * Fetches SKILL.md frontmatter from 3 GitHub repos at build time,
 * generates docs/data/skills.json and docs/index.html.
 */

import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Plugin definitions ────────────────────────────────────────────────
const PLUGINS = [
  {
    name: "ai-native-dev-skills",
    repo: "webmaxru/ai-native-dev",
    description: "Core development tools: package management, skill deployment, and agentic workflows",
  },
  {
    name: "web-ai-skills",
    repo: "webmaxru/agent-skills",
    description: "Browser AI APIs: Prompt API, language detection, translation, writing assistance, and on-device ML",
  },
  {
    name: "enonic-skills",
    repo: "webmaxru/enonic-agent-skills",
    description: "Enonic CMS agent skills for content management, API reference, and integrations",
  },
];

// ── Frontmatter parser (no external deps) ─────────────────────────────
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result = {};
  let currentIndentKey = null;

  for (const line of yaml.split(/\r?\n/)) {
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Nested key (2-space indent)
    const nestedMatch = line.match(/^  (\w[\w-]*):\s*"?([^"]*)"?\s*$/);
    if (nestedMatch && currentIndentKey) {
      if (typeof result[currentIndentKey] !== "object") {
        result[currentIndentKey] = {};
      }
      result[currentIndentKey][nestedMatch[1]] = nestedMatch[2].trim();
      continue;
    }

    // Top-level key
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (topMatch) {
      const key = topMatch[1];
      let value = topMatch[2].trim();

      // Handle multi-line description with >
      if (value === ">" || value === "|") {
        currentIndentKey = key;
        result[key] = "";
        continue;
      }

      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
      currentIndentKey = key;
    } else if (currentIndentKey && typeof result[currentIndentKey] === "string") {
      // Continuation line for multi-line scalar
      result[currentIndentKey] += (result[currentIndentKey] ? " " : "") + line.trim();
    }
  }

  return result;
}

// ── GitHub fetcher ────────────────────────────────────────────────────
async function fetchJSON(url) {
  const headers = { Accept: "application/json", "User-Agent": "ai-native-dev-website-builder" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchText(url) {
  const headers = { "User-Agent": "ai-native-dev-website-builder" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchPluginSkills(plugin) {
  const [owner, repo] = plugin.repo.split("/");
  console.log(`  Scanning ${plugin.repo}/skills/ ...`);

  const entries = await fetchJSON(
    `https://api.github.com/repos/${owner}/${repo}/contents/skills`
  );
  const dirs = entries.filter((e) => e.type === "dir");

  const skills = [];
  for (const dir of dirs) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/skills/${dir.name}/SKILL.md`;
    try {
      const md = await fetchText(rawUrl);
      const fm = parseFrontmatter(md);

      const name = fm.name || dir.name;
      const description = fm.description || "";
      const version = fm.metadata?.version || fm.version || null;
      const author = fm.metadata?.author || fm.author || null;
      const license = fm.license || null;

      // Extract first sentence of description as short description
      const shortDesc = description.split(/\.\s/)[0] + (description.includes(". ") ? "." : "");

      skills.push({
        name,
        dirName: dir.name,
        description,
        shortDescription: shortDesc.length < description.length ? shortDesc : description,
        version,
        author,
        license,
        githubUrl: `https://github.com/${owner}/${repo}/tree/main/skills/${dir.name}`,
        installCmd: `apm install ${owner}/${repo}/skills/${dir.name}`,
      });

      console.log(`    ✓ ${name}${version ? ` v${version}` : ""}`);
    } catch (err) {
      console.warn(`    ✗ ${dir.name}: ${err.message}`);
    }
  }

  return {
    name: plugin.name,
    repo: plugin.repo,
    repoUrl: `https://github.com/${plugin.repo}`,
    description: plugin.description,
    skillCount: skills.length,
    skills,
  };
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log("Building skills catalog website...\n");

  // Fetch skill data from all repos
  const plugins = [];
  for (const plugin of PLUGINS) {
    const data = await fetchPluginSkills(plugin);
    plugins.push(data);
  }

  const totalSkills = plugins.reduce((sum, p) => sum + p.skillCount, 0);
  console.log(`\n  Total: ${totalSkills} skills across ${plugins.length} plugins\n`);

  const catalogData = {
    generatedAt: new Date().toISOString(),
    totalSkills,
    plugins,
  };

  // Ensure output directories exist
  const docsDir = resolve(ROOT, "docs");
  const dataDir = resolve(docsDir, "data");
  mkdirSync(dataDir, { recursive: true });

  // Write JSON data
  const jsonPath = resolve(dataDir, "skills.json");
  writeFileSync(jsonPath, JSON.stringify(catalogData, null, 2));
  console.log(`  Written ${jsonPath}`);

  // Read template and inject data
  const templatePath = resolve(ROOT, "website", "template.html");
  let html = readFileSync(templatePath, "utf-8");
  html = html.replace(
    "/*__CATALOG_DATA__*/",
    JSON.stringify(catalogData)
  );

  const indexPath = resolve(docsDir, "index.html");
  writeFileSync(indexPath, html);
  console.log(`  Written ${indexPath}`);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
