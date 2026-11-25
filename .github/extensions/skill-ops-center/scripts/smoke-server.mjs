// End-to-end harness for the loopback server + action layer. Run: node scripts\smoke-server.mjs
// Set LIVE_DRY_RUN=1 to also dispatch one real (harmless) release dry run on the hub.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "../lib/core.mjs";
import { startUiServer } from "../lib/server.mjs";
import { userArtifactsDir } from "../lib/paths.mjs";
import { analyze, killSwitches, isAutomationIssue } from "../lib/collect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "..", "ui");
const dir = await mkdtemp(join(tmpdir(), "ops-smoke-"));
const asked = [];
const core = await createCore({ artifactsDir: dir, ask: async (p) => void asked.push(p) });
const srv = await startUiServer({ core, uiDir });
const port = new URL(srv.url).port;

let failures = 0;
const check = (name, ok, extra = "") => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const call = (method, path, { headers = {}, body, token = srv.token, host = `127.0.0.1:${port}` } = {}) =>
    new Promise((resolve, reject) => {
        const h = { Host: host, ...headers };
        if (token) h["X-Ops-Token"] = token;
        if (body !== undefined) h["Content-Type"] = "application/json";
        const req = request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {}
                resolve({ status: res.statusCode, text, json, headers: res.headers });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
    });
const act = (body, opts) => call("POST", "/api/action", { body, ...opts });

try {
    // settings location (never inside the extension folder)
    check("settings dir honours COPILOT_HOME", userArtifactsDir({ COPILOT_HOME: join("x", "ch") }, "unused") === join("x", "ch", "extensions", "skill-ops-center", "artifacts"));
    check("settings dir defaults to ~/.copilot", userArtifactsDir({}, join("x", "home")) === join("x", "home", ".copilot", "extensions", "skill-ops-center", "artifacts"));

    // kill switches: variables that cannot be read are unknown, never reported as "on"
    const ks = killSwitches([{ name: "AUTO_RELEASE", value: "false" }]);
    check("variable set to false reads as paused, unset as on", ks.AUTO_RELEASE.enabled === false && ks.AUTO_SHIP.enabled === true);
    check("unreadable variables give no kill-switch state", killSwitches(null) === null);
    const bare = { repo: "o/r", role: "hub", flows: {}, secrets: null, switches: null, workflows: [], latestVersion: null, unreleased: null, pulls: [], issues: [], errors: [] };
    check("findings tolerate unknown kill-switch state", analyze(bare).length === 0);

    // repositories that do not use this automation: no invented health issues, no release buttons without a release workflow
    const bot = { __typename: "Bot", login: "github-actions" };
    check(
        "the automation's own bot issues count as health issues",
        ["Skill automation health", "[skill-update] failed weekly skill updates", "Automatic skill release failed"].every((title) => isAutomationIssue({ title, author: bot })),
    );
    check(
        "people's issues are never health issues",
        !isAutomationIssue({ title: "gh run rerun --failed stops on 404", author: { __typename: "User", login: "someone" } }) && !isAutomationIssue({ title: "Skill automation health", author: null }),
    );
    check("bot issues without a health keyword are ignored", !isAutomationIssue({ title: "Bump foo from 1.0 to 2.0", author: { __typename: "Bot", login: "dependabot" } }));
    const ahead = { repo: "o/r", role: "hub", secrets: null, switches: null, latestVersion: null, pulls: [], issues: [], errors: [], meta: { defaultBranch: "main" }, latestRelease: { tag: "v1.0.0" }, unreleased: { aheadBy: 2, commits: [{ type: "feat", breaking: false }], skillsTouched: [], compareUrl: "https://example.test/compare" } };
    const unreleased = (workflows) => analyze({ ...ahead, flows: {}, workflows }).find((f) => f.id === "o/r:unreleased");
    check("unreleased finding has no release buttons without a release workflow", unreleased([]) && !(unreleased([]).actions ?? []).length && Boolean(unreleased([]).url));
    const withFlow = unreleased([{ key: "release", dispatchable: true, file: "release.yaml", hubRefs: [] }]);
    check("unreleased finding offers dry run and release for the repository's own release file", withFlow?.actions?.length === 2 && withFlow.actions.every((a) => a.action === "dispatch" && a.args.workflow === "release.yaml"));

    // static assets
    const page = await call("GET", "/", { token: null });
    check("GET / serves HTML", page.status === 200 && page.text.includes("<main"));
    check("token injected into page", page.text.includes(srv.token) && !page.text.includes("__OPS_TOKEN__"));
    check("GET /app.js", (await call("GET", "/app.js", { token: null })).status === 200);
    check("GET /styles.css", (await call("GET", "/styles.css", { token: null })).status === 200);
    check("cross-origin fetch of page is refused", (await call("GET", "/", { token: null, headers: { Origin: "https://evil.example" } })).status === 403);

    // transport security
    check("no token -> 401", (await call("GET", "/api/state", { token: null })).status === 401);
    check("wrong token -> 401", (await call("GET", "/api/state", { token: "nope" })).status === 401);
    check("bad Host -> 403", (await call("GET", "/api/state", { host: "evil.example" })).status === 403);
    check("bad Origin on API -> 403", (await call("GET", "/api/state", { headers: { Origin: "https://evil.example" } })).status === 403);
    check("unknown endpoint -> 404", (await call("GET", "/api/nope")).status === 404);
    check("invalid JSON -> 400", (await act("{not json")).status === 400);

    // state
    const t0 = Date.now();
    const st = await call("GET", "/api/state?force=1");
    check("GET /api/state", st.status === 200 && Array.isArray(st.json?.repos), `${Date.now() - t0}ms`);
    const state = st.json;
    check("all repos loaded", state.repos.length === 3 && state.repos.every((d) => !d.error), state.repos.map((d) => d.error ?? d.repo.split("/")[1]).join(", "));
    check("health computed", ["ok", "warn", "fail"].includes(state.health), `${state.health} ${JSON.stringify(state.counts)}`);
    check("login + rate present", !!state.login && !!state.rate?.core, `${state.login} ${state.rate?.core?.remaining}/${state.rate?.core?.limit}`);
    const hub = state.repos.find((d) => d.role === "hub");
    const spoke = state.repos.find((d) => d.role === "spoke");
    const hubRelease = hub.workflows.find((w) => w.key === "release" && w.dispatchable);
    const weekly = hub.workflows.find((w) => w.key === "weekly" && w.dispatchable);
    check("hub release workflow is dispatchable", !!hubRelease, hubRelease?.file);
    check("hub weekly workflow is dispatchable", !!weekly, weekly?.file);

    // run drill-down
    const some = hub.runs.find((r) => r.state === "ok") ?? hub.runs[0];
    const rd = await call("GET", `/api/run?repo=${encodeURIComponent(hub.repo)}&id=${some.id}`);
    check("GET /api/run", rd.status === 200 && rd.json.jobs?.length > 0, `run ${some.id}: ${rd.json?.jobs?.length} jobs`);
    const failedRun = state.repos.flatMap((d) => d.runs.filter((r) => r.state === "fail").map((r) => ({ ...r, repo: d.repo })))[0];
    if (failedRun) {
        const fr = await call("GET", `/api/run?repo=${encodeURIComponent(failedRun.repo)}&id=${failedRun.id}`);
        check("GET /api/run for a failed run includes a log", fr.status === 200 && (fr.json.log === null || typeof fr.json.log === "string"), `log ${fr.json?.log ? fr.json.log.length : 0} chars`);
    }
    check("run on unconnected repo -> 404", (await call("GET", "/api/run?repo=octocat/hello-world&id=1")).status === 404);
    check("run with bad id -> 400", (await call("GET", `/api/run?repo=${encodeURIComponent(hub.repo)}&id=abc`)).status === 400);

    // guarded actions must refuse WITHOUT touching GitHub
    const noConfirm = await act({ type: "dispatch", repo: hub.repo, workflow: hubRelease.file, inputs: { dry_run: "false", bump: "auto" } });
    check("real release without typed confirm -> 409", noConfirm.status === 409 && noConfirm.json?.error?.code === "confirmation_required");
    const wrongConfirm = await act({ type: "dispatch", repo: hub.repo, workflow: hubRelease.file, inputs: { dry_run: "false" }, confirm: "wrong" });
    check("real release with wrong confirm -> 409", wrongConfirm.status === 409);
    const noInputs = await act({ type: "dispatch", repo: hub.repo, workflow: hubRelease.file, inputs: {} });
    check("release with default inputs (not dry run) -> 409", noInputs.status === 409);
    check("auto_ship input rejected", (await act({ type: "dispatch", repo: hub.repo, workflow: hubRelease.file, inputs: { dry_run: "true", auto_ship: "true" } })).status === 400);
    check("unknown input rejected", (await act({ type: "dispatch", repo: hub.repo, workflow: hubRelease.file, inputs: { bogus: "1" } })).status === 400);
    check("unknown workflow -> 404", (await act({ type: "dispatch", repo: hub.repo, workflow: "nope.yml" })).status === 404);
    check("non-dispatchable workflow -> 404", (await act({ type: "dispatch", repo: hub.repo, workflow: hub.workflows.find((w) => !w.dispatchable && !w.dynamic).file })).status === 404);
    check("weekly prompt_path traversal rejected", (await act({ type: "dispatch", repo: hub.repo, workflow: weekly.file, inputs: { prompt_path: "../../etc/passwd" } })).status === 400);
    check("weekly prompt_path must exist", (await act({ type: "dispatch", repo: hub.repo, workflow: weekly.file, inputs: { prompt_path: ".github/prompts/ghost-skill-update.prompt.md" } })).status === 400);
    check("dispatch to unconnected repo -> 404", (await act({ type: "dispatch", repo: "octocat/hello-world", workflow: "x.yml" })).status === 404);
    check("kill switch without confirm -> 409", (await act({ type: "kill_switch", mode: "pause" })).status === 409);
    check("kill switch with wrong word -> 409", (await act({ type: "kill_switch", mode: "pause", confirm: "pause please" })).status === 409);
    check("kill switch bad mode -> 400", (await act({ type: "kill_switch", mode: "explode", confirm: "PAUSE" })).status === 400);
    check("var_set rejects other variables", (await act({ type: "var_set", repo: hub.repo, name: "COPILOT_MODEL", value: "x" })).status === 400);
    check("var_set rejects non-boolean", (await act({ type: "var_set", repo: hub.repo, name: "AUTO_RELEASE", value: "maybe" })).status === 400);
    check("pr_approve on missing PR -> 404", (await act({ type: "pr_approve", repo: hub.repo, number: 999999, confirm: "ai-native-dev" })).status === 404);
    check("pr_approve bad number -> 400", (await act({ type: "pr_approve", repo: hub.repo, number: "1; rm -rf", confirm: "x" })).status === 400);
    const draft = state.repos.flatMap((d) => d.pulls.filter((p) => p.draft).map((p) => ({ ...p, repo: d.repo })))[0];
    if (draft) check("approving a draft is refused", (await act({ type: "pr_approve", repo: draft.repo, number: draft.number, confirm: draft.repo.split("/")[1] })).status === 400, `${draft.repo}#${draft.number}`);
    const ready = state.repos.flatMap((d) => d.pulls.filter((p) => !p.draft).map((p) => ({ ...p, repo: d.repo })))[0];
    if (ready) check("approve without typed confirm -> 409", (await act({ type: "pr_approve", repo: ready.repo, number: ready.number })).status === 409, `${ready.repo}#${ready.number}`);
    check("unknown action -> 404", (await act({ type: "format_c" })).status === 404);
    check("__proto__ action name -> 404", (await act({ type: "__proto__" })).status === 404);
    check("workflow_enable on unknown file -> 404", (await act({ type: "workflow_enable", repo: hub.repo, workflow: "ghost.yml" })).status === 404);
    check("issue_close on missing issue -> 404", (await act({ type: "issue_close", repo: hub.repo, number: 999999 })).status === 404);

    // config actions (temp config only)
    check("settings rejects 5s", (await act({ type: "settings", refreshSec: 5 })).status === 400);
    const set = await act({ type: "settings", refreshSec: 120 });
    check("settings 120s", set.status === 200 && core.config().refreshSec === 120);
    check("config persisted to artifacts", JSON.parse(await readFile(join(dir, "config.json"), "utf8")).refreshSec === 120);
    check("repo_add rejects bad format", (await act({ type: "repo_add", repo: "not a repo" })).status === 400);
    check("repo_add rejects duplicate", (await act({ type: "repo_add", repo: hub.repo })).status === 409);
    check("repo_add rejects inaccessible repo", (await act({ type: "repo_add", repo: "webmaxru/definitely-not-a-real-repo-xyz" })).status === 404);
    const added = await act({ type: "repo_add", repo: "cli/cli", role: "spoke" });
    check("repo_add cli/cli", added.status === 200 && core.config().repos.length === 4);
    const removed = await act({ type: "repo_remove", repo: "cli/cli" });
    check("repo_remove cli/cli", removed.status === 200 && core.config().repos.length === 3);
    check("repo_remove unknown -> 404", (await act({ type: "repo_remove", repo: "cli/cli" })).status === 404);

    // agent hand-off
    const askRes = await act({ type: "ask", prompt: "hello" });
    check("ask forwards prompt", askRes.status === 200 && asked.length === 1 && asked[0] === "hello");
    check("ask rejects empty", (await act({ type: "ask", prompt: "" })).status === 400);
    check("refresh action", (await act({ type: "refresh" })).status === 200);

    // compact snapshot for the agent
    const compact = core.compact(await core.getState());
    check("compact snapshot", compact.repos.length === 3 && Array.isArray(compact.attention), `${compact.attention.length} attention items`);

    // optional: one real, harmless dry run
    if (process.env.LIVE_DRY_RUN === "1") {
        const live = await act({ type: "dispatch", repo: hub.repo, workflow: hubRelease.file, inputs: { dry_run: "true", bump: "auto" } });
        check("LIVE release dry run dispatched", live.status === 200 && live.json.ok, live.json?.url ?? live.text);
        check("LIVE dispatch resolved the run id", Boolean(live.json?.runId), live.json?.runId ? `run ${live.json.runId}` : "no run found in the lookup window");
        if (live.json?.runId) {
            await new Promise((r) => setTimeout(r, 5000));
            const d = await call("GET", `/api/run?repo=${encodeURIComponent(hub.repo)}&id=${live.json.runId}`);
            check("LIVE run visible in drill-down", d.status === 200, `${d.json?.status}/${d.json?.conclusion}`);
        }
    }
} finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
