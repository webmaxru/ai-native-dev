// Drives headless Edge over CDP against a running scripts\serve.mjs. Run: node scripts\smoke-ui.mjs <url> [xss]
// Set EDGE_PATH when Edge is not in its default Windows location.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [url, mode] = process.argv.slice(2);
const xss = mode === "xss";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts", "shots");
const EDGE = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) {
    console.error(`Edge not found at ${EDGE}. Set EDGE_PATH to the full path of msedge.exe.`);
    process.exit(2);
}
const profile = await mkdtemp(join(tmpdir(), "edge-ops-"));
const port = 9300 + Math.floor(Math.random() * 500);
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

let targets;
for (let i = 0; i < 50; i++) {
    try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(300);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
};
const send = (method, params = {}) =>
    new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.result.value;
};
const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(out, `${name}.png`), Buffer.from(r.result.data, "base64"));
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
const { mkdir } = await import("node:fs/promises");
await mkdir(out, { recursive: true });

try {
    await send("Page.navigate", { url });
    for (let i = 0; i < 80 && !(await ev("!!document.querySelector('#main') && !document.querySelector('#main .loading') && document.querySelectorAll('#tabs .tab').length > 0")); i++) await sleep(500);
    await sleep(1500);
    const title = await ev("document.title");
    check("page loaded", !!title, title);
    check("no script errors on load", problems.length === 0, problems.join(" | "));

    const tabs = await ev("[...document.querySelectorAll('#tabs .tab')].map(b => b.textContent.trim().replace(/\\s+\\d+$/, ''))");
    check("tab buttons rendered", Array.isArray(tabs) && tabs.length === 8, JSON.stringify(tabs));
    const clickTab = (i) => ev(`(() => { const b = document.querySelectorAll('#tabs .tab')[${i}]; if (!b) return false; b.click(); return true; })()`);

    for (const color of ["dark", "light"]) {
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: color }] });
        await sleep(300);
        await shot(`${xss ? "xss-" : ""}overview-${color}`);
    }

    const names = ["overview", "workflows", "runs", "prs", "issues", "releases", "skills", "settings"];
    for (const [i, t] of names.entries()) {
        const clicked = await clickTab(i);
        await sleep(500);
        const len = await ev("document.querySelector('#main')?.innerText.length ?? 0");
        check(`tab ${t} renders`, clicked && len > 40, `${len} chars`);
        if (!xss) await shot(`tab-${t}`);
    }

    // overview details
    await clickTab(0);
    await sleep(400);
    const body = await ev("document.body.innerText");
    for (const needle of ["ai-native-dev", "web-ai-agent-skills", "enonic-agent-skills"]) check(`shows ${needle}`, body.includes(needle));

    // drawer: open the first run chip
    await clickTab(2);
    await sleep(500);
    const opened = await ev(`(() => { const r = document.querySelector('#main [data-cmd="run"]'); if (!r) return false; r.click(); return true; })()`);
    await sleep(3000);
    check("run drawer opens", opened && (await ev("!document.querySelector('#drawer').hidden && document.querySelector('#drawer').innerText.length > 30")));
    if (!xss) await shot("run-drawer");
    await ev(`document.querySelector('#drawer [data-cmd="closeDrawer"]')?.click(); 0`);

    if (xss) {
        check("no injected script ran", (await ev("window.__xss === undefined")) === true);
        check("no <img onerror> element injected", (await ev("document.querySelectorAll('img[src=\"x\"]').length")) === 0);
        check("hostile text shown as text", (await ev("document.body.innerText.includes('<img src=x')")) === true);
        const hrefs = await ev("[...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /^\\s*javascript:/i.test(h)).length");
        check("no javascript: links", hrefs === 0, `${hrefs} found`);
    }

    // modal for a guarded action must not fire anything by itself
    await ev(`document.querySelector('#top [data-cmd="pauseAll"]')?.click(); 0`);
    await sleep(400);
    const modal = await ev("document.querySelector('#modal-root .modal')?.innerText ?? ''");
    check("pause opens a typed confirmation modal", /PAUSE/.test(modal), modal.replace(/\s+/g, " ").slice(0, 100));
    if (!xss) await shot("pause-modal");
    // submitting without the typed word must be refused client-side (nothing is sent to GitHub)
    await ev(`document.querySelector('#modal-form').requestSubmit(); 0`);
    await sleep(400);
    const err = await ev("(() => { const e = document.querySelector('#modal-root .modal-error'); return e && !e.hidden ? e.textContent : ''; })()");
    check("empty typed confirmation is refused", /PAUSE/.test(err) && (await ev("!!document.querySelector('#modal-root .modal')")), err);
    await ev(`document.querySelector('#modal-root [data-cmd="closeModal"]')?.click(); 0`);
    check("modal closes on cancel", (await ev("!document.querySelector('#modal-root .modal')")) === true);

    check("no script errors overall", problems.length === 0, problems.join(" | "));
} catch (e) {
    check("test run", false, e.message);
} finally {
    ws.close();
    edge.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `\n${failures} FAILED` : "\nAll UI checks passed");
process.exit(failures ? 1 : 0);
