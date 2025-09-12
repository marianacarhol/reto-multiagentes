"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRIORITY_API_URL = exports.withinWindow = exports.mapArea = exports.classify = exports.isInRange = exports.hhmm = exports.nowISO = void 0;
exports.toHHMM = toHHMM;
exports.normName = normName;
exports.calcEtaToSLA = calcEtaToSLA;
exports.hardRulesFallback = hardRulesFallback;
exports.getPriorityFromAPI = getPriorityFromAPI;
exports.envBool = envBool;
exports.askYesNo = askYesNo;
require("dotenv/config");
// ===== Time and text utils =====
const nowISO = () => new Date().toISOString();
exports.nowISO = nowISO;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (nowStr) => {
    const d = nowStr ? new Date(nowStr) : new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
exports.hhmm = hhmm;
const isInRange = (cur, start, end) => start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
exports.isInRange = isInRange;
function toHHMM(s) { return s.toString().slice(0, 5); }
function normName(s) {
    return (s ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim().replace(/\s+/g, ' ');
}
// ===== Classify & mapping =====
const classify = (text, items, explicit) => {
    if (explicit)
        return explicit;
    const blob = `${text ?? ''} ${(items ?? []).map(i => i.name).join(' ')}`.toLowerCase();
    if (/(repair|leak|broken|fuga|mantenimiento|plomer|reparar|aire acondicionado|tv|luz|calefacci[oó]n|ducha|inodoro)/i.test(blob))
        return 'maintenance';
    if (/(beer|vino|coca|bebida|agua|jugo|drink|cerveza|whiskey|ron|vodka|cocktail)/i.test(blob))
        return 'beverage';
    return 'food';
};
exports.classify = classify;
const mapArea = (type) => type === 'maintenance' ? 'maintenance' : type === 'beverage' ? 'bar' : 'kitchen';
exports.mapArea = mapArea;
const withinWindow = (nowStr, window, cfg, dnd) => {
    if (dnd)
        return false;
    const start = window?.start ?? cfg.start;
    const end = window?.end ?? cfg.end;
    if (!start || !end)
        return true;
    return (0, exports.isInRange)((0, exports.hhmm)(nowStr), start, end);
};
exports.withinWindow = withinWindow;
// ===== Priority API & rules =====
exports.PRIORITY_API_URL = process.env.PRIORITY_API_URL || 'http://localhost:8000/predict';
function calcEtaToSLA(params) {
    const now = new Date();
    const created = params.createdAtISO ? new Date(params.createdAtISO) : now;
    const elapsedMin = Math.floor((now.getTime() - created.getTime()) / 60000);
    const slaMin = params.domain === 'rb' ? 45 : 120; // ajusta a tus SLAs reales
    return slaMin - elapsedMin;
}
function hardRulesFallback(payload) {
    const t = (payload.text || '').toLowerCase();
    const danger = /(fuga|leak|humo|incendio|chispa|descarga|sangre|shock|smoke|fire)/i.test(t);
    if (danger)
        return { priority: 'high', score: 95, model: 'rules' };
    const soon = (payload.eta_to_sla_min ?? 999) < 30;
    const vip = !!payload.vip;
    if (soon && vip)
        return { priority: 'high', score: 80, model: 'rules' };
    if (soon)
        return { priority: 'medium', score: 65, model: 'rules' };
    return { priority: 'low', score: 30, model: 'rules' };
}
async function getPriorityFromAPI(input) {
    try {
        const res = await fetch(exports.PRIORITY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!res.ok)
            throw new Error(`priority api ${res.status}`);
        const json = await res.json();
        let p = (json.priority || '').toLowerCase();
        if (!['low', 'medium', 'high'].includes(p))
            p = 'medium';
        return {
            priority: p,
            score: Number(json.score ?? 0),
            proba: json.proba,
            needs_review: !!json.needs_review,
            model: json.model || 'tfidf_logreg_v1'
        };
    }
    catch (_e) {
        return hardRulesFallback({
            text: input.text,
            vip: input.vip,
            eta_to_sla_min: input.eta_to_sla_min
        });
    }
}
// ===== CLI helpers =====
function envBool(name, def = true) {
    const raw = (process.env[name] ?? '').trim().toLowerCase();
    if (raw === '')
        return def;
    return ['1', 'true', 't', 'yes', 'y', 'si', 'sí', 'on'].includes(raw);
}
function askYesNo(question) {
    return new Promise((resolve) => {
        // NOTA: readline se usa desde index.ts; la interfaz se mantiene igual
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} [y/n]: `, (answer) => {
            rl.close();
            const a = (answer || '').trim().toLowerCase();
            resolve(a === 'y' || a === 'yes' || a === 's' || a === 'si' || a === 'sí');
        });
    });
}
//# sourceMappingURL=utils.js.map