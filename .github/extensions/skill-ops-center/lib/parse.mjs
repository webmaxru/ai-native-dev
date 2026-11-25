const unquote = (s) => {
    const text = String(s ?? "").trim();
    const m = text.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    return m ? m[2] : text.replace(/\s+#.*$/, "");
};
const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => /^\s*(#.*)?$/.test(l);

function parseInputs(lines) {
    const inputs = [];
    const first = lines.find((l) => !isBlank(l));
    if (!first) return inputs;
    const base = indentOf(first);
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([\w-]+)\s*:\s*(\{\s*\})?\s*(?:#.*)?$/);
        if (!m || m[1].length !== base) {
            i++;
            continue;
        }
        const input = { name: m[2], type: "string", description: "", default: "", required: false, options: [] };
        i++;
        const body = [];
        while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > base)) body.push(lines[i++]);
        const propBase = indentOf(body.find((l) => !isBlank(l)) ?? "");
        for (let j = 0; j < body.length; j++) {
            const p = body[j].match(/^(\s*)([\w-]+)\s*:\s*(.*)$/);
            if (!p || p[1].length !== propBase) continue;
            const value = p[3].trim();
            if (p[2] === "description") input.description = unquote(value);
            else if (p[2] === "type") input.type = unquote(value);
            else if (p[2] === "default") input.default = unquote(value);
            else if (p[2] === "required") input.required = unquote(value) === "true";
            else if (p[2] === "options") {
                if (value.startsWith("[")) {
                    input.options = value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
                } else {
                    for (let k = j + 1; k < body.length; k++) {
                        const item = body[k].match(/^\s*-\s*(.+)$/);
                        if (item) input.options.push(unquote(item[1]));
                        else if (!isBlank(body[k])) break;
                    }
                }
            }
        }
        if (input.type === "string" && input.options.length) input.type = "choice";
        inputs.push(input);
    }
    return inputs;
}

function parseOnBlock(block, out) {
    const meaningful = block.filter((l) => !isBlank(l));
    if (!meaningful.length) return;
    const base = Math.min(...meaningful.map(indentOf));
    const events = [];
    block.forEach((line, idx) => {
        if (isBlank(line) || indentOf(line) !== base) return;
        const m = line.match(/^\s*(?:-\s*)?([\w-]+)\s*:?/);
        if (m) events.push({ name: m[1], idx });
    });
    events.forEach((ev, n) => {
        const end = n + 1 < events.length ? events[n + 1].idx : block.length;
        const sub = block.slice(ev.idx + 1, end);
        out.triggers.push(ev.name);
        if (ev.name === "schedule") {
            for (const l of sub) {
                const m = l.match(/cron:\s*(.+)$/);
                if (m && !/^\s*#/.test(l)) out.crons.push(unquote(m[1]));
            }
        } else if (ev.name === "workflow_dispatch") {
            const at = sub.findIndex((l) => /^\s*inputs\s*:/.test(l));
            if (at >= 0) {
                const inputBase = indentOf(sub[at]);
                const body = [];
                for (let k = at + 1; k < sub.length && (isBlank(sub[k]) || indentOf(sub[k]) > inputBase); k++) body.push(sub[k]);
                out.inputs = parseInputs(body);
            }
        }
    });
}

/** Extracts triggers, schedules, dispatch inputs and hub references from a workflow file. */
export function parseWorkflow(text) {
    const lines = String(text).replace(/\r/g, "").split("\n");
    const out = { name: null, triggers: [], crons: [], inputs: [], hubRefs: [], hubRefInputs: [] };
    const nameLine = lines.find((l) => /^name:\s*\S/.test(l));
    if (nameLine) out.name = unquote(nameLine.replace(/^name:\s*/, ""));

    const onIdx = lines.findIndex((l) => /^(?:on|"on"|'on')\s*:/.test(l));
    if (onIdx >= 0) {
        const rest = lines[onIdx].replace(/^(?:on|"on"|'on')\s*:\s*/, "").replace(/\s+#.*$/, "");
        if (rest) {
            out.triggers.push(
                ...rest
                    .replace(/^\[|\]$/g, "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s && !s.startsWith("{")),
            );
        } else {
            const block = [];
            for (let i = onIdx + 1; i < lines.length; i++) {
                if (!isBlank(lines[i]) && indentOf(lines[i]) === 0) break;
                block.push(lines[i]);
            }
            parseOnBlock(block, out);
        }
    }

    for (const line of lines) {
        if (/^\s*#/.test(line)) continue;
        const uses = line.match(/^\s*(?:-\s*)?uses:\s*['"]?(webmaxru\/ai-native-dev\/\S+?)@([^\s'"#]+)/);
        if (uses) out.hubRefs.push({ target: uses[1], ref: uses[2] });
        const hubRef = line.match(/^\s*hub_ref:\s*['"]?([^\s'"#$]+)/);
        if (hubRef) out.hubRefInputs.push(hubRef[1]);
    }
    out.triggers = [...new Set(out.triggers)];
    return out;
}

/** Reads name, description and metadata.version from SKILL.md frontmatter. */
export function parseSkill(text) {
    const m = String(text).replace(/\r/g, "").match(/^---\n([\s\S]*?)\n---/);
    if (!m) return { name: null, version: null, description: "" };
    const keys = {};
    let current = null;
    for (const line of m[1].split("\n")) {
        const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (top) {
            current = top[1];
            keys[current] = { value: top[2], cont: [] };
        } else if (current) {
            keys[current].cont.push(line);
        }
    }
    const flatten = (k) => {
        if (!keys[k]) return "";
        const value = /^[>|][+-]?$/.test(keys[k].value.trim()) ? "" : keys[k].value;
        return unquote([value, ...keys[k].cont.map((l) => l.trim())].join(" ").replace(/\s+/g, " ").trim());
    };
    const versionLine = keys.metadata?.cont.map((l) => l.match(/^\s+version:\s*(.+)$/)).find(Boolean);
    return {
        name: flatten("name") || null,
        version: versionLine ? unquote(versionLine[1]) : null,
        description: flatten("description"),
    };
}
