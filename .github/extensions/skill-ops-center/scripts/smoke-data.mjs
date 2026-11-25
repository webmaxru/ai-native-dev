import { collectRepo } from "../lib/collect.mjs";
import { nextRuns, describeCron } from "../lib/cron.mjs";

const repos = [
    { repo: "webmaxru/ai-native-dev", role: "hub" },
    { repo: "webmaxru/web-ai-agent-skills", role: "spoke" },
    { repo: "webmaxru/enonic-agent-skills", role: "spoke" },
];

console.log("cron", describeCron("0 8 * * 1"), nextRuns("0 8 * * 1", new Date(), 2).map((d) => d.toISOString()));
console.log("cron", describeCron("0 */6 * * *"), nextRuns("0 */6 * * *", new Date(), 2).map((d) => d.toISOString()));

const t0 = Date.now();
const all = await Promise.all(repos.map((r) => collectRepo(r)));
console.log(`collected in ${Date.now() - t0}ms`);
for (const d of all) {
    console.log("\n==", d.repo, d.error ?? "");
    if (d.error) continue;
    console.log("release", d.latestRelease?.tag, "ahead", d.unreleased?.aheadBy, "skillsTouched", d.unreleased?.skillsTouched);
    console.log("versions", d.versions.map((v) => `${v.path}:${v.label}=${v.value}`).join(" | "));
    console.log("skills", d.skills.map((s) => `${s.dir}@${s.version}`).join(", "));
    console.log("prompts", d.prompts.length);
    console.log("workflows", d.workflows.map((w) => `${w.file}[${w.state}${w.reusable ? ",reuse" : ""}${w.dispatchable ? ",disp" : ""}${w.crons.length ? "," + w.crons.map((c) => c.human).join("/") : ""}]`).join(" "));
    for (const f of Object.values(d.flows)) console.log("flow", f.key, f.missing ? "missing" : `${f.last?.state}/${f.last?.event} meaningful=${f.lastMeaningful?.state} ok=${f.lastSuccess?.createdAt}`);
    console.log("pulls", d.pulls.map((p) => `#${p.number}${p.draft ? "d" : ""}${p.bot ? "b" : ""}`).join(" "), "issues", d.issues.map((i) => `#${i.number}`).join(" "));
    console.log("switches", JSON.stringify(d.switches), "secrets", d.secrets?.map((s) => s.name));
    console.log("errors", d.errors);
    console.log("findings:");
    for (const f of d.findings) console.log("  ", f.severity, f.title, "-", f.detail);
}
const hubDispatch = all[0].workflows.find((w) => w.file === "release.yml");
console.log("\nrelease.yml inputs", JSON.stringify(hubDispatch?.inputs));
console.log("weekly inputs", JSON.stringify(all[0].workflows.find((w) => w.file === "weekly-skill-updates.yml")?.inputs));
