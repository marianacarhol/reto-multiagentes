"use strict";
/**
 * Agent-03 RoomService & Maintenance Tool (Enhanced Version) - CORREGIDO
 *
 * Funcionalidades completas:
 * - Menús dinámicos por hora/stock
 * - Cross-sell inteligente
 * - Confirmación de servicios
 * - Gestión de stock
 * - Políticas avanzadas
 *
 * @fileoverview Enhanced implementation for agent-03-roomservice-maintenance
 * @since 2.0.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const tools_1 = require("@ai-spine/tools");
// Importación dinámica de Supabase
let createClient;
try {
    const supabaseModule = require('@supabase/supabase-js');
    createClient = supabaseModule.createClient;
}
catch (error) {
    console.warn('Supabase not available:', error);
    createClient = () => ({
        from: () => ({
            insert: () => ({ error: null }),
            update: () => ({ error: null }),
            select: () => ({ data: null, error: null }),
        })
    });
}
/* =======================
   Cliente Supabase
   ======================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('⚠️  Falta configuración de Supabase en .env');
}
const supabase = createClient(SUPABASE_URL ?? '', SUPABASE_SERVICE_ROLE ?? '');
/* =======================
   Base de datos de menús (simulada)
   En producción, esto vendría de Supabase
   ======================= */
const MENU_ITEMS = [
    // FOOD
    {
        id: 'f001',
        name: 'Hamburguesa Clásica',
        price: 15.99,
        category: 'food',
        available_start: '12:00',
        available_end: '23:30',
        stock_current: 25,
        stock_minimum: 5,
        cross_sell_items: ['d001', 'b002'] // brownie, coca-cola
    },
    {
        id: 'f002',
        name: 'Pizza Margarita',
        price: 18.50,
        category: 'food',
        available_start: '18:00',
        available_end: '23:00',
        stock_current: 12,
        stock_minimum: 3,
        cross_sell_items: ['b001', 'b003'] // vino tinto, agua mineral
    },
    {
        id: 'f003',
        name: 'Ensalada César',
        price: 12.75,
        category: 'food',
        available_start: '11:00',
        available_end: '22:00',
        stock_current: 30,
        stock_minimum: 8,
        cross_sell_items: ['b003', 'b004'] // agua mineral, jugo natural
    },
    // BEVERAGES
    {
        id: 'b001',
        name: 'Vino Tinto Casa',
        price: 8.99,
        category: 'beverage',
        available_start: '17:00',
        available_end: '02:00',
        stock_current: 40,
        stock_minimum: 10,
        cross_sell_items: ['f002'] // pizza
    },
    {
        id: 'b002',
        name: 'Coca-Cola',
        price: 3.50,
        category: 'beverage',
        available_start: '06:00',
        available_end: '23:59',
        stock_current: 100,
        stock_minimum: 20,
        cross_sell_items: ['f001'] // hamburguesa
    },
    {
        id: 'b003',
        name: 'Agua Mineral',
        price: 2.25,
        category: 'beverage',
        available_start: '00:00',
        available_end: '23:59',
        stock_current: 150,
        stock_minimum: 30,
        cross_sell_items: ['f003'] // ensalada
    },
    {
        id: 'b004',
        name: 'Jugo Natural Naranja',
        price: 4.75,
        category: 'beverage',
        available_start: '06:00',
        available_end: '14:00',
        stock_current: 20,
        stock_minimum: 5,
        cross_sell_items: ['f003'] // ensalada
    },
    // DESSERTS
    {
        id: 'd001',
        name: 'Brownie con Helado',
        price: 6.99,
        category: 'food',
        available_start: '12:00',
        available_end: '23:30',
        stock_current: 18,
        stock_minimum: 4,
        cross_sell_items: ['b002'] // coca-cola
    }
];
/* =======================
   Utilidades mejoradas
   ======================= */
const nowISO = () => new Date().toISOString();
const getCurrentTime = (nowStr) => {
    const now = nowStr ? new Date(nowStr) : new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
};
const isTimeInRange = (current, start, end) => {
    // Maneja casos donde el rango cruza medianoche
    if (start <= end) {
        return current >= start && current <= end;
    }
    else {
        return current >= start || current <= end;
    }
};
const getAvailableMenu = (category, now, enableStockCheck = true) => {
    const currentTime = getCurrentTime(now);
    return MENU_ITEMS.filter(item => {
        // Filtrar por categoría si se especifica
        if (category && item.category !== category)
            return false;
        // Verificar horario de disponibilidad
        if (!isTimeInRange(currentTime, item.available_start, item.available_end))
            return false;
        // Verificar stock si está habilitado
        if (enableStockCheck && item.stock_current <= item.stock_minimum)
            return false;
        return true;
    });
};
const getIntelligentCrossSell = (selectedItems, guestPreferences = []) => {
    const selectedIds = selectedItems
        .map(item => item.id)
        .filter(Boolean);
    if (selectedIds.length === 0)
        return [];
    // Encontrar items de cross-sell basados en selección actual
    const crossSellIds = new Set();
    selectedIds.forEach(selectedId => {
        const item = MENU_ITEMS.find(i => i.id === selectedId);
        if (item) {
            item.cross_sell_items.forEach(id => crossSellIds.add(id));
        }
    });
    // Filtrar por preferencias del huésped y disponibilidad
    const suggestions = Array.from(crossSellIds)
        .map(id => MENU_ITEMS.find(i => i.id === id))
        .filter(Boolean);
    // Priorizar por preferencias del huésped
    return suggestions.sort((a, b) => {
        const aPreferred = guestPreferences.some(pref => a.name.toLowerCase().includes(pref.toLowerCase()));
        const bPreferred = guestPreferences.some(pref => b.name.toLowerCase().includes(pref.toLowerCase()));
        if (aPreferred && !bPreferred)
            return -1;
        if (!aPreferred && bPreferred)
            return 1;
        return 0;
    }).slice(0, 3); // Máximo 3 sugerencias
};
const classify = (text, items, explicit) => {
    if (explicit)
        return explicit;
    const content = `${text ?? ''} ${(items ?? []).map(i => i.name).join(' ')}`.toLowerCase();
    // Patrones más específicos para mantenimiento
    if (/(repair|leak|broken|fuga|mantenimiento|plomer|reparar|aire acondicionado|tv|luz|calefacción|ducha|inodoro)/i.test(content)) {
        return 'maintenance';
    }
    // Patrones para bebidas
    if (/(beer|vino|coca|bebida|agua|jugo|drink|cerveza|whiskey|ron|vodka|cocktail)/i.test(content)) {
        return 'beverage';
    }
    return 'food';
};
const mapArea = (type) => {
    switch (type) {
        case 'maintenance': return 'maintenance';
        case 'beverage': return 'bar';
        case 'food': return 'kitchen';
        default: return 'kitchen';
    }
};
const withinWindow = (nowStr, window, config, dnd) => {
    if (dnd)
        return false;
    const start = window?.start ?? config.start;
    const end = window?.end ?? config.end;
    if (!start || !end)
        return true;
    const currentTime = getCurrentTime(nowStr);
    return isTimeInRange(currentTime, start, end);
};
const enforceSpend = (items, profile) => {
    const total = (items ?? []).reduce((acc, item) => acc + (item.price ?? 0) * (item.qty ?? 1), 0);
    const daily = profile?.daily_spend ?? 0;
    const limit = profile?.spend_limit ?? Infinity;
    return {
        ok: daily + total <= limit,
        total,
        remainingBudget: limit - daily
    };
};
const updateStock = async (items) => {
    // En producción, esto actualizaría la base de datos
    // Por ahora, actualizamos el array en memoria
    items.forEach(item => {
        if (item.id) {
            const menuItem = MENU_ITEMS.find(m => m.id === item.id);
            if (menuItem) {
                menuItem.stock_current -= (item.qty ?? 1);
            }
        }
    });
};
/* =======================
   Funciones de base de datos (sin cambios)
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
const generateConfirmationMessage = (type, status) => {
    const messages = {
        food: {
            'EN_PROCESO': 'Su pedido está siendo preparado en cocina. Tiempo estimado: 25-30 minutos.',
            'COMPLETADA': 'Su pedido ha sido entregado. ¡Esperamos que disfrute su comida!'
        },
        beverage: {
            'EN_PROCESO': 'Su pedido de bebidas está siendo preparado en el bar. Tiempo estimado: 10-15 minutos.',
            'COMPLETADA': '¡Sus bebidas han sido entregadas! Que las disfrute.'
        },
        maintenance: {
            'EN_PROCESO': 'Nuestro equipo de mantenimiento está atendiendo su solicitud.',
            'COMPLETADA': 'El problema de mantenimiento ha sido resuelto. Gracias por su paciencia.'
        }
    };
    return messages[type]?.[status] ?? 'Estado actualizado correctamente.';
};
/* =======================
   Tool principal mejorado
   ======================= */
const tool = (0, tools_1.createTool)({
    metadata: {
        name: 'agent-03-roomservice-maintenance-enhanced',
        version: '2.0.0',
        description: 'Agente Room Service y Mantenimiento con menús dinámicos, cross-sell inteligente y confirmación de servicios',
        capabilities: [
            'dynamic-menu',
            'intelligent-cross-sell',
            'stock-management',
            'service-confirmation',
            'advanced-policies'
        ],
        author: 'Equipo A3',
        license: 'MIT',
    },
    schema: {
        input: {
            action: {
                type: 'string',
                enum: ['create', 'assign', 'status', 'complete', 'feedback', 'get_menu', 'confirm_service'],
                default: 'create',
                required: false,
            },
            guest_id: (0, tools_1.stringField)({ required: true }),
            room: (0, tools_1.stringField)({ required: true }),
            text: (0, tools_1.stringField)({ required: false }),
            type: {
                type: 'string',
                required: false,
                enum: ['food', 'beverage', 'maintenance'],
            },
            items: {
                type: 'array',
                required: false,
                items: {
                    type: 'object',
                    required: false,
                    properties: {
                        name: {
                            type: 'string',
                            required: true,
                        },
                        id: {
                            type: 'string',
                            required: false,
                        },
                        qty: {
                            type: 'number',
                            required: false,
                            default: 1,
                        },
                        price: {
                            type: 'number',
                            required: false,
                        },
                    },
                },
            },
            notes: {
                type: 'string',
                required: false,
            },
            priority: {
                type: 'string',
                enum: ['low', 'normal', 'high'],
                required: false,
                default: 'normal',
            },
            now: {
                type: 'string',
                required: false,
            },
            do_not_disturb: {
                type: 'boolean',
                required: false,
            },
            guest_profile: {
                type: 'object',
                required: false,
                properties: {
                    tier: {
                        type: 'string',
                        enum: ['standard', 'gold', 'platinum'],
                        required: false,
                    },
                    daily_spend: {
                        type: 'number',
                        required: false,
                    },
                    spend_limit: {
                        type: 'number',
                        required: false,
                    },
                    preferences: {
                        type: 'array',
                        required: false,
                        items: {
                            type: 'string',
                            required: false,
                        }
                    }
                },
            },
            access_window: {
                type: 'object',
                required: false,
                properties: {
                    start: {
                        type: 'string',
                        required: true,
                    },
                    end: {
                        type: 'string',
                        required: true,
                    },
                },
            },
            issue: {
                type: 'string',
                required: false,
            },
            severity: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                required: false
            },
            request_id: {
                type: 'string',
                required: false,
            },
            service_rating: {
                type: 'number',
                required: false,
            },
            service_feedback: {
                type: 'string',
                required: false,
            },
            service_completed_by: {
                type: 'string',
                required: false,
            },
        },
        config: {
            accessWindowStart: {
                type: 'string',
                required: false,
            },
            accessWindowEnd: {
                type: 'string',
                required: false,
            },
            api_key: {
                type: 'string',
                required: false,
            },
            default_count: {
                type: 'number',
                required: false,
                default: 1,
            },
            enable_stock_check: {
                type: 'boolean',
                required: false,
                default: true,
            },
            enable_cross_sell: {
                type: 'boolean',
                required: false,
                default: true,
            },
            cross_sell_threshold: {
                type: 'number',
                required: false,
                default: 1,
            },
        }
    },
    async execute(input, config) {
        const { action = 'create', guest_id, room } = input;
        if (typeof guest_id !== 'string' || !guest_id || typeof room !== 'string' || !room) {
            return {
                status: 'error',
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'guest_id y room son requeridos y deben ser cadenas de texto no vacías',
                    type: 'validation_error'
                },
            };
        }
        try {
            // --- GET MENU ---
            if (action === 'get_menu') {
                const { type: menuType, now } = input;
                const availableMenu = getAvailableMenu(menuType, now, config.enable_stock_check);
                return {
                    status: 'success',
                    data: {
                        menu: availableMenu,
                        current_time: getCurrentTime(now),
                        total_items: availableMenu.length,
                        categories: [...new Set(availableMenu.map(i => i.category))]
                    }
                };
            }
            // --- CREATE (mejorado) ---
            if (action === 'create') {
                const { text, items, notes, priority = 'normal', type: explicitType, now, do_not_disturb, guest_profile, access_window, issue } = input;
                const type = classify(text, items, explicitType);
                const area = mapArea(type);
                // Validaciones mejoradas para food/beverage
                if (type === 'food' || type === 'beverage') {
                    const configWindow = {
                        start: config.accessWindowStart,
                        end: config.accessWindowEnd,
                    };
                    if (!withinWindow(now, access_window, configWindow, do_not_disturb)) {
                        return {
                            status: 'error',
                            error: {
                                code: 'ACCESS_WINDOW_BLOCK',
                                message: 'Fuera de ventana de servicio o DND activo',
                                type: 'validation_error'
                            },
                        };
                    }
                    const spend = enforceSpend(items, guest_profile);
                    if (!spend.ok) {
                        return {
                            status: 'error',
                            error: {
                                code: 'SPEND_LIMIT',
                                message: `Límite de gasto excedido. Presupuesto restante: $${spend.remainingBudget}`,
                                type: 'validation_error'
                            },
                        };
                    }
                    // Verificar disponibilidad de items en menú
                    if (config.enable_stock_check && items) {
                        const unavailableItems = items.filter(item => {
                            const menuItem = MENU_ITEMS.find(m => m.name.toLowerCase() === item.name.toLowerCase() &&
                                (m.stock_current <= m.stock_minimum ||
                                    !isTimeInRange(getCurrentTime(now), m.available_start, m.available_end)));
                            return menuItem;
                        });
                        if (unavailableItems.length > 0) {
                            return {
                                status: 'error',
                                error: {
                                    code: 'ITEMS_UNAVAILABLE',
                                    message: `Items no disponibles: ${unavailableItems.map(i => i.name).join(', ')}`,
                                    type: 'validation_error'
                                }
                            };
                        }
                    }
                }
                if (type === 'maintenance' && !issue) {
                    return {
                        status: 'error',
                        error: {
                            code: 'MISSING_ISSUE',
                            message: 'Descripción del problema de mantenimiento es requerida',
                            type: 'validation_error'
                        },
                    };
                }
                const id = `REQ-${Date.now()}`;
                await dbCreateTicket({
                    id,
                    guest_id,
                    room,
                    type,
                    area,
                    items: items ? JSON.stringify(items) : null,
                    notes: notes ?? '',
                    priority,
                    status: 'CREADO',
                });
                await dbAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });
                // Auto-aceptar
                await dbUpdateTicket(id, { status: 'ACEPTADA' });
                await dbAddHistory({ request_id: id, status: 'ACEPTADA', actor: area });
                // Actualizar stock si aplica
                if (items && config.enable_stock_check) {
                    await updateStock(items);
                }
                // Generar cross-sell inteligente
                let suggestions = [];
                if (config.enable_cross_sell && type !== 'maintenance' && items) {
                    suggestions = getIntelligentCrossSell(items, guest_profile?.preferences);
                }
                return {
                    status: 'success',
                    data: {
                        request_id: id,
                        type,
                        area,
                        status: 'ACEPTADA',
                        estimated_time: type === 'food' ? '25-30 min' : type === 'beverage' ? '10-15 min' : 'Variable',
                        total_cost: items ? items.reduce((acc, item) => acc + (item.price ?? 0) * (item.qty ?? 1), 0) : 0,
                        cross_sell_suggestions: suggestions.map(s => ({
                            name: s.name,
                            price: s.price,
                            category: s.category
                        }))
                    },
                };
            }
            // --- CONFIRM SERVICE (nueva funcionalidad) ---
            if (action === 'confirm_service') {
                const { request_id, service_rating, service_feedback, service_completed_by } = input;
                if (!request_id) {
                    return {
                        status: 'error',
                        error: {
                            code: 'MISSING_REQUEST_ID',
                            message: 'request_id es requerido',
                            type: 'validation_error'
                        },
                    };
                }
                const ticket = await dbGetTicket(request_id);
                if (!ticket) {
                    return {
                        status: 'error',
                        error: {
                            code: 'NOT_FOUND',
                            message: 'Ticket no encontrado',
                            type: 'validation_error'
                        }
                    };
                }
                // Actualizar ticket con confirmación de servicio
                const updates = { status: 'COMPLETADA' };
                if (service_rating) {
                    updates.completion_rating = service_rating;
                }
                await dbUpdateTicket(request_id, updates);
                await dbAddHistory({
                    request_id,
                    status: 'COMPLETADA',
                    actor: service_completed_by || 'staff',
                    note: service_feedback ? `Rating: ${service_rating}/5. Feedback: ${service_feedback}` : `Servicio confirmado. Rating: ${service_rating}/5`
                });
                return {
                    status: 'success',
                    data: {
                        request_id,
                        status: 'COMPLETADA',
                        confirmation: 'Servicio confirmado exitosamente',
                        rating_received: service_rating,
                        thank_you_message: '¡Gracias por su calificación! Su opinión es muy valiosa para nosotros.'
                    }
                };
            }
            // --- Resto de acciones (status, complete, feedback, assign) ---
            if (!input.request_id) {
                return {
                    status: 'error',
                    error: {
                        code: 'MISSING_REQUEST_ID',
                        message: 'request_id es requerido para esta acción',
                        type: 'validation_error'
                    },
                };
            }
            const ticket = await dbGetTicket(input.request_id);
            if (!ticket) {
                return {
                    status: 'error',
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Ticket no encontrado',
                        type: 'validation_error'
                    }
                };
            }
            if (action === 'status') {
                await dbUpdateTicket(input.request_id, { status: 'EN_PROCESO' });
                await dbAddHistory({
                    request_id: input.request_id,
                    status: 'EN_PROCESO',
                    actor: ticket.area
                });
                return {
                    status: 'success',
                    data: {
                        request_id: input.request_id,
                        type: ticket.type,
                        area: ticket.area,
                        status: 'EN_PROCESO',
                        confirmation: generateConfirmationMessage(ticket.type, 'EN_PROCESO')
                    },
                };
            }
            if (action === 'complete') {
                await dbUpdateTicket(input.request_id, { status: 'COMPLETADA' });
                await dbAddHistory({
                    request_id: input.request_id,
                    status: 'COMPLETADA',
                    actor: ticket.area
                });
                return {
                    status: 'success',
                    data: {
                        request_id: input.request_id,
                        type: ticket.type,
                        area: ticket.area,
                        status: 'COMPLETADA',
                        confirmation: generateConfirmationMessage(ticket.type, 'COMPLETADA'),
                        message: 'Servicio completado. Por favor califique su experiencia.'
                    },
                };
            }
            if (action === 'assign') {
                const newArea = mapArea(ticket.type);
                await dbUpdateTicket(input.request_id, { area: newArea });
                await dbAddHistory({
                    request_id: input.request_id,
                    status: ticket.status,
                    actor: newArea,
                    note: 'Ticket reasignado a departamento especializado',
                });
                return {
                    status: 'success',
                    data: {
                        request_id: input.request_id,
                        type: ticket.type,
                        area: newArea,
                        status: ticket.status,
                        message: `Ticket reasignado exitosamente a: ${newArea}`,
                        estimated_resolution: getEstimatedResolution(ticket.type, ticket.priority)
                    },
                };
            }
            if (action === 'feedback') {
                await dbAddHistory({
                    request_id: input.request_id,
                    status: ticket.status,
                    actor: 'guest',
                    note: input.notes || 'Feedback del huésped recibido',
                });
                // Si es feedback negativo, escalar prioridad
                const isNegativeFeedback = input.service_rating && input.service_rating <= 2;
                if (isNegativeFeedback && ticket.status !== 'COMPLETADA') {
                    await dbUpdateTicket(input.request_id, {
                        priority: 'high',
                        notes: `${ticket.notes || ''}\n[ESCALADO] Feedback negativo recibido: ${input.service_feedback || 'Sin detalles'}`
                    });
                    await dbAddHistory({
                        request_id: input.request_id,
                        status: 'ESCALADO',
                        actor: 'system',
                        note: `Ticket escalado por feedback negativo (Rating: ${input.service_rating}/5)`
                    });
                }
                return {
                    status: 'success',
                    data: {
                        request_id: input.request_id,
                        type: ticket.type,
                        area: ticket.area,
                        status: ticket.status,
                        message: 'Gracias por su feedback. Su opinión nos ayuda a mejorar nuestros servicios.',
                        feedbackReceived: true,
                        escalated: isNegativeFeedback && ticket.status !== 'COMPLETADA'
                    },
                };
            }
            return {
                status: 'error',
                error: {
                    code: 'UNKNOWN_ACTION',
                    message: 'Acción no soportada',
                    type: 'validation_error'
                }
            };
        }
        catch (e) {
            console.error('Error en ejecución:', e?.message || e);
            return {
                status: 'error',
                error: {
                    code: 'INTERNAL_ERROR',
                    message: String(e?.message || e),
                    type: 'execution_error'
                },
            };
        }
    },
});
/* =======================
   Funciones auxiliares adicionales
   ======================= */
const getEstimatedResolution = (type, priority) => {
    const baseTimes = {
        food: priority === 'high' ? '15-20 min' : '25-30 min',
        beverage: priority === 'high' ? '5-10 min' : '10-15 min',
        maintenance: priority === 'high' ? '30-60 min' : '2-4 horas'
    };
    return baseTimes[type];
};
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
        console.log('🚀 Agent-03 Enhanced Room Service & Maintenance Tool started');
        console.log('📋 Nuevas funcionalidades:');
        console.log('   ✅ Menús dinámicos por horario y stock');
        console.log('   ✅ Cross-sell inteligente basado en preferencias');
        console.log('   ✅ Confirmación de servicios con rating');
        console.log('   ✅ Escalamiento automático por feedback negativo');
        console.log('   ✅ Gestión avanzada de stock');
        console.log(`🔗 Health:  http://localhost:${process.env.PORT || 3000}/health`);
        console.log(`🔗 Execute: http://localhost:${process.env.PORT || 3000}/api/execute`);
        console.log(`🔗 Menu:    http://localhost:${process.env.PORT || 3000}/api/execute (action: get_menu)`);
    }
    catch (error) {
        console.error('Failed to start enhanced tool server:', error);
        process.exit(1);
    }
}
// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 SIGINT -> shutting down enhanced agent...');
    await tool.stop();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('🔄 SIGTERM -> shutting down enhanced agent...');
    await tool.stop();
    process.exit(0);
});
if (require.main === module) {
    main();
}
exports.default = tool;
//# sourceMappingURL=index.js.map