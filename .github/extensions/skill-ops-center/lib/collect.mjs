import { api, graphql, memo } from "./gh.mjs";
import { describeCron, nextRuns } from "./cron.mjs";
import { parseSkill, parseWorkflow } from "./parse.mjs";

export const FLOW_KEYS = [
    { key: "weekly", label: "Weekly update", re: /(^|\/)weekly-skill-updates\.ya?ml$/ },
    { key: "ship", label: "Approve → ship", re: /(^|\/)auto-ship\.ya?ml$/ },
    { key: "release", label: "Release", re: /(^|\/)release\.ya?ml$/ },
    { key: "health", label: "Health check", re: /(^|\/)repo-health\.ya?ml$/ },
    { key: "validate", label: "Validation", re: /(^|\/)validate-skills\.ya?ml$/ },
    { key: "website", label: "Website", re: /(^|\/)deploy-website\.ya?ml$/ },
];

export const KILL_SWITCHES = ["AUTO_RELEASE", "AUTO_SHIP"];

// Unset means enabled; when the variables could not be read the state is unknown (null), not "on".
export function killSwitches(variables) {
    if (!variables) return null;
    return Object.fromEntries(
        KILL_SWITCHES.map((n) => {
            const v = variables.find((x) => x.name === n);
            return [n, { set: Boolean(v), value: v?.value ?? null, enabled: !v || v.value.toLowerCase() !== "false" }];
        }),
    );
}

const VERSION_FILES = [
    "package.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".github/plugin/plugin.json",
    ".github/plugin/marketplace.json",
];

const TTL = { meta: 300000, workflows: 60000, runs: 20000, releases: 120000, compare: 120000, gql: 30000, vars: 60000, secrets: 300000, tree: 90000 };
const FOREVER = Number.MAX_SAFE_INTEGER;

const base = (p) => p.split("/").pop();
const keyOf = (path) => FLOW_KEYS.find((k) => k.re.test(path))?.key ?? null;

export function runState(run) {
    if (run.status !== "completed") return ["in_progress", "queued", "waiting", "pending", "requested"].includes(run.status) ? "run" : "run";
    switch (run.conclusion) {
        case "success":
            return "ok";
        case "failure":
        case "timed_out":
        case "startup_failure":
            return "fail";
        case "cancelled":
            return "cancel";
        case "skipped":
            return "skip";
        default:
            return "warn";
    }
}

const slimRun = (r) => ({
    id: r.id,
    number: r.run_number,
    attempt: r.run_attempt,
    workflowId: r.workflow_id,
    workflow: r.name,
    path: r.path,
    title: r.display_title,
    status: r.status,
    conclusion: r.conclusion,
    state: runState(r),
    event: r.event,
    branch: r.head_branch,
    sha: (r.head_sha || "").slice(0, 7),
    actor: r.actor?.login ?? r.triggering_actor?.login ?? null,
    createdAt: r.created_at,
    startedAt: r.run_started_at || r.created_at,
    updatedAt: r.updated_at,
    url: r.html_url,
});

const blob = (repo, sha) =>
    memo(`blob:${repo}:${sha}`, FOREVER, async () => {
        const data = await api(`repos/${repo}/git/blobs/${sha}`);
        return Buffer.from(data.content, "base64").toString("utf8");
    });

const commitType = (message) => {
    const m = String(message).match(/^(\w+)(?:\([^)]*\))?(!)?:/);
    if (!m) return { type: "other", breaking: /BREAKING CHANGE/.test(message) };
    return { type: m[1].toLowerCase(), breaking: Boolean(m[2]) || /BREAKING CHANGE/.test(message) };
};

// The automation files its own issues (health monitor, failure reporters) as the Actions bot; people's issues that merely mention "failed" are not health issues.
export const isAutomationIssue = (issue) => issue.author?.__typename === "Bot" && /health|failure|failed|skill-update/i.test(issue.title);

const GQL = `query($o:String!,$n:String!){repository(owner:$o,name:$n){
  prs:pullRequests(first:40,states:OPEN,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{
    number title isDraft url createdAt updatedAt headRefName reviewDecision mergeable mergeStateStatus additions deletions changedFiles
    author{login __typename} labels(first:6){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}
  merged:pullRequests(first:10,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
    number title url mergedAt author{login __typename} mergedBy{login}}}
  issues(first:40,states:OPEN,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{
    number title url createdAt updatedAt author{login __typename} labels(first:6){nodes{name}} comments{totalCount}}}
}}`;

const latest = (runs) => runs.reduce((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);

export async function collectRepo({ repo, role }, force = false) {
    const errors = [];
    const guard = async (section, fn, fallback) => {
        try {
            return await fn();
        } catch (e) {
            errors.push({ section, message: e.message, status: e.status });
            return fallback;
        }
    };
    const [owner, name] = repo.split("/");
    const fetchedAt = new Date().toISOString();

    const meta = await guard("repository", () => memo(`${repo}:meta`, TTL.meta, () => api(`repos/${repo}`), force), null);
    if (!meta) return { repo, role, error: errors[0]?.message || "Repository is not reachable", errors, fetchedAt };
    const branch = meta.default_branch;

    const [wfList, runsRaw, releasesRaw, gql, vars, secrets, tree] = await Promise.all([
        guard("workflows", () => memo(`${repo}:workflows`, TTL.workflows, () => api(`repos/${repo}/actions/workflows?per_page=100`), force), null),
        guard("runs", () => memo(`${repo}:runs`, TTL.runs, () => api(`repos/${repo}/actions/runs?per_page=100`), force), null),
        guard("releases", () => memo(`${repo}:releases`, TTL.releases, () => api(`repos/${repo}/releases?per_page=10`), force), []),
        guard("pull requests & issues", () => memo(`${repo}:gql`, TTL.gql, () => graphql(GQL, { o: owner, n: name }), force), null),
        guard("variables", () => memo(`${repo}:vars`, TTL.vars, () => api(`repos/${repo}/actions/variables?per_page=100`), force), null),
        guard("secrets", () => memo(`${repo}:secrets`, TTL.secrets, () => api(`repos/${repo}/actions/secrets?per_page=100`), force), null),
        guard("file tree", () => memo(`${repo}:tree`, TTL.tree, () => api(`repos/${repo}/git/trees/${branch}?recursive=1`), force), null),
    ]);

    const entries = tree?.tree ?? [];
    const byPath = new Map(entries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

    // workflow files (parsed once per blob sha)
    const parsedByPath = new Map();
    await Promise.all(
        entries
            .filter((e) => e.type === "blob" && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.path))
            .map((e) =>
                guard(`workflow ${e.path}`, async () => {
                    const parsed = await memo(`parsed:${repo}:${e.sha}`, FOREVER, async () => parseWorkflow(await blob(repo, e.sha)));
                    parsedByPath.set(e.path, parsed);
                }),
            ),
    );

    // runs: add per-workflow lookups for dispatchable/scheduled workflows missing from the recent list
    let runs = (runsRaw?.workflow_runs ?? []).map(slimRun);
    const workflowsRaw = wfList?.workflows ?? [];
    const seen = new Set(runs.map((r) => r.workflowId));
    const missing = workflowsRaw.filter((w) => {
        const parsed = parsedByPath.get(w.path);
        const callOnly = parsed && parsed.triggers.length > 0 && parsed.triggers.every((t) => t === "workflow_call");
        return !seen.has(w.id) && !w.path.startsWith("dynamic/") && !callOnly && w.state === "active";
    });
    const extra = await Promise.all(
        missing.map((w) =>
            guard(`runs ${base(w.path)}`, () => memo(`${repo}:wfruns:${w.id}`, 120000, () => api(`repos/${repo}/actions/workflows/${w.id}/runs?per_page=5`), force), null),
        ),
    );
    for (const res of extra) for (const r of res?.workflow_runs ?? []) if (!runs.some((x) => x.id === r.id)) runs.push(slimRun(r));
    runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    const now = new Date();
    const workflows = workflowsRaw.map((w) => {
        const parsed = parsedByPath.get(w.path);
        const wfRuns = runs.filter((r) => r.workflowId === w.id);
        const flowRuns = wfRuns.filter((r) => r.event !== "pull_request" && r.event !== "pull_request_target");
        const meaningful = flowRuns.filter((r) => ["ok", "fail"].includes(r.state));
        const crons = (parsed?.crons ?? []).map((expr) => ({ expr, human: describeCron(expr), next: nextRuns(expr, now, 1)[0]?.toISOString() ?? null }));
        return {
            id: w.id,
            name: w.name,
            path: w.path,
            file: base(w.path),
            state: w.state,
            dynamic: w.path.startsWith("dynamic/"),
            key: keyOf(w.path),
            triggers: parsed?.triggers ?? [],
            reusable: Boolean(parsed && parsed.triggers.length > 0 && parsed.triggers.every((t) => t === "workflow_call")),
            dispatchable: Boolean(parsed?.triggers.includes("workflow_dispatch")),
            inputs: parsed?.inputs ?? [],
            crons,
            nextRun: crons.map((c) => c.next).filter(Boolean).sort()[0] ?? null,
            hubRefs: [...(parsed?.hubRefs ?? []).map((h) => h.ref), ...(parsed?.hubRefInputs ?? [])],
            url: `https://github.com/${repo}/actions/workflows/${base(w.path)}`,
            latestRun: latest(wfRuns),
            lastFlowRun: latest(flowRuns),
            lastMeaningful: latest(meaningful),
            lastSuccess: latest(meaningful.filter((r) => r.state === "ok")),
        };
    });

    const flows = {};
    for (const { key, label } of FLOW_KEYS) {
        const wf = workflows.find((w) => w.key === key && !w.dynamic);
        flows[key] = wf
            ? { key, label, workflowId: wf.id, file: wf.file, workflowState: wf.state, last: wf.lastFlowRun, lastMeaningful: wf.lastMeaningful, lastSuccess: wf.lastSuccess, nextRun: wf.nextRun }
            : { key, label, missing: true };
    }

    // releases
    const releases = (releasesRaw ?? []).map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        publishedAt: r.published_at || r.created_at,
        url: r.html_url,
        draft: r.draft,
        prerelease: r.prerelease,
        author: r.author?.login ?? null,
        notes: (r.body || "").trim().split(/\r?\n/).find(Boolean) ?? "",
    }));
    const latestRelease = releases.find((r) => !r.draft && !r.prerelease) ?? null;
    const latestVersion = latestRelease ? latestRelease.tag.replace(/^v/, "") : null;

    // unreleased work since the latest release tag
    let unreleased = null;
    if (latestRelease) {
        const cmp = await guard("compare", () =>
            memo(`${repo}:compare:${latestRelease.tag}:${meta.pushed_at}`, TTL.compare, () => api(`repos/${repo}/compare/${encodeURIComponent(latestRelease.tag)}...${branch}`), force),
        null);
        if (cmp) {
            const commits = (cmp.commits ?? []).map((c) => {
                const subject = c.commit.message.split(/\r?\n/)[0];
                return { sha: c.sha.slice(0, 7), subject, ...commitType(c.commit.message), author: c.author?.login ?? c.commit.author?.name, date: c.commit.author?.date, url: c.html_url };
            }).reverse();
            const skillsTouched = [...new Set((cmp.files ?? []).map((f) => f.filename.match(/^skills\/([^/]+)\//)?.[1]).filter(Boolean))];
            unreleased = { aheadBy: cmp.ahead_by, commits: commits.slice(0, 25), skillsTouched, compareUrl: cmp.html_url };
        }
    }

    // versions across release surfaces
    const versions = [];
    await Promise.all(
        VERSION_FILES.filter((p) => byPath.has(p)).map((p) =>
            guard(`version ${p}`, async () => {
                const json = JSON.parse(await blob(repo, byPath.get(p)));
                if (typeof json.version === "string") versions.push({ path: p, label: "version", value: json.version });
                for (const plugin of json.plugins ?? []) {
                    if (typeof plugin.version === "string") versions.push({ path: p, label: plugin.name ?? "plugin", value: plugin.version });
                }
                if (typeof json.metadata?.version === "string") versions.push({ path: p, label: "marketplace schema", value: json.metadata.version, informational: true });
            }),
        ),
    );
    versions.sort((a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label));

    // skills and prompts
    const skills = (
        await Promise.all(
            entries
                .filter((e) => e.type === "blob" && /^skills\/[^/]+\/SKILL\.md$/.test(e.path))
                .map((e) =>
                    guard(`skill ${e.path}`, async () => {
                        const fm = parseSkill(await blob(repo, e.sha));
                        const dir = e.path.split("/")[1];
                        return { dir, name: fm.name ?? dir, version: fm.version, description: fm.description, changedSinceRelease: Boolean(unreleased?.skillsTouched.includes(dir)), url: `https://github.com/${repo}/tree/${branch}/skills/${dir}` };
                    }, null),
                ),
        )
    ).filter(Boolean).sort((a, b) => a.dir.localeCompare(b.dir));
    const prompts = entries
        .filter((e) => e.type === "blob" && /^\.github\/prompts\/[^/]+\.prompt\.md$/.test(e.path))
        .map((e) => ({ path: e.path, name: base(e.path).replace(/\.prompt\.md$/, "") }));

    // pull requests & issues
    const repoGql = gql?.repository;
    const label = (n) => (n.labels?.nodes ?? []).map((l) => l.name);
    const isBot = (a) => !a || a.__typename === "Bot" || /\[bot\]$|^(app\/)?copilot/i.test(a.login);
    const pulls = (repoGql?.prs.nodes ?? []).map((p) => ({
        number: p.number,
        title: p.title,
        draft: p.isDraft,
        url: p.url,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        branch: p.headRefName,
        review: p.reviewDecision,
        mergeable: p.mergeable,
        mergeState: p.mergeStateStatus,
        checks: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
        additions: p.additions,
        deletions: p.deletions,
        files: p.changedFiles,
        author: p.author?.login ?? "ghost",
        bot: isBot(p.author),
        labels: label(p),
    }));
    const merged = (repoGql?.merged.nodes ?? []).map((p) => ({ number: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt, author: p.author?.login ?? "ghost", mergedBy: p.mergedBy?.login ?? null }));
    const issues = (repoGql?.issues.nodes ?? []).map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        author: i.author?.login ?? "ghost",
        labels: label(i),
        comments: i.comments.totalCount,
        health: isAutomationIssue(i),
    }));

    const variables = vars ? (vars.variables ?? []).map((v) => ({ name: v.name, value: v.value, updatedAt: v.updated_at })) : null;
    const switches = killSwitches(variables);

    const data = {
        repo,
        role,
        fetchedAt,
        meta: { defaultBranch: branch, url: meta.html_url, description: meta.description, private: meta.private, archived: meta.archived, pushedAt: meta.pushed_at, stars: meta.stargazers_count },
        latestRelease,
        latestVersion,
        releases,
        unreleased,
        versions,
        skills,
        prompts,
        workflows,
        flows,
        runs: runs.slice(0, 80),
        pulls,
        pullTotal: repoGql?.prs.totalCount ?? pulls.length,
        merged,
        issues,
        issueTotal: repoGql?.issues.totalCount ?? issues.length,
        variables,
        secrets: secrets ? (secrets.secrets ?? []).map((s) => ({ name: s.name, updatedAt: s.updated_at })) : null,
        switches,
        errors,
    };
    data.findings = analyze(data);
    return data;
}

const SEVERITY = { fail: 0, warn: 1, todo: 2, info: 3 };
const ago = (iso) => Math.max(0, Date.now() - Date.parse(iso));
const days = (ms) => Math.floor(ms / 86400000);

export function analyze(d) {
    const out = [];
    const add = (severity, id, title, detail, extra = {}) => out.push({ repo: d.repo, severity, id: `${d.repo}:${id}`, title, detail, ...extra });
    const dispatch = (label, workflow, inputs = {}, confirm = false) => ({ label, action: "dispatch", args: { repo: d.repo, workflow, inputs }, confirm });

    for (const flow of Object.values(d.flows)) {
        if (flow.missing) continue;
        const m = flow.lastMeaningful;
        if (flow.workflowState && flow.workflowState !== "active") {
            add("warn", `disabled:${flow.key}`, `${flow.label} workflow is ${flow.workflowState.replace(/_/g, " ")}`, "GitHub disables scheduled workflows after 60 days without repository activity; re-enable it in Actions.", { url: `https://github.com/${d.repo}/actions/workflows/${flow.file}` });
        }
        if (m?.state === "fail") {
            add("fail", `failed:${flow.key}`, `${flow.label} failed`, `Run #${m.number} (${m.event}${m.branch ? ` on ${m.branch}` : ""}) failed ${days(ago(m.createdAt)) ? `${days(ago(m.createdAt))}d` : "recently"} ago and nothing has succeeded since.`, {
                url: m.url,
                runId: m.id,
                actions: [
                    { label: "Run details", action: "run_details", args: { repo: d.repo, id: m.id } },
                    { label: "Re-run failed jobs", action: "run_rerun_failed", args: { repo: d.repo, id: m.id }, confirm: true },
                    { label: "Ask Copilot", action: "ask", args: { prompt: `The "${flow.label}" workflow in ${d.repo} failed (run ${m.url}). Investigate the failure with gh, explain the root cause and propose a fix.` } },
                ],
            });
        }
        if (flow.key === "weekly" && !flow.workflowState?.startsWith("disabled")) {
            const ok = flow.lastSuccess;
            if (ok && days(ago(ok.createdAt)) > 8) add("warn", "weekly-overdue", `Weekly update is overdue`, `Last successful weekly run was ${days(ago(ok.createdAt))} days ago.`, { url: `https://github.com/${d.repo}/actions/workflows/${flow.file}` });
            if (!ok && !flow.last) add("info", "weekly-never", "Weekly update has no run history yet", "", { url: `https://github.com/${d.repo}/actions/workflows/${flow.file}` });
        }
    }

    if (d.secrets && !d.secrets.some((s) => s.name === "COPILOT_GITHUB_TOKEN") && !d.flows.weekly?.missing) {
        add("fail", "missing-secret", "COPILOT_GITHUB_TOKEN secret is missing", "The weekly agentic update needs this repository secret.", { url: `https://github.com/${d.repo}/settings/secrets/actions` });
    }

    for (const [name, sw] of Object.entries(d.switches ?? {})) {
        if (!sw.enabled) add("warn", `paused:${name}`, `${name} is off`, `Variable ${name}=false pauses this part of the automation.`, { actions: [{ label: "Resume", action: "var_set", args: { repo: d.repo, name, value: "true" }, confirm: true }] });
    }

    if (d.role !== "hub") {
        const pinned = [...new Set(d.workflows.flatMap((w) => w.hubRefs))].filter((r) => r !== "main");
        if (pinned.length) add("warn", "hub-ref", `Hub workflows pinned to ${pinned.join(", ")}`, "Spoke callers should reference the hub at @main after rollout.");
    }

    if (d.latestVersion) {
        const drift = d.versions.filter((v) => !v.informational && v.value !== d.latestVersion);
        if (drift.length) add("warn", "drift", `${drift.length} version file(s) differ from ${d.latestRelease.tag}`, drift.map((v) => `${v.path} (${v.label}) = ${v.value}`).join("; "));
    }

    if (d.unreleased?.aheadBy > 0) {
        const releasable = d.unreleased.commits.filter((c) => ["feat", "fix", "perf", "revert"].includes(c.type) || c.breaking).length;
        const releasing = d.flows.release?.last && d.flows.release.last.state === "run";
        const release = d.workflows.find((w) => w.key === "release" && w.dispatchable);
        const detail = `${d.unreleased.aheadBy} commit(s) on ${d.meta.defaultBranch} since ${d.latestRelease.tag}${d.unreleased.skillsTouched.length ? `; skills touched: ${d.unreleased.skillsTouched.join(", ")}` : ""}.`;
        if (releasing) add("info", "releasing", "Release in progress", detail, { url: d.flows.release.last.url });
        else if (releasable || d.unreleased.skillsTouched.length) {
            add("todo", "unreleased", `Unreleased changes since ${d.latestRelease.tag}`, detail, {
                url: d.unreleased.compareUrl,
                ...(release && { actions: [dispatch("Release dry run", release.file, { dry_run: "true", bump: "auto" }), dispatch("Release now…", release.file, { dry_run: "false", bump: "auto" })] }),
            });
        } else add("info", "unreleased-minor", `${d.unreleased.aheadBy} non-releasable commit(s) since ${d.latestRelease.tag}`, detail, { url: d.unreleased.compareUrl });
    }

    const bots = d.pulls.filter((p) => p.bot);
    const humans = d.pulls.filter((p) => !p.bot);
    const drafts = bots.filter((p) => p.draft);
    const ready = bots.filter((p) => !p.draft);
    if (ready.length) add("todo", "bot-prs", `${ready.length} update PR(s) waiting for approval`, `${ready.map((p) => `#${p.number}`).join(", ")} — approving one triggers merge and release.`, { actions: [{ label: "Review PRs", action: "goto", args: { tab: "prs", repo: d.repo } }] });
    if (drafts.length) add("todo", "draft-prs", `${drafts.length} draft update PR(s)`, `${drafts.map((p) => `#${p.number}`).join(", ")} — mark ready for review to enable approve-and-ship.`, { actions: [{ label: "Review PRs", action: "goto", args: { tab: "prs", repo: d.repo } }] });
    if (humans.length) add("info", "human-prs", `${humans.length} open pull request(s) by people`, humans.map((p) => `#${p.number}`).join(", "), { actions: [{ label: "Review PRs", action: "goto", args: { tab: "prs", repo: d.repo } }] });
    const stale = d.pulls.filter((p) => days(ago(p.createdAt)) > 7);
    if (stale.length) add("warn", "stale-prs", `${stale.length} pull request(s) open for more than 7 days`, stale.map((p) => `#${p.number}`).join(", "), { actions: [{ label: "Review PRs", action: "goto", args: { tab: "prs", repo: d.repo } }] });

    for (const issue of d.issues.filter((i) => i.health)) {
        add("warn", `issue:${issue.number}`, `Issue #${issue.number}: ${issue.title}`, `Opened ${days(ago(issue.createdAt))}d ago, ${issue.comments} comment(s).`, {
            url: issue.url,
            actions: [{ label: "Close", action: "issue_close", args: { repo: d.repo, number: issue.number }, confirm: true }],
        });
    }
    for (const e of d.errors) add("info", `error:${e.section}`, `Could not load ${e.section}`, e.message);

    return out.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
}
