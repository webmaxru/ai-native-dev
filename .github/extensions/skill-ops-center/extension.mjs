// Extension: skill-ops-center
// Unified control center for the weekly skill-update and auto-release flows across connected repos.
// Wiring only: data collection lives in lib/collect.mjs, actions in lib/actions.mjs, the HTTP server in lib/server.mjs.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@microsoft/copilot-sdk/extension";
import { createCore } from "./lib/core.mjs";
import { startUiServer } from "./lib/server.mjs";
import { OpsError } from "./lib/actions.mjs";
import { userArtifactsDir } from "./lib/paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "ui");
const TABS = ["overview", "workflows", "runs", "prs", "issues", "releases", "skills", "settings"];

let session = null;
const core = await createCore({
    artifactsDir: userArtifactsDir(),
    ask: async (prompt) => {
        if (!session) throw new OpsError("unavailable", "The Copilot session is not connected yet.", 503);
        await session.send({ prompt });
    },
});

// One loopback server (and access token) per open canvas instance.
const servers = new Map();

const toCanvasError = (e) => {
    if (e instanceof CanvasError) return e;
    if (e instanceof OpsError) return new CanvasError(e.code, e.message);
    return new CanvasError("ops_failed", e?.message ?? String(e));
};

const guard = (fn) => async (ctx) => {
    try {
        return await fn(ctx);
    } catch (e) {
        throw toCanvasError(e);
    }
};

const canvas = createCanvas({
    id: "skill-ops-center",
    displayName: "Skill Ops Center",
    description: "Control center for the weekly skill-update and auto-release flows across the connected repositories: statuses, runs, pull requests, releases, kill switches and manual dispatch.",
    inputSchema: {
        type: "object",
        properties: {
            tab: { type: "string", enum: TABS, description: "Tab to show first. Defaults to overview." },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "refresh",
            description: "Reload live status from GitHub for every connected repository and return the health summary.",
            handler: guard(async () => {
                core.invalidateAll();
                const state = await core.getState(true);
                return { generatedAt: state.generatedAt, health: state.health, counts: state.counts };
            }),
        },
        {
            name: "get_snapshot",
            description: "Compact status of every connected repository: latest release, unreleased commits, last result of each flow, open pull requests and issues, kill-switch state, plus everything needing attention.",
            handler: guard(async () => core.compact(await core.getState())),
        },
        {
            name: "get_attention",
            description: "List only the findings that need attention (failing, warning or to-do items) with their repository and detail.",
            handler: guard(async () => {
                const state = await core.getState();
                return {
                    health: state.health,
                    items: state.findings.filter((f) => f.severity !== "info").map((f) => ({ repo: f.repo, severity: f.severity, title: f.title, detail: f.detail, url: f.url })),
                };
            }),
        },
        {
            name: "dispatch_workflow",
            description:
                "Manually dispatch a workflow_dispatch workflow in a connected repository. A real release (release.yml with dry_run not true) needs confirm set to the short repository name; prefer dry_run=true.",
            inputSchema: {
                type: "object",
                properties: {
                    repo: { type: "string", description: "owner/name of a connected repository" },
                    workflow: { type: "string", description: "Workflow file name, for example release.yml" },
                    inputs: { type: "object", additionalProperties: { type: "string" }, description: "Workflow inputs as strings" },
                    confirm: { type: "string", description: "Short repository name, required for a real release" },
                },
                required: ["repo", "workflow"],
                additionalProperties: false,
            },
            handler: guard(async (ctx) => core.act({ ...ctx.input, type: "dispatch" })),
        },
    ],
    open: guard(async (ctx) => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startUiServer({ core, uiDir });
            servers.set(ctx.instanceId, entry);
        }
        const tab = ctx.input?.tab;
        return { title: "Skill Ops Center", url: tab ? `${entry.url}#${tab}` : entry.url };
    }),
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
            servers.delete(ctx.instanceId);
            await entry.close();
        }
    },
});

session = await joinSession({ canvases: { definitions: [canvas] } });
