"use strict";
/**
 * Agent-03 RoomService & Maintenance Tool (Supabase-backed)
 *
 * Orquesta pedidos de A&B y tickets de mantenimiento:
 * - Clasificación (food | beverage | maintenance)
 * - Políticas (ventana de acceso, DND, límite de gasto)
 * - Despacho/estado e historial (persistente en Supabase)
 *
 * @fileoverview Main tool implementation for agent-03-roomservice-maintenance
 * @since 1.0.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const tools_1 = require("@ai-spine/tools");
const supabase_js_1 = require("@supabase/supabase-js");
/* =======================
   Supabase Client
   ======================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    // eslint-disable-next-line no-console
    console.warn('⚠️  Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE en .env — el servidor arrancará, pero las operaciones DB fallarán.');
}
const supabase = (0, supabase_js_1.createClient)(SUPABASE_URL ?? '', SUPABASE_SERVICE_ROLE ?? '');
/* =======================
   Utilidades de dominio
   ======================= */
const nowISO = () => new Date().toISOString();
const classify = (text, items, explicit) => {
    if (explicit)
        return explicit;
    const blob = `${text ?? ''} ${(items ?? []).map(i => i.name).join(' ')}`.toLowerCase();
    if (/(repair|leak|broken|fuga|mantenimiento|plomer|reparar)/i.test(blob))
        return 'maintenance';
    if (/(beer|vino|coca|bebida|agua|jugo|drink)/i.test(blob))
        return 'beverage';
    return 'food';
};
const mapArea = (t) => t === 'maintenance' ? 'maintenance' : t === 'beverage' ? 'bar' : 'kitchen';
const withinWindow = (nowStr, win, cfg, dnd) => {
    if (dnd)
        return false;
    const start = win?.start ?? cfg.start;
    const end = win?.end ?? cfg.end;
    if (!start || !end)
        return true;
    const now = nowStr ? new Date(nowStr) : new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const cur = `${hh}:${mm}:${ss}`;
    return start <= cur && cur <= end;
};
const enforceSpend = (items, profile) => {
    const total = (items ?? []).reduce((a, i) => a + (i.price ?? 0) * (i.qty ?? 1), 0);
    const daily = profile?.daily_spend ?? 0;
    const limit = profile?.spend_limit ?? Infinity;
    return { ok: daily + total <= limit, total };
};
const crossSell = (items) => {
    const names = new Set((items ?? []).map(i => i.name.toLowerCase()));
    const s = [];
    if (names.has('hamburguesa'))
        s.push('brownie');
    if (names.has('pizza'))
        s.push('vino tinto');
    if (names.has('ensalada'))
        s.push('agua mineral');
    return s;
};
/* =======================
   Acceso a datos (Supabase)
   Tablas esperadas:
   - tickets(id text pk, guest_id, room, type, area, status, priority, items jsonb, notes, created_at, updated_at)
   - ticket_history(id bigserial, request_id fk, status, actor, note, ts)
   ======================= */
async function dbCreateTicket(t) {
    const { error } = await supabase.from('tickets').insert({
        id: t.id,
        guest_id: t.guest_id,
        room: t.room,
        type: t.type,
        area: t.area,
        items: t.items ?? null,
        notes: t.notes ?? null,
        priority: t.priority ?? 'normal',
        status: t.status,
        created_at: nowISO(),
        updated_at: nowISO(),
    });
    if (error)
        throw error;
}
async function dbUpdateTicket(id, patch) {
    const { error } = await supabase
        .from('tickets')
        .update({ ...patch, updated_at: nowISO() })
        .eq('id', id);
    if (error)
        throw error;
}
async function dbGetTicket(id) {
    const { data, error } = await supabase
        .from('tickets')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error)
        throw error;
    return data;
}
async function dbAddHistory(rec) {
    const { error } = await supabase.from('ticket_history').insert({
        request_id: rec.request_id,
        status: rec.status,
        actor: rec.actor,
        note: rec.note ?? null,
        ts: nowISO(),
    });
    if (error)
        throw error;
}
/* =======================
   Implementación del Tool
   ======================= */
const tool = (0, tools_1.createTool)({
    // 1) METADATA
    metadata: {
        name: 'agent-03-roomservice-maintenance',
        version: '1.0.0',
        description: 'Agente 3: Room Service (A&B) y Mantenimiento. Orquesta pedidos A&B y tickets de mantenimiento con políticas de horario, límite de gasto y escalamiento.',
        capabilities: ['classification', 'policy-check', 'dispatch', 'ticket-tracking'],
        author: 'Equipo A3',
        license: 'MIT',
    },
    // 2) SCHEMA
    schema: {
        input: {
            action: {
                type: 'string',
                enum: ['create', 'assign', 'status', 'complete', 'feedback'],
                required: false,
                default: 'create',
                description: 'Flujo a ejecutar',
            },
            guest_id: (0, tools_1.stringField)({ required: true }),
            room: (0, tools_1.stringField)({ required: true }),
            text: (0, tools_1.stringField)({ required: false }),
            type: { type: 'string', enum: ['food', 'beverage', 'maintenance'], required: false },
            items: {
                type: 'array',
                required: false,
                items: {
                    type: 'object',
                    properties: {
                        name: (0, tools_1.stringField)({ required: true }),
                        qty: (0, tools_1.numberField)({ required: false, min: 1, default: 1 }),
                        price: (0, tools_1.numberField)({ required: false, min: 0 }),
                    },
                    required: ['name'],
                },
            },
            notes: (0, tools_1.stringField)({ required: false }),
            priority: {
                type: 'string',
                enum: ['low', 'normal', 'high'],
                required: false,
                default: 'normal',
            },
            now: (0, tools_1.stringField)({ required: false, description: 'ISO datetime' }),
            do_not_disturb: (0, tools_1.booleanField)({ required: false }),
            guest_profile: {
                type: 'object',
                required: false,
                properties: {
                    tier: {
                        type: 'string',
                        enum: ['standard', 'gold', 'platinum'],
                        required: false,
                        default: 'standard',
                    },
                    daily_spend: (0, tools_1.numberField)({ required: false, min: 0, default: 0 }),
                    spend_limit: (0, tools_1.numberField)({ required: false, min: 1, default: 200 }),
                },
            },
            access_window: {
                type: 'object',
                required: false,
                properties: {
                    start: (0, tools_1.stringField)({ required: true, description: 'HH:MM:SS' }),
                    end: (0, tools_1.stringField)({ required: true, description: 'HH:MM:SS' }),
                },
                required: ['start', 'end'],
            },
            issue: (0, tools_1.stringField)({ required: false }),
            severity: { type: 'string', enum: ['low', 'medium', 'high'], required: false },
            request_id: (0, tools_1.stringField)({ required: false }),
        },
        config: {
            accessWindowStart: (0, tools_1.stringField)({ required: false }),
            accessWindowEnd: (0, tools_1.stringField)({ required: false }),
            api_key: (0, tools_1.apiKeyField)({ required: false, description: 'API key opcional' }),
            default_count: {
                type: 'number',
                required: false,
                default: 1,
                description: 'Compatibilidad con template; no se usa en este agente',
            },
        },
    },
    // 3) EXECUTE
    async execute(input, config, context) {
        const { action = 'create', guest_id, room, text, items, notes, priority = 'normal', type: explicitType, now, do_not_disturb, guest_profile, access_window, issue, severity, request_id, } = input;
        if (!guest_id || !room) {
            return {
                status: 'error',
                error: { code: 'VALIDATION_ERROR', message: 'guest_id y room son requeridos' },
            };
        }
        try {
            // --- CREATE ---
            if (action === 'create') {
                const type = classify(text, items, explicitType);
                const area = mapArea(type);
                if (type === 'food' || type === 'beverage') {
                    const okWindow = withinWindow(now, access_window, {
                        start: config.accessWindowStart,
                        end: config.accessWindowEnd,
                    }, do_not_disturb);
                    if (!okWindow) {
                        return {
                            status: 'error',
                            error: { code: 'ACCESS_WINDOW_BLOCK', message: 'Fuera de ventana o DND activo' },
                        };
                    }
                    const spend = enforceSpend(items, guest_profile);
                    if (!spend.ok) {
                        return {
                            status: 'error',
                            error: { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' },
                        };
                    }
                }
                if (type === 'maintenance' && !issue) {
                    return {
                        status: 'error',
                        error: { code: 'MISSING_ISSUE', message: 'Describe el issue de mantenimiento' },
                    };
                }
                const id = `REQ-${Date.now()}`;
                // CREADO
                await dbCreateTicket({
                    id,
                    guest_id,
                    room,
                    type,
                    area,
                    items,
                    notes,
                    priority,
                    status: 'CREADO',
                });
                await dbAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });
                // ACEPTADA (auto)
                await dbUpdateTicket(id, { status: 'ACEPTADA' });
                await dbAddHistory({ request_id: id, status: 'ACEPTADA', actor: area });
                const suggestions = type !== 'maintenance' ? crossSell(items) : [];
                return {
                    status: 'success',
                    data: { request_id: id, type, area, status: 'ACEPTADA', suggestions },
                };
            }
            // --- Acciones que requieren request_id ---
            if (!request_id) {
                return {
                    status: 'error',
                    error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' },
                };
            }
            const t = await dbGetTicket(request_id);
            if (!t) {
                return { status: 'error', error: { code: 'NOT_FOUND', message: 'No existe el ticket' } };
            }
            if (action === 'status') {
                await dbUpdateTicket(request_id, { status: 'EN_PROCESO' });
                await dbAddHistory({ request_id, status: 'EN_PROCESO', actor: t.area });
                return {
                    status: 'success',
                    data: { request_id, type: t.type, area: t.area, status: 'EN_PROCESO' },
                };
            }
            if (action === 'complete') {
                await dbUpdateTicket(request_id, { status: 'COMPLETADA' });
                await dbAddHistory({ request_id, status: 'COMPLETADA', actor: t.area });
                return {
                    status: 'success',
                    data: { request_id, type: t.type, area: t.area, status: 'COMPLETADA' },
                };
            }
            if (action === 'assign') {
                const newArea = mapArea(t.type); // aquí podrías decidir reasignar diferente si lo deseas
                await dbUpdateTicket(request_id, { area: newArea });
                await dbAddHistory({
                    request_id,
                    status: t.status,
                    actor: newArea,
                    note: 'Reassigned',
                });
                return {
                    status: 'success',
                    data: { request_id, type: t.type, area: newArea, status: t.status },
                };
            }
            if (action === 'feedback') {
                await dbAddHistory({
                    request_id,
                    status: t.status,
                    actor: 'guest',
                    note: 'Feedback',
                });
                return {
                    status: 'success',
                    data: {
                        request_id,
                        type: t.type,
                        area: t.area,
                        status: t.status,
                        message: 'Feedback recibido',
                    },
                };
            }
            return { status: 'error', error: { code: 'UNKNOWN_ACTION', message: 'Acción no soportada' } };
        }
        catch (e) {
            // eslint-disable-next-line no-console
            console.error('DB error:', e?.message || e);
            return {
                status: 'error',
                error: { code: 'INTERNAL_DB_ERROR', message: String(e?.message || e) },
            };
        }
    },
});
/* =======================
   Arranque del servidor
   ======================= */
async function main() {
    try {
        await tool.start({
            port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
            host: process.env.HOST || '0.0.0.0',
            development: {
                requestLogging: process.env.NODE_ENV === 'development',
            },
            security: {
                requireAuth: process.env.API_KEY_AUTH === 'true',
                ...(process.env.VALID_API_KEYS && {
                    apiKeys: process.env.VALID_API_KEYS.split(','),
                }),
            },
        });
        console.log('🚀 Agent-03 tool server started');
        console.log(`🔗 Health:  http://localhost:${process.env.PORT || 3000}/health`);
        console.log(`🔗 Execute: http://localhost:${process.env.PORT || 3000}/api/execute`);
    }
    catch (error) {
        console.error('Failed to start tool server:', error);
        process.exit(1);
    }
}
// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 SIGINT -> shutting down...');
    await tool.stop();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('🔄 SIGTERM -> shutting down...');
    await tool.stop();
    process.exit(0);
});
if (require.main === module) {
    main();
}
exports.default = tool;
//# sourceMappingURL=index.js.map