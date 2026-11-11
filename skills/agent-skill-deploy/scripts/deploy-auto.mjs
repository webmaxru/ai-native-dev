#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const PLUGIN_FILES = [
  ".claude-plugin/plugin.json",
  ".github/plugin/plugin.json",
  "package.json",
  ".claude-plugin/marketplace.json",
  ".github/plugin/marketplace.json",
];
const COMPONENT_KEYS = new Set([
  "agents",
  "commands",
  "hooks",
  "mcpServers",
  "skills",
]);
const GITHUB_BOT = "github-actions[bot]";

function command(file, args, cwd, options = {}) {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    if (options.allowFailure) return null;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`${file} ${args.join(" ")} failed: ${detail}`);
  }
}

function git(args, cwd, options) {
  return command("git", args, cwd, options);
}

function gh(args, cwd, { allowMissing = false } = {}) {
  const prefix = process.env.DEPLOY_AUTO_GH_PREFIX
    ? JSON.parse(process.env.DEPLOY_AUTO_GH_PREFIX)
    : [];
  try {
    return command(process.env.DEPLOY_AUTO_GH_BIN || "gh", [...prefix, ...args], cwd);
  } catch (error) {
    if (allowMissing && /\b404\b|not found/i.test(error.message)) return null;
    throw error;
  }
}

function parseArgs(args) {
  const options = { bump: "auto", json: false, dryRun: false, push: false };
  let dryRunRequested = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      dryRunRequested = true;
    }
    else if (arg === "--push") options.push = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--bump" && args[i + 1]) options.bump = args[++i];
    else if (arg === "--notes-file" && args[i + 1]) options.notesFile = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!["auto", "patch", "minor", "major"].includes(options.bump)) {
    throw new Error(`Invalid bump '${options.bump}'; use auto, patch, minor, or major`);
  }
  if (dryRunRequested && options.push) throw new Error("--dry-run and --push cannot be combined");
  if (!options.push) options.dryRun = true;
  return options;
}

function parseVersion(value, label) {
  const match = SEMVER.exec(String(value));
  if (!match) throw new Error(`${label} has invalid version '${value}'; expected X.Y or X.Y.Z`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0), parts: match[3] === undefined ? 2 : 3 };
}

function compareVersions(left, right) {
  const a = parseVersion(left, "Version");
  const b = parseVersion(right, "Version");
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function bumpVersion(value, bump) {
  const version = parseVersion(value, "Version");
  if (bump === "major") return `${version.major + 1}.0${version.parts === 3 ? ".0" : ""}`;
  if (bump === "minor") return `${version.major}.${version.minor + 1}${version.parts === 3 ? ".0" : ""}`;
  if (bump === "patch") return `${version.major}.${version.minor}.${version.patch + 1}`;
  throw new Error(`Cannot directly apply bump '${bump}'`);
}

function safeText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function frontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${file} is missing YAML frontmatter`);
  return match[1];
}

function skillMetadata(text, file, expectedName) {
  const yaml = frontmatter(text, file);
  const name = yaml.match(/^name:\s*["']?([^"'#\r\n]+)["']?\s*$/m)?.[1]?.trim();
  const metadataBlock = yaml.match(/^metadata:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m)?.[1];
  const version = metadataBlock?.match(/^[ \t]+version:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/m)?.[1];
  if (!name || name !== expectedName) {
    throw new Error(`${file} name '${name || "missing"}' must match directory '${expectedName}'`);
  }
  if (!version) throw new Error(`${file} is missing metadata.version`);
  parseVersion(version, `${file} metadata.version`);
  return { name, version };
}

function setSkillVersion(text, file, version) {
  const match = text.match(/(^metadata:\s*\r?\n)((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m);
  if (!match) throw new Error(`${file} has no metadata block`);
  const versionField = /^([ \t]+version:\s*)(["']?)[^'"\r\n]+(["']?)(\s*(?:#.*)?)$/m;
  if (!versionField.test(match[2])) throw new Error(`${file} has no metadata.version field`);
  const updated = match[2].replace(
    versionField,
    (_line, prefix, quoteStart, quoteEnd, suffix) => `${prefix}${quoteStart}${version}${quoteEnd}${suffix}`,
  );
  return text.replace(match[0], `${match[1]}${updated}`);
}

function readJson(file, cwd) {
  const text = readFileSync(join(cwd, file), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is malformed JSON: ${error.message}`);
  }
}

function manifestVersions(cwd) {
  const manifests = [];
  for (const file of PLUGIN_FILES) {
    if (!existsSync(join(cwd, file))) continue;
    const data = readJson(file, cwd);
    if (file.endsWith("marketplace.json")) {
      if (!Array.isArray(data.plugins)) throw new Error(`${file} must contain a plugins array`);
      const local = data.plugins.find((plugin) => plugin.source === "." || plugin.source === "./");
      if (local) {
        parseVersion(local.version, `${file} local plugin version`);
        manifests.push({ file, data, field: "marketplace", version: local.version });
      }
    } else {
      if (typeof data.version !== "string") throw new Error(`${file} must contain a string version`);
      parseVersion(data.version, `${file} version`);
      manifests.push({ file, data, field: "version", version: data.version });
    }
  }
  if (!manifests.length) throw new Error("No plugin version manifests found");
  const versions = [...new Set(manifests.map((item) => item.version))];
  if (versions.length !== 1) {
    throw new Error(`Plugin versions disagree: ${manifests.map((m) => `${m.file}=${m.version}`).join(", ")}`);
  }
  return { manifests, version: versions[0] };
}

function setManifestVersion(manifest, version) {
  if (manifest.field === "marketplace") {
    const local = manifest.data.plugins.find((plugin) => plugin.source === "." || plugin.source === "./");
    local.version = version;
  } else {
    manifest.data.version = version;
  }
  return `${JSON.stringify(manifest.data, null, 2)}\n`;
}

function currentSkillDirs(cwd) {
  const output = git(["ls-files", "-z", "--", "skills"], cwd);
  return [...new Set(output.split("\0").filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path)).map((path) => path.split("/")[1]))];
}

function pathsAtTag(tag, cwd) {
  if (!tag) return new Set();
  return new Set(git(["ls-tree", "-r", "--name-only", "-z", tag], cwd).split("\0").filter(Boolean));
}

function changedPaths(tag, cwd, roots) {
  if (!tag) return new Set(git(["log", "--all", "--format=", "--name-only", "--", ...roots], cwd).split("\n").filter(Boolean));
  return new Set(git(["diff", "--name-only", "-z", `${tag}..HEAD`], cwd).split("\0").filter(Boolean));
}

function componentRoots(cwd) {
  const roots = new Set([
    "skills/",
    "package.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".github/plugin/plugin.json",
    ".github/plugin/marketplace.json",
  ]);
  for (const file of PLUGIN_FILES.slice(0, 2)) {
    if (!existsSync(join(cwd, file))) continue;
    const manifest = readJson(file, cwd);
    for (const [key, value] of Object.entries(manifest)) {
      if (!COMPONENT_KEYS.has(key)) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item !== "string") continue;
        const path = item.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/?$/, "/");
        if (path && !path.startsWith("../") && !path.startsWith("/")) roots.add(path);
      }
    }
  }
  return [...roots];
}

function underRoot(file, root) {
  return root.endsWith("/") ? file.startsWith(root) : file === root;
}

function contentCommits(tag, roots, cwd) {
  const range = tag ? `${tag}..HEAD` : "--all";
  const commits = tag
    ? git(["log", "--format=%H%x00%s", range], cwd)
    : git(["log", "--format=%H%x00%s", "--reverse", "--", ...roots], cwd);
  const records = commits.split("\n").filter(Boolean);
  const results = [];
  for (const record of records) {
    const split = record.indexOf("\0");
    if (split < 0) continue;
    const hash = record.slice(0, split);
    const subject = record.slice(split + 1);
    if (/^chore: version bump SKILLS$/i.test(subject) || /^Release v\d+\.\d+(?:\.\d+)?$/i.test(subject)) continue;
    const names = git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", hash], cwd)
      .split("\0")
      .filter(Boolean);
    const paths = names.filter((file) => roots.some((root) => underRoot(file, root)));
    if (paths.length) results.push({ hash, subject, paths });
  }
  return results;
}

function bumpFromCommits(commits, cwd) {
  for (const { hash, subject } of commits) {
    if (/^[a-z]+(?:\([^)]*\))?!:/.test(subject)) return "major";
    const body = git(["show", "-s", "--format=%b", hash], cwd, { allowFailure: true });
    if (body?.split(/\r?\n/).some((line) => /^BREAKING CHANGE:/.test(line))) return "major";
  }
  if (commits.some(({ subject }) => /^feat(?:\([^)]*\))?:/.test(subject))) return "minor";
  return "patch";
}

function latestTag(cwd) {
  const tag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], cwd, { allowFailure: true });
  if (!tag) return null;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(tag)) {
    throw new Error(`Latest reachable release tag '${tag}' is not semver`);
  }
  parseVersion(tag.slice(1), "Release tag");
  return tag;
}

function safeNotes(commits, skills, cwd, repository) {
  const lines = [];
  const prCache = new Map();
  const ids = new Set();
  for (const skill of skills) {
    const relevant = commits.filter((commit) => commit.paths.some((path) => path.startsWith(`skills/${skill}/`)));
    lines.push(`## ${skill}`);
    if (!existsSync(join(cwd, "skills", skill, "SKILL.md"))) lines.push("- Removed from the collection.");
    for (const commit of relevant) {
      const prId = commit.subject.match(/(?:#|pull request #)(\d+)\)?$/i)?.[1];
      let text = safeText(commit.subject);
      if (prId && !prCache.has(prId)) {
        try {
          const details = gh(["pr", "view", prId, "--repo", repository, "--json", "title,body"], cwd);
          const pr = JSON.parse(details);
          prCache.set(prId, safeText(`${pr.title || ""}${pr.body ? ` — ${pr.body}` : ""}`));
        } catch {
          prCache.set(prId, "");
        }
      }
      if (prId && prCache.get(prId)) {
        text = prCache.get(prId);
        ids.add(prId);
      } else {
        text = `${text} (${commit.hash.slice(0, 8)})`;
      }
      lines.push(`- ${text}`);
    }
    if (!relevant.length) lines.push("- Removed from the collection.");
    lines.push("");
  }
  return { notes: lines.join("\n").trim() || "Automated skills collection release.", pullRequests: [...ids] };
}

function planRelease(cwd, bumpOverride, repository) {
  const tag = latestTag(cwd);
  const roots = componentRoots(cwd);
  const changes = changedPaths(tag, cwd, roots);
  const commits = contentCommits(tag, roots, cwd);
  const lastMessage = git(["log", "-1", "--format=%B", "HEAD"], cwd);
  const skipDirective = /\[skip release\]/i.test(lastMessage);
  const scheduledOrManual = ["schedule", "workflow_dispatch"].includes(process.env.DEPLOY_AUTO_EVENT);
  if (skipDirective && !scheduledOrManual) {
    return { released: false, reason: "head commit contains [skip release]", tag, commits: [], skills: [] };
  }
  const currentDirs = currentSkillDirs(cwd);
  const changedSkills = new Set();
  for (const path of changes) {
    const match = path.match(/^skills\/([^/]+)\//);
    if (match) changedSkills.add(match[1]);
  }
  if (!tag) {
    for (const name of currentDirs) changedSkills.add(name);
  }
  const componentChanged = [...changes].some((file) => roots.some((root) => underRoot(file, root)));
  if (!componentChanged || !commits.length) {
    return { released: false, reason: "no publishable content changed since the latest release", tag, commits: [], skills: [] };
  }

  const { manifests, version: pluginVersion } = manifestVersions(cwd);
  const baseFiles = pathsAtTag(tag, cwd);
  const skills = [];
  for (const name of [...changedSkills].sort()) {
    const file = `skills/${name}/SKILL.md`;
    if (!existsSync(join(cwd, file))) continue;
    const text = readFileSync(join(cwd, file), "utf8");
    const current = skillMetadata(text, file, name).version;
    const baseText = tag && baseFiles.has(file)
      ? git(["show", `${tag}:${file}`], cwd)
      : null;
    const previous = baseText ? skillMetadata(baseText, file, name).version : null;
    if (previous && compareVersions(current, previous) < 0) {
      throw new Error(`${file} version regressed from ${previous} to ${current}`);
    }
    const alreadyBumped = previous && compareVersions(current, previous) > 0;
    skills.push({ name, file, current, previous, next: alreadyBumped ? current : bumpVersion(current, "minor") });
  }

  const commitsBump = bumpFromCommits(commits, cwd);
  let nextPlugin = pluginVersion;
  const tagVersion = tag?.slice(1);
  if (tagVersion && compareVersions(pluginVersion, tagVersion) < 0) {
    throw new Error(`Plugin version ${pluginVersion} regressed below release tag ${tagVersion}`);
  }
  if (!tagVersion || compareVersions(pluginVersion, tagVersion) === 0) {
    nextPlugin = bumpVersion(pluginVersion, bumpOverride === "auto" ? commitsBump : bumpOverride);
  }
  const releaseTag = `v${nextPlugin}`;
  const noteSkills = [...new Set(commits.flatMap((commit) =>
    commit.paths.map((path) => path.match(/^skills\/([^/]+)\//)?.[1]).filter(Boolean)))].sort();
  const notes = safeNotes(commits, noteSkills, cwd, repository);
  return {
    released: true,
    reason: "publishable content changed",
    tag,
    version: nextPlugin,
    releaseTag,
    skills,
    commits,
    roots,
    manifests,
    notes: notes.notes,
    pullRequests: notes.pullRequests,
  };
}

function repositorySlug(cwd) {
  if (process.env.DEPLOY_AUTO_REPOSITORY) return process.env.DEPLOY_AUTO_REPOSITORY;
  const url = git(["remote", "get-url", "origin"], cwd);
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`origin must be a GitHub repository URL; got '${url}'`);
  return match[1];
}

function emit(result, json, error = false) {
  const destination = json ? process.stderr : (error ? process.stderr : process.stdout);
  if (json && !error) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  destination.write(`${error ? "ERROR: " : ""}${result}\n`);
}

function makePreview(plan) {
  return {
    released: plan.released,
    reason: plan.reason,
    previousTag: plan.tag,
    version: plan.version || null,
    tag: plan.releaseTag || null,
    skills: plan.skills.map(({ name, current, next }) => ({ name, current, next })),
    commits: plan.commits.map(({ hash, subject }) => ({ hash: hash.slice(0, 8), subject })),
    notes: plan.notes || "",
  };
}

function releaseExists(tag, repository, cwd) {
  return Boolean(gh(["release", "view", tag, "--repo", repository, "--json", "tagName"], cwd, { allowMissing: true }));
}

function createRelease(tag, notes, notesFile, repository, cwd) {
  const file = notesFile ? resolve(cwd, notesFile) : join(cwd, `.release-notes-${process.pid}.md`);
  writeFileSync(file, `${notes.trim()}\n`, "utf8");
  try {
    if (!releaseExists(tag, repository, cwd)) {
      gh(["release", "create", tag, "--repo", repository, "--title", tag, "--notes-file", file], cwd);
    }
  } finally {
    if (!notesFile && existsSync(file)) rmSync(file);
  }
}

function writeAndCommit(plan, cwd) {
  if (git(["show-ref", "--verify", "--quiet", `refs/tags/${plan.releaseTag}`], cwd, { allowFailure: true }) !== null) {
    throw new Error(`Tag ${plan.releaseTag} already exists locally`);
  }
  for (const skill of plan.skills) {
    const path = join(cwd, skill.file);
    const updated = setSkillVersion(readFileSync(path, "utf8"), skill.file, skill.next);
    writeFileSync(path, updated, "utf8");
  }
  for (const manifest of plan.manifests) {
    writeFileSync(join(cwd, manifest.file), setManifestVersion(manifest, plan.version), "utf8");
  }
  git(["add", "--", ...plan.skills.map((skill) => skill.file), ...plan.manifests.map((manifest) => manifest.file)], cwd);
  const stagedChanges = git(["diff", "--cached", "--quiet"], cwd, { allowFailure: true });
  if (stagedChanges === null) {
    git(["-c", `user.name=${GITHUB_BOT}`, "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m", "chore: version bump SKILLS"], cwd);
  }
  git(["-c", `user.name=${GITHUB_BOT}`, "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "--allow-empty", "-m", `Release ${plan.releaseTag}`], cwd);
  git(["-c", `user.name=${GITHUB_BOT}`, "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "tag", "-a", plan.releaseTag, "-m", plan.releaseTag], cwd);
}

function getRepairPlan(cwd, repository) {
  const tag = latestTag(cwd);
  if (!tag || releaseExists(tag, repository, cwd)) return null;
  const previous = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${tag}^`], cwd, { allowFailure: true });
  const names = previous ? git(["diff", "--name-only", "-z", `${previous}..${tag}`], cwd).split("\0").filter(Boolean) : [];
  const skills = [...new Set(names.map((path) => path.match(/^skills\/([^/]+)\//)?.[1]).filter(Boolean))].sort();
  const commits = git(["log", "--format=%H%x00%s", ...(previous ? [`${previous}..${tag}`] : [tag])], cwd)
    .split("\n").filter(Boolean).map((record) => {
      const pos = record.indexOf("\0");
      const hash = record.slice(0, pos);
      const subject = record.slice(pos + 1);
      const paths = git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", hash], cwd).split("\0").filter(Boolean);
      return { hash, subject, paths };
    }).filter((commit) => !/^chore: version bump SKILLS$/i.test(commit.subject) && !/^Release v/i.test(commit.subject));
  return {
    released: true,
    reason: `repairing missing GitHub release for existing ${tag}`,
    tag: previous,
    version: tag.slice(1),
    releaseTag: tag,
    skills,
    commits,
    notes: safeNotes(commits, skills, cwd, repository).notes,
    repair: true,
  };
}

function assertReady(cwd, pushing) {
  git(["rev-parse", "--git-dir"], cwd);
  if (git(["status", "--porcelain"], cwd)) throw new Error("working tree is not clean");
  if (!pushing) return;
  const branch = git(["branch", "--show-current"], cwd);
  if (!["main", "master"].includes(branch)) throw new Error(`--push requires main or master; current branch is '${branch || "detached"}'`);
}

function runLocal(options, cwd, repository) {
  assertReady(cwd, false);
  const repair = getRepairPlan(cwd, repository);
  const plan = repair || planRelease(cwd, options.bump, repository);
  const preview = makePreview(plan);
  if (options.json) process.stdout.write(`${JSON.stringify(preview)}\n`);
  else process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  if (options.notesFile && !options.dryRun && plan.released) {
    writeFileSync(resolve(cwd, options.notesFile), `${plan.notes}\n`, "utf8");
  }
  return plan;
}

function runPush(options, cwd, repository) {
  assertReady(cwd, true);
  git(["fetch", "origin", "main", "--tags"], cwd);
  const tmp = mkdtempSync(join(tmpdir(), "deploy-auto-"));
  let lastError;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ref = git(["rev-parse", "origin/main"], cwd);
      const target = join(tmp, `target-${attempt}`);
      git(["worktree", "add", "--detach", target, ref], cwd);
      try {
        const repair = getRepairPlan(target, repository);
        const plan = repair || planRelease(target, options.bump, repository);
        if (!plan.released) {
          emit(makePreview(plan), options.json);
          return plan;
        }
        if (!repair) writeAndCommit(plan, target);
        if (!repair) {
          const pushed = git(
            ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${plan.releaseTag}`],
            target,
            { allowFailure: true },
          );
          if (pushed === null) {
            lastError = new Error(`atomic push failed on attempt ${attempt}; recalculating from latest origin/main`);
            const remoteTag = git(["ls-remote", "--tags", "--exit-code", "origin", `refs/tags/${plan.releaseTag}`], target, { allowFailure: true });
            if (!remoteTag) git(["tag", "-d", plan.releaseTag], target, { allowFailure: true });
            git(["fetch", "origin", "main", "--tags"], cwd);
            continue;
          }
        }
        createRelease(plan.releaseTag, plan.notes, options.notesFile, repository, target);
        emit(makePreview(plan), options.json);
        return plan;
      } finally {
        git(["worktree", "remove", "--force", target], cwd, { allowFailure: true });
      }
    }
    throw lastError || new Error("push race retry limit reached");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    git(["worktree", "prune"], cwd, { allowFailure: true });
  }
}

export {
  bumpFromCommits,
  bumpVersion,
  compareVersions,
  manifestVersions,
  parseVersion,
  planRelease,
  safeText,
  setSkillVersion,
  skillMetadata,
  writeAndCommit,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = resolve(".");
  const repository = repositorySlug(cwd);
  if (options.push) {
    runPush(options, cwd, repository);
    return;
  }
  const plan = runLocal(options, cwd, repository);
  if (options.notesFile && !options.dryRun && plan.released) {
    writeFileSync(resolve(cwd, options.notesFile), `${plan.notes}\n`, "utf8");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const json = process.argv.includes("--json");
    if (json) {
      process.stderr.write(`${JSON.stringify({ error: safeText(error.message) })}\n`);
    } else {
      process.stderr.write(`ERROR: ${error.message}\n`);
    }
    process.exitCode = 1;
  });
}
