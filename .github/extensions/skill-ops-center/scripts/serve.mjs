// Standalone server for UI testing. Run: node scripts\serve.mjs  (XSS=1 injects hostile strings into the data)
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "../lib/core.mjs";
import { startUiServer } from "../lib/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const core = await createCore({ artifactsDir: await mkdtemp(join(tmpdir(), "ops-serve-")), ask: async (p) => console.log("ASK:", p) });

const EVIL = `<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>"'>`;
const poison = (state) => {
    for (const f of state.findings) {
        f.title = EVIL + f.title;
        f.detail = EVIL;
        f.url = "javascript:window.__xss=1";
    }
    for (const d of state.repos) {
        for (const r of d.runs ?? []) r.title = EVIL;
        for (const p of d.pulls ?? []) {
            p.title = EVIL;
            p.url = "javascript:window.__xss=1";
        }
        for (const i of d.issues ?? []) i.title = EVIL;
        for (const s of d.skills ?? []) s.description = EVIL;
        for (const c of d.unreleased?.commits ?? []) c.subject = EVIL;
    }
    return state;
};
const wrapped = process.env.XSS === "1" ? { ...core, getState: async (f) => poison(structuredClone(await core.getState(f))) } : core;

const srv = await startUiServer({ core: wrapped, uiDir: join(here, "..", "ui") });
console.log(`READY ${srv.url}`);
process.on("SIGINT", async () => {
    await srv.close();
    process.exit(0);
});
setInterval(() => {}, 1 << 30);
