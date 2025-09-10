"use strict";
/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant, Split Tables)
 * v2.2.0
 *
 * - Menús separados por restaurante (rest1/rest2) + vista menu_union
 * - Cross-sell entre restaurantes
 * - Tickets separados: tickets_rb / tickets_m + historiales
 * - Feedback usando tu tabla (ticket_id)
 * - Límite de gasto (perfil inline o tabla guests)
 * - Seguimiento de estado
 * - Descuento de stock al crear RB
 * - Prioridad simple (severity 'high' y feedback <= 2)
 * - Registro de consumo en spend_ledger (opcional; ignora si no existe)
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const tools_1 = require("@ai-spine/tools");
const supabase_js_1 = require("@supabase/supabase-js");
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');
// ============ Utils ============
const nowISO = () => new Date().toISOString();
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (nowStr) => {
    const d = nowStr ? new Date(nowStr) : new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const isInRange = (cur, start, end) => {
    // soporta rangos cruzando medianoche
    return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
};
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
const sumItems = (items) => (items ?? []).reduce((a, i) => a + (i.price ?? 0) * (i.qty ?? 1), 0);
// ============ DB helpers ============
// guests (opcional para gastar)
async function dbGetGuestSpendLimit(guest_id) {
    const { data, error } = await supabase.from('guests')
        .select('spend_limit')
        .eq('id', guest_id)
        .maybeSingle();
    if (error)
        throw error;
    return data?.spend_limit;
}
async function dbMenuUnion() {
    const { data, error } = await supabase.from('menu_union').select('*');
    if (error)
        throw error;
    return (data ?? []);
}
// Room Service (RB)
async function rbCreateTicket(row) {
    const { error } = await supabase.from('tickets_rb').insert(row);
    if (error)
        throw error;
}
async function rbUpdateTicket(id, patch) {
    const { error } = await supabase.from('tickets_rb')
        .update({ ...patch, updated_at: nowISO() }).eq('id', id);
    if (error)
        throw error;
}
async function rbGetTicket(id) {
    const { data, error } = await supabase.from('tickets_rb').select('*').eq('id', id).maybeSingle();
    if (error)
        throw error;
    return data;
}
async function rbAddHistory(h) {
    const { error } = await supabase.from('ticket_history_rb').insert({ ...h, ts: nowISO() });
    if (error)
        throw error;
}
// Mantenimiento (M)
async function mCreateTicket(row) {
    const { error } = await supabase.from('tickets_m').insert(row);
    if (error)
        throw error;
}
async function mUpdateTicket(id, patch) {
    const { error } = await supabase.from('tickets_m')
        .update({ ...patch, updated_at: nowISO() }).eq('id', id);
    if (error)
        throw error;
}
async function mGetTicket(id) {
    const { data, error } = await supabase.from('tickets_m').select('*').eq('id', id).maybeSingle();
    if (error)
        throw error;
    return data;
}
async function mAddHistory(h) {
    const { error } = await supabase.from('ticket_history_m').insert({ ...h, ts: nowISO() });
    if (error)
        throw error;
}
// Feedback (Opción B: usa tu tabla tal cual con ticket_id)
async function addFeedback(rec) {
    const { error } = await supabase.from('feedback').insert({
        guest_id: rec.guest_id,
        ticket_id: rec.request_id, // <-- tu columna
        message: rec.message ?? null,
        rating: rec.rating ?? null,
        created_at: nowISO(),
    });
    if (error)
        throw error;
}
// Descontar stock al crear RB
async function decrementStock(items) {
    if (!items?.length)
        return;
    const menu = await dbMenuUnion();
    for (const it of items) {
        const row = it.id
            ? menu.find(m => m.id === it.id)
            : menu.find(m => m.name.toLowerCase() === it.name.toLowerCase());
        if (!row)
            continue;
        const table = row.restaurant === 'rest1' ? 'rest1_menu_items' : 'rest2_menu_items';
        const qty = Math.max(1, it.qty ?? 1);
        const newStock = Math.max(0, (row.stock_current ?? 0) - qty);
        const { error } = await supabase
            .from(table)
            .update({ stock_current: newStock, updated_at: nowISO() })
            .eq('id', row.id);
        if (error)
            throw error;
    }
}
// Registrar consumo (opcional). Si la tabla no existe, se ignora.
async function addDailySpend(guest_id, amount) {
    try {
        const { error } = await supabase.from('spend_ledger').insert({
            guest_id,
            amount,
            occurred_at: nowISO(),
        });
        if (error) {
            console.warn('spend_ledger insert skipped:', error.message);
        }
    }
    catch (e) {
        console.warn('spend_ledger insert skipped:', e?.message || e);
    }
}
// Cross-sell desde menu_union
function pickCrossSellFromUnion(menu, chosen, prefer) {
    const chosenIds = new Set(chosen.map(c => c.id).filter(Boolean));
    const byId = new Map(menu.map(m => [m.id, m]));
    const sugs = new Set();
    for (const c of chosen) {
        if (c.id && byId.has(c.id)) {
            const row = byId.get(c.id);
            (row.cross_sell_items ?? []).forEach(id => sugs.add(id));
        }
        else {
            const row = menu.find(m => m.name.toLowerCase() === c.name.toLowerCase());
            row?.cross_sell_items?.forEach(id => sugs.add(id));
        }
    }
    chosenIds.forEach(id => sugs.delete(id));
    const cur = hhmm();
    const asRows = [...sugs].map(id => byId.get(id)).filter(Boolean);
    const available = asRows.filter(r => r.is_active &&
        r.stock_current > r.stock_minimum &&
        isInRange(cur, r.available_start.toString().slice(0, 5), r.available_end.toString().slice(0, 5)));
    available.sort((a, b) => {
        if (a.restaurant === prefer && b.restaurant !== prefer)
            return -1;
        if (a.restaurant !== prefer && b.restaurant === prefer)
            return 1;
        return 0;
    });
    return available.slice(0, 3).map(r => ({
        restaurant: r.restaurant,
        id: r.id,
        name: r.name,
        price: r.price,
        category: r.category
    }));
}
// ============ Tool ============
const tool = (0, tools_1.createTool)({
    metadata: {
        name: 'agent-03-roomservice-maintenance-split',
        version: '2.2.0',
        description: 'Room Service (rest1/rest2) + Maintenance con tablas separadas y cross-sell inter-restaurantes',
        capabilities: ['dynamic-menu', 'intelligent-cross-sell', 'ticket-tracking', 'feedback', 'policy-check'],
        author: 'Equipo A3',
        license: 'MIT',
    },
    schema: {
        input: {
            action: { type: 'string', enum: ['get_menu', 'create', 'status', 'complete', 'assign', 'feedback', 'confirm_service'], required: false, default: 'create' },
            guest_id: (0, tools_1.stringField)({ required: true }),
            room: (0, tools_1.stringField)({ required: true }),
            restaurant: { type: 'string', required: false, enum: ['rest1', 'rest2'] },
            type: { type: 'string', required: false, enum: ['food', 'beverage', 'maintenance'] },
            items: {
                type: 'array', required: false, items: {
                    type: 'object', properties: {
                        id: (0, tools_1.stringField)({ required: false }),
                        name: (0, tools_1.stringField)({ required: true }),
                        qty: (0, tools_1.numberField)({ required: false, default: 1, min: 1 }),
                        price: (0, tools_1.numberField)({ required: false, min: 0 }),
                        restaurant: { type: 'string', required: false, enum: ['rest1', 'rest2'] },
                    }
                }
            },
            issue: (0, tools_1.stringField)({ required: false }),
            severity: { type: 'string', required: false, enum: ['low', 'medium', 'high'] },
            text: (0, tools_1.stringField)({ required: false }),
            notes: (0, tools_1.stringField)({ required: false }),
            priority: { type: 'string', required: false, default: 'normal', enum: ['low', 'normal', 'high'] },
            now: (0, tools_1.stringField)({ required: false }),
            do_not_disturb: (0, tools_1.booleanField)({ required: false }),
            guest_profile: {
                type: 'object', required: false, properties: {
                    tier: { type: 'string', required: false, enum: ['standard', 'gold', 'platinum'] },
                    daily_spend: (0, tools_1.numberField)({ required: false, min: 0 }),
                    spend_limit: (0, tools_1.numberField)({ required: false, min: 0 }),
                    preferences: { type: 'array', required: false, items: { type: 'string' } }
                }
            },
            access_window: {
                type: 'object', required: false, properties: {
                    start: (0, tools_1.stringField)({ required: true }),
                    end: (0, tools_1.stringField)({ required: true }),
                }
            },
            request_id: (0, tools_1.stringField)({ required: false }),
            service_rating: (0, tools_1.numberField)({ required: false, min: 1, max: 5 }),
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
            api_key: (0, tools_1.stringField)({ required: false }),
            default_count: (0, tools_1.numberField)({ required: false, default: 1 }),
        },
    },
    async execute(input, config) {
        const { action = 'create', guest_id, room } = input;
        if (!guest_id || !room || typeof guest_id !== 'string' || typeof room !== 'string') {
            return { status: 'error', error: { code: 'VALIDATION_ERROR', message: 'guest_id y room son requeridos (string)' } };
        }
        try {
            // ---- GET MENU
            if (action === 'get_menu') {
                const menu = await dbMenuUnion();
                const cur = hhmm(input.now);
                const filtered = menu.filter(m => (!input.menu_category || m.category === input.menu_category) &&
                    m.is_active &&
                    (!config.enable_stock_check || m.stock_current > m.stock_minimum) &&
                    isInRange(cur, m.available_start.toString().slice(0, 5), m.available_end.toString().slice(0, 5)));
                return {
                    status: 'success',
                    data: {
                        current_time: cur,
                        items: filtered.map(m => ({
                            restaurant: m.restaurant, id: m.id, name: m.name, price: m.price,
                            category: m.category, available_start: m.available_start, available_end: m.available_end,
                            stock_current: m.stock_current
                        }))
                    }
                };
            }
            // Determine domain by classification (unless explicit)
            const type = classify(input.text, input.items, input.type);
            const area = mapArea(type);
            // ---- CREATE
            if (action === 'create') {
                if (type === 'food' || type === 'beverage') {
                    if (!input.restaurant) {
                        return { status: 'error', error: { code: 'VALIDATION_ERROR', message: 'restaurant es requerido para Room Service' } };
                    }
                    // Policies: ventana + límite de gasto (de perfil o guests)
                    const okWindow = withinWindow(input.now, input.access_window, { start: config.accessWindowStart, end: config.accessWindowEnd }, input.do_not_disturb);
                    if (!okWindow) {
                        return { status: 'error', error: { code: 'ACCESS_WINDOW_BLOCK', message: 'Fuera de ventana o DND activo' } };
                    }
                    const items = input.items ?? [];
                    // Límite de gasto
                    let spendLimit = input.guest_profile?.spend_limit;
                    if (spendLimit == null) {
                        const fromGuest = await dbGetGuestSpendLimit(guest_id);
                        if (typeof fromGuest === 'number')
                            spendLimit = Number(fromGuest);
                    }
                    const total = sumItems(items);
                    const dailySpend = input.guest_profile?.daily_spend ?? 0;
                    if (spendLimit != null && (dailySpend + total) > spendLimit) {
                        return { status: 'error', error: { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' } };
                    }
                    // Stock/horario (opcional)
                    if (config.enable_stock_check && items.length) {
                        const menu = await dbMenuUnion();
                        const cur = hhmm(input.now);
                        for (const it of items) {
                            const row = it.id ? menu.find(m => m.id === it.id)
                                : menu.find(m => m.name.toLowerCase() === it.name.toLowerCase());
                            if (!row)
                                continue;
                            const ok = row.is_active &&
                                row.stock_current > row.stock_minimum &&
                                isInRange(cur, row.available_start.toString().slice(0, 5), row.available_end.toString().slice(0, 5));
                            if (!ok) {
                                return { status: 'error', error: { code: 'ITEMS_UNAVAILABLE', message: `No disponible: ${row.name}` } };
                            }
                        }
                    }
                    const id = `REQ-${Date.now()}`;
                    await rbCreateTicket({
                        id,
                        guest_id,
                        room,
                        restaurant: input.restaurant,
                        status: 'CREADO',
                        priority: input.priority ?? 'normal',
                        items: items,
                        total_amount: total,
                        notes: input.notes ?? undefined
                    });
                    await rbAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });
                    await rbUpdateTicket(id, { status: 'ACEPTADA' });
                    await rbAddHistory({ request_id: id, status: 'ACEPTADA', actor: input.restaurant });
                    // Descontar stock
                    await decrementStock(items);
                    // Registrar consumo (opcional; ignora si la tabla no existe)
                    if (total > 0) {
                        await addDailySpend(guest_id, total);
                    }
                    // Cross-sell
                    let cross = [];
                    if (config.enable_cross_sell && items.length >= (config.cross_sell_threshold ?? 1)) {
                        const menu = await dbMenuUnion();
                        cross = pickCrossSellFromUnion(menu, items, input.restaurant);
                    }
                    return {
                        status: 'success',
                        data: {
                            request_id: id,
                            domain: 'rb',
                            type,
                            area,
                            status: 'ACEPTADA',
                            total_amount: total,
                            cross_sell_suggestions: cross
                        }
                    };
                }
                // maintenance
                if (!input.issue) {
                    return { status: 'error', error: { code: 'MISSING_ISSUE', message: 'Describe el issue de mantenimiento' } };
                }
                // prioridad simple: severity high => high
                const computedPriority = (input.severity === 'high') ? 'high' : (input.priority ?? 'normal');
                const id = `REQ-${Date.now()}`;
                await mCreateTicket({
                    id,
                    guest_id,
                    room,
                    issue: input.issue,
                    severity: input.severity,
                    status: 'CREADO',
                    priority: computedPriority,
                    notes: input.notes ?? undefined
                });
                await mAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });
                await mUpdateTicket(id, { status: 'ACEPTADA' });
                await mAddHistory({ request_id: id, status: 'ACEPTADA', actor: 'maintenance' });
                return { status: 'success', data: { request_id: id, domain: 'm', type, area, status: 'ACEPTADA' } };
            }
            // ---- Acciones posteriores (status/complete/assign/feedback/confirm)
            if (!input.request_id) {
                return { status: 'error', error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' } };
            }
            // intenta RB
            const rb = await rbGetTicket(input.request_id);
            if (rb) {
                if (action === 'status') {
                    await rbUpdateTicket(input.request_id, { status: 'EN_PROCESO' });
                    await rbAddHistory({ request_id: input.request_id, status: 'EN_PROCESO', actor: rb.restaurant });
                    return { status: 'success', data: { request_id: input.request_id, domain: 'rb', status: 'EN_PROCESO' } };
                }
                if (action === 'complete') {
                    await rbUpdateTicket(input.request_id, { status: 'COMPLETADA' });
                    await rbAddHistory({ request_id: input.request_id, status: 'COMPLETADA', actor: rb.restaurant });
                    return { status: 'success', data: { request_id: input.request_id, domain: 'rb', status: 'COMPLETADA' } };
                }
                if (action === 'assign') {
                    await rbAddHistory({ request_id: input.request_id, status: rb.status, actor: rb.restaurant, note: 'Reasignado (demo)' });
                    return { status: 'success', data: { request_id: input.request_id, domain: 'rb', status: rb.status, message: 'Reasignado' } };
                }
                if (action === 'feedback' || action === 'confirm_service') {
                    if (action === 'confirm_service') {
                        await rbUpdateTicket(input.request_id, { status: 'COMPLETADA' });
                        await rbAddHistory({
                            request_id: input.request_id,
                            status: 'COMPLETADA',
                            actor: input.service_completed_by || rb.restaurant,
                            note: input.service_feedback ? `Rating: ${input.service_rating ?? ''} - ${input.service_feedback}` : undefined
                        });
                    }
                    if (input.service_rating || input.service_feedback) {
                        await addFeedback({
                            domain: 'rb',
                            guest_id,
                            request_id: input.request_id,
                            message: input.service_feedback,
                            rating: input.service_rating
                        });
                        // Escalar prioridad si rating <= 2 y no está completado
                        if ((input.service_rating ?? 5) <= 2 && rb.status !== 'COMPLETADA') {
                            await rbUpdateTicket(input.request_id, { priority: 'high' });
                            await rbAddHistory({ request_id: input.request_id, status: rb.status, actor: 'system', note: 'Escalado por feedback negativo' });
                        }
                    }
                    return { status: 'success', data: { request_id: input.request_id, domain: 'rb', status: action === 'confirm_service' ? 'COMPLETADA' : rb.status, feedbackSaved: !!(input.service_rating || input.service_feedback) } };
                }
                return { status: 'error', error: { code: 'UNKNOWN_ACTION', message: 'Acción no soportada para RB' } };
            }
            // intenta M
            const mt = await mGetTicket(input.request_id);
            if (mt) {
                if (action === 'status') {
                    await mUpdateTicket(input.request_id, { status: 'EN_PROCESO' });
                    await mAddHistory({ request_id: input.request_id, status: 'EN_PROCESO', actor: 'maintenance' });
                    return { status: 'success', data: { request_id: input.request_id, domain: 'm', status: 'EN_PROCESO' } };
                }
                if (action === 'complete') {
                    await mUpdateTicket(input.request_id, { status: 'COMPLETADA' });
                    await mAddHistory({ request_id: input.request_id, status: 'COMPLETADA', actor: 'maintenance' });
                    return { status: 'success', data: { request_id: input.request_id, domain: 'm', status: 'COMPLETADA' } };
                }
                if (action === 'assign') {
                    await mAddHistory({ request_id: input.request_id, status: mt.status, actor: 'maintenance', note: 'Reasignado (demo)' });
                    return { status: 'success', data: { request_id: input.request_id, domain: 'm', status: mt.status, message: 'Reasignado' } };
                }
                if (action === 'feedback' || action === 'confirm_service') {
                    if (action === 'confirm_service') {
                        await mUpdateTicket(input.request_id, { status: 'COMPLETADA' });
                        await mAddHistory({
                            request_id: input.request_id,
                            status: 'COMPLETADA',
                            actor: input.service_completed_by || 'maintenance',
                            note: input.service_feedback ? `Rating: ${input.service_rating ?? ''} - ${input.service_feedback}` : undefined
                        });
                    }
                    if (input.service_rating || input.service_feedback) {
                        await addFeedback({
                            domain: 'm',
                            guest_id,
                            request_id: input.request_id,
                            message: input.service_feedback,
                            rating: input.service_rating
                        });
                        // Escalar prioridad si rating <= 2 y no está completado
                        if ((input.service_rating ?? 5) <= 2 && mt.status !== 'COMPLETADA') {
                            await mUpdateTicket(input.request_id, { priority: 'high' });
                            await mAddHistory({ request_id: input.request_id, status: mt.status, actor: 'system', note: 'Escalado por feedback negativo' });
                        }
                    }
                    return { status: 'success', data: { request_id: input.request_id, domain: 'm', status: action === 'confirm_service' ? 'COMPLETADA' : mt.status, feedbackSaved: !!(input.service_rating || input.service_feedback) } };
                }
                return { status: 'error', error: { code: 'UNKNOWN_ACTION', message: 'Acción no soportada para M' } };
            }
            return { status: 'error', error: { code: 'NOT_FOUND', message: 'request_id no existe ni en RB ni en M' } };
        }
        catch (e) {
            console.error('ERROR:', e?.message || e);
            return { status: 'error', error: { code: 'INTERNAL_DB_ERROR', message: String(e?.message || e) } };
        }
    },
});
// ============ Server bootstrap ============
async function main() {
    try {
        await tool.start({
            port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
            host: process.env.HOST || '0.0.0.0',
            development: { requestLogging: process.env.NODE_ENV === 'development' },
            security: {
                requireAuth: process.env.API_KEY_AUTH === 'true',
                ...(process.env.VALID_API_KEYS && { apiKeys: process.env.VALID_API_KEYS.split(',') }),
            },
        });
        console.log('🚀 Agent-03 RS&M split server ready');
        console.log(`Health:  http://localhost:${process.env.PORT || 3000}/health`);
        console.log(`Execute: http://localhost:${process.env.PORT || 3000}/api/execute`);
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