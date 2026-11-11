#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const target = resolve(process.env.RELEASE_TARGET || "target");
const engine = resolve(process.env.RELEASE_ENGINE || "hub/skills/agent-skill-deploy/scripts/deploy-auto.mjs");
const resultFile = resolve(
  process.env.RELEASE_RESULT_FILE || join(process.env.RUNNER_TEMP || tmpdir(), "release-result.json"),
);
const output = execFileSync(
  process.execPath,
  [engine, "--dry-run", "--json", "--bump", "auto"],
  { cwd: target, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
JSON.parse(output);
mkdirSync(dirname(resultFile), { recursive: true });
writeFileSync(resultFile, `${output.trim()}\n`, "utf8");

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Automatic release preview\n\n\`\`\`json\n${readFileSync(resultFile, "utf8")}\`\`\`\n`,
    "utf8",
  );
}

console.log(`Release preview written to ${resultFile}.`);
