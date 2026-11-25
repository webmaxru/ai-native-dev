import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { api, invalidate, memo } from "./gh.mjs";
import { collectRepo } from "./collect.mjs";
import { createActions, OpsError, runDetails } from "./actions.mjs";

const DEFAULTS = {
    refreshSec: 90,
    repos: [
        { repo: "webmaxru/ai-native-dev", role: "hub" },
        { repo: "webmaxru/web-ai-agent-skills", role: "spoke" },
        { repo: "webmaxru/enonic-agent-skills", role: "spoke" },
    ],
};

const SEVERITY = { fail: 0, warn: 1, todo: 2, info: 3 };

function sanitize(raw) {
    const repos = Array.isArray(raw?.repos)
        ? raw.repos.filter((r) => r && /^[\w.-]+\/[\w.-]+$/.test(r.repo)).map((r) => ({ repo: r.repo, role: r.role === "hub" ? "hub" : "spoke" }))
        : [];
    const refreshSec = Number.isInteger(raw?.refreshSec) && raw.refreshSec >= 30 && raw.refreshSec <= 900 ? raw.refreshSec : DEFAULTS.refreshSec;
    return { refreshSec, repos: repos.length ? repos : DEFAULTS.repos };
}

/** Shared state, configuration and action dispatch for every open canvas instance. */
export async function createCore({ artifactsDir, ask }) {
    const file = join(artifactsDir, "config.json");
    await mkdir(artifactsDir, { recursive: true });
    let config;
    try {
        config = sanitize(JSON.parse(await readFile(file, "utf8")));
    } catch {
        config = sanitize(null);
    }

    const saveConfig = async (next) => {
        config = sanitize(next);
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(config, null, 2));
        await rename(tmp, file);
    };

    let cache = null;
    let inflight = null;
    const dropCache = () => {
        cache = null;
    };

    const build = async (force) => {
        const repos = await Promise.all(
            config.repos.map((r) =>
                collectRepo(r, force).catch((e) => ({ repo: r.repo, role: r.role, error: e.message, errors: [], fetchedAt: new Date().toISOString() })),
            ),
        );
        for (const d of repos) {
            if (d.error) d.findings = [{ repo: d.repo, severity: "fail", id: `${d.repo}:unreachable`, title: "Repository could not be loaded", detail: d.error }];
        }
        const findings = repos.flatMap((d) => d.findings).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.repo.localeCompare(b.repo));
        const counts = { fail: 0, warn: 0, todo: 0, info: 0 };
        for (const f of findings) counts[f.severity]++;
        const [login, rate] = await Promise.all([
            memo("auth", 600000, async () => (await api("user")).login, force).catch(() => null),
            memo("rate", 30000, async () => (await api("rate_limit")).resources, force).catch(() => null),
        ]);
        return {
            generatedAt: new Date().toISOString(),
            login,
            rate: rate ? { core: rate.core, graphql: rate.graphql } : null,
            config,
            health: counts.fail ? "fail" : counts.warn ? "warn" : "ok",
            counts,
            findings,
            repos,
        };
    };

    const getState = (force = false) => {
        if (!force && cache && Date.now() - cache.at < 4000) return Promise.resolve(cache.value);
        if (inflight) return inflight;
        inflight = build(force)
            .then((value) => {
                cache = { at: Date.now(), value };
                return value;
            })
            .finally(() => {
                inflight = null;
            });
        return inflight;
    };

    const requireRepo = (repo) => {
        const hit = config.repos.find((r) => r.repo === repo);
        if (!hit) throw new OpsError("unknown_repo", `${repo} is not a connected repository.`, 404);
        return hit.repo;
    };

    const data = (repo) => collectRepo(config.repos.find((r) => r.repo === repo), false);

    const act = createActions({ config: () => config, saveConfig, requireRepo, data, dropCache, getState, ask });

    const compact = (state) => ({
        generatedAt: state.generatedAt,
        health: state.health,
        counts: state.counts,
        repos: state.repos.map((d) => ({
            repo: d.repo,
            role: d.role,
            error: d.error,
            latestRelease: d.latestRelease?.tag ?? null,
            unreleasedCommits: d.unreleased?.aheadBy ?? null,
            flows: Object.fromEntries(Object.values(d.flows ?? {}).filter((f) => !f.missing).map((f) => [f.key, f.last ? `${f.last.state} (${f.last.event}, ${f.last.createdAt})` : "no runs"])),
            openPullRequests: d.pulls?.map((p) => `#${p.number} ${p.draft ? "draft " : ""}${p.title}`) ?? [],
            openIssues: d.issues?.map((i) => `#${i.number} ${i.title}`) ?? [],
            killSwitches: d.switches ? Object.fromEntries(Object.entries(d.switches).map(([k, v]) => [k, v.enabled ? "enabled" : "paused"])) : null,
        })),
        attention: state.findings.filter((f) => f.severity !== "info").map((f) => ({ repo: f.repo, severity: f.severity, title: f.title, detail: f.detail, url: f.url })),
    });

    return {
        config: () => config,
        getState,
        compact,
        act,
        run: (repo, id) => runDetails(requireRepo(repo), id),
        invalidateAll: () => {
            invalidate("");
            dropCache();
        },
    };
}
