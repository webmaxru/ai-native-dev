import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { OpsError } from "./actions.mjs";

const FILES = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

const MAX_BODY = 64 * 1024;

const readBody = (req) =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new OpsError("too_large", "Request body is too large.", 413));
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });

/** One loopback server per canvas instance; every /api call needs the instance token. */
export async function startUiServer({ core, uiDir }) {
    const token = randomBytes(24).toString("hex");
    const tokenBuf = Buffer.from(token);
    let port = 0;

    const send = (res, status, body, headers = {}) => {
        res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
        res.end(body);
    };
    const json = (res, status, value, headers) => send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", ...headers });

    const server = createServer(async (req, res) => {
        const cors = {};
        try {
            const host = req.headers.host ?? "";
            if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: { code: "bad_host", message: "Unexpected Host header." } });

            const origin = req.headers.origin;
            if (origin !== undefined) {
                if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}` && origin !== "null") {
                    return json(res, 403, { error: { code: "bad_origin", message: "Unexpected Origin." } });
                }
                Object.assign(cors, { "Access-Control-Allow-Origin": origin, Vary: "Origin" });
            }
            if (req.method === "OPTIONS") {
                return send(res, 204, "", { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "X-Ops-Token, Content-Type", "Access-Control-Max-Age": "600" });
            }

            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

            if (req.method === "GET" && FILES[url.pathname]) {
                const [name, type] = FILES[url.pathname];
                // Navigations never send Origin; a fetch() from another page would, and must not read the token.
                if (name === "index.html" && origin !== undefined) return json(res, 403, { error: { code: "bad_origin", message: "The page cannot be fetched cross-origin." } });
                let body = await readFile(join(uiDir, name), "utf8");
                if (name === "index.html") body = body.replace("__OPS_TOKEN__", token);
                return send(res, 200, body, { "Content-Type": type, ...cors });
            }

            if (url.pathname.startsWith("/api/")) {
                const given = Buffer.from(String(req.headers["x-ops-token"] ?? ""));
                if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
                    return json(res, 401, { error: { code: "unauthorized", message: "Missing or invalid token." } }, cors);
                }
                if (req.method === "GET" && url.pathname === "/api/state") {
                    return json(res, 200, await core.getState(url.searchParams.get("force") === "1"), cors);
                }
                if (req.method === "GET" && url.pathname === "/api/run") {
                    return json(res, 200, await core.run(url.searchParams.get("repo") ?? "", url.searchParams.get("id") ?? ""), cors);
                }
                if (req.method === "POST" && url.pathname === "/api/action") {
                    let body;
                    try {
                        body = JSON.parse(await readBody(req));
                    } catch (e) {
                        if (e instanceof OpsError) throw e;
                        throw new OpsError("bad_json", "Request body must be JSON.");
                    }
                    return json(res, 200, await core.act(body), cors);
                }
                return json(res, 404, { error: { code: "not_found", message: "Unknown endpoint." } }, cors);
            }
            return json(res, 404, { error: { code: "not_found", message: "Not found." } }, cors);
        } catch (e) {
            const status = e instanceof OpsError ? e.status : 502;
            return json(res, status, { error: { code: e.code ?? "gh_error", message: e.message ?? String(e) } }, cors);
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;

    return {
        url: `http://127.0.0.1:${port}/`,
        token,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
