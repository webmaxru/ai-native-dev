import { execFile } from "node:child_process";

const MAX_PARALLEL = 8;
let active = 0;
const waiting = [];

const acquire = () =>
    new Promise((resolve) => {
        if (active < MAX_PARALLEL) {
            active++;
            resolve();
        } else {
            waiting.push(resolve);
        }
    });

const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
};

export class GhError extends Error {
    constructor(message, { status, stderr } = {}) {
        super(message);
        this.name = "GhError";
        this.status = status;
        this.stderr = stderr;
    }
}

function explain(stdout, stderr, fallback) {
    let message = "";
    try {
        const body = JSON.parse(stdout);
        if (body && typeof body.message === "string") message = body.message;
    } catch {
        /* stdout is not JSON */
    }
    const text = (stderr || "").trim();
    const status = Number((text.match(/HTTP (\d{3})/) || [])[1]) || undefined;
    if (!message) message = text.split(/\r?\n/).find(Boolean) || fallback;
    return new GhError(message, { status, stderr: text });
}

/** Runs the gh CLI without a shell; args are always passed as an array. */
export async function gh(args, { timeout = 45000 } = {}) {
    await acquire();
    try {
        return await new Promise((resolve, reject) => {
            const child = execFile(
                "gh",
                args,
                {
                    timeout,
                    maxBuffer: 32 * 1024 * 1024,
                    windowsHide: true,
                    env: {
                        ...process.env,
                        GH_PROMPT_DISABLED: "1",
                        GH_NO_UPDATE_NOTIFIER: "1",
                        GH_SPINNER_DISABLED: "1",
                        NO_COLOR: "1",
                    },
                },
                (err, stdout, stderr) => {
                    if (err) reject(explain(stdout, stderr, err.message));
                    else resolve(stdout);
                },
            );
            child.stdin?.end();
        });
    } finally {
        release();
    }
}

export async function api(path, { method, fields } = {}) {
    const args = ["api", path];
    if (method) args.push("--method", method);
    for (const [key, value] of Object.entries(fields || {})) args.push("-f", `${key}=${value}`);
    const out = await gh(args);
    return out.trim() ? JSON.parse(out) : null;
}

export async function graphql(query, variables = {}) {
    const args = ["api", "graphql", "-f", `query=${query.replace(/\s+/g, " ").trim()}`];
    for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);
    const out = JSON.parse(await gh(args));
    if (out.errors?.length) throw new GhError(out.errors.map((e) => e.message).join("; "));
    return out.data;
}

const memoMap = new Map();

/** Memoises async work by key; concurrent callers share one in-flight promise. */
export function memo(key, ttlMs, fn, force = false) {
    const hit = memoMap.get(key);
    const now = Date.now();
    if (hit && (hit.pending || (!force && now - hit.at < ttlMs))) return hit.promise;
    const entry = { at: now, pending: true, promise: null };
    entry.promise = fn().then(
        (value) => {
            entry.pending = false;
            entry.at = Date.now();
            return value;
        },
        (error) => {
            if (memoMap.get(key) === entry) memoMap.delete(key);
            throw error;
        },
    );
    memoMap.set(key, entry);
    return entry.promise;
}

export function invalidate(prefix) {
    for (const key of memoMap.keys()) if (key.startsWith(prefix)) memoMap.delete(key);
}
