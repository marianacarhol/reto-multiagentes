"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
 **
    * Agent - 3;
RoomService & Maintenance;
Tool(Multi - Restaurant)
    * /;
require("dotenv/config");
const tools_1 = require("@ai-spine/tools");
const fs_1 = tslib_1.__importDefault(require("fs"));
const path_1 = tslib_1.__importDefault(require("path"));
const utils_1 = require("./utils/utils");
const rbApi_1 = require("./api/rbApi");
const maintenanceApi_1 = require("./api/maintenanceApi");
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
        // --- VALIDAR HUESPED/ROOM CONTRA BD ---
        if (action === 'create') {
            try {
                await (0, rbApi_1.dbValidateGuestAndRoom)(guest_id, room);
            }
            catch (e) {
                return {
                    status: 'error',
                    error: { code: e?.code || 'GUEST_VALIDATION', message: e?.message || 'Validación de huésped falló' }
                };
            }
        }
        try {
            const nowHHMM = (0, utils_1.hhmm)(input.now);
            // GET MENU
            if (action === 'get_menu') {
                const menu = await (0, rbApi_1.dbMenuUnion)();
                const filtered = menu.filter(m => (!input.menu_category || m.category === input.menu_category) &&
                    m.is_active &&
                    (config.enable_stock_check !== false ? (m.stock_current > m.stock_minimum) : true) &&
                    (0, utils_1.isInRange)(nowHHMM, m.available_start.toString().slice(0, 5), m.available_end.toString().slice(0, 5)));
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
            const type = (0, utils_1.classify)(input.text, input.items, input.type);
            const area = (0, utils_1.mapArea)(type);
            // CREATE
            if (action === 'create') {
                // ======== ROOM SERVICE (food/beverage) ========
                if (type === 'food' || type === 'beverage') {
                    const okWindow = (0, utils_1.withinWindow)(input.now, input.access_window, { start: config.accessWindowStart, end: config.accessWindowEnd }, input.do_not_disturb);
                    if (!okWindow)
                        return { status: 'error', error: { code: 'ACCESS_WINDOW_BLOCK', message: 'Fuera de ventana o DND activo' } };
                    const rawItems = input.items ?? [];
                    if (rawItems.length === 0) {
                        return { status: 'error', error: { code: 'NEED_ITEMS', message: 'Debes proporcionar al menos un ítem del menú.' } };
                    }
                    let resolved = [];
                    let total = 0;
                    let restSet = new Set();
                    try {
                        const res = await (0, rbApi_1.resolveAndValidateItems)(rawItems, input.now, config.enable_stock_check !== false);
                        resolved = res.items;
                        total = res.total;
                        restSet = res.restSet;
                    }
                    catch (e) {
                        return { status: 'error', error: { code: 'ITEMS_UNAVAILABLE', message: String(e?.message || e) } };
                    }
                    // Si el usuario especificó restaurant, todos los ítems deben pertenecer a ese restaurant
                    if (input.restaurant === 'rest1' || input.restaurant === 'rest2') {
                        const bad = resolved.find(r => r.restaurant !== input.restaurant);
                        if (bad) {
                            return {
                                status: 'error',
                                error: {
                                    code: 'RESTAURANT_MISMATCH',
                                    message: `El ítem "${bad.name}" pertenece a ${bad.restaurant}, pero se indicó ${input.restaurant}.`
                                }
                            };
                        }
                    }
                    // ---- Límite de gasto (precheck con ledger del día)
                    let spendLimit = input.guest_profile?.spend_limit ?? (guest_id ? await (0, rbApi_1.dbGetGuestSpendLimit)(guest_id) : null);
                    if (spendLimit != null) {
                        const spentToday = guest_id ? await (0, rbApi_1.dbGetSpentToday)(guest_id) : 0;
                        if ((spentToday + total) > Number(spendLimit)) {
                            return { status: 'error', error: { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' } };
                        }
                    }
                    const ticketRestaurant = restSet.size > 1 ? 'multi' :
                        restSet.size === 1 ? Array.from(restSet)[0] :
                            'multi';
                    const id = `REQ-${Date.now()}`;
                    const priorityLabelRB = input.priority ?? 'normal';
                    // ---- CROSS-SELL (opcional)
                    let crossSell = [];
                    if (config.enable_cross_sell !== false) {
                        const preferOppositeOf = (config.cross_sell_prefer_opposite && (input.restaurant === 'rest1' || input.restaurant === 'rest2'))
                            ? (input.restaurant === 'rest1' ? 'rest2' : 'rest1')
                            : undefined;
                        const menu = await (0, rbApi_1.dbMenuUnion)();
                        crossSell = (0, rbApi_1.pickCrossSellByCategory)(menu, resolved, {
                            nowHHMM,
                            perCategoryCount: Math.max(1, Math.min(3, config.cross_sell_per_category_count ?? 1)),
                            preferOppositeOf: preferOppositeOf,
                            explicitType: type,
                            forbidSameCategoryIfPresent: !!config.cross_sell_per_category
                        });
                        const threshold = Number(config.cross_sell_threshold ?? 1);
                        if ((resolved?.length ?? 0) < threshold)
                            crossSell = [];
                    }
                    const crossSellNames = crossSell.map(s => s.name);
                    await (0, rbApi_1.rbCreateTicket)({
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
                    await (0, rbApi_1.rbAddHistory)({
                        request_id: id,
                        status: 'CREADO',
                        actor: 'system'
                    });
                    return {
                        status: 'success',
                        data: {
                            request_id: id,
                            domain: 'rb',
                            type,
                            area,
                            status: 'CREADO',
                            message: 'Ticket creado. Usa action "accept" o "reject".',
                            cross_sell_suggestions: crossSellNames
                        }
                    };
                }
                // ======== MANTENIMIENTO — CON IA ========
                if (!input.issue)
                    return { status: 'error', error: { code: 'MISSING_ISSUE', message: 'Describe el issue de mantenimiento' } };
                const id = `REQ-${Date.now()}`;
                const eta_to_sla_min_m = (0, utils_1.calcEtaToSLA)({ domain: 'm', type, createdAtISO: input.now });
                const priM = await (0, utils_1.getPriorityFromAPI)({
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
                const serviceHoursCreate = input.access_window
                    ? `${(0, utils_1.toHHMM)(input.access_window.start)}-${(0, utils_1.toHHMM)(input.access_window.end)}`
                    : (input.service_hours ?? null);
                await (0, maintenanceApi_1.mCreateTicket)({
                    id, guest_id: guest_id, room: room,
                    issue: input.issue, severity: severityM,
                    status: 'CREADO', priority: priorityLabelM,
                    notes: input.notes ?? undefined,
                    service_hours: serviceHoursCreate,
                    priority_score: priM.score,
                    priority_model: priM.model,
                    priority_proba: priM.proba ?? null,
                    needs_review: !!priM.needs_review
                });
                await (0, maintenanceApi_1.mAddHistory)({
                    request_id: id,
                    status: 'CREADO',
                    actor: 'system',
                    service_hours: serviceHoursCreate,
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
                const { error } = await (await Promise.resolve().then(() => tslib_1.__importStar(require('./api/rbApi')))).supabase
                    .from('tickets_rb')
                    .update({ status: newStatus, updated_at: (0, utils_1.nowISO)() })
                    .eq('id', ticket.id);
                if (error)
                    throw error;
                await (0, rbApi_1.rbAddHistory)({ request_id: ticket.id, status: newStatus, actor: 'agent', note: input.notes });
                if (action === 'accept') {
                    try {
                        await (0, rbApi_1.chargeGuestForRB)({ id: ticket.id, guest_id: ticket.guest_id, total_amount: ticket.total_amount });
                        await (0, rbApi_1.decrementStock)(ticket.items || []);
                        const restSet = new Set((ticket.items || []).map((i) => i.restaurant).filter(Boolean));
                        for (const r of restSet) {
                            await (0, rbApi_1.rbAddHistory)({ request_id: ticket.id, status: newStatus, actor: r });
                        }
                    }
                    catch (e) {
                        await (0, rbApi_1.rbAddHistory)({
                            request_id: ticket.id,
                            status: ticket.status,
                            actor: 'system',
                            note: `Accept failed: ${e?.code || ''} ${e?.message || e}`
                        });
                        await (await Promise.resolve().then(() => tslib_1.__importStar(require('./api/rbApi')))).supabase.from('tickets_rb')
                            .update({ status: 'CREADO', updated_at: (0, utils_1.nowISO)() })
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
                const serviceHours = input.access_window
                    ? `${(0, utils_1.toHHMM)(input.access_window.start)}-${(0, utils_1.toHHMM)(input.access_window.end)}`
                    : (input.service_hours ?? ticket.service_hours ?? null);
                const patch = { status: newStatus, updated_at: (0, utils_1.nowISO)() };
                if (serviceHours != null)
                    patch.service_hours = serviceHours;
                const { error: mUpdErr } = await (await Promise.resolve().then(() => tslib_1.__importStar(require('./api/rbApi')))).supabase
                    .from('tickets_m')
                    .update(patch)
                    .eq('id', ticket.id);
                if (mUpdErr)
                    throw mUpdErr;
                await (0, maintenanceApi_1.mAddHistory)({
                    request_id: ticket.id,
                    status: newStatus,
                    actor: 'agent',
                    note: input.notes,
                    service_hours: serviceHours,
                });
                return { status: 'success', data: { request_id: ticket.id, status: newStatus } };
            }
            if (action === 'feedback') {
                const ticketRB = await (0, rbApi_1.rbGetTicket)(input.request_id);
                const ticketM = ticketRB ? null : await (0, maintenanceApi_1.mGetTicket)(input.request_id);
                if (!ticketRB && !ticketM) {
                    return { status: 'error', error: { code: 'NOT_FOUND', message: 'Ticket no encontrado' } };
                }
                const domain = ticketRB ? 'rb' : 'm';
                const guest_id2 = (ticketRB ?? ticketM).guest_id;
                if (input.service_feedback == null) {
                    return { status: 'error', error: { code: 'EMPTY_FEEDBACK', message: 'Provee service_feedback' } };
                }
                await (0, rbApi_1.addFeedback)({
                    domain,
                    guest_id: guest_id2,
                    request_id: input.request_id,
                    message: input.service_feedback,
                });
                if (domain === 'rb') {
                    await (await Promise.resolve().then(() => tslib_1.__importStar(require('./api/rbApi')))).supabase
                        .from('tickets_rb')
                        .update({ feedback: input.service_feedback ?? null, updated_at: (0, utils_1.nowISO)() })
                        .eq('id', input.request_id);
                    await (0, rbApi_1.rbAddHistory)({
                        request_id: input.request_id,
                        status: 'FEEDBACK',
                        actor: 'guest',
                        feedback: input.service_feedback,
                    });
                }
                else {
                    await (await Promise.resolve().then(() => tslib_1.__importStar(require('./api/rbApi')))).supabase
                        .from('tickets_m')
                        .update({ feedback: input.service_feedback ?? null, updated_at: (0, utils_1.nowISO)() })
                        .eq('id', input.request_id);
                    await (0, maintenanceApi_1.mAddHistory)({
                        request_id: input.request_id,
                        status: 'FEEDBACK',
                        actor: 'guest',
                        feedback: input.service_feedback,
                    });
                }
                return { status: 'success', data: { request_id: input.request_id, domain, message: 'Feedback guardado' } };
            }
            const rb = await (0, rbApi_1.rbGetTicket)(input.request_id);
            if (rb)
                return await handleRB(rb);
            const mt = await (0, maintenanceApi_1.mGetTicket)(input.request_id);
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
// ===== INIT: create -> accept/reject -> complete/cancel -> feedback (solo askYesNo) =====
const utils_2 = require("./utils/utils");
async function runInitFlow(baseUrl) {
    try {
        const resolvedPath = path_1.default.resolve(process.env.INIT_JSON_PATH ?? './input.json');
        console.log(`[INIT] CWD: ${process.cwd()}`);
        console.log(`[INIT] INIT_JSON_PATH (resuelto): ${resolvedPath}`);
        if (!fs_1.default.existsSync(resolvedPath)) {
            console.log(`[INIT] No se encontró archivo en ${resolvedPath}. Se omite INIT.`);
            return;
        }
        const raw = fs_1.default.readFileSync(resolvedPath, 'utf-8');
        console.log(`[INIT] input.json bytes=${raw.length}`);
        console.log(`[INIT] preview: ${raw.slice(0, 200).replace(/\n/g, ' ')}${raw.length > 200 ? '…' : ''}`);
        const parsed = JSON.parse(raw);
        const inputData = parsed?.input_data && typeof parsed.input_data === 'object' ? parsed.input_data : parsed;
        if (!inputData || typeof inputData !== 'object') {
            console.error('[INIT] El JSON no es un objeto válido ni contiene "input_data" objeto.');
            return;
        }
        if (!inputData.action)
            inputData.action = 'create';
        const headers = { 'Content-Type': 'application/json' };
        const apiKeyAuth = (process.env.API_KEY_AUTH ?? '').toLowerCase() === 'true';
        if (apiKeyAuth && process.env.VALID_API_KEYS) {
            headers['X-API-Key'] = process.env.VALID_API_KEYS.split(',')[0].trim();
        }
        // 1) CREATE
        console.log('[INIT] POST /api/execute (create)…');
        const createResp = await fetch(`${baseUrl}/api/execute`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input_data: inputData }),
        });
        const createTxt = await createResp.text();
        let createJson = {};
        try {
            createJson = JSON.parse(createTxt);
        }
        catch { }
        console.log('[INIT] create status=', createResp.status, JSON.stringify(createJson, null, 2));
        const requestId = createJson?.output_data?.request_id ||
            createJson?.data?.request_id ||
            createJson?.request_id;
        if (!requestId) {
            console.error('[INIT] No se obtuvo request_id del create. Abortando flujo.');
            return;
        }
        console.log(`[INIT] request_id=${requestId}`);
        // 2) ACCEPT o REJECT
        const interactive = ['1', 'true', 't', 'yes', 'y', 'si', 'sí', 'on'].includes((process.env.INTERACTIVE_DECIDE ?? 'false').trim().toLowerCase());
        const initDecisionRaw = (process.env.INIT_DECISION ?? 'accept').trim().toLowerCase();
        let decision;
        if (interactive) {
            const yes = await (0, utils_2.askYesNo)(`¿Aceptar pedido ${requestId}?`);
            decision = yes ? 'accept' : 'reject';
        }
        else {
            decision = initDecisionRaw === 'reject' ? 'reject' : 'accept';
        }
        console.log(`[INIT] decision=${decision}`);
        const firstAct = await fetch(`${baseUrl}/api/execute`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input_data: { action: decision, request_id: requestId } }),
        });
        const firstTxt = await firstAct.text();
        let firstJson = {};
        try {
            firstJson = JSON.parse(firstTxt);
        }
        catch { }
        console.log(`[INIT] ${decision} status=${firstAct.status} body=`, JSON.stringify(firstJson, null, 2));
        // 3) Si fue ACCEPT, COMPLETE o CANCEL
        let finalAction = decision === 'reject' ? 'reject' : 'cancel';
        if (decision === 'accept') {
            const done = await (0, utils_2.askYesNo)(`¿Se completó el pedido ${requestId}?`);
            finalAction = done ? 'complete' : 'cancel';
            const secondAct = await fetch(`${baseUrl}/api/execute`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ input_data: { action: finalAction, request_id: requestId } }),
            });
            const secondTxt = await secondAct.text();
            let secondJson = {};
            try {
                secondJson = JSON.parse(secondTxt);
            }
            catch { }
            console.log(`[INIT] ${finalAction} status=${secondAct.status} body=`, JSON.stringify(secondJson, null, 2));
        }
        // 4) Feedback (opcional)
        const wantsFeedback = await (0, utils_2.askYesNo)('¿Quieres agregar un comentario/feedback?');
        if (wantsFeedback) {
            const readline = await Promise.resolve().then(() => tslib_1.__importStar(require('readline')));
            const comment = await new Promise((resolve) => {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl.question('Comentario: ', (answer) => {
                    rl.close();
                    resolve(String(answer ?? '').trim());
                });
            });
            if (comment) {
                const fbResp = await fetch(`${baseUrl}/api/execute`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        input_data: { action: 'feedback', request_id: requestId, service_feedback: comment }
                    }),
                });
                const fbTxt = await fbResp.text();
                let fbJson = {};
                try {
                    fbJson = JSON.parse(fbTxt);
                }
                catch { }
                console.log(`[INIT] feedback status=${fbResp.status} body=`, JSON.stringify(fbJson, null, 2));
            }
            else {
                console.log('[INIT] feedback omitido (vacío).');
            }
        }
        else {
            console.log('[INIT] feedback saltado por usuario.');
        }
    }
    catch (e) {
        console.error('[INIT] flow error:', e?.message || e);
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
        // 2) INIT opcional (controlado por ENV, con logs claros)
        const initOnStart = (0, utils_1.envBool)('INIT_ON_START', true);
        const initJsonPath = process.env.INIT_JSON_PATH ?? './input.json';
        const interactive = (0, utils_1.envBool)('INTERACTIVE_DECIDE', false);
        const initDecisionRaw = (process.env.INIT_DECISION ?? 'accept').toLowerCase();
        console.log(`[INIT] INIT_ON_START=${initOnStart}  (crudo="${process.env.INIT_ON_START ?? '<unset>'}")`);
        console.log(`[INIT] INIT_JSON_PATH="${initJsonPath}"`);
        console.log(`[INIT] INTERACTIVE_DECIDE=${interactive}  (crudo="${process.env.INTERACTIVE_DECIDE ?? '<unset>'}")`);
        console.log(`[INIT] INIT_DECISION="${initDecisionRaw}"`);
        if (initOnStart) {
            await runInitFlow(baseUrl);
        }
        else {
            console.log('[INIT] Saltado porque INIT_ON_START=false');
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