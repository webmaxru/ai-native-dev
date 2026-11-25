#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const reviewId = process.env.REVIEW_ID;
const reviewedSha = process.env.REVIEWED_SHA;
const reviewerLogin = process.env.REVIEWER_LOGIN;
const outputFile = process.env.GITHUB_OUTPUT;
const allowedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function run(args, allowFailure = false) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(error.stderr?.toString().trim() || error.message);
  }
}

function setOutput(name, value) {
  if (outputFile) appendFileSync(outputFile, `${name}=${value}\n`);
}

function skip(reason) {
  console.log(`Skipping ship: ${reason}`);
  setOutput("ship", "false");
}

function loadJson(args) {
  const raw = run(args);
  return JSON.parse(raw);
}

function commentManualMerge(paths) {
  const names = paths.map((path) => path.replace(/[\u0000-\u001f\u007f`<>]/g, "_")).join(", ");
  run(["pr", "comment", prNumber, "--repo", repo, "--body", `manual merge required: touches ${names}`]);
}

function currentReview() {
  const pr = loadJson(["api", `repos/${repo}/pulls/${prNumber}`]);
  if (pr.state !== "open") return { reason: "pull request is no longer open" };
  if (pr.base?.ref !== "main") return { reason: "pull request base is not main" };
  if (pr.base?.repo?.full_name !== repo || pr.head?.repo?.full_name !== repo) {
    return { reason: "pull request head and base must be in the same repository" };
  }
  if (pr.user?.login !== "github-actions[bot]") return { reason: "pull request author is not github-actions[bot]" };
  if (!String(pr.title || "").startsWith("[skill-update] ")) return { reason: "pull request title is outside the skill-update flow" };
  if (pr.head?.sha !== reviewedSha) return { reason: "pull request head changed after the review" };

  const reviews = loadJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`]).flat();
  const eventReview = reviews.find((review) => String(review.id) === String(reviewId));
  if (
    !eventReview ||
    eventReview.state !== "APPROVED" ||
    eventReview.commit_id !== reviewedSha ||
    eventReview.user?.login !== reviewerLogin ||
    !allowedAssociations.has(eventReview.author_association) ||
    reviewerLogin === pr.user?.login ||
    eventReview.user?.type === "Bot"
  ) return { reason: "the submitted approval is not valid for the reviewed head" };

  const latest = reviews
    .filter((review) => review.user?.login === reviewerLogin)
    .sort((a, b) => Date.parse(b.submitted_at || 0) - Date.parse(a.submitted_at || 0))[0];
  if (latest?.id !== eventReview.id || latest.state !== "APPROVED" || latest.commit_id !== pr.head.sha) {
    return { reason: "approval was revoked, superseded, or is stale" };
  }
  return { pr };
}

function changedFiles() {
  return run(["api", "--paginate", `repos/${repo}/pulls/${prNumber}/files?per_page=100`, "--jq", ".[].filename"])
    .split(/\r?\n/).filter(Boolean);
}

function safeTree(sha) {
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", sha, "--", "skills"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean);
  for (const entry of entries) {
    const [mode] = entry.split(" ", 1);
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`skill tree contains a symlink or non-file entry: ${entry.slice(entry.indexOf("\t") + 1)}`);
    }
  }
}

function main() {
  if (process.env.AUTO_SHIP === "false") return skip("AUTO_SHIP is disabled");
  if (!repo || !prNumber || !reviewId || !reviewedSha || !reviewerLogin) {
    throw new Error("Missing required pull request review context");
  }
  const checked = currentReview();
  if (checked.reason) return skip(checked.reason);
  const files = changedFiles();
  const invalid = files.filter((path) => !/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+$/.test(path) || path.split("/").some((part) => part === "." || part === ".."));
  if (invalid.length) {
    commentManualMerge(invalid);
    return skip(`manual merge required for ${invalid.join(", ")}`);
  }
  if (!files.length) return skip("pull request contains no changed skill files");
  safeTree(reviewedSha);
  if (outputFile) {
    setOutput("ship", "true");
    setOutput("reviewed_sha", reviewedSha);
    setOutput("draft", checked.pr.draft ? "true" : "false");
  }
  console.log(`Approved skill update is valid at ${reviewedSha}; ${files.length} changed file(s).`);
}

try {
  main();
} catch (error) {
  console.error(`Ship gate failed: ${error.message}`);
  process.exitCode = 1;
}
