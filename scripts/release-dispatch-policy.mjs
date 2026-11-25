#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const source = process.env.RELEASE_DISPATCH_SOURCE;
if (!["manual", "auto-ship"].includes(source)) {
  throw new Error("RELEASE_DISPATCH_SOURCE must be manual or auto-ship");
}
if (!process.env.GITHUB_OUTPUT) {
  throw new Error("GITHUB_OUTPUT is required");
}

const allowed = source === "manual" || process.env.AUTO_RELEASE !== "false";
appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${allowed}\n`);
console.log(
  allowed
    ? `Release dispatch allowed for ${source}.`
    : "Automatic release dispatch blocked because AUTO_RELEASE=false.",
);
