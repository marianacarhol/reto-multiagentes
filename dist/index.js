"use strict";
// index.ts
/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant)
 * v2.3.4
 * - Menú dinámico por restaurante (rest1/rest2) con horarios
 * - Ítems de entrada: sólo name (+qty opcional); precio/stock/horario/restaurant desde BD
 * - Tickets RB/M, feedback y cross-sell
 * - INIT opcional: lee ./input.json y ejecuta flujo create -> accept/reject
 *
 * ENV:
 *  - INIT_ON_START=true|false         (default true)
 *  - INIT_JSON_PATH=./input.json
 *  - INTERACTIVE_DECIDE=true|false    (default false)
 *  - INIT_DECISION=accept|reject      (default accept)
 *  - API_KEY_AUTH=true|false
 *  - VALID_API_KEYS=key1,key2
 *  - SUPABASE_URL, SUPABASE_SERVICE_ROLE
 *  - PRIORITY_API_URL=http://localhost:8000/predict
 */
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
require("dotenv/config");
const tools_1 = require("@ai-spine/tools");
const supabase_js_1 = require("@supabase/supabase-js");
const fs_1 = tslib_1.__importDefault(require("fs"));
const path_1 = tslib_1.__importDefault(require("path"));
const readline_1 = tslib_1.__importDefault(require("readline"));
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');
// ===== Utils
const nowISO = () => new Date().toISOString();
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (nowStr) => {
    const d = nowStr ? new Date(nowStr) : new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const isInRange = (cur, start, end) => start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
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
const mapArea = (type) => type === 'maintenance' ? 'maintenance' : type === 'beverage' ? 'bar' : 'kitchen';
const withinWindow = (nowStr, window, cfg, dnd) => {
    if (dnd)
        return false;
    const start = window?.start ?? cfg.start;
    const end = window?.end ?? cfg.end;
    if (!start || !end)
        return true;
    return isInRange(hhmm(nowStr), start, end);
};
function toHHMM(s) { return s.toString().slice(0, 5); }
function normName(s) {
    return (s ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim().replace(/\s+/g, ' ');
}
// ===== PRIORITY (TF-IDF + LogReg servido en FastAPI) =====
const PRIORITY_API_URL = process.env.PRIORITY_API_URL || 'http://localhost:8000/predict';
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
        const res = await fetch(PRIORITY_API_URL, {
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
// ===== DB helpers
async function dbGetGuestSpendLimit(guest_id) {
    const { data, error } = await supabase.from('guests')
        .select('spend_limit')
        .eq('id', guest_id)
        .maybeSingle();
    if (error)
        throw error;
    return data?.spend_limit;
}
// ===== Spend helpers =====
async function dbGetSpentToday(guest_id) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 1);
    const { data, error } = await supabase
        .from('spend_ledger')
        .select('amount, occurred_at')
        .eq('guest_id', guest_id)
        .gte('occurred_at', start.toISOString())
        .lt('occurred_at', end.toISOString());
    if (error)
        throw error;
    return (data ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);
}
// Inserta en ledger una sola vez por (guest_id, request_id)
async function ledgerInsertOnce(rec) {
    const { error } = await supabase
        .from('spend_ledger')
        .upsert([{
            domain: rec.domain,
            request_id: rec.request_id,
            guest_id: rec.guest_id,
            amount: rec.amount,
            occurred_at: nowISO(),
        }], { onConflict: 'guest_id,request_id', ignoreDuplicates: true });
    if (error)
        throw error;
}
// Intenta RPC decremental atómica; si no existe la RPC, hace fallback 2 pasos
async function decrementGuestLimitIfEnough(guest_id, amount) {
    try {
        const { data, error } = await supabase
            .rpc('decrement_guest_limit_if_enough', { p_guest_id: guest_id, p_amount: amount });
        if (error)
            throw error;
        if (!data || data.updated_rows !== 1) {
            const err = new Error('SPEND_LIMIT_EXCEEDED');
            err.code = 'SPEND_LIMIT';
            throw err;
        }
        return;
    }
    catch (_e) {
        const { data, error } = await supabase
            .from('guests')
            .select('spend_limit')
            .eq('id', guest_id)
            .maybeSingle();
        if (error)
            throw error;
        const current = Number(data?.spend_limit ?? 0);
        if (current < amount) {
            const err = new Error('SPEND_LIMIT_EXCEEDED');
            err.code = 'SPEND_LIMIT';
            throw err;
        }
        const newVal = Number((current - amount).toFixed(2));
        const { error: e2 } = await supabase
            .from('guests')
            .update({ spend_limit: newVal })
            .eq('id', guest_id);
        if (e2)
            throw e2;
    }
}
// Cobra un ticket RB
async function chargeGuestForRB(ticket) {
    const amount = Number(ticket.total_amount || 0);
    if (amount <= 0)
        return;
    await ledgerInsertOnce({ domain: 'rb', request_id: ticket.id, guest_id: ticket.guest_id, amount });
    try {
        await decrementGuestLimitIfEnough(ticket.guest_id, amount);
    }
    catch (e) {
        await supabase.from('spend_ledger')
            .delete()
            .eq('domain', 'rb')
            .eq('request_id', ticket.id);
        if (e?.code === 'SPEND_LIMIT') {
            throw { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' };
        }
        throw e;
    }
}
async function dbMenuUnion() {
    const { data, error } = await supabase.from('menu_union').select('*');
    if (error)
        throw error;
    return (data ?? []);
}
async function resolveAndValidateItems(rawItems, nowStr, enableStockCheck = true) {
    const menu = await dbMenuUnion();
    const cur = hhmm(nowStr);
    const byId = new Map(menu.map(m => [m.id, m]));
    const byName = new Map(menu.map(m => [normName(m.name), m]));
    const resolved = [];
    for (const it of (rawItems ?? [])) {
        const row = it.id ? byId.get(it.id) : byName.get(normName(it.name));
        if (!row)
            throw new Error(`No encontrado en menú: ${it.name}`);
        const active = row.is_active === true;
        const inTime = isInRange(cur, toHHMM(row.available_start), toHHMM(row.available_end));
        const stockOK = !enableStockCheck || (row.stock_current > row.stock_minimum);
        if (!active)
            throw new Error(`Inactivo: ${row.name}`);
        if (!inTime)
            throw new Error(`Fuera de horario: ${row.name}`);
        if (!stockOK)
            throw new Error(`Sin stock suficiente: ${row.name}`);
        const qty = Math.max(1, it.qty ?? 1);
        resolved.push({
            id: row.id,
            name: row.name,
            qty,
            price: Number(row.price),
            restaurant: row.restaurant,
            category: row.category,
        });
    }
    const total = resolved.reduce((acc, r) => acc + r.price * r.qty, 0);
    const restSet = new Set(resolved.map(r => r.restaurant));
    return { items: resolved, total, restSet };
}
// ===== RB / M
async function rbCreateTicket(row) { const { error } = await supabase.from('tickets_rb').insert(row); if (error)
    throw error; }
async function rbUpdateTicket(id, patch) {
    const { error } = await supabase.from('tickets_rb').update({ ...patch, updated_at: nowISO() }).eq('id', id);
    if (error)
        throw error;
}
async function rbGetTicket(id) { const { data, error } = await supabase.from('tickets_rb').select('*').eq('id', id).maybeSingle(); if (error)
    throw error; return data; }
async function rbAddHistory(h) {
    const { error } = await supabase
        .from('ticket_history_rb')
        .insert({ ...h, ts: nowISO() });
    if (error)
        throw error;
}
async function mCreateTicket(row) {
    const { error } = await supabase.from('tickets_m').insert(row);
    if (error)
        throw error;
}
async function mGetTicket(id) { const { data, error } = await supabase.from('tickets_m').select('*').eq('id', id).maybeSingle(); if (error)
    throw error; return data; }
async function mAddHistory(h) {
    const { error } = await supabase
        .from('ticket_history_m')
        .insert({ ...h, ts: nowISO() });
    if (error)
        throw error;
}
// Feedback
async function addFeedback(rec) {
    const { error } = await supabase.from('feedback').insert({
        domain: rec.domain,
        guest_id: rec.guest_id,
        request_id: rec.request_id,
        message: rec.message ?? null,
        created_at: nowISO(),
    });
    if (error)
        throw error;
}
// Descontar stock
async function decrementStock(items) {
    if (!items?.length)
        return;
    const menu = await dbMenuUnion();
    for (const it of items) {
        const row = it.id ? menu.find(m => m.id === it.id) : menu.find(m => m.name.toLowerCase() === it.name.toLowerCase());
        if (!row)
            continue;
        const table = row.restaurant === 'rest1' ? 'rest1_menu_items' : 'rest2_menu_items';
        const qty = Math.max(1, it.qty ?? 1);
        const newStock = Math.max(0, (row.stock_current ?? 0) - qty);
        const { error } = await supabase.from(table).update({ stock_current: newStock, updated_at: nowISO() }).eq('id', row.id);
        if (error)
            throw error;
    }
}
// Cross-sell (usado si habilitas cross-sell)
function pickCrossSellByCategory(menu, chosen, opts) {
    const norm = (s) => (s ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim().replace(/\s+/g, ' ');
    const chosenIds = new Set(chosen.map(c => c.id).filter(Boolean));
    const chosenNames = new Set(chosen.map(c => norm(c.name)));
    const byName = new Map(menu.map(m => [norm(m.name), m]));
    const chosenRows = chosen.map(it => it.id ? menu.find(m => m.id === it.id) : byName.get(norm(it.name))).filter(Boolean);
    const chosenCats = new Set(chosenRows.map(r => r.category));
    if (opts.explicitType === 'food' || opts.explicitType === 'beverage') {
        if (!chosenCats.has(opts.explicitType))
            chosenCats.add(opts.explicitType);
    }
    const allCats = ['food', 'beverage', 'dessert'];
    const targetCats = [];
    for (const cat of allCats) {
        if (opts.forbidSameCategoryIfPresent && chosenCats.has(cat))
            continue;
        if (!chosenCats.has(cat))
            targetCats.push(cat);
    }
    if (targetCats.length === 0)
        return [];
    const available = menu.filter(r => r.is_active && r.stock_current > r.stock_minimum &&
        isInRange(opts.nowHHMM, r.available_start.toString().slice(0, 5), r.available_end.toString().slice(0, 5)) &&
        !chosenIds.has(r.id) && !chosenNames.has(norm(r.name)));
    const byCat = new Map();
    for (const c of allCats)
        byCat.set(c, []);
    for (const r of available)
        byCat.get(r.category).push(r);
    if (opts.preferOppositeOf) {
        for (const cat of allCats) {
            const arr = byCat.get(cat);
            arr.sort((a, b) => {
                if (a.restaurant === opts.preferOppositeOf && b.restaurant !== opts.preferOppositeOf)
                    return -1;
                if (a.restaurant !== opts.preferOppositeOf && b.restaurant === opts.preferOppositeOf)
                    return 1;
                return 0;
            });
        }
    }
    const picks = [];
    for (const cat of targetCats) {
        const pool = byCat.get(cat) ?? [];
        if (!pool.length)
            continue;
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const count = Math.max(1, Math.min(3, opts.perCategoryCount));
        for (const r of pool.slice(0, count))
            picks.push({ restaurant: r.restaurant, id: r.id, name: r.name, price: r.price, category: r.category });
    }
    return picks;
}
// ===== Tool
const tool = (0, tools_1.createTool)({
    metadata: {
        name: 'agent-03-roomservice-maintenance-split',
        version: '2.3.4',
        description: 'Room Service (rest1/rest2) + Maintenance con tablas separadas y cross-sell inter-restaurantes (multi-enabled)',
        capabilities: ['dynamic-menu', 'intelligent-cross-sell', 'ticket-tracking', 'feedback', 'policy-check'],
        author: 'Equipo A3',
        license: 'MIT',
    },
    schema: {
        input: {
            action: { type: 'string', enum: ['get_menu', 'create', 'status', 'complete', 'assign', 'feedback', 'confirm_service', 'accept', 'reject', 'cancel'], required: false, default: 'create' },
            guest_id: (0, tools_1.stringField)({ required: false }),
            room: (0, tools_1.stringField)({ required: false }),
            service_hours: (0, tools_1.stringField)({ required: false }),
            restaurant: { type: 'string', required: false, enum: ['rest1', 'rest2', 'multi'] },
            type: { type: 'string', required: false, enum: ['food', 'beverage', 'maintenance'] },
            items: { type: 'array', required: false, items: { type: 'object', properties: {
                        id: (0, tools_1.stringField)({ required: false }),
                        name: (0, tools_1.stringField)({ required: true }),
                        qty: (0, tools_1.numberField)({ required: false, default: 1, min: 1 }),
                    } } },
            issue: (0, tools_1.stringField)({ required: false }),
            severity: { type: 'string', required: false, enum: ['low', 'medium', 'high'] },
            text: (0, tools_1.stringField)({ required: false }),
            notes: (0, tools_1.stringField)({ required: false }),
            priority: { type: 'string', required: false, default: 'normal', enum: ['low', 'normal', 'high'] },
            now: (0, tools_1.stringField)({ required: false }),
            do_not_disturb: (0, tools_1.booleanField)({ required: false }),
            guest_profile: { type: 'object', required: false, properties: {
                    tier: { type: 'string', required: false, enum: ['standard', 'gold', 'platinum'] },
                    daily_spend: (0, tools_1.numberField)({ required: false, min: 0 }),
                    spend_limit: (0, tools_1.numberField)({ required: false, min: 0 }),
                    preferences: { type: 'array', required: false, items: { type: 'string' } }
                } },
            access_window: { type: 'object', required: false, properties: {
                    start: (0, tools_1.stringField)({ required: true }),
                    end: (0, tools_1.stringField)({ required: true }),
                } },
            request_id: (0, tools_1.stringField)({ required: false }),
            service_feedback: (0, tools_1.stringField)({ required: false }),
            service_completed_by: (0, tools_1.stringField)({ required: false }),
            menu_category: { type: 'string', required: false, enum: ['food', 'beverage', 'dessert'] },
        },
        config: {
            accessWindowStart: (0, tools_1.stringField)({ required: false }),
            accessWindowEnd: (0, tools_1.stringField)({ required: false }),
            enable_stock_check: (0, tools_1.booleanField)({ required: false, default: true }),
            enable_cross_sell: (0, tools_1.booleanField)({ required: false, default: true }),
            cross_sell_threshold: (0, tools_1.numberField)({ required: false, default: 1 }),
            cross_sell_per_category: (0, tools_1.booleanField)({ required: false, default: true }),
            cross_sell_per_category_count: (0, tools_1.numberField)({ required: false, default: 1, min: 1, max: 3 }),
            cross_sell_prefer_opposite: (0, tools_1.booleanField)({ required: false, default: true }),
            api_key: (0, tools_1.stringField)({ required: false }),
            default_count: (0, tools_1.numberField)({ required: false, default: 1 }),
        },
    },
    async execute(input, config, _context) {
        const { action = 'create', guest_id, room } = input;
        // Validación mínima al crear
        if (action === 'create') {
            if (!guest_id || !room || typeof guest_id !== 'string' || typeof room !== 'string') {
                return { status: 'error', error: { code: 'VALIDATION_ERROR', message: 'guest_id y room son requeridos (string) para crear ticket' } };
            }
        }
        try {
            const nowHHMM = hhmm(input.now);
            // GET MENU
            if (action === 'get_menu') {
                const menu = await dbMenuUnion();
                const filtered = menu.filter(m => (!input.menu_category || m.category === input.menu_category) &&
                    m.is_active &&
                    (config.enable_stock_check !== false ? (m.stock_current > m.stock_minimum) : true) &&
                    isInRange(nowHHMM, m.available_start.toString().slice(0, 5), m.available_end.toString().slice(0, 5)));
                return {
                    status: 'success',
                    data: {
                        current_time: nowHHMM,
                        items: filtered.map(m => ({
                            restaurant: m.restaurant,
                            id: m.id,
                            name: m.name,
                            price: m.price,
                            category: m.category,
                            available_start: m.available_start,
                            available_end: m.available_end,
                            stock_current: m.stock_current
                        }))
                    }
                };
            }
            const type = classify(input.text, input.items, input.type);
            const area = mapArea(type);
            // CREATE
            if (action === 'create') {
                // ======== ROOM SERVICE (food/beverage) — SIN IA ========
                if (type === 'food' || type === 'beverage') {
                    const okWindow = withinWindow(input.now, input.access_window, { start: config.accessWindowStart, end: config.accessWindowEnd }, input.do_not_disturb);
                    if (!okWindow)
                        return { status: 'error', error: { code: 'ACCESS_WINDOW_BLOCK', message: 'Fuera de ventana o DND activo' } };
                    const rawItems = input.items ?? [];
                    if (!input.restaurant && rawItems.length === 0) {
                        return { status: 'error', error: { code: 'VALIDATION_ERROR', message: 'Provee al menos un ítem' } };
                    }
                    let resolved = [];
                    let total = 0;
                    let restSet = new Set();
                    try {
                        const res = await resolveAndValidateItems(rawItems, input.now, config.enable_stock_check !== false);
                        resolved = res.items;
                        total = res.total;
                        restSet = res.restSet;
                    }
                    catch (e) {
                        return { status: 'error', error: { code: 'ITEMS_UNAVAILABLE', message: String(e?.message || e) } };
                    }
                    // ---- Límite de gasto (precheck con ledger del día)
                    let spendLimit = input.guest_profile?.spend_limit ?? (guest_id ? await dbGetGuestSpendLimit(guest_id) : null);
                    if (spendLimit != null) {
                        const spentToday = guest_id ? await dbGetSpentToday(guest_id) : 0;
                        if ((spentToday + total) > Number(spendLimit)) {
                            return { status: 'error', error: { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' } };
                        }
                    }
                    const anchor = (input.restaurant === 'rest1' || input.restaurant === 'rest2') ? input.restaurant : undefined;
                    const ticketRestaurant = input.restaurant === 'multi' ? 'multi'
                        : restSet.size > 1 ? 'multi'
                            : restSet.size === 1 ? Array.from(restSet)[0]
                                : anchor ?? 'multi';
                    // SIN IA: prioridad directa (o default 'normal')
                    const id = `REQ-${Date.now()}`;
                    const priorityLabelRB = input.priority ?? 'normal';
                    await rbCreateTicket({
                        id,
                        guest_id: guest_id,
                        room: room,
                        restaurant: ticketRestaurant,
                        status: 'CREADO',
                        priority: priorityLabelRB,
                        items: resolved,
                        total_amount: total,
                        notes: input.notes ?? undefined
                    });
                    await rbAddHistory({
                        request_id: id,
                        status: 'CREADO',
                        actor: 'system'
                    });
                    return { status: 'success', data: { request_id: id, domain: 'rb', type, area, status: 'CREADO', message: 'Ticket creado. Usa action "accept" o "reject".' } };
                }
                // ======== MANTENIMIENTO — CON IA ========
                if (!input.issue)
                    return { status: 'error', error: { code: 'MISSING_ISSUE', message: 'Describe el issue de mantenimiento' } };
                const id = `REQ-${Date.now()}`;
                const eta_to_sla_min_m = calcEtaToSLA({ domain: 'm', type, createdAtISO: input.now });
                const priM = await getPriorityFromAPI({
                    text: input.issue || input.text || '',
                    domain: 'm',
                    vip: (input.guest_profile?.tier === 'platinum' || input.guest_profile?.tier === 'gold') ? 1 : 0,
                    spend30d: Number(input.guest_profile?.daily_spend ?? 0),
                    eta_to_sla_min: eta_to_sla_min_m,
                });
                const severityM = input.severity ?? priM.priority;
                const priorityLabelM = severityM === 'high' ? 'high' :
                    severityM === 'low' ? 'low' :
                        (input.priority ?? 'normal');
                await mCreateTicket({
                    id, guest_id: guest_id, room: room,
                    issue: input.issue, severity: severityM,
                    status: 'CREADO', priority: priorityLabelM,
                    notes: input.notes ?? undefined,
                    service_hours: input.service_hours ?? null,
                    priority_score: priM.score,
                    priority_model: priM.model,
                    priority_proba: priM.proba ?? null,
                    needs_review: !!priM.needs_review
                });
                await mAddHistory({
                    request_id: id,
                    status: 'CREADO',
                    actor: 'system',
                    service_hours: input.service_hours ?? null
                });
                return { status: 'success', data: { request_id: id, domain: 'm', type, area, status: 'CREADO', message: 'Ticket creado. Usa action "accept" o "reject".' } };
            }
            // POST-actions
            if (!input.request_id)
                return { status: 'error', error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' } };
            async function handleRB(ticket) {
                let newStatus = ticket.status;
                if (action === 'accept')
                    newStatus = 'ACEPTADA';
                else if (action === 'reject')
                    newStatus = 'RECHAZADA';
                else if (action === 'complete')
                    newStatus = 'COMPLETADA';
                else if (action === 'status') {
                    return { status: 'success', data: { request_id: ticket.id, status: ticket.status } };
                }
                else if (action === 'cancel')
                    newStatus = 'CANCELADO';
                const { error } = await supabase
                    .from('tickets_rb')
                    .update({ status: newStatus, updated_at: nowISO() })
                    .eq('id', ticket.id);
                if (error)
                    throw error;
                await rbAddHistory({ request_id: ticket.id, status: newStatus, actor: 'agent', note: input.notes });
                if (action === 'accept') {
                    try {
                        await chargeGuestForRB({ id: ticket.id, guest_id: ticket.guest_id, total_amount: ticket.total_amount });
                        await decrementStock(ticket.items || []);
                        const restSet = new Set((ticket.items || []).map((i) => i.restaurant).filter(Boolean));
                        for (const r of restSet) {
                            await rbAddHistory({ request_id: ticket.id, status: ticket.status, actor: r });
                        }
                    }
                    catch (e) {
                        await rbAddHistory({
                            request_id: ticket.id,
                            status: ticket.status,
                            actor: 'system',
                            note: `Accept failed: ${e?.code || ''} ${e?.message || e}`
                        });
                        await supabase.from('tickets_rb')
                            .update({ status: 'CREADO', updated_at: nowISO() })
                            .eq('id', ticket.id);
                        return { status: 'error', error: { code: e?.code || 'PAYMENT_ERROR', message: e?.message || 'No se pudo cobrar' } };
                    }
                }
                return { status: 'success', data: { request_id: ticket.id, status: newStatus } };
            }
            async function handleM(ticket) {
                let newStatus = ticket.status;
                if (action === 'accept')
                    newStatus = 'ACEPTADA';
                else if (action === 'reject')
                    newStatus = 'RECHAZADA';
                else if (action === 'complete')
                    newStatus = 'COMPLETADA';
                else if (action === 'status')
                    return { status: 'success', data: { request_id: ticket.id, status: ticket.status } };
                else if (action === 'cancel')
                    newStatus = 'CANCELADO';
                await mAddHistory({
                    request_id: ticket.id,
                    status: newStatus,
                    actor: 'agent',
                    note: input.notes,
                    service_hours: input.service_hours ?? null
                });
                return { status: 'success', data: { request_id: ticket.id, status: newStatus } };
            }
            if (action === 'feedback') {
                if (!input.request_id) {
                    return { status: 'error', error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' } };
                }
                const ticketRB = await rbGetTicket(input.request_id);
                const ticketM = ticketRB ? null : await mGetTicket(input.request_id);
                if (!ticketRB && !ticketM) {
                    return { status: 'error', error: { code: 'NOT_FOUND', message: 'Ticket no encontrado' } };
                }
                const domain = ticketRB ? 'rb' : 'm';
                const guest_id = (ticketRB ?? ticketM).guest_id;
                if (input.service_feedback == null) {
                    return { status: 'error', error: { code: 'EMPTY_FEEDBACK', message: 'Provee service_feedback' } };
                }
                await addFeedback({
                    domain,
                    guest_id,
                    request_id: input.request_id,
                    message: input.service_feedback,
                });
                if (domain === 'rb') {
                    await supabase
                        .from('tickets_rb')
                        .update({ feedback: input.service_feedback ?? null, updated_at: nowISO() })
                        .eq('id', input.request_id);
                    await rbAddHistory({
                        request_id: input.request_id,
                        status: 'FEEDBACK',
                        actor: 'guest',
                        feedback: input.service_feedback,
                    });
                }
                else {
                    await supabase
                        .from('tickets_m')
                        .update({ feedback: input.service_feedback ?? null, updated_at: nowISO() })
                        .eq('id', input.request_id);
                    await mAddHistory({
                        request_id: input.request_id,
                        status: 'FEEDBACK',
                        actor: 'guest',
                        feedback: input.service_feedback,
                    });
                }
                return { status: 'success', data: { request_id: input.request_id, domain, message: 'Feedback guardado' } };
            }
            const rb = await rbGetTicket(input.request_id);
            if (rb)
                return await handleRB(rb);
            const mt = await mGetTicket(input.request_id);
            if (mt)
                return await handleM(mt);
            return { status: 'error', error: { code: 'NOT_FOUND', message: 'request_id no existe ni en RB ni en M' } };
        }
        catch (e) {
            console.error('ERROR:', e?.message || e);
            return { status: 'error', error: { code: 'INTERNAL_DB_ERROR', message: String(e?.message || e) } };
        }
    },
});
// ===== Helpers CLI
function askYesNo(question) {
    return new Promise((resolve) => {
        const rl = readline_1.default.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} [y/n]: `, (answer) => {
            rl.close();
            const a = (answer || '').trim().toLowerCase();
            resolve(a === 'y' || a === 'yes' || a === 's' || a === 'si' || a === 'sí');
        });
    });
}
// ===== INIT: postear ./input.json y luego decision interactiva o automática
async function runInitFlow(baseUrl) {
    try {
        const jsonPath = path_1.default.resolve(process.env.INIT_JSON_PATH ?? './input.json');
        if (!fs_1.default.existsSync(jsonPath)) {
            console.log(`INIT: no se encontró ${jsonPath}, se omite init.`);
            return;
        }
        const raw = fs_1.default.readFileSync(jsonPath, 'utf-8');
        const inputData = JSON.parse(raw);
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.API_KEY_AUTH === 'true' && process.env.VALID_API_KEYS) {
            headers['X-API-Key'] = process.env.VALID_API_KEYS.split(',')[0].trim();
        }
        // 1) Crear ticket
        const createResp = await fetch(`${baseUrl}/api/execute`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input_data: inputData }),
        });
        const createJson = await createResp.json().catch(() => ({}));
        console.log('INIT create status:', createResp.status, JSON.stringify(createJson));
        const requestId = createJson?.output_data?.request_id;
        if (!requestId) {
            console.error('INIT: no se obtuvo request_id del create. Abortando flujo.');
            return;
        }
        // 2) Decidir (interactivo o automático)
        let decision;
        if ((process.env.INTERACTIVE_DECIDE ?? 'false').toLowerCase() === 'true') {
            const yes = await askYesNo(`¿Aceptar pedido ${requestId}?`);
            decision = yes ? 'accept' : 'reject';
        }
        else {
            decision = (process.env.INIT_DECISION ?? 'accept').toLowerCase() === 'reject' ? 'reject' : 'accept';
        }
        const postData = { action: decision, request_id: requestId };
        const actResp = await fetch(`${baseUrl}/api/execute`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input_data: postData }),
        });
        const actJson = await actResp.json().catch(() => ({}));
        console.log(`INIT ${decision} status:`, actResp.status, JSON.stringify(actJson));
    }
    catch (e) {
        console.error('INIT flow error:', e?.message || e);
    }
}
// ===== Server bootstrap =====
async function main() {
    try {
        const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
        const host = process.env.HOST || '0.0.0.0';
        // 1) Arranca server HTTP
        await tool.start({ port, host });
        const baseUrl = `http://localhost:${port}`;
        console.log('🚀 Agent-03 RS&M split server ready');
        console.log(`Health:  ${baseUrl}/health`);
        console.log(`Execute: ${baseUrl}/api/execute`);
        // 2) INIT opcional (controlado por ENV)
        const initOnStart = (process.env.INIT_ON_START ?? 'true').toLowerCase() !== 'false';
        if (initOnStart) {
            await runInitFlow(baseUrl);
        }
        else {
            console.log('INIT_ON_START=false → se omite flujo INIT.');
        }
    }
    catch (e) {
        console.error('Failed to start:', e);
        process.exit(1);
    }
}
process.on('SIGINT', async () => { console.log('SIGINT'); await tool.stop(); process.exit(0); });
process.on('SIGTERM', async () => { console.log('SIGTERM'); await tool.stop(); process.exit(0); });
if (require.main === module) {
    main();
}
exports.default = tool;
//# sourceMappingURL=index.js.map