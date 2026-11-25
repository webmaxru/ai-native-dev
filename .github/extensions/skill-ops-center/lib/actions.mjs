import { api, gh, invalidate, memo } from "./gh.mjs";
import { KILL_SWITCHES } from "./collect.mjs";

export class OpsError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "OpsError";
        this.code = code;
        this.status = status;
    }
}

const NUM = /^\d{1,12}$/;
const REF = /^[A-Za-z0-9._/-]{1,100}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PROMPT = /^\.github\/prompts\/[\w.-]+-skill-update\.prompt\.md$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortName = (repo) => repo.split("/")[1];

const requireTyped = (given, expected, what) => {
    if (String(given ?? "").trim().toLowerCase() !== expected.toLowerCase()) {
        throw new OpsError("confirmation_required", `${what} requires typing "${expected}" to confirm.`, 409);
    }
};

const tail = (text, lines) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).slice(-lines).join("\n");

/** All mutating operations. `c` is the core context supplied by core.mjs. */
export function createActions(c) {
    const need = (v, what) => {
        if (v === undefined || v === null || v === "") throw new OpsError("invalid_input", `${what} is required.`);
        return v;
    };
    const number = (v, what) => {
        if (!NUM.test(String(v ?? ""))) throw new OpsError("invalid_input", `${what} must be a number.`);
        return String(v);
    };

    const openPull = async (repo, n) => {
        const d = await c.data(repo);
        const pr = d.pulls.find((p) => String(p.number) === n);
        if (!pr) throw new OpsError("not_found", `No open pull request #${n} in ${repo}. Refresh and try again.`, 404);
        return pr;
    };

    const changed = (repo, ...prefixes) => {
        for (const p of prefixes) invalidate(`${repo}:${p}`);
        c.dropCache();
    };

    const handlers = {
        async dispatch(a) {
            const repo = c.requireRepo(a.repo);
            const d = await c.data(repo);
            if (d.error) throw new OpsError("repo_unavailable", d.error, 502);
            const file = String(need(a.workflow, "workflow"));
            const wf = d.workflows.find((w) => w.file === file && w.dispatchable && !w.dynamic);
            if (!wf) throw new OpsError("workflow_not_dispatchable", `${file} is not a manually dispatchable workflow in ${repo}.`, 404);
            const ref = a.ref ? String(a.ref) : d.meta.defaultBranch;
            if (!REF.test(ref)) throw new OpsError("invalid_input", "Invalid ref.");

            const inputs = {};
            for (const [key, raw] of Object.entries(a.inputs ?? {})) {
                const def = wf.inputs.find((i) => i.name === key);
                if (!def) throw new OpsError("invalid_input", `Unknown input "${key}" for ${file}.`);
                if (key === "auto_ship") throw new OpsError("invalid_input", "auto_ship is reserved for the approve-to-ship automation.");
                const value = String(raw ?? "");
                if (value === "") continue;
                if (def.type === "boolean" && !["true", "false"].includes(value)) throw new OpsError("invalid_input", `${key} must be true or false.`);
                if (def.type === "choice" && !def.options.includes(value)) throw new OpsError("invalid_input", `${key} must be one of: ${def.options.join(", ")}.`);
                if (def.type === "number" && !/^\d{1,6}$/.test(value)) throw new OpsError("invalid_input", `${key} must be a whole number.`);
                if (def.type === "string" && (value.length > 300 || /[\r\n]/.test(value))) throw new OpsError("invalid_input", `${key} is not a valid value.`);
                if (wf.key === "weekly" && key === "prompt_path" && (!PROMPT.test(value) || !d.prompts.some((p) => p.path === value))) {
                    throw new OpsError("invalid_input", "prompt_path must be an existing .github/prompts/*-skill-update.prompt.md file.");
                }
                inputs[key] = value;
            }

            if ((wf.key === "release" || wf.key === "ship") && inputs.dry_run !== "true") {
                requireTyped(a.confirm, shortName(repo), "A real release (it publishes tags, GitHub releases and marketplace versions)");
            }

            const startedAt = Date.now();
            const args = ["workflow", "run", file, "-R", repo, "--ref", ref];
            for (const [k, v] of Object.entries(inputs)) args.push("-f", `${k}=${v}`);
            await gh(args);
            let run = null;
            // GitHub can take several seconds to list a run it has just queued.
            for (let attempt = 0; attempt < 4 && !run; attempt++) {
                await sleep(attempt === 0 ? 2500 : 2000);
                try {
                    const res = await api(`repos/${repo}/actions/workflows/${wf.id}/runs?event=workflow_dispatch&per_page=3`);
                    run = res.workflow_runs.find((r) => Date.parse(r.created_at) >= startedAt - 30000) ?? null;
                } catch {
                    break; // the dispatch itself succeeded
                }
            }
            changed(repo, "runs", "wfruns");
            return { ok: true, message: `Dispatched ${file} on ${repo}@${ref}`, url: run?.html_url ?? wf.url, runId: run?.id ?? null };
        },

        async pr_ready(a) {
            const repo = c.requireRepo(a.repo);
            const n = number(a.number, "number");
            const pr = await openPull(repo, n);
            if (!pr.draft) throw new OpsError("invalid_state", `#${n} is already ready for review.`);
            await gh(["pr", "ready", n, "-R", repo]);
            changed(repo, "gql");
            return { ok: true, message: `#${n} marked ready for review` };
        },

        async pr_approve(a) {
            const repo = c.requireRepo(a.repo);
            const n = number(a.number, "number");
            const pr = await openPull(repo, n);
            if (pr.draft) throw new OpsError("invalid_state", `#${n} is a draft. Mark it ready first.`);
            requireTyped(a.confirm, shortName(repo), "Approving starts the merge-and-release automation");
            await gh(["pr", "review", n, "-R", repo, "--approve", "--body", "Approved from Skill Ops Center."]);
            changed(repo, "gql", "runs");
            return { ok: true, message: `Approved #${n}. The approve-to-ship workflow takes over.` };
        },

        async pr_close(a) {
            const repo = c.requireRepo(a.repo);
            const n = number(a.number, "number");
            await openPull(repo, n);
            const args = ["pr", "close", n, "-R", repo];
            if (a.deleteBranch) args.push("--delete-branch");
            await gh(args);
            changed(repo, "gql");
            return { ok: true, message: `Closed #${n}${a.deleteBranch ? " and deleted its branch" : ""}` };
        },

        async issue_close(a) {
            const repo = c.requireRepo(a.repo);
            const n = number(a.number, "number");
            const d = await c.data(repo);
            if (!d.issues.some((i) => String(i.number) === n)) throw new OpsError("not_found", `No open issue #${n} in ${repo}.`, 404);
            await gh(["issue", "close", n, "-R", repo, "--reason", "completed"]);
            changed(repo, "gql");
            return { ok: true, message: `Closed issue #${n}` };
        },

        async run_cancel(a) {
            const repo = c.requireRepo(a.repo);
            const id = number(a.id, "run id");
            await api(`repos/${repo}/actions/runs/${id}/cancel`, { method: "POST" });
            changed(repo, "runs", "wfruns", "rundetail");
            return { ok: true, message: `Cancellation requested for run ${id}` };
        },

        async run_rerun(a) {
            const repo = c.requireRepo(a.repo);
            const id = number(a.id, "run id");
            await api(`repos/${repo}/actions/runs/${id}/rerun`, { method: "POST" });
            changed(repo, "runs", "wfruns", "rundetail");
            return { ok: true, message: `Re-running run ${id}` };
        },

        async run_rerun_failed(a) {
            const repo = c.requireRepo(a.repo);
            const id = number(a.id, "run id");
            await api(`repos/${repo}/actions/runs/${id}/rerun-failed-jobs`, { method: "POST" });
            changed(repo, "runs", "wfruns", "rundetail");
            return { ok: true, message: `Re-running failed jobs of run ${id}` };
        },

        async workflow_enable(a) {
            const repo = c.requireRepo(a.repo);
            const d = await c.data(repo);
            const wf = d.workflows.find((w) => w.file === a.workflow && !w.dynamic);
            if (!wf) throw new OpsError("not_found", `Workflow ${a.workflow} not found in ${repo}.`, 404);
            await gh(["workflow", "enable", wf.file, "-R", repo]);
            changed(repo, "workflows");
            return { ok: true, message: `Enabled ${wf.file}` };
        },

        async var_set(a) {
            const repo = c.requireRepo(a.repo);
            const name = String(a.name ?? "");
            const value = String(a.value ?? "");
            if (!KILL_SWITCHES.includes(name)) throw new OpsError("invalid_input", `Only ${KILL_SWITCHES.join(" and ")} can be changed here.`);
            if (!["true", "false"].includes(value)) throw new OpsError("invalid_input", "Value must be true or false.");
            await gh(["variable", "set", name, "--body", value, "-R", repo]);
            changed(repo, "vars");
            return { ok: true, message: `${repo}: ${name}=${value}` };
        },

        async kill_switch(a) {
            const mode = String(a.mode ?? "");
            if (!["pause", "resume"].includes(mode)) throw new OpsError("invalid_input", "mode must be pause or resume.");
            const word = mode === "pause" ? "PAUSE" : "RESUME";
            if (String(a.confirm ?? "").trim() !== word) throw new OpsError("confirmation_required", `Type ${word} to confirm.`, 409);
            const value = mode === "pause" ? "false" : "true";
            const results = [];
            for (const { repo } of c.config().repos) {
                for (const name of KILL_SWITCHES) {
                    try {
                        await gh(["variable", "set", name, "--body", value, "-R", repo]);
                        results.push({ repo, name, ok: true });
                    } catch (e) {
                        results.push({ repo, name, ok: false, error: e.message });
                    }
                }
                changed(repo, "vars");
            }
            const failed = results.filter((r) => !r.ok);
            return { ok: failed.length === 0, message: failed.length ? `${failed.length} variable update(s) failed` : `${mode === "pause" ? "Paused" : "Resumed"} automation in ${c.config().repos.length} repositories`, results };
        },

        async repo_add(a) {
            const repo = String(a.repo ?? "").trim();
            if (!REPO.test(repo)) throw new OpsError("invalid_input", "Use the owner/name format.");
            const cfg = c.config();
            if (cfg.repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) throw new OpsError("duplicate", `${repo} is already connected.`, 409);
            const role = a.role === "hub" ? "hub" : "spoke";
            try {
                await api(`repos/${repo}`);
            } catch (e) {
                throw new OpsError("not_found", `Cannot access ${repo}: ${e.message}`, 404);
            }
            await c.saveConfig({ ...cfg, repos: [...cfg.repos, { repo, role }] });
            c.dropCache();
            return { ok: true, message: `Connected ${repo}` };
        },

        async repo_remove(a) {
            const repo = c.requireRepo(a.repo);
            const cfg = c.config();
            if (cfg.repos.length <= 1) throw new OpsError("invalid_state", "At least one repository must stay connected.");
            await c.saveConfig({ ...cfg, repos: cfg.repos.filter((r) => r.repo !== repo) });
            changed(repo, "");
            return { ok: true, message: `Disconnected ${repo}` };
        },

        async settings(a) {
            const sec = Number(a.refreshSec);
            if (!Number.isInteger(sec) || sec < 30 || sec > 900) throw new OpsError("invalid_input", "Refresh interval must be 30–900 seconds.");
            await c.saveConfig({ ...c.config(), refreshSec: sec });
            return { ok: true, message: `Auto-refresh every ${sec}s` };
        },

        async ask(a) {
            const prompt = String(need(a.prompt, "prompt"));
            if (prompt.length > 6000) throw new OpsError("invalid_input", "Prompt is too long.");
            await c.ask(prompt);
            return { ok: true, message: "Sent to Copilot chat" };
        },

        async refresh() {
            c.dropCache();
            await c.getState(true);
            return { ok: true, message: "Refreshed" };
        },
    };

    return async (body) => {
        const type = String(body?.type ?? "");
        const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
        if (!handler) throw new OpsError("unknown_action", `Unknown action "${type}".`, 404);
        return handler(body);
    };
}

/** Read-only run drill-down: jobs, failing steps and a log tail. */
export async function runDetails(repo, id) {
    if (!NUM.test(String(id))) throw new OpsError("invalid_input", "Invalid run id.");
    return memo(`${repo}:rundetail:${id}`, 15000, async () => {
        const [run, jobsRes] = await Promise.all([api(`repos/${repo}/actions/runs/${id}`), api(`repos/${repo}/actions/runs/${id}/jobs?per_page=50`)]);
        const jobs = (jobsRes.jobs ?? []).map((j) => ({
            name: j.name,
            status: j.status,
            conclusion: j.conclusion,
            startedAt: j.started_at,
            completedAt: j.completed_at,
            url: j.html_url,
            steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
        }));
        const failing = jobs.some((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
        let log = null;
        if (run.status === "completed" && failing) {
            try {
                log = tail(await gh(["run", "view", String(id), "-R", repo, "--log-failed"], { timeout: 60000 }), 150);
            } catch (e) {
                log = `(log unavailable: ${e.message})`;
            }
        }
        return {
            id: run.id,
            repo,
            name: run.name,
            title: run.display_title,
            event: run.event,
            branch: run.head_branch,
            sha: (run.head_sha || "").slice(0, 7),
            status: run.status,
            conclusion: run.conclusion,
            actor: run.actor?.login ?? null,
            attempt: run.run_attempt,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            url: run.html_url,
            jobs,
            log,
        };
    });
}
