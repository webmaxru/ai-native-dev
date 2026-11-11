import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bumpFromCommits,
  bumpVersion,
  compareVersions,
  planRelease,
  safeText,
  setSkillVersion,
  skillMetadata,
  writeAndCommit,
} from "../skills/agent-skill-deploy/scripts/deploy-auto.mjs";

const engine = fileURLToPath(new URL("../skills/agent-skill-deploy/scripts/deploy-auto.mjs", import.meta.url));
const healthScript = fileURLToPath(new URL("../scripts/repo-health.mjs", import.meta.url));
const tempPaths = [];

function command(file, args, cwd, env = process.env) {
  return execFileSync(file, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(cwd, path, text) {
  const file = join(cwd, path);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function skill(version = "1.0") {
  return `---\nname: sample-skill\ndescription: >-\n  Installs useful tooling when a skill collection needs a release.\nmetadata:\n  version: "${version}"\n---\n\n# Sample\n\nInitial content.\n`;
}

function manifests(version = "1.0.0") {
  return {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "sample", version }, null, 2) + "\n",
    ".github/plugin/plugin.json": JSON.stringify({ name: "sample", version, skills: "skills/" }, null, 2) + "\n",
    "package.json": JSON.stringify({ name: "sample", version }, null, 2) + "\n",
    ".claude-plugin/marketplace.json": JSON.stringify({
      metadata: { version: "2.0.0" },
      plugins: [{ name: "sample", source: ".", version }],
    }, null, 2) + "\n",
    ".github/plugin/marketplace.json": JSON.stringify({
      metadata: { version: "2.0.0" },
      plugins: [{ name: "sample", source: ".", version }],
    }, null, 2) + "\n",
  };
}

function fixture({ tag = true, bare = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deploy-auto-test-"));
  tempPaths.push(root);
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  command("git", ["init", "-b", "main"], cwd);
  command("git", ["config", "user.name", "Test User"], cwd);
  command("git", ["config", "user.email", "test@example.invalid"], cwd);
  write(cwd, "skills/sample-skill/SKILL.md", skill());
  for (const [path, content] of Object.entries(manifests())) write(cwd, path, content);
  command("git", ["add", "."], cwd);
  command("git", ["commit", "-m", "chore: baseline"], cwd);
  if (tag) {
    command("git", ["tag", "-a", "v1.0.0", "-m", "v1.0.0"], cwd);
  }
  if (bare) {
    const remote = join(root, "remote.git");
    command("git", ["init", "--bare", remote], root);
    command("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], root);
    command("git", ["remote", "add", "origin", remote], cwd);
    command("git", ["push", "-u", "origin", "main", "--tags"], cwd);
    const ghState = join(root, "gh-state");
    writeFileSync(ghState, "v1.0.0\n", "utf8");
    const ghMock = join(root, "gh-mock.mjs");
    writeFileSync(ghMock, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const releases = process.env.GH_MOCK_RELEASES;
const failFlag = process.env.GH_MOCK_FAIL_CREATE_ONCE;
const tag = args[2];
if (args[0] === "release" && args[1] === "view") {
  if (readFileSync(releases, "utf8").split(/\\r?\\n/).includes(tag)) process.stdout.write(JSON.stringify({ tagName: tag }));
  else { process.stderr.write("HTTP 404: release not found"); process.exit(1); }
} else if (args[0] === "release" && args[1] === "create") {
  if (failFlag && !existsSync(failFlag)) {
    writeFileSync(failFlag, "failed");
    process.stderr.write("simulated release API failure");
    process.exit(1);
  }
  appendFileSync(releases, tag + "\\n");
  process.stdout.write("created " + tag);
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" "));
  process.exit(2);
}
`, "utf8");
    return { root, cwd, remote, ghState, ghMock };
  }
  return { root, cwd };
}

function commit(cwd, message, files = ["skills/sample-skill/SKILL.md"]) {
  command("git", ["add", "--", ...files], cwd);
  command("git", ["commit", "-m", message], cwd);
}

function environment(fixtureData, extra = {}) {
  return {
    ...process.env,
    DEPLOY_AUTO_REPOSITORY: "webmaxru/fixture",
    DEPLOY_AUTO_GH_BIN: process.execPath,
    DEPLOY_AUTO_GH_PREFIX: JSON.stringify([fixtureData.ghMock]),
    GH_MOCK_RELEASES: fixtureData.ghState,
    ...extra,
  };
}

test.after(() => {
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
});

test("semantic version helpers support two- and three-part versions", () => {
  assert.equal(bumpVersion("1.5", "minor"), "1.6");
  assert.equal(bumpVersion("1.5", "major"), "2.0");
  assert.equal(bumpVersion("1.5.2", "patch"), "1.5.3");
  assert.equal(compareVersions("1.5", "1.5.0"), 0);
  assert.throws(() => bumpVersion("01.5.0", "patch"), /invalid version/);
  assert.equal(bumpFromCommits([{ hash: "x", subject: "fix!: remove setting" }], process.cwd()), "major");
  assert.equal(bumpFromCommits([{ hash: "x", subject: "feat: add setting" }], process.cwd()), "minor");
});

test("safe notes remove control characters and skill version edits preserve frontmatter", () => {
  assert.equal(safeText("line one\nline\t two\u0000"), "line one line two");
  const text = skill("1.0");
  const updated = setSkillVersion(text, "SKILL.md", "1.1");
  assert.equal(skillMetadata(updated, "SKILL.md", "sample-skill").version, "1.1");
  assert.match(updated, /version: "1\.1"/);
});

test("content commits select the plugin bump and already-bumped skills are not bumped twice", () => {
  const { cwd } = fixture();
  write(cwd, "skills/sample-skill/SKILL.md", `${skill("1.1")}\nAdded a new capability.\n`);
  commit(cwd, "feat: add skill capability");
  const plan = planRelease(cwd, "auto", "webmaxru/fixture");
  assert.equal(plan.version, "1.1.0");
  assert.deepEqual(plan.skills.map(({ current, next }) => [current, next]), [["1.1", "1.1"]]);
});

test("pre-bumped plugin manifests do not create a duplicate version commit", () => {
  const { cwd } = fixture();
  write(cwd, "skills/sample-skill/SKILL.md", `${skill("1.1")}\nPre-bumped content.\n`);
  for (const [path, content] of Object.entries(manifests("1.1.0"))) write(cwd, path, content);
  commit(cwd, "feat: pre-bump all release versions", [
    "skills/sample-skill/SKILL.md",
    ...Object.keys(manifests()),
  ]);
  const plan = planRelease(cwd, "auto", "webmaxru/fixture");
  assert.equal(plan.version, "1.1.0");
  writeAndCommit(plan, cwd);
  const messages = command("git", ["log", "--format=%s", "v1.0.0..HEAD"], cwd).split(/\r?\n/);
  assert.deepEqual(messages, ["Release v1.1.0", "feat: pre-bump all release versions"]);
  const marketplace = JSON.parse(command("git", ["show", "HEAD:.github/plugin/marketplace.json"], cwd));
  assert.equal(marketplace.metadata.version, "2.0.0");
  assert.equal(marketplace.plugins[0].version, "1.1.0");
});

test("unrelated commits and no-change history do not release", () => {
  const noChange = fixture();
  const empty = planRelease(noChange.cwd, "auto", "webmaxru/fixture");
  assert.equal(empty.released, false);

  write(noChange.cwd, "docs/notes.md", "website only\n");
  commit(noChange.cwd, "docs: update notes", ["docs/notes.md"]);
  const unrelated = planRelease(noChange.cwd, "auto", "webmaxru/fixture");
  assert.equal(unrelated.released, false);
});

test("skip-release directive suppresses pushes but not scheduled recovery", () => {
  const { cwd } = fixture();
  write(cwd, "skills/sample-skill/SKILL.md", `${skill()}\nSkipped once.\n`);
  commit(cwd, "feat: defer release [skip release]");
  const previous = process.env.DEPLOY_AUTO_EVENT;
  delete process.env.DEPLOY_AUTO_EVENT;
  try {
    assert.equal(planRelease(cwd, "auto", "webmaxru/fixture").released, false);
    process.env.DEPLOY_AUTO_EVENT = "schedule";
    assert.equal(planRelease(cwd, "auto", "webmaxru/fixture").released, true);
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_AUTO_EVENT;
    else process.env.DEPLOY_AUTO_EVENT = previous;
  }
});
test("deletion and no-tag histories remain publishable", () => {
  const deleted = fixture();
  command("git", ["rm", "-r", "skills/sample-skill"], deleted.cwd);
  command("git", ["commit", "-m", "refactor: remove skill"], deleted.cwd);
  const deletionPlan = planRelease(deleted.cwd, "auto", "webmaxru/fixture");
  assert.equal(deletionPlan.released, true);
  assert.match(deletionPlan.notes, /Removed from the collection/);

  const first = fixture({ tag: false });
  write(first.cwd, "skills/sample-skill/SKILL.md", `${skill()}\nFirst publishable update.\n`);
  commit(first.cwd, "feat: prepare first release");
  const firstPlan = planRelease(first.cwd, "auto", "webmaxru/fixture");
  assert.equal(firstPlan.released, true);
  assert.equal(firstPlan.version, "1.1.0");
});

test("malformed metadata is rejected before planning a release", () => {
  const { cwd } = fixture();
  write(cwd, "skills/sample-skill/SKILL.md", skill("invalid"));
  commit(cwd, "fix: break metadata");
  assert.throws(() => planRelease(cwd, "auto", "webmaxru/fixture"), /invalid version/);
});

test("dry run is JSON-only and does not change the checkout, tag, or remote", () => {
  const data = fixture({ bare: true });
  write(data.cwd, "skills/sample-skill/SKILL.md", `${skill()}\nA new release change.\n`);
  commit(data.cwd, "feat: add a release change");
  command("git", ["push", "origin", "main"], data.cwd);
  const before = command("git", ["rev-parse", "HEAD"], data.cwd);
  const output = command(process.execPath, [engine, "--dry-run", "--json"], data.cwd, environment(data));
  const result = JSON.parse(output);
  assert.equal(result.released, true);
  assert.equal(command("git", ["rev-parse", "HEAD"], data.cwd), before);
  assert.deepEqual(command("git", ["tag", "--list", "v1.1.0"], data.cwd), "");
  assert.equal(command("git", ["rev-parse", "origin/main"], data.cwd), command("git", ["rev-parse", "main"], data.cwd));
  assert.equal(readFileSync(data.ghState, "utf8"), "v1.0.0\n");
});

test("push failure after tag creation is repaired without another bump", () => {
  const data = fixture({ bare: true });
  write(data.cwd, "skills/sample-skill/SKILL.md", `${skill()}\nRelease retry fixture.\n`);
  commit(data.cwd, "feat: add retry fixture");
  command("git", ["push", "origin", "main"], data.cwd);
  const failFlag = join(data.root, "fail-release-once");
  const env = environment(data, { GH_MOCK_FAIL_CREATE_ONCE: failFlag });
  assert.throws(() => command(process.execPath, [engine, "--push", "--json"], data.cwd, env));
  assert.ok(command("git", ["ls-remote", "--tags", "origin", "refs/tags/v1.1.0"], data.cwd));
  assert.match(command("git", ["show-ref", "--tags", "v1.1.0"], data.cwd), /v1\.1\.0/);
  command(process.execPath, [engine, "--push", "--json"], data.cwd, env);
  assert.equal(readFileSync(data.ghState, "utf8").trim().split(/\r?\n/).at(-1), "v1.1.0");
  assert.equal(command("git", ["rev-parse", "origin/main"], data.cwd), command("git", ["ls-remote", "origin", "refs/heads/main"], data.cwd).split("\t")[0]);
});

test("push race recalculates from latest main and retains the concurrent commit", async () => {
  const data = fixture({ bare: true });
  write(data.cwd, "skills/sample-skill/SKILL.md", `${skill()}\nRace fixture content.\n`);
  commit(data.cwd, "feat: add race fixture");
  command("git", ["push", "origin", "main"], data.cwd);
  const racer = join(data.root, "racer");
  command("git", ["clone", data.remote, racer], data.root);
  command("git", ["config", "user.name", "Concurrent User"], racer);
  command("git", ["config", "user.email", "racer@example.invalid"], racer);
  write(racer, "docs/concurrent.md", "concurrent main update\n");
  command("git", ["add", "."], racer);
  command("git", ["commit", "-m", "docs: concurrent update"], racer);
  const hookDir = join(data.root, "hooks");
  mkdirSync(hookDir);
  const marker = join(data.root, "race-ran");
  const hook = `#!/bin/sh\nif [ ! -f "${marker.replace(/\\/g, "/")}" ]; then\n  touch "${marker.replace(/\\/g, "/")}"\n  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n  git -C "${racer.replace(/\\/g, "/")}" push origin main\nfi\n`;
  writeFileSync(join(hookDir, "pre-push"), hook, "utf8");
  command("git", ["config", "core.hooksPath", hookDir], data.cwd);
  command(process.execPath, [engine, "--push", "--json"], data.cwd, environment(data));
  const remoteMain = command("git", ["ls-remote", "origin", "refs/heads/main"], data.cwd).split("\t")[0];
  const remoteCommit = command("git", ["show", `${remoteMain}:docs/concurrent.md`], data.cwd);
  assert.equal(remoteCommit, "concurrent main update");
  assert.ok(command("git", ["ls-remote", "--tags", "origin", "refs/tags/v1.1.0"], data.cwd));
});

test("push rejects a wrong branch before fetching or writing", () => {
  const data = fixture({ bare: true });
  command("git", ["checkout", "-b", "feature"], data.cwd);
  const before = command("git", ["rev-parse", "HEAD"], data.cwd);
  assert.throws(
    () => command(process.execPath, [engine, "--push", "--json"], data.cwd, environment(data)),
    /requires main or master/,
  );
  assert.equal(command("git", ["rev-parse", "HEAD"], data.cwd), before);
  assert.equal(command("git", ["tag", "--list", "v1.1.0"], data.cwd), "");
});

test("repository health script checks workflows and exits cleanly for a healthy repo", () => {
  const { root, cwd } = fixture({ tag: false });
  write(cwd, ".github/workflows/weekly-skill-updates.yml", "name: Weekly Skill Updates\non:\n  schedule:\n    - cron: '0 9 * * 1'\n");
  const mock = join(root, "health-gh-mock.mjs");
  writeFileSync(mock, `
const args = process.argv.slice(2);
const workflow = { id: 17, name: "Weekly Skill Updates", path: ".github/workflows/weekly-skill-updates.yml", state: "active", html_url: "https://github.com/webmaxru/fixture/actions/workflows/17" };
if (args[0] === "api" && args[1] === "--paginate") {
  const path = args.at(-1);
  process.stdout.write(JSON.stringify(path.includes("/actions/workflows?")
    ? [{ workflows: [workflow] }]
    : [[]]));
} else if (args[0] === "api" && args[1] === "repos/webmaxru/fixture") {
  process.stdout.write(JSON.stringify({ default_branch: "main" }));
} else if (args[0] === "api" && args[1].includes("/runs?event=schedule")) {
  process.stdout.write(JSON.stringify({ workflow_runs: [] }));
} else if (args[0] === "api" && args[1].includes("/releases/latest")) {
  process.stdout.write("null");
} else if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write("[]");
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" "));
  process.exit(2);
}
`, "utf8");
  const summary = join(root, "summary.md");
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "webmaxru/fixture",
    GITHUB_STEP_SUMMARY: summary,
    REPO_HEALTH_GH_BIN: process.execPath,
    REPO_HEALTH_GH_PREFIX: JSON.stringify([mock]),
  };
  const output = command(process.execPath, [healthScript], cwd, env);
  assert.match(output, /All monitored skill automation checks are healthy/);
  assert.match(readFileSync(summary, "utf8"), /All monitored skill automation checks are healthy/);
});

test("repository health detects unreleased changes beyond the first commit page", () => {
  const { root, cwd } = fixture({ tag: false });
  write(cwd, ".github/workflows/weekly-skill-updates.yml", "name: Weekly Skill Updates\non:\n  schedule:\n    - cron: '0 9 * * 1'\n");
  const recentDate = new Date(Date.now() - 60_000).toISOString();
  const oldDate = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const recentCommits = Array.from({ length: 100 }, (_, index) => ({
    sha: `recent-${index}`,
    commit: { committer: { date: recentDate } },
  }));
  const oldCommit = {
    sha: "stale-commit-sha",
    html_url: "https://github.com/webmaxru/fixture/commit/stale-commit-sha",
    commit: { committer: { date: oldDate } },
  };
  const mock = join(root, "health-gh-mock.mjs");
  writeFileSync(mock, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const workflow = { id: 17, name: "Weekly Skill Updates", path: ".github/workflows/weekly-skill-updates.yml", state: "active", html_url: "https://github.com/webmaxru/fixture/actions/workflows/17" };
const commitPages = JSON.parse(process.env.COMMIT_PAGES_JSON);
if (args[0] === "api" && args[1] === "--paginate") {
  const path = args.at(-1);
  process.stdout.write(JSON.stringify(path.includes("/actions/workflows?")
    ? [{ workflows: [workflow] }]
    : commitPages));
} else if (args[0] === "api" && args[1] === "repos/webmaxru/fixture") {
  process.stdout.write(JSON.stringify({ default_branch: "main" }));
} else if (args[0] === "api" && args[1].includes("/runs?event=schedule")) {
  process.stdout.write(JSON.stringify({ workflow_runs: [] }));
} else if (args[0] === "api" && args[1].includes("/releases/latest")) {
  process.stdout.write("null");
} else if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write("[]");
} else if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write(args[args.indexOf("--body") + 1]);
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" "));
  process.exit(2);
}
`, "utf8");
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "webmaxru/fixture",
    GITHUB_STEP_SUMMARY: join(root, "summary.md"),
    REPO_HEALTH_GH_BIN: process.execPath,
    REPO_HEALTH_GH_PREFIX: JSON.stringify([mock]),
    COMMIT_PAGES_JSON: JSON.stringify([recentCommits, [oldCommit]]),
  };
  command(process.execPath, [healthScript], cwd, env);
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, /stale-commit-sha/);
  assert.match(summary, /days old/);
});
