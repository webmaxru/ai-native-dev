const NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function field(src, min, max) {
    const set = new Set();
    for (const part of src.toLowerCase().split(",")) {
        const [rangeSrc, stepSrc] = part.split("/");
        const step = stepSrc === undefined ? 1 : Number(stepSrc);
        if (!Number.isInteger(step) || step < 1) return null;
        let lo;
        let hi;
        if (rangeSrc === "*") {
            lo = min;
            hi = max;
        } else {
            const [a, b] = rangeSrc.split("-").map((x) => (x in NAMES ? NAMES[x] : Number(x)));
            lo = a;
            hi = b === undefined ? (stepSrc === undefined ? a : max) : b;
        }
        if (![lo, hi].every(Number.isInteger) || lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) set.add(v);
    }
    return set.size ? set : null;
}

export function parseCron(expr) {
    const parts = String(expr).trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [mi, ho, dom, mo, dow] = parts;
    const spec = {
        minute: field(mi, 0, 59),
        hour: field(ho, 0, 23),
        dom: field(dom, 1, 31),
        month: field(mo, 1, 12),
        dow: field(dow, 0, 7),
        domStar: dom === "*",
        dowStar: dow === "*",
    };
    if (Object.values(spec).some((v) => v === null)) return null;
    if (spec.dow.has(7)) spec.dow.add(0);
    return spec;
}

/** Next UTC fire times of a 5-field cron expression after `from`. */
export function nextRuns(expr, from = new Date(), count = 1) {
    const spec = parseCron(expr);
    if (!spec) return [];
    const out = [];
    const hours = [...spec.hour].sort((a, b) => a - b);
    const minutes = [...spec.minute].sort((a, b) => a - b);
    const midnight = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    for (let day = 0; day < 400 && out.length < count; day++) {
        const date = new Date(midnight + day * 86400000);
        if (!spec.month.has(date.getUTCMonth() + 1)) continue;
        const domOk = spec.dom.has(date.getUTCDate());
        const dowOk = spec.dow.has(date.getUTCDay());
        const dayOk = spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
        if (!dayOk) continue;
        for (const h of hours) {
            for (const m of minutes) {
                const t = new Date(midnight + day * 86400000 + h * 3600000 + m * 60000);
                if (t > from) {
                    out.push(t);
                    if (out.length >= count) return out;
                }
            }
        }
    }
    return out;
}

export function describeCron(expr) {
    const spec = parseCron(expr);
    if (!spec) return String(expr);
    const [mi, ho, dom, mo, dow] = String(expr).trim().split(/\s+/);
    const pad = (n) => String(n).padStart(2, "0");
    const single = /^\d+$/;
    if (single.test(mi) && /^\*\/\d+$/.test(ho) && dom === "*" && mo === "*" && dow === "*") {
        return `Every ${ho.slice(2)}h at :${pad(mi)} UTC`;
    }
    if (single.test(mi) && single.test(ho) && dom === "*" && mo === "*") {
        const time = `${pad(ho)}:${pad(mi)} UTC`;
        if (dow === "*") return `Daily ${time}`;
        if (single.test(dow)) return `Weekly ${DAYS[Number(dow) % 7]} ${time}`;
    }
    return `${expr} (UTC)`;
}
