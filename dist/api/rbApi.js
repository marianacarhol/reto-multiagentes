"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
exports.dbGetGuestSpendLimit = dbGetGuestSpendLimit;
exports.dbGetGuestById = dbGetGuestById;
exports.dbValidateGuestAndRoom = dbValidateGuestAndRoom;
exports.dbGetSpentToday = dbGetSpentToday;
exports.ledgerInsertOnce = ledgerInsertOnce;
exports.decrementGuestLimitIfEnough = decrementGuestLimitIfEnough;
exports.chargeGuestForRB = chargeGuestForRB;
exports.dbMenuUnion = dbMenuUnion;
exports.decrementStock = decrementStock;
exports.resolveAndValidateItems = resolveAndValidateItems;
exports.rbCreateTicket = rbCreateTicket;
exports.rbUpdateTicket = rbUpdateTicket;
exports.rbGetTicket = rbGetTicket;
exports.rbAddHistory = rbAddHistory;
exports.pickCrossSellByCategory = pickCrossSellByCategory;
exports.addFeedback = addFeedback;
const supabase_js_1 = require("@supabase/supabase-js");
const utils_1 = require("../utils/utils");
exports.supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');
// ===== Guests =====
async function dbGetGuestSpendLimit(guest_id) {
    const { data, error } = await exports.supabase.from('guests')
        .select('spend_limit')
        .eq('id', guest_id)
        .maybeSingle();
    if (error)
        throw error;
    return data?.spend_limit;
}
async function dbGetGuestById(guest_id) {
    const { data, error } = await exports.supabase
        .from('guests')
        .select('id, nombre, room, spend_limit')
        .eq('id', guest_id)
        .maybeSingle();
    if (error)
        throw error;
    return data ?? null;
}
async function dbValidateGuestAndRoom(guest_id, room) {
    const g = await dbGetGuestById(guest_id);
    if (!g) {
        const err = new Error('GUEST_NOT_FOUND');
        err.code = 'GUEST_NOT_FOUND';
        err.message = `Huésped "${guest_id}" no existe`;
        throw err;
    }
    const dbRoom = (g.room ?? '').trim();
    const inRoom = (room ?? '').trim();
    if (dbRoom && inRoom && dbRoom !== inRoom) {
        const err = new Error('ROOM_MISMATCH');
        err.code = 'ROOM_MISMATCH';
        err.message = `La habitación no coincide (guest=${dbRoom}, input=${inRoom})`;
        throw err;
    }
    return g;
}
// ===== Spend / Ledger =====
async function dbGetSpentToday(guest_id) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 1);
    const { data, error } = await exports.supabase
        .from('spend_ledger')
        .select('amount, occurred_at')
        .eq('guest_id', guest_id)
        .gte('occurred_at', start.toISOString())
        .lt('occurred_at', end.toISOString());
    if (error)
        throw error;
    return (data ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);
}
async function ledgerInsertOnce(rec) {
    const { error } = await exports.supabase
        .from('spend_ledger')
        .upsert([{
            domain: rec.domain,
            request_id: rec.request_id,
            guest_id: rec.guest_id,
            amount: rec.amount,
            occurred_at: (0, utils_1.nowISO)(),
        }], { onConflict: 'guest_id,request_id', ignoreDuplicates: true });
    if (error)
        throw error;
}
async function decrementGuestLimitIfEnough(guest_id, amount) {
    try {
        const { data, error } = await exports.supabase
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
        const { data, error } = await exports.supabase
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
        const { error: e2 } = await exports.supabase
            .from('guests')
            .update({ spend_limit: newVal })
            .eq('id', guest_id);
        if (e2)
            throw e2;
    }
}
async function chargeGuestForRB(ticket) {
    const amount = Number(ticket.total_amount || 0);
    if (amount <= 0)
        return;
    await ledgerInsertOnce({ domain: 'rb', request_id: ticket.id, guest_id: ticket.guest_id, amount });
    try {
        await decrementGuestLimitIfEnough(ticket.guest_id, amount);
    }
    catch (e) {
        await exports.supabase.from('spend_ledger')
            .delete()
            .eq('domain', 'rb')
            .eq('request_id', ticket.id);
        if (e?.code === 'SPEND_LIMIT') {
            throw { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' };
        }
        throw e;
    }
}
// ===== Menu / Stock =====
async function dbMenuUnion() {
    const { data, error } = await exports.supabase.from('menu_union').select('*');
    if (error)
        throw error;
    return (data ?? []);
}
async function decrementStock(items) {
    if (!items?.length)
        return;
    const menu = await dbMenuUnion();
    const byId = new Map(menu.map(m => [m.id, m]));
    const byName = new Map(menu.map(m => [(0, utils_1.normName)(m.name), m]));
    for (const it of items) {
        const row = it.id ? byId.get(it.id) : byName.get((0, utils_1.normName)(it.name));
        if (!row)
            continue;
        const table = row.restaurant === 'rest1' ? 'rest1_menu_items' : 'rest2_menu_items';
        const qty = Math.max(1, it.qty ?? 1);
        const newStock = Math.max(0, (row.stock_current ?? 0) - qty);
        const { error } = await exports.supabase.from(table).update({ stock_current: newStock, updated_at: (0, utils_1.nowISO)() }).eq('id', row.id);
        if (error)
            throw error;
    }
}
async function resolveAndValidateItems(rawItems, nowStr, enableStockCheck = true) {
    const menu = await dbMenuUnion();
    const cur = (0, utils_1.hhmm)(nowStr);
    const byId = new Map(menu.map(m => [m.id, m]));
    const byName = new Map(menu.map(m => [(0, utils_1.normName)(m.name), m]));
    const resolved = [];
    for (const it of (rawItems ?? [])) {
        const row = it.id ? byId.get(it.id) : byName.get((0, utils_1.normName)(it.name));
        if (!row)
            throw new Error(`No encontrado en menú: ${it.name}`);
        const active = row.is_active === true;
        const inTime = (0, utils_1.isInRange)(cur, (0, utils_1.toHHMM)(row.available_start), (0, utils_1.toHHMM)(row.available_end));
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
// ===== Tickets RB =====
async function rbCreateTicket(row) { const { error } = await exports.supabase.from('tickets_rb').insert(row); if (error)
    throw error; }
async function rbUpdateTicket(id, patch) {
    const { error } = await exports.supabase.from('tickets_rb').update({ ...patch, updated_at: (0, utils_1.nowISO)() }).eq('id', id);
    if (error)
        throw error;
}
async function rbGetTicket(id) {
    const { data, error } = await exports.supabase.from('tickets_rb').select('*').eq('id', id).maybeSingle();
    if (error)
        throw error;
    return data;
}
async function rbAddHistory(h) {
    const { error } = await exports.supabase
        .from('ticket_history_rb')
        .insert({ ...h, ts: (0, utils_1.nowISO)() });
    if (error)
        throw error;
}
// ===== Cross-sell =====
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
        (0, utils_1.isInRange)(opts.nowHHMM, r.available_start.toString().slice(0, 5), r.available_end.toString().slice(0, 5)) &&
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
// ===== Feedback (compartido) =====
async function addFeedback(rec) {
    const { error } = await exports.supabase.from('feedback').insert({
        domain: rec.domain,
        guest_id: rec.guest_id,
        request_id: rec.request_id,
        message: rec.message ?? null,
        created_at: (0, utils_1.nowISO)(),
    });
    if (error)
        throw error;
}
//# sourceMappingURL=rbApi.js.map