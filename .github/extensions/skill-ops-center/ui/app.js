"use strict";
(() => {
    const TOKEN = document.querySelector('meta[name="ops-token"]')?.content ?? "";
    const $ = (sel, root = document) => root.querySelector(sel);

    /* ---------- safe templating: every interpolated value is escaped unless wrapped by html/raw ---------- */
    class Raw {
        constructor(s) {
            this.s = s;
        }
    }
    const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
    const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : v === false || v == null ? "" : esc(v));
    const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ""), ""));
    const raw = (s) => new Raw(s);
    const put = (el, r) => {
        el.innerHTML = part(r);
    };
    const cmd = (name, args = {}) => raw(`data-cmd="${esc(name)}" data-a="${esc(JSON.stringify(args))}"`);

    /* ---------- formatting ---------- */
    const short = (repo) => String(repo).split("/")[1] ?? repo;
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const abs = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
    const rel = (iso) => {
        if (!iso) return "—";
        const sec = (Date.now() - Date.parse(iso)) / 1000;
        const a = Math.abs(sec);
        const [n, u] = a < 60 ? [Math.round(a), "s"] : a < 3600 ? [Math.round(a / 60), "m"] : a < 86400 ? [Math.round(a / 3600), "h"] : [Math.round(a / 86400), "d"];
        return sec < 0 ? `in ${n}${u}` : `${n}${u} ago`;
    };
    const when = (iso) => (iso ? html`<span title="${abs(iso)}">${rel(iso)}</span>` : raw("—"));
    const duration = (r) => {
        if (r.status !== "completed" || !r.startedAt || !r.updatedAt) return "";
        const s = Math.max(0, Math.round((Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 1000));
        return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    };
    const safeUrl = (u) => (/^https:\/\/github\.com\//.test(String(u)) ? u : "#");
    const link = (url, text, cls = "") => html`<a class="${cls}" href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

    const GLYPH = { ok: "✓", fail: "✕", run: "●", cancel: "⊘", skip: "↷", warn: "!", none: "–" };
    const STATE_LABEL = { ok: "Success", fail: "Failed", run: "Running", cancel: "Cancelled", skip: "Skipped", warn: "Neutral", none: "No runs" };
    const chip = (state, text, c) =>
        c
            ? html`<button class="chip ${state}" ${c} title="${STATE_LABEL[state] ?? ""}"><span class="g">${GLYPH[state] ?? ""}</span>${text}</button>`
            : html`<span class="chip ${state}" title="${STATE_LABEL[state] ?? ""}"><span class="g">${GLYPH[state] ?? ""}</span>${text}</span>`;
    const jobState = (status, conclusion) => {
        if (status !== "completed") return "run";
        return { success: "ok", failure: "fail", timed_out: "fail", cancelled: "cancel", skipped: "skip" }[conclusion] ?? "warn";
    };
    const SEV = { fail: "Failing", warn: "Warning", todo: "To do", info: "Info" };
    const actBtn = (a, cls = "") => html`<button class="btn sm ${cls}" ${cmd("do", a)}>${a.label}</button>`;
    const runChip = (r, label) => (r ? chip(r.state, label ?? rel(r.createdAt), cmd("run", { repo: r.repo ?? "", id: r.id })) : chip("none", "No runs"));

    /* ---------- state ---------- */
    const TABS = [
        ["overview", "Overview"],
        ["workflows", "Workflows"],
        ["runs", "Runs"],
        ["prs", "Pull requests"],
        ["issues", "Issues"],
        ["releases", "Releases"],
        ["skills", "Skills"],
        ["settings", "Settings"],
    ];
    const S = {
        state: null,
        error: null,
        loading: false,
        again: false,
        tab: (TABS.find(([id]) => id === location.hash.slice(1)) ?? TABS[0])[0],
        repo: "all",
        rf: { state: "all", event: "all", wf: "all", q: "", hideSkipped: true },
        modal: null,
        drawer: null,
        timer: null,
        drawerTimer: null,
        dirty: false,
    };
    const repos = () => (S.state?.repos ?? []).filter((d) => S.repo === "all" || d.repo === S.repo);
    const find = (repo) => S.state?.repos.find((d) => d.repo === repo);

    /* ---------- transport ---------- */
    async function api(path, opts = {}) {
        const res = await fetch(path, { ...opts, headers: { "X-Ops-Token": TOKEN, "Content-Type": "application/json" } });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error(body?.error?.message || res.statusText || "Request failed"), { code: body?.error?.code, status: res.status });
        return body;
    }

    async function load({ force = false } = {}) {
        if (S.loading) {
            S.again = S.again || force;
            return;
        }
        S.loading = true;
        paintHeader();
        try {
            S.state = await api(`/api/state${force ? "?force=1" : ""}`);
            S.error = null;
        } catch (e) {
            S.error = e.message;
        }
        S.loading = false;
        paintAll();
        schedule();
        if (S.again) {
            S.again = false;
            load();
        }
    }

    function schedule() {
        clearTimeout(S.timer);
        const sec = S.state?.config?.refreshSec ?? 90;
        S.timer = setTimeout(() => {
            if (document.hidden) S.timer = setTimeout(schedule, 5000);
            else load();
        }, sec * 1000);
    }

    async function send(body) {
        try {
            const r = await api("/api/action", { method: "POST", body: JSON.stringify(body) });
            toast(r.message || "Done", r.ok === false ? "fail" : "ok", r.url);
            if (body.type !== "ask") {
                load();
                setTimeout(() => load(), 4500);
                if (S.drawer) setTimeout(refreshDrawer, 1500);
            }
            return r;
        } catch (e) {
            toast(e.message, "fail");
            throw e;
        }
    }

    /* ---------- toasts ---------- */
    function toast(message, kind = "ok", url) {
        const el = document.createElement("div");
        el.className = `toast ${kind === "ok" ? "" : kind}`;
        put(el, html`${message}${url ? html` · ${link(url, "Open ↗")}` : ""}`);
        $("#toasts").appendChild(el);
        setTimeout(() => el.remove(), kind === "fail" ? 10000 : 5500);
    }

    /* ---------- header & tabs ---------- */
    function paintHeader() {
        const s = S.state;
        const h = s?.health ?? "none";
        const c = s?.counts ?? {};
        const label = !s ? "Loading…" : h === "ok" ? "Healthy" : h === "warn" ? plural(c.warn, "warning") : `${c.fail} failing`;
        const switches = (s?.repos ?? []).flatMap((d) => Object.values(d.switches ?? {}));
        const anyPaused = switches.some((x) => !x.enabled);
        const rate = s?.rate?.core;
        put(
            $("#top"),
            html`
            <div class="brand"><span class="logo">◆</span> Skill Ops Center</div>
            <span class="pill ${h}" title="${s ? `${c.fail} failing · ${c.warn} warnings · ${c.todo} to do` : ""}">${label}</span>
            ${anyPaused ? html`<span class="pill warn" title="One or more kill switches are off">Paused</span>` : ""}
            <select data-bind="repo" aria-label="Repository filter">
              <option value="all" ${S.repo === "all" ? "selected" : ""}>All repositories</option>
              ${(s?.config?.repos ?? []).map((r) => html`<option value="${r.repo}" ${S.repo === r.repo ? "selected" : ""}>${r.repo}</option>`)}
            </select>
            <span class="grow"></span>
            <span class="muted small" id="updated">${s ? `Updated ${rel(s.generatedAt)}` : ""}</span>
            <button class="btn" ${cmd("refresh")} ${S.loading ? "disabled" : ""}><span class="${S.loading ? "spin" : ""}">↻</span> Refresh</button>
            ${s ? (anyPaused ? html`<button class="btn" ${cmd("resumeAll")}>Resume automation</button>` : html`<button class="btn" ${cmd("pauseAll")}>Pause automation</button>`) : ""}
            <button class="btn" ${cmd("askOverview")} ${s ? "" : "disabled"}>Ask Copilot</button>
            ${s?.login ? html`<span class="badge" title="gh authentication">@${s.login}</span>` : ""}
            ${rate ? html`<span class="badge ${rate.remaining < 500 ? "warn" : ""}" title="REST API quota, resets ${abs(new Date(rate.reset * 1000).toISOString())}">API ${rate.remaining}/${rate.limit}</span>` : ""}`,
        );
    }

    function paintTabs() {
        const s = S.state;
        const attention = s ? s.counts.fail + s.counts.warn + s.counts.todo : 0;
        const prs = (s?.repos ?? []).reduce((n, d) => n + (d.pullTotal ?? 0), 0);
        const issues = (s?.repos ?? []).reduce((n, d) => n + (d.issueTotal ?? 0), 0);
        const count = (key) => {
            if (!s) return "";
            if (key === "overview" && attention) return html`<span class="n ${s.counts.fail ? "fail" : "warn"}">${attention}</span>`;
            if (key === "prs" && prs) return html`<span class="n">${prs}</span>`;
            if (key === "issues" && issues) return html`<span class="n">${issues}</span>`;
            return "";
        };
        put($("#tabs"), html`${TABS.map(([key, label]) => html`<button class="tab ${S.tab === key ? "on" : ""}" ${cmd("tab", { tab: key })}>${label}${count(key)}</button>`)}`);
    }

    function paintAll() {
        paintHeader();
        paintTabs();
        paintMain();
    }

    function paintMain() {
        const main = $("#main");
        const active = document.activeElement;
        const keep = active && main.contains(active) && active.dataset.bind ? { bind: active.dataset.bind, start: active.selectionStart, end: active.selectionEnd } : null;
        const y = window.scrollY;
        if (!S.state) {
            put(main, S.error ? html`<div class="banner"><b>Could not load data.</b> ${S.error}<div class="btns" style="margin-top:8px"><button class="btn" ${cmd("refresh")}>Retry</button></div></div>` : html`<div class="loading">Loading repositories…</div>`);
            return;
        }
        const views = { overview, workflows: workflowsTab, runs: runsTab, prs: prsTab, issues: issuesTab, releases: releasesTab, skills: skillsTab, settings: settingsTab };
        put(main, html`${S.error ? html`<div class="banner">Refresh failed: ${S.error}. Showing the last data.</div>` : ""}${(S.state.repos.filter((d) => d.error)).map((d) => html`<div class="banner"><b>${d.repo}</b> could not be loaded: ${d.error}</div>`)}${views[S.tab]()}`);
        window.scrollTo(0, y);
        if (keep) {
            const el = main.querySelector(`[data-bind="${keep.bind}"]`);
            if (el) {
                el.focus();
                try {
                    el.setSelectionRange(keep.start, keep.end);
                } catch {
                    /* not a text input */
                }
            }
        }
    }

    /* ---------- overview ---------- */
    const kpi = (label, value, sub) => html`<div class="kpi"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
    const isFlowRun = (r) => r.event !== "pull_request" && r.event !== "pull_request_target";

    function findingItem(f) {
        return html`<li class="finding ${f.severity}">
          <span class="sev ${f.severity}">${SEV[f.severity]}</span>
          <div class="grow"><div class="f-title"><span class="repo-tag">${short(f.repo)}</span>${f.title}</div>${f.detail ? html`<div class="f-detail">${f.detail}</div>` : ""}</div>
          <div class="f-actions">${(f.actions ?? []).map((a) => actBtn(a))}${f.url ? link(f.url, "Open ↗", "btn sm ghost") : ""}</div>
        </li>`;
    }

    function pipeline(d) {
        const flows = Object.values(d.flows).filter((f) => !f.missing);
        return html`<div class="pipe">${flows.map((f) => {
            const r = f.last?.state === "run" ? f.last : (f.lastMeaningful ?? f.last);
            const run = r ? { ...r, repo: d.repo } : null;
            return html`<div class="pipe-item"><div class="small muted">${f.label}${f.workflowState !== "active" ? " (disabled)" : ""}</div>${run ? chip(run.state, rel(run.createdAt), cmd("run", { repo: d.repo, id: run.id })) : chip("none", "No runs")}</div>`;
        })}</div>`;
    }

    function repoCard(d) {
        if (d.error) return html`<section class="card"><h3>${d.repo}</h3><div class="note danger">${d.error}</div></section>`;
        const weekly = d.workflows.find((w) => w.key === "weekly" && w.dispatchable);
        const release = d.workflows.find((w) => w.key === "release" && w.dispatchable);
        const botReady = d.pulls.filter((p) => p.bot && !p.draft).length;
        const unreleased = d.unreleased?.aheadBy ?? 0;
        return html`<section class="card">
          <h3>${link(d.meta.url, d.repo)} <span class="badge ${d.role === "hub" ? "info" : ""}">${d.role}</span></h3>
          <div class="kv">
            <div>Release</div><div>${d.latestRelease ? html`${link(d.latestRelease.url, d.latestRelease.tag)} · ${when(d.latestRelease.publishedAt)}${unreleased ? html` · <span class="${d.unreleased.commits.some((c) => ["feat", "fix", "perf"].includes(c.type)) ? "warn" : "muted"}">${plural(unreleased, "commit")} ahead</span>` : html` · <span class="ok">up to date</span>`}` : "No releases"}</div>
            <div>Skills</div><div>${d.skills.length} skills · ${d.prompts.length} prompts</div>
            <div>Open work</div><div>${plural(d.pullTotal, "PR")}${botReady ? html` (<span class="info">${botReady} awaiting approval</span>)` : ""} · ${plural(d.issueTotal, "issue")}</div>
            <div>Last push</div><div>${when(d.meta.pushedAt)}</div>
          </div>
          ${pipeline(d)}
          ${d.switches ? html`<div class="btns" style="margin:10px 0">${Object.entries(d.switches).map(([name, sw]) => html`<span class="badge ${sw.enabled ? "ok" : "warn"}">${name}: ${sw.enabled ? "on" : "paused"}</span><button class="btn sm ghost" ${cmd("do", { label: sw.enabled ? "Pause" : "Resume", action: "var_set", args: { repo: d.repo, name, value: sw.enabled ? "false" : "true" }, confirm: true })}>${sw.enabled ? "Pause" : "Resume"}</button>`)}</div>` : ""}
          <div class="btns">
            ${weekly ? html`<button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: weekly.file })}>Weekly update…</button>` : ""}
            ${release ? html`<button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: release.file, inputs: { dry_run: "true", bump: "auto" } })}>Release dry run</button><button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: release.file, inputs: { dry_run: "false", bump: "auto" } })}>Release now…</button>` : ""}
            ${link(`https://github.com/${d.repo}/actions`, "Actions ↗", "btn sm ghost")}
          </div>
        </section>`;
    }

    function schedules(rs) {
        const rows = rs
            .filter((d) => !d.error)
            .flatMap((d) => d.workflows.flatMap((w) => (w.state === "active" ? w.crons.map((c) => ({ repo: d.repo, w, c })) : [])))
            .filter((x) => x.c.next)
            .sort((a, b) => (a.c.next < b.c.next ? -1 : 1));
        if (!rows.length) return html`<div class="empty">No scheduled workflows.</div>`;
        return html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Next run</th><th>Repository</th><th>Workflow</th><th>Schedule</th><th>Last run</th></tr></thead><tbody>
          ${rows.map(({ repo, w, c }) => html`<tr><td class="nowrap">${when(c.next)} <span class="sub">${abs(c.next)}</span></td><td>${short(repo)}</td><td>${link(w.url, w.name)}</td><td>${c.human} <span class="sub mono">${c.expr}</span></td><td>${w.lastFlowRun ? runChip({ ...w.lastFlowRun, repo }) : chip("none", "No runs")}</td></tr>`)}
        </tbody></table></div>`;
    }

    function overview() {
        const rs = repos();
        const s = S.state;
        const findings = s.findings.filter((f) => S.repo === "all" || f.repo === S.repo);
        const action = findings.filter((f) => f.severity !== "info");
        const info = findings.filter((f) => f.severity === "info");
        const day = Date.now() - 86400000;
        const recent = rs.flatMap((d) => (d.runs ?? []).filter((r) => isFlowRun(r) && Date.parse(r.createdAt) > day && r.state !== "skip"));
        const okRuns = recent.filter((r) => r.state === "ok").length;
        const failRuns = recent.filter((r) => r.state === "fail").length;
        const prs = rs.reduce((n, d) => n + (d.pullTotal ?? 0), 0);
        const ready = rs.reduce((n, d) => n + d.pulls.filter((p) => p.bot && !p.draft).length, 0);
        const issues = rs.reduce((n, d) => n + (d.issueTotal ?? 0), 0);
        const healthIssues = rs.reduce((n, d) => n + d.issues.filter((i) => i.health).length, 0);
        const counts = { fail: 0, warn: 0, todo: 0 };
        for (const f of findings) if (f.severity in counts) counts[f.severity]++;
        const next = rs
            .flatMap((d) => d.workflows.filter((w) => w.state === "active" && w.nextRun).map((w) => ({ repo: d.repo, w })))
            .sort((a, b) => (a.w.nextRun < b.w.nextRun ? -1 : 1))[0];

        return html`
        <div class="kpis">
          ${kpi("Health", html`<span class="pill ${counts.fail ? "fail" : counts.warn ? "warn" : "ok"}">${counts.fail ? "Failing" : counts.warn ? "Needs a look" : "Healthy"}</span>`, `${counts.fail} failing · ${counts.warn} warnings · ${counts.todo} to do`)}
          ${kpi("Latest releases", html`${rs.map((d) => html`<div class="small">${short(d.repo)} <b>${d.latestRelease?.tag ?? "—"}</b></div>`)}`, "")}
          ${kpi("Open pull requests", prs, ready ? `${ready} awaiting approval` : "none awaiting approval")}
          ${kpi("Open issues", issues, healthIssues ? `${healthIssues} health report${healthIssues === 1 ? "" : "s"}` : "no health reports")}
          ${kpi("Runs, last 24h", html`<span class="ok">${okRuns}</span> / <span class="${failRuns ? "fail" : "muted"}">${failRuns}</span>`, "succeeded / failed (skips excluded)")}
          ${kpi("Next scheduled run", next ? when(next.w.nextRun) : "—", next ? `${short(next.repo)} · ${next.w.name}` : "nothing scheduled")}
        </div>

        <div class="section"><div class="head"><h2>Needs attention</h2></div>
          ${action.length ? html`<ul class="findings">${action.map(findingItem)}</ul>` : html`<div class="empty">Nothing needs your attention. 🎉</div>`}
          ${info.length ? html`<details><summary>${plural(info.length, "informational item")}</summary><ul class="findings" style="margin-top:6px">${info.map(findingItem)}</ul></details>` : ""}
        </div>

        <div class="section"><div class="head"><h2>Repositories</h2><span class="muted small">Pipeline = latest run of each flow. Click a chip for details.</span></div>
          <div class="grid">${rs.map(repoCard)}</div></div>

        <div class="section"><div class="head"><h2>Upcoming scheduled runs (UTC cron, shown in local time)</h2></div>${schedules(rs)}</div>

        <div class="section"><details><summary>How the system works</summary>${flowExplainer()}</details></div>`;
    }

    function flowExplainer() {
        return html`<div class="flow"><ol>
          <li><b>Weekly update</b> (Mon, per repo): the shared gh-aw worker in the hub researches upstream changes and opens a draft or ready PR per skill.</li>
          <li><b>Review</b>: you mark the PR ready and approve it. <b>Approve → ship</b> merges it automatically (unless <code>AUTO_SHIP</code> is false).</li>
          <li><b>Release</b>: after a debounce window the release workflow bumps versions, tags, publishes the GitHub release and plugin/marketplace manifests (unless <code>AUTO_RELEASE</code> is false).</li>
          <li><b>Health check</b> (Mon): opens or updates one “Skill automation health” issue when a flow is failing or stale, and closes it once everything is green.</li>
          <li><b>Website</b> (hub): refreshes the published site every 6 hours.</li>
        </ol></div>`;
    }

    /* ---------- workflows ---------- */
    function workflowRow(d, w) {
        return html`<tr>
          <td>${link(w.url, w.name)}<span class="sub mono">${w.file}</span></td>
          <td>${w.key ? html`<span class="badge info">${d.flows[w.key]?.label ?? w.key}</span>` : ""}</td>
          <td>${w.triggers.map((t) => html`<span class="badge">${t}</span> `)}</td>
          <td>${w.crons.length ? w.crons.map((c) => html`<div>${c.human}</div>`) : html`<span class="muted">—</span>`}</td>
          <td class="nowrap">${w.nextRun && w.state === "active" ? when(w.nextRun) : "—"}</td>
          <td>${w.lastFlowRun ? runChip({ ...w.lastFlowRun, repo: d.repo }) : chip("none", "No runs")}</td>
          <td>${w.state === "active" ? html`<span class="ok">active</span>` : html`<span class="warn">${w.state.replace(/_/g, " ")}</span>`}</td>
          <td><div class="btns">
            ${w.dispatchable && w.state === "active" ? html`<button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: w.file })}>Run…</button>` : ""}
            ${w.state !== "active" ? html`<button class="btn sm" ${cmd("do", { label: "Enable", action: "workflow_enable", args: { repo: d.repo, workflow: w.file } })}>Enable</button>` : ""}
            <button class="btn sm ghost" ${cmd("tab", { tab: "runs", repo: d.repo, wf: `${d.repo}|${w.id}` })}>History</button>
          </div></td></tr>`;
    }

    function workflowsTab() {
        return html`${repos().filter((d) => !d.error).map((d) => {
            const main = d.workflows.filter((w) => !w.reusable && !w.dynamic);
            const other = d.workflows.filter((w) => w.reusable || w.dynamic);
            const head = html`<thead><tr><th>Workflow</th><th>Flow</th><th>Triggers</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>State</th><th></th></tr></thead>`;
            return html`<section class="section"><div class="head"><h2>${d.repo}</h2><span class="muted small">${plural(main.length, "workflow")}${other.length ? ` + ${other.length} internal/reusable` : ""}</span></div>
              <div class="tbl-wrap"><table class="tbl">${head}<tbody>${main.map((w) => workflowRow(d, w))}</tbody></table></div>
              ${other.length ? html`<details><summary>${plural(other.length, "reusable / internal workflow")}</summary><div class="tbl-wrap"><table class="tbl">${head}<tbody>${other.map((w) => workflowRow(d, w))}</tbody></table></div></details>` : ""}
            </section>`;
        })}`;
    }

    /* ---------- runs ---------- */
    function runsTab() {
        const rs = repos().filter((d) => !d.error);
        const all = rs.flatMap((d) => d.runs.map((r) => ({ ...r, repo: d.repo })));
        const events = [...new Set(all.map((r) => r.event))].sort();
        const f = S.rf;
        const q = f.q.trim().toLowerCase();
        const list = all
            .filter((r) => (f.state === "all" || r.state === f.state) && (f.event === "all" || r.event === f.event) && (f.wf === "all" || `${r.repo}|${r.workflowId}` === f.wf) && (!f.hideSkipped || r.state !== "skip") && (!q || `${r.title} ${r.branch} ${r.actor} ${r.workflow}`.toLowerCase().includes(q)))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
            .slice(0, 250);
        const opt = (v, t, cur) => html`<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`;
        return html`
        <div class="filters">
          <select data-bind="rf.state" aria-label="Status">${[["all", "Any status"], ["ok", "Success"], ["fail", "Failed"], ["run", "Running"], ["cancel", "Cancelled"], ["skip", "Skipped"]].map(([v, t]) => opt(v, t, f.state))}</select>
          <select data-bind="rf.event" aria-label="Event">${opt("all", "Any event", f.event)}${events.map((e) => opt(e, e, f.event))}</select>
          <select data-bind="rf.wf" aria-label="Workflow">${opt("all", "Any workflow", f.wf)}${rs.map((d) => html`<optgroup label="${d.repo}">${d.workflows.filter((w) => !w.dynamic).map((w) => opt(`${d.repo}|${w.id}`, w.name, f.wf))}</optgroup>`)}</select>
          <input type="text" data-bind="rf.q" placeholder="Search title, branch, actor…" value="${f.q}" aria-label="Search runs">
          <label class="small"><input type="checkbox" data-bind="rf.hideSkipped" ${f.hideSkipped ? "checked" : ""}> Hide skipped</label>
          <span class="muted small">${plural(list.length, "run")}</span>
        </div>
        ${list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Status</th><th>Repository</th><th>Workflow</th><th>Run</th><th>Event</th><th>Actor</th><th>Started</th><th>Took</th><th></th></tr></thead><tbody>
          ${list.map((r) => html`<tr>
            <td>${chip(r.state, STATE_LABEL[r.state], cmd("run", { repo: r.repo, id: r.id }))}</td>
            <td>${short(r.repo)}</td><td>${r.workflow}</td>
            <td class="title" title="${r.title}">${r.title}<span class="sub">#${r.number}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ""} · ${r.branch ?? ""}@${r.sha}</span></td>
            <td><span class="badge">${r.event}</span></td><td>${r.actor ?? ""}</td><td class="nowrap">${when(r.createdAt)}</td><td class="nowrap">${duration(r)}</td>
            <td><div class="btns"><button class="btn sm" ${cmd("run", { repo: r.repo, id: r.id })}>Details</button>${link(r.url, "↗", "btn sm ghost")}</div></td></tr>`)}
        </tbody></table></div>` : html`<div class="empty">No runs match these filters.</div>`}`;
    }

    /* ---------- pull requests ---------- */
    function prStatus(p) {
        const review = { APPROVED: chip("ok", "Approved"), CHANGES_REQUESTED: chip("fail", "Changes requested"), REVIEW_REQUIRED: chip("warn", "Review required") }[p.review] ?? chip("none", "No review");
        const checks = { SUCCESS: chip("ok", "Checks pass"), FAILURE: chip("fail", "Checks fail"), ERROR: chip("fail", "Checks error"), PENDING: chip("run", "Checks running"), EXPECTED: chip("run", "Checks pending") }[p.checks] ?? chip("none", "No checks");
        return html`<div class="btns">${review}${checks}${p.mergeable === "CONFLICTING" ? chip("fail", "Conflicts") : ""}</div>`;
    }

    function prsTab() {
        return html`${repos().filter((d) => !d.error).map((d) => html`<section class="section">
          <div class="head"><h2>${d.repo}</h2><span class="muted small">${d.pullTotal > d.pulls.length ? `showing ${d.pulls.length} of ${d.pullTotal} open` : `${plural(d.pullTotal, "open pull request")}`}</span></div>
          ${d.pulls.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Title</th><th>Author</th><th>State</th><th>Review & checks</th><th>Size</th><th>Age</th><th></th></tr></thead><tbody>
            ${d.pulls.map((p) => html`<tr>
              <td>${link(p.url, `#${p.number}`)}</td>
              <td class="title" title="${p.title}">${p.title}<span class="sub mono">${p.branch}</span></td>
              <td>${p.author}${p.bot ? html` <span class="badge info">bot</span>` : ""}</td>
              <td>${p.draft ? html`<span class="badge warn">Draft</span>` : html`<span class="badge ok">Ready</span>`}</td>
              <td>${prStatus(p)}</td>
              <td class="nowrap"><span class="ok">+${p.additions}</span> <span class="fail">−${p.deletions}</span><span class="sub">${plural(p.files, "file")}</span></td>
              <td class="nowrap">${when(p.createdAt)}</td>
              <td><div class="btns">
                ${p.draft ? html`<button class="btn sm" ${cmd("do", { label: "Mark ready", action: "pr_ready", args: { repo: d.repo, number: p.number }, confirm: true })}>Mark ready</button>` : html`<button class="btn sm primary" ${cmd("do", { label: "Approve & ship", action: "pr_approve", args: { repo: d.repo, number: p.number, title: p.title } })}>Approve &amp; ship…</button>`}
                <button class="btn sm" ${cmd("do", { label: "Close", action: "pr_close", args: { repo: d.repo, number: p.number, title: p.title } })}>Close…</button>
                <button class="btn sm ghost" ${cmd("do", { label: "Ask", action: "ask", args: { prompt: `Review pull request ${p.url} in ${d.repo}. Summarize what changed, flag risks, and say whether it is safe to approve and ship.` } })}>Ask Copilot</button>
              </div></td></tr>`)}
          </tbody></table></div>` : html`<div class="empty">No open pull requests.</div>`}
          ${d.merged.length ? html`<details><summary>Recently merged (${d.merged.length})</summary><div class="tbl-wrap"><table class="tbl"><tbody>
            ${d.merged.map((p) => html`<tr><td>${link(p.url, `#${p.number}`)}</td><td class="title" title="${p.title}">${p.title}</td><td>${p.author}</td><td>merged by ${p.mergedBy ?? "?"}</td><td class="nowrap">${when(p.mergedAt)}</td></tr>`)}
          </tbody></table></div></details>` : ""}
        </section>`)}`;
    }

    /* ---------- issues ---------- */
    function issuesTab() {
        return html`${repos().filter((d) => !d.error).map((d) => html`<section class="section">
          <div class="head"><h2>${d.repo}</h2><span class="muted small">${plural(d.issueTotal, "open issue")}</span></div>
          ${d.issues.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Title</th><th>Author</th><th>Labels</th><th>Comments</th><th>Opened</th><th></th></tr></thead><tbody>
            ${d.issues.map((i) => html`<tr>
              <td>${link(i.url, `#${i.number}`)}</td>
              <td class="title" title="${i.title}">${i.title} ${i.health ? html`<span class="badge warn">health</span>` : ""}</td>
              <td>${i.author}</td><td>${i.labels.map((l) => html`<span class="badge">${l}</span> `)}</td><td>${i.comments}</td><td class="nowrap">${when(i.createdAt)}</td>
              <td><div class="btns">
                <button class="btn sm" ${cmd("do", { label: "Close issue", action: "issue_close", args: { repo: d.repo, number: i.number }, confirm: true })}>Close</button>
                <button class="btn sm ghost" ${cmd("do", { label: "Ask", action: "ask", args: { prompt: `Investigate issue ${i.url} in ${d.repo}: ${i.title}. Explain what it means, whether it is still valid, and what to do next.` } })}>Ask Copilot</button>
              </div></td></tr>`)}
          </tbody></table></div>` : html`<div class="empty">No open issues.</div>`}
        </section>`)}`;
    }

    /* ---------- releases ---------- */
    function releasesTab() {
        return html`${repos().filter((d) => !d.error).map((d) => {
            const release = d.workflows.find((w) => w.key === "release" && w.dispatchable);
            const u = d.unreleased;
            return html`<section class="section">
              <div class="head"><h2>${d.repo}</h2><div class="btns">${release ? html`<button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: release.file, inputs: { dry_run: "true", bump: "auto" } })}>Release dry run</button><button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: release.file, inputs: { dry_run: "false", bump: "auto" } })}>Release now…</button>` : ""}</div></div>
              <div class="grid">
                <div class="card"><h3>Releases</h3>${d.releases.length ? html`<table class="tbl"><tbody>${d.releases.map((r) => html`<tr><td>${link(r.url, r.tag)}${r.draft ? html` <span class="badge warn">draft</span>` : ""}${r.prerelease ? html` <span class="badge">pre</span>` : ""}</td><td class="nowrap">${when(r.publishedAt)}</td><td class="muted">${r.author ?? ""}</td></tr>`)}</tbody></table>` : html`<div class="empty">No releases.</div>`}</div>
                <div class="card"><h3>Unreleased ${u ? html`<span class="badge ${u.aheadBy ? "warn" : "ok"}">${u.aheadBy} ahead of ${d.latestRelease.tag}</span>` : ""}</h3>
                  ${u?.commits.length ? html`${u.commits.map((c) => html`<div class="commit"><span class="t"><span class="badge ${c.breaking ? "fail" : ["feat", "fix", "perf"].includes(c.type) ? "info" : ""}">${c.type}${c.breaking ? "!" : ""}</span></span><span class="grow">${link(c.url, c.subject)}</span><span class="muted small nowrap">${c.author ?? ""} · ${rel(c.date)}</span></div>`)}${u.skillsTouched.length ? html`<p class="small muted">Skills touched: ${u.skillsTouched.join(", ")}</p>` : ""}<p>${link(u.compareUrl, "Compare on GitHub ↗", "small")}</p>` : html`<div class="empty">Everything on the default branch is released.</div>`}
                </div>
                <div class="card"><h3>Version alignment ${d.latestVersion ? html`<span class="muted small">(target ${d.latestVersion})</span>` : ""}</h3>
                  ${d.versions.length ? html`<table class="tbl"><tbody>${d.versions.map((v) => html`<tr><td class="mono">${v.path}</td><td>${v.label}</td><td class="mono">${v.value}</td><td>${v.informational ? html`<span class="badge">schema</span>` : v.value === d.latestVersion ? html`<span class="ok">✓</span>` : html`<span class="warn">drift</span>`}</td></tr>`)}</tbody></table>` : html`<div class="empty">No version files found.</div>`}
                </div>
              </div></section>`;
        })}`;
    }

    /* ---------- skills ---------- */
    function skillsTab() {
        return html`${repos().filter((d) => !d.error).map((d) => {
            const weekly = d.workflows.find((w) => w.key === "weekly" && w.dispatchable);
            return html`<section class="section"><div class="head"><h2>${d.repo}</h2><span class="muted small">${plural(d.skills.length, "skill")} · ${plural(d.prompts.length, "prompt")}</span></div>
              <div class="grid">
                <div class="card"><h3>Skills</h3><table class="tbl"><tbody>${d.skills.map((s) => html`<tr><td>${link(s.url, s.name)}${s.changedSinceRelease ? html` <span class="badge warn">changed</span>` : ""}<span class="sub">${(s.description ?? "").slice(0, 110)}${(s.description ?? "").length > 110 ? "…" : ""}</span></td><td class="mono">${s.version ?? "—"}</td></tr>`)}</tbody></table></div>
                <div class="card"><h3>Weekly update prompts</h3><table class="tbl"><tbody>${d.prompts.map((p) => html`<tr><td>${p.name}<span class="sub mono">${p.path}</span></td><td class="right">${weekly && /-skill-update\.prompt\.md$/.test(p.path) ? html`<button class="btn sm" ${cmd("dispatch", { repo: d.repo, workflow: weekly.file, inputs: { prompt_path: p.path } })}>Run…</button>` : ""}</td></tr>`)}</tbody></table></div>
              </div></section>`;
        })}`;
    }

    /* ---------- settings ---------- */
    function settingsTab() {
        const s = S.state;
        const rs = s.repos.filter((d) => !d.error);
        const rate = s.rate;
        return html`
        <div class="section"><div class="head"><h2>Kill switches</h2><div class="btns"><button class="btn sm" ${cmd("pauseAll")}>Pause everything…</button><button class="btn sm" ${cmd("resumeAll")}>Resume everything…</button></div></div>
          <p class="muted small">Repository variables read by the automation. <code>AUTO_RELEASE=false</code> stops releases, <code>AUTO_SHIP=false</code> stops approve-to-merge. Unset means enabled.</p>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Repository</th><th>AUTO_RELEASE</th><th>AUTO_SHIP</th><th>COPILOT_GITHUB_TOKEN</th><th>Hub workflow ref</th></tr></thead><tbody>
            ${rs.map((d) => {
                const refs = [...new Set(d.workflows.flatMap((w) => w.hubRefs))];
                return html`<tr><td>${d.repo}</td>
                  ${["AUTO_RELEASE", "AUTO_SHIP"].map((name) => {
                      const sw = d.switches?.[name];
                      return html`<td>${sw ? html`<span class="badge ${sw.enabled ? "ok" : "warn"}">${sw.enabled ? "on" : "paused"}</span> <button class="btn sm ghost" ${cmd("do", { label: sw.enabled ? "Pause" : "Resume", action: "var_set", args: { repo: d.repo, name, value: sw.enabled ? "false" : "true" }, confirm: true })}>${sw.enabled ? "Pause" : "Resume"}</button>` : "—"}</td>`;
                  })}
                  <td>${d.secrets ? (d.secrets.some((x) => x.name === "COPILOT_GITHUB_TOKEN") ? html`<span class="ok">✓ present</span>` : html`<span class="fail">✕ missing</span>`) : "—"}</td>
                  <td>${d.role === "hub" ? html`<span class="muted">local</span>` : refs.length ? refs.map((r) => html`<span class="badge ${r === "main" ? "ok" : "warn"}">@${r}</span> `) : "—"}</td></tr>`;
            })}
          </tbody></table></div></div>

        <div class="section"><div class="head"><h2>Connected repositories</h2><button class="btn sm" ${cmd("addRepo")}>Connect repository…</button></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Repository</th><th>Role</th><th>Default branch</th><th>Visibility</th><th>Variables</th><th></th></tr></thead><tbody>
            ${s.repos.map((d) => html`<tr><td>${d.error ? d.repo : link(d.meta.url, d.repo)}</td><td><span class="badge ${d.role === "hub" ? "info" : ""}">${d.role}</span></td><td>${d.meta?.defaultBranch ?? "—"}</td><td>${d.meta ? (d.meta.private ? "private" : "public") : "—"}</td>
              <td>${(d.variables ?? []).map((v) => html`<span class="badge" title="${abs(v.updatedAt)}">${v.name}=${v.value}</span> `)}${d.variables && !d.variables.length ? html`<span class="muted">none</span>` : ""}</td>
              <td><button class="btn sm ghost" ${cmd("removeRepo", { repo: d.repo })}>Disconnect</button></td></tr>`)}
          </tbody></table></div></div>

        <div class="section"><div class="head"><h2>Dashboard</h2></div>
          <div class="kv">
            <div>Auto-refresh</div><div><select data-bind="refreshSec" aria-label="Auto-refresh interval">${[30, 60, 90, 180, 300, 600].map((n) => html`<option value="${n}" ${s.config.refreshSec === n ? "selected" : ""}>every ${n < 60 ? `${n}s` : `${n / 60} min`}</option>`)}</select></div>
            <div>GitHub account</div><div>${s.login ? `@${s.login}` : "unknown"} (via gh CLI)</div>
            <div>REST quota</div><div>${rate ? `${rate.core.remaining}/${rate.core.limit}, resets ${rel(new Date(rate.core.reset * 1000).toISOString())}` : "unknown"}</div>
            <div>GraphQL quota</div><div>${rate ? `${rate.graphql.remaining}/${rate.graphql.limit}` : "unknown"}</div>
            <div>Data generated</div><div>${abs(s.generatedAt)}</div>
          </div>
          <details><summary>How the system works</summary>${flowExplainer()}</details></div>`;
    }

    /* ---------- modal ---------- */
    const fieldHtml = (f) => html`<label><span>${f.label}${f.hint ? html` <small>${f.hint}</small>` : ""}</span>${
        f.kind === "select"
            ? html`<select name="${f.name}">${f.options.map((o) => html`<option value="${o.v}" ${o.v === f.value ? "selected" : ""}>${o.t}</option>`)}</select>`
            : html`<input name="${f.name}" type="${f.kind === "number" ? "number" : "text"}" value="${f.value ?? ""}" placeholder="${f.placeholder ?? ""}" ${f.kind === "number" ? raw('min="0"') : ""} autocomplete="off">`
    }</label>`;

    function openModal(spec) {
        S.modal = spec;
        const fields = [...(spec.fields ?? []), ...(spec.typed ? [{ name: "typed", label: spec.typed.label, kind: "text", placeholder: spec.typed.expected }] : [])];
        put(
            $("#modal-root"),
            html`<div class="overlay" data-overlay><form class="modal" id="modal-form" role="dialog" aria-modal="true" aria-label="${spec.title}">
              <h2>${spec.title}</h2>
              <div class="modal-body">${spec.intro ? html`<div class="note ${spec.danger ? "danger" : "info"}">${spec.intro}</div>` : ""}${fields.map(fieldHtml)}</div>
              <div class="modal-error" hidden></div>
              <div class="modal-actions"><button type="button" class="btn" ${cmd("closeModal")}>Cancel</button><button type="submit" class="btn ${spec.danger ? "danger" : "primary"}">${spec.confirmLabel ?? "Confirm"}</button></div>
            </form></div>`,
        );
        const first = $("#modal-root input, #modal-root select");
        if (first) first.focus();
        else $("#modal-root .btn.primary, #modal-root .btn.danger")?.focus();
    }
    const closeModal = () => {
        S.modal = null;
        $("#modal-root").innerHTML = "";
    };
    const modalError = (msg) => {
        const el = $("#modal-root .modal-error");
        if (!el) return;
        el.textContent = msg ?? "";
        el.hidden = !msg;
    };

    async function submitModal(form) {
        const m = S.modal;
        if (!m) return;
        const values = Object.fromEntries(new FormData(form));
        const needsTyped = m.typed && !(m.typed.optionalWhen && m.typed.optionalWhen(values));
        if (needsTyped && String(values.typed ?? "").trim().toLowerCase() !== m.typed.expected.toLowerCase()) {
            modalError(`Type "${m.typed.expected}" to confirm.`);
            return;
        }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        modalError("");
        try {
            await m.onSubmit(values);
            closeModal();
        } catch (e) {
            btn.disabled = false;
            modalError(e.message);
        }
    }

    /* ---------- actions ---------- */
    function openDispatch(repo, file, preset = {}) {
        const d = find(repo);
        const wf = d?.workflows.find((w) => w.file === file);
        if (!wf) return toast(`${file} was not found in ${repo}`, "fail");
        const real = wf.key === "release" || wf.key === "ship";
        const fields = wf.inputs
            .filter((i) => i.name !== "auto_ship")
            .map((i) => {
                const value = String(preset[i.name] ?? i.default ?? "");
                const base = { name: i.name, label: i.name.replace(/_/g, " "), hint: i.description || "", value };
                if (wf.key === "weekly" && i.name === "prompt_path") {
                    return { ...base, label: "prompt", kind: "select", options: [{ v: "", t: "All prompts (default)" }, ...d.prompts.filter((p) => /-skill-update\.prompt\.md$/.test(p.path)).map((p) => ({ v: p.path, t: p.name }))] };
                }
                if (i.type === "boolean") return { ...base, kind: "select", value: value || "false", options: [{ v: "true", t: "true" }, { v: "false", t: "false" }] };
                if (i.type === "choice") return { ...base, kind: "select", options: i.options.map((o) => ({ v: o, t: o })) };
                if (i.type === "number") return { ...base, kind: "number" };
                return { ...base, kind: "text" };
            });
        const intro = wf.key === "weekly" ? "Runs the agentic skill update with Copilot (uses Copilot quota) and opens pull requests for any changes." : real ? "A real run publishes tags, GitHub releases and marketplace versions. Use dry_run=true to only preview the plan." : `Dispatches ${wf.file} on ${d.meta.defaultBranch}.`;
        openModal({
            title: `Run ${wf.name} · ${short(repo)}`,
            intro,
            fields,
            danger: real && preset.dry_run !== "true",
            confirmLabel: "Run workflow",
            typed: real ? { expected: short(repo), label: `Type “${short(repo)}” to publish (not needed for dry runs)`, optionalWhen: (v) => v.dry_run === "true" } : null,
            onSubmit: async (v) => {
                const { typed, ...inputs } = v;
                await send({ type: "dispatch", repo, workflow: file, inputs, confirm: typed });
            },
        });
    }

    function runAction(a) {
        const args = a.args ?? {};
        const type = a.action;
        if (type === "goto") {
            S.tab = args.tab;
            if (args.repo) S.repo = args.repo;
            paintAll();
            window.scrollTo(0, 0);
            return;
        }
        if (type === "run_details") return openDrawer(args.repo, args.id);
        if (type === "dispatch") return openDispatch(args.repo, args.workflow, args.inputs ?? {});
        if (type === "ask") return send({ type: "ask", prompt: args.prompt }).catch(() => {});
        if (type === "pr_approve") {
            return openModal({
                title: `Approve & ship #${args.number}`,
                intro: `Approving ${short(args.repo)}#${args.number} (“${args.title ?? ""}”) triggers the approve-to-ship workflow: merge, then release after the debounce window.`,
                danger: true,
                confirmLabel: "Approve & ship",
                typed: { expected: short(args.repo), label: `Type “${short(args.repo)}” to confirm` },
                onSubmit: (v) => send({ type: "pr_approve", repo: args.repo, number: args.number, confirm: v.typed }),
            });
        }
        if (type === "pr_close") {
            return openModal({
                title: `Close #${args.number}`,
                intro: `Close ${short(args.repo)}#${args.number} (“${args.title ?? ""}”) without merging.`,
                fields: [{ name: "deleteBranch", label: "Delete branch", kind: "select", value: "no", options: [{ v: "no", t: "Keep the branch" }, { v: "yes", t: "Delete the branch" }] }],
                confirmLabel: "Close pull request",
                danger: true,
                onSubmit: (v) => send({ type: "pr_close", repo: args.repo, number: args.number, deleteBranch: v.deleteBranch === "yes" }),
            });
        }
        if (a.confirm) {
            return openModal({
                title: a.label,
                intro: `${a.label} — ${args.repo ?? ""}${args.number ? ` #${args.number}` : ""}${args.name ? ` · ${args.name}=${args.value}` : ""}${args.id ? ` · run ${args.id}` : ""}. Continue?`,
                confirmLabel: a.label,
                onSubmit: () => send({ type, ...args }),
            });
        }
        return send({ type, ...args }).catch(() => {});
    }

    function pauseResume(mode) {
        const word = mode === "pause" ? "PAUSE" : "RESUME";
        openModal({
            title: mode === "pause" ? "Pause all automation" : "Resume all automation",
            intro: mode === "pause" ? "Sets AUTO_RELEASE=false and AUTO_SHIP=false in every connected repository. Scheduled weekly updates keep running, but nothing merges or releases." : "Sets AUTO_RELEASE=true and AUTO_SHIP=true in every connected repository.",
            danger: mode === "pause",
            confirmLabel: mode === "pause" ? "Pause everything" : "Resume everything",
            typed: { expected: word, label: `Type ${word} to confirm` },
            onSubmit: (v) => send({ type: "kill_switch", mode, confirm: v.typed }),
        });
    }

    function overviewPrompt() {
        const s = S.state;
        const lines = s.findings.filter((f) => f.severity !== "info").slice(0, 12).map((f) => `- [${f.severity}] ${f.repo}: ${f.title}`);
        return `Review my skill maintenance automation (${s.repos.map((d) => d.repo).join(", ")}). Current health: ${s.health}.\n${lines.length ? lines.join("\n") : "No open findings."}\nSummarize the situation and recommend the next actions in priority order.`;
    }

    const COMMANDS = {
        refresh: () => load({ force: true }),
        tab: (a) => {
            S.tab = a.tab;
            if (a.repo) S.repo = a.repo;
            if (a.wf !== undefined) S.rf.wf = a.wf;
            paintAll();
            window.scrollTo(0, 0);
        },
        do: runAction,
        run: (a) => openDrawer(a.repo, a.id),
        dispatch: (a) => openDispatch(a.repo, a.workflow, a.inputs ?? {}),
        closeDrawer: () => closeDrawer(),
        closeModal,
        pauseAll: () => pauseResume("pause"),
        resumeAll: () => pauseResume("resume"),
        askOverview: () => send({ type: "ask", prompt: overviewPrompt() }).catch(() => {}),
        addRepo: () =>
            openModal({
                title: "Connect repository",
                intro: "The repository must be reachable with your gh login. Hub repositories host the shared workflows; spokes call them.",
                fields: [
                    { name: "repo", label: "Repository", kind: "text", placeholder: "owner/name" },
                    { name: "role", label: "Role", kind: "select", value: "spoke", options: [{ v: "spoke", t: "spoke" }, { v: "hub", t: "hub" }] },
                ],
                confirmLabel: "Connect",
                onSubmit: (v) => send({ type: "repo_add", repo: v.repo, role: v.role }),
            }),
        removeRepo: (a) =>
            openModal({
                title: `Disconnect ${a.repo}`,
                intro: "Only removes it from this dashboard. Nothing changes in the repository.",
                confirmLabel: "Disconnect",
                onSubmit: () => send({ type: "repo_remove", repo: a.repo }),
            }),
    };

    /* ---------- run drawer ---------- */
    function closeDrawer() {
        clearTimeout(S.drawerTimer);
        S.drawer = null;
        const el = $("#drawer");
        el.hidden = true;
        el.innerHTML = "";
    }

    async function openDrawer(repo, id) {
        clearTimeout(S.drawerTimer);
        S.drawer = { repo, id, data: null, error: null };
        paintDrawer();
        await refreshDrawer();
    }

    async function refreshDrawer() {
        const dr = S.drawer;
        if (!dr) return;
        try {
            dr.data = await api(`/api/run?repo=${encodeURIComponent(dr.repo)}&id=${encodeURIComponent(dr.id)}`);
            dr.error = null;
        } catch (e) {
            dr.error = e.message;
        }
        if (S.drawer !== dr) return;
        paintDrawer();
        clearTimeout(S.drawerTimer);
        if (dr.data && dr.data.status !== "completed") S.drawerTimer = setTimeout(refreshDrawer, 6000);
    }

    function paintDrawer() {
        const dr = S.drawer;
        const el = $("#drawer");
        if (!dr) return;
        el.hidden = false;
        const r = dr.data;
        const st = r ? jobState(r.status, r.conclusion) : "none";
        const args = { repo: dr.repo, id: dr.id };
        put(
            el,
            html`<div class="drawer-head"><div><h2 style="font-size:16px;margin:0">${r ? r.title : `Run ${dr.id}`}</h2><div class="muted small">${dr.repo}${r ? ` · ${r.name}` : ""}</div></div><button class="btn sm" ${cmd("closeDrawer")} aria-label="Close">✕</button></div>
            ${dr.error ? html`<div class="banner">${dr.error}</div>` : ""}
            ${r ? html`
              <div class="btns" style="margin-bottom:10px">${chip(st, r.status === "completed" ? STATE_LABEL[st] : r.status.replace(/_/g, " "))}
                <span class="badge">${r.event}</span><span class="badge mono">${r.branch ?? ""}@${r.sha}</span><span class="muted small">${r.actor ?? ""} · ${when(r.createdAt)} · attempt ${r.attempt}</span></div>
              <div class="btns" style="margin-bottom:12px">
                ${link(r.url, "Open on GitHub ↗", "btn sm")}
                ${r.status !== "completed" ? actBtn({ label: "Cancel run", action: "run_cancel", args, confirm: true }) : actBtn({ label: "Re-run all jobs", action: "run_rerun", args, confirm: true })}
                ${st === "fail" ? actBtn({ label: "Re-run failed jobs", action: "run_rerun_failed", args, confirm: true }) : ""}
                ${actBtn({ label: "Ask Copilot", action: "ask", args: { prompt: `Investigate GitHub Actions run ${r.url} (${r.name}, ${r.conclusion ?? r.status}) in ${dr.repo}. Explain what happened and what to do.` } })}
              </div>
              <h2>Jobs</h2>
              ${r.jobs.length ? r.jobs.map((j) => {
                  const js = jobState(j.status, j.conclusion);
                  const steps = j.steps.filter((s) => s.conclusion !== "skipped");
                  return html`<div class="job"><div class="btns">${chip(js, j.name)} ${j.url ? link(j.url, "↗", "small") : ""}</div>
                    ${steps.map((s) => html`<div class="step"><span class="${jobState(s.status, s.conclusion)}">${GLYPH[jobState(s.status, s.conclusion)]}</span> ${s.name}</div>`)}</div>`;
              }) : html`<div class="muted">No jobs yet.</div>`}
              ${r.log ? html`<h2 style="margin-top:14px">Failed log (last 150 lines)</h2><pre class="log">${r.log}</pre>` : ""}` : dr.error ? "" : html`<div class="loading">Loading run…</div>`}`,
        );
    }

    /* ---------- events ---------- */
    document.addEventListener("click", (e) => {
        const overlay = e.target.closest("[data-overlay]");
        if (overlay && e.target === overlay) return closeModal();
        const el = e.target.closest("[data-cmd]");
        if (!el) return;
        const fn = COMMANDS[el.dataset.cmd];
        if (!fn) return;
        let args = {};
        try {
            args = JSON.parse(el.dataset.a || "{}");
        } catch {
            /* no args */
        }
        Promise.resolve(fn(args)).catch((err) => toast(err.message, "fail"));
    });

    document.addEventListener("submit", (e) => {
        if (e.target.id !== "modal-form") return;
        e.preventDefault();
        submitModal(e.target);
    });

    function bind(name, value, el) {
        if (name === "repo") {
            S.repo = value;
            paintAll();
        } else if (name.startsWith("rf.")) {
            const key = name.slice(3);
            S.rf[key] = key === "hideSkipped" ? el.checked : value;
            paintMain();
        } else if (name === "refreshSec") {
            send({ type: "settings", refreshSec: Number(value) }).then(() => load({ force: true })).catch(() => {});
        }
    }
    document.addEventListener("change", (e) => {
        const el = e.target;
        if (el.dataset?.bind && el.dataset.bind !== "rf.q") bind(el.dataset.bind, el.value, el);
    });
    document.addEventListener("input", (e) => {
        const el = e.target;
        if (el.dataset?.bind === "rf.q") bind("rf.q", el.value, el);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (S.modal) closeModal();
        else if (S.drawer) closeDrawer();
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && S.state && Date.now() - Date.parse(S.state.generatedAt) > (S.state.config.refreshSec ?? 90) * 1000) load();
    });
    window.addEventListener("unhandledrejection", (e) => toast(e.reason?.message ?? "Unexpected error", "fail"));
    setInterval(() => {
        const el = $("#updated");
        if (el && S.state) el.textContent = `Updated ${rel(S.state.generatedAt)}`;
    }, 1000);

    paintHeader();
    paintTabs();
    paintMain();
    load();
})();
