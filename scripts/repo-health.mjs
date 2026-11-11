#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const title = "Skill automation health";
const failures = [];

function gh(args) {
  try {
    const prefix = process.env.REPO_HEALTH_GH_PREFIX
      ? JSON.parse(process.env.REPO_HEALTH_GH_PREFIX)
      : [];
    return execFileSync(process.env.REPO_HEALTH_GH_BIN || "gh", [...prefix, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(error.stderr?.toString().trim() || error.message);
  }
}

function api(path, { allowMissing = false } = {}) {
  try {
    return JSON.parse(gh(["api", path]));
  } catch (error) {
    if (allowMissing && /\b404\b|not found/i.test(error.message)) return null;
    throw error;
  }
}

function paged(path) {
  return JSON.parse(gh(["api", "--paginate", "--slurp", path])).flat();
}

function localScheduledPaths() {
  const directory = join(process.cwd(), ".github", "workflows");
  if (!existsSync(directory)) return new Set();
  return new Set(
    readdirSync(directory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .filter((name) => /^\s{2}schedule:\s*$/m.test(readFileSync(join(directory, name), "utf8")))
      .map((name) => `.github/workflows/${name}`),
  );
}

function contentAge(repo, defaultBranch, latestRelease) {
  let releaseDate = 0;
  if (latestRelease?.tag_name) {
    const tagCommit = api(`repos/${repo}/commits/${encodeURIComponent(latestRelease.tag_name)}`, { allowMissing: true });
    releaseDate = Date.parse(tagCommit?.commit?.committer?.date || tagCommit?.commit?.author?.date || "") || 0;
  }
  const since = releaseDate ? `&since=${encodeURIComponent(new Date(releaseDate).toISOString())}` : "";
  const commits = api(`repos/${repo}/commits?path=skills&sha=${encodeURIComponent(defaultBranch)}&per_page=100${since}`);
  if (!Array.isArray(commits) || !commits.length) return;
  const stale = commits
    .map((commit) => ({
      commit,
      date: Date.parse(commit.commit?.committer?.date || commit.commit?.author?.date || ""),
    }))
    .filter(({ date }) => Number.isFinite(date) && date > releaseDate && (Date.now() - date) / 86_400_000 > 3)
    .sort((left, right) => left.date - right.date)[0];
  if (stale) {
    const ageDays = (Date.now() - stale.date) / 86_400_000;
    failures.push(`- **${repo}** has unreleased skill changes; commit [${stale.commit.sha.slice(0, 7)}](${stale.commit.html_url}) is ${Math.floor(ageDays)} days old.`);
  }
}

async function checkRepository(repo, local) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repository name: ${repo}`);
  const info = api(`repos/${repo}`);
  const workflows = paged(`repos/${repo}/actions/workflows?per_page=100`)
    .flatMap((page) => page.workflows || []);
  const scheduledPaths = local ? localScheduledPaths() : new Set();

  for (const workflow of workflows) {
    const isLocalScheduled = local && scheduledPaths.has(workflow.path);
    if (workflow.state?.startsWith("disabled")) {
      if (isLocalScheduled && workflow.state === "disabled_inactivity") {
        gh(["api", "--method", "PUT", `repos/${repo}/actions/workflows/${workflow.id}/enable`]);
        const refreshed = api(`repos/${repo}/actions/workflows/${workflow.id}`);
        if (refreshed.state?.startsWith("disabled")) {
          failures.push(`- **${repo}** workflow [${workflow.name}](${workflow.html_url}) is still ${refreshed.state} after enable request.`);
        }
      } else {
        failures.push(`- **${repo}** workflow [${workflow.name}](${workflow.html_url}) is ${workflow.state}.`);
      }
    }

    const isWeeklyUpdates = /weekly[- ]skill[- ]updates/i.test(`${workflow.name} ${workflow.path}`);
    if (isWeeklyUpdates) {
      const result = api(`repos/${repo}/actions/workflows/${workflow.id}/runs?event=schedule&per_page=2`);
      const runs = (result.workflow_runs || []).slice(0, 2);
      if (runs.length === 2 && runs.every((run) => ["failure", "cancelled", "timed_out", "action_required"].includes(run.conclusion))) {
        failures.push(`- **${repo}** last two scheduled update runs failed or were cancelled: [${runs[0].conclusion}](${runs[0].html_url}), [${runs[1].conclusion}](${runs[1].html_url}).`);
      }
    }
  }

  const release = api(`repos/${repo}/releases/latest`, { allowMissing: true });
  contentAge(repo, info.default_branch, release);
}

async function main() {
  const currentRepo = process.env.GITHUB_REPOSITORY;
  if (!currentRepo) throw new Error("GITHUB_REPOSITORY is required");
  const watched = (process.env.WATCH_REPOS || "").split(",").map((repo) => repo.trim()).filter(Boolean);
  await checkRepository(currentRepo, true);
  for (const repo of watched) await checkRepository(repo, false);

  const existing = JSON.parse(gh(["issue", "list", "--repo", currentRepo, "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title"]))
    .find((issue) => issue.title === title);
  const report = failures.length
    ? `## Skill automation health findings\n\n${failures.join("\n")}\n\nChecked: ${new Date().toISOString()}`
    : `All monitored skill automation checks are healthy as of ${new Date().toISOString()}.`;

  if (failures.length) {
    if (existing) gh(["issue", "edit", String(existing.number), "--repo", currentRepo, "--body", report]);
    else gh(["issue", "create", "--repo", currentRepo, "--title", title, "--body", report]);
    console.error(report);
  } else if (existing) {
    gh(["issue", "close", String(existing.number), "--repo", currentRepo, "--comment", report]);
    console.log(`Closed recovered health issue #${existing.number}.`);
  } else {
    console.log(report);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await import("node:fs/promises").then(({ appendFile }) =>
      appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, "utf8"));
  }
}

main().catch((error) => {
  console.error(`Repository health check failed: ${error.message}`);
  process.exitCode = 1;
});
