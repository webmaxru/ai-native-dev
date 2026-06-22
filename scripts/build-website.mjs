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
    name: "AI-Native Development Skills",
    repo: "webmaxru/ai-native-dev",
    description: "Core development tools: package management, skill deployment, and agentic workflows",
    pluginAddCmd: "/plugin install ai-native-dev-skills@webmaxru-ai-native-dev",
  },
  {
    name: "Web AI Skills",
    repo: "webmaxru/web-ai-agent-skills",
    description: "Browser AI APIs: Prompt API, language detection, translation, writing assistance, and on-device ML",
    pluginAddCmd: "/plugin install web-ai-skills@webmaxru-ai-native-dev",
  },
  {
    name: "Enonic CMS Skills",
    repo: "webmaxru/enonic-agent-skills",
    description: "Enonic CMS agent skills for content management, API reference, and integrations",
    pluginAddCmd: "/plugin install enonic-skills@webmaxru-ai-native-dev",
  },
];

// ── ARD capability manifest config ────────────────────────────────────
// Identity (host) for the generated ai-catalog.json. Only displayName and
// documentation are asserted here — no unverifiable trust/identity claims.
const ARD_HOST = {
  displayName: "AI-Native Development Skills",
  documentationUrl: "https://github.com/webmaxru/ai-native-dev#readme",
};

// IANA-style media type advertised in each entry's ARD envelope `type` field.
const ARD_SKILL_TYPE = "application/ai-skill";

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

      // Handle multi-line block scalars: >, |, and chomping/indent variants
      // such as >-, >+, |-, |+, |2 (otherwise the indicator leaks into the value).
      if (/^[>|][-+]?\d*$/.test(value)) {
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
    pluginAddCmd: plugin.pluginAddCmd,
    skillCount: skills.length,
    skills,
  };
}

// ── ARD manifest builder ──────────────────────────────────────────────
// Build a stable urn:air: identity from a GitHub "owner/repo" and skill dir.
// Publisher segment is the verifiable FQDN github.com (the trust anchor);
// the namespace is owner:repo and the terminal name is the skill folder.
function buildSkillUrn(repo, dirName) {
  const [owner, repoName] = repo.split("/");
  const seg = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "-");
  return `urn:air:github.com:${seg(owner)}:${seg(repoName)}:${seg(dirName)}`;
}

// Derive simple keyword tags from a skill directory name (e.g.
// "agent-package-manager" -> ["agent", "package", "manager"]).
function deriveTags(dirName) {
  return [
    ...new Set(
      String(dirName)
        .split(/[-_]/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 3)
    ),
  ];
}

// Derive 2–5 representative natural-language queries from a skill description.
// Pulls the "Use when/whenever ..." intent clause and splits it into phrases.
// Returns null when fewer than 2 usable phrases can be extracted (the field is
// optional, but when present the ARD schema requires 2–5 items).
function deriveRepresentativeQueries(description) {
  if (!description) return null;
  const match = description.match(
    /\bUse (?:it |this )?(?:when|whenever)\b(.*?)(?:Don['’]t use|Do NOT use|$)/is
  );
  if (!match) return null;
  const clause = match[1].replace(
    /^\s*the user(?:\s+(?:works with|wants to|is|needs to))?\s*/i,
    ""
  );
  const phrases = clause
    .split(",")
    .map((p) =>
      p
        .replace(/^\s*(?:or|and)\s+/i, "")
        .replace(/[\s.;:—-]+$/g, "")
        .trim()
    )
    .filter((p) => p.length >= 4 && p.length <= 80)
    .filter((p) => !/^(?:including|especially|etc)\b/i.test(p));
  const unique = [...new Set(phrases)];
  return unique.length >= 2 ? unique.slice(0, 5) : null;
}

// Assemble an ARD ai-catalog.json capability manifest from the collected data.
// Every exposed skill becomes one catalog entry (identity = URN, location = url).
function buildArdManifest(catalogData) {
  const entries = [];
  for (const plugin of catalogData.plugins) {
    for (const skill of plugin.skills) {
      const entry = {
        identifier: buildSkillUrn(plugin.repo, skill.dirName),
        displayName: skill.name,
        type: ARD_SKILL_TYPE,
        url: skill.githubUrl,
        description: skill.description,
      };

      const tags = deriveTags(skill.dirName);
      if (tags.length) entry.tags = tags;

      const queries = deriveRepresentativeQueries(skill.description);
      if (queries) entry.representativeQueries = queries;

      if (skill.version) entry.version = String(skill.version);

      const metadata = {};
      if (skill.author) metadata.author = skill.author;
      if (skill.license) metadata.license = skill.license;
      metadata.plugin = plugin.name;
      metadata.repo = plugin.repo;
      entry.metadata = metadata;

      entries.push(entry);
    }
  }

  return {
    specVersion: "1.0",
    host: { ...ARD_HOST },
    entries,
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
    '"__CATALOG_DATA__"',
    JSON.stringify(catalogData)
  );

  const indexPath = resolve(docsDir, "index.html");
  writeFileSync(indexPath, html);
  console.log(`  Written ${indexPath}`);

  // Generate the ARD ai-catalog.json capability manifest for all exposed
  // skills and publish it at the conventional /.well-known/ discovery path.
  const ardManifest = buildArdManifest(catalogData);
  const wellKnownDir = resolve(docsDir, ".well-known");
  mkdirSync(wellKnownDir, { recursive: true });
  const manifestPath = resolve(wellKnownDir, "ai-catalog.json");
  writeFileSync(manifestPath, JSON.stringify(ardManifest, null, 2));
  console.log(`  Written ${manifestPath} (${ardManifest.entries.length} entries)`);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
