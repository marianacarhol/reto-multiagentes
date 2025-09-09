/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant, Split Tables)
 * v2.1.0
 *
 * - Menús separados por restaurante (rest1/rest2) + vista menu_union
 */

import 'dotenv/config';
import {
  createTool,
  stringField,
  numberField,
  booleanField,
  apiKeyField,
} from '@ai-spine/tools';
import { createClient } from '@supabase/supabase-js';

/* =======================
   Tipos de entrada/config
   ======================= */
type TicketStatus = 'CREADO' | 'ACEPTADA' | 'EN_PROCESO' | 'COMPLETADA';

interface AgentInput {
  action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service';

  // Identidad básica
  guest_id: string;
  room: string;

  // Room Service
  restaurant?: 'rest1' | 'rest2'; // requerido si type=food|beverage
  type?: ServiceType;
  items?: Array<{ id?: string; name: string; qty?: number; price?: number; restaurant?: 'rest1'|'rest2' }>;

  // Mantenimiento
  issue?: string;
  severity?: 'low'|'medium'|'high';

  // Comunes
  text?: string;
  notes?: string;
  priority?: 'low'|'normal'|'high';

  now?: string;
  do_not_disturb?: boolean;
  guest_profile?: {
    tier?: 'standard' | 'gold' | 'platinum';
    daily_spend?: number;
    spend_limit?: number;
    preferences?: string[];
  };
  access_window?: { start: string; end: string };

  // Transiciones
  request_id?: string;

  // Confirmación/Feedback
  service_rating?: number;      // 1-5
  service_feedback?: string;
  service_completed_by?: string;

  // Filtros get_menu
  menu_category?: 'food'|'beverage'|'dessert';
}

interface AgentConfig {
  accessWindowStart?: string;
  accessWindowEnd?: string;
  //enable_stock_check?: boolean;
  enable_cross_sell?: boolean;
  cross_sell_threshold?: number;
  api_key?: string;       // compat
  default_count?: number; // compat
}

// ============ Supabase ============
const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? ''
);


/* =======================
   Utilidades de dominio
   ======================= */
const nowISO = () => new Date().toISOString();

const classify = (
  text?: string,
  items?: Array<{ name: string }>,
  explicit?: 'food' | 'beverage' | 'maintenance'
): 'food' | 'beverage' | 'maintenance' => {
  if (explicit) return explicit;
  const blob = `${text ?? ''} ${(items ?? []).map(i => i.name).join(' ')}`.toLowerCase();
  if (/(repair|leak|broken|fuga|mantenimiento|plomer|reparar)/i.test(blob)) return 'maintenance';
  if (/(beer|vino|coca|bebida|agua|jugo|drink)/i.test(blob)) return 'beverage';
  return 'food';
};

const mapArea = (t: 'food' | 'beverage' | 'maintenance') =>
  t === 'maintenance' ? 'maintenance' : t === 'beverage' ? 'bar' : 'kitchen';

const withinWindow = (
  nowStr: string | undefined,
  win: { start: string; end: string } | undefined,
  cfg: { start?: string; end?: string },
  dnd?: boolean
) => {
  if (dnd) return false;
  const start = win?.start ?? cfg.start;
  const end = win?.end ?? cfg.end;
  if (!start || !end) return true;
  const now = nowStr ? new Date(nowStr) : new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const cur = `${hh}:${mm}:${ss}`;
  return start <= cur && cur <= end;
};

const enforceSpend = (
  items?: Array<{ qty?: number; price?: number }>,
  profile?: { daily_spend?: number; spend_limit?: number }
) => {
  const total = (items ?? []).reduce((a, i) => a + (i.price ?? 0) * (i.qty ?? 1), 0);
  const daily = profile?.daily_spend ?? 0;
  const limit = profile?.spend_limit ?? Infinity;
  return { ok: daily + total <= limit, total };
};

// menú: vista unificada
type MenuRow = {
  restaurant: 'rest1'|'rest2';
  id: string;
  name: string;
  price: number;
  category: 'food'|'beverage'|'dessert';
  available_start: string; // HH:MM:SS
  available_end: string;   // HH:MM:SS
  stock_current: number;
  stock_minimum: number;
  is_active: boolean;
  cross_sell_items: string[]; // array de ids
};

async function dbMenuUnion(): Promise<MenuRow[]> {
  const { data, error } = await supabase.from('menu_union').select('*');
  if (error) throw error;
  return (data ?? []) as any;
}


async function dbCreateTicket(t: {
  id: string;
  guest_id: string;
  room: string;
  type: string;
  area: string;
  items?: any;
  notes?: string;
  priority?: string;
  status: TicketStatus;
}) {
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
  if (error) throw error;
}

async function dbUpdateTicket(
  id: string,
  patch: Partial<{ status: TicketStatus; area: string; notes: string }>
) {
  const { error } = await supabase
    .from('tickets')
    .update({ ...patch, updated_at: nowISO() })
    .eq('id', id);
  if (error) throw error;
}

async function dbGetTicket(id: string) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data as
    | {
        id: string;
        guest_id: string;
        room: string;
        type: 'food' | 'beverage' | 'maintenance';
        area: string;
        status: TicketStatus;
        items?: any;
        notes?: string;
        priority?: string;
      }
    | null;
}

async function dbAddHistory(rec: {
  request_id: string;
  status: TicketStatus | string;
  actor: string;
  note?: string;
}) {
  const { error } = await supabase.from('ticket_history').insert({
    request_id: rec.request_id,
    status: rec.status,
    actor: rec.actor,
    note: rec.note ?? null,
    ts: nowISO(),
  });
  if (error) throw error;
}

/* =======================
   Implementación del Tool
   ======================= */
const tool = createTool<AgentInput, AgentConfig>({
  // 1) METADATA
  metadata: {
    name: 'agent-03-roomservice-maintenance',
    version: '1.0.0',
    description:
      'Agente 3: Room Service (A&B) y Mantenimiento. Orquesta pedidos A&B y tickets de mantenimiento con políticas de horario, límite de gasto y escalamiento.',
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
      guest_id: stringField({ required: true }),
      room: stringField({ required: true }),
      text: stringField({ required: false }),
      type: { type: 'string', enum: ['food', 'beverage', 'maintenance'], required: false },
      items: {
        type: 'array',
        required: false,
        items: {
          type: 'object',
          properties: {
            name: stringField({ required: true }),
            qty: numberField({ required: false, min: 1, default: 1 }),
            price: numberField({ required: false, min: 0 }),
          },
          required: ['name'],
        },
      },
      notes: stringField({ required: false }),
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        required: false,
        default: 'normal',
      },

      now: stringField({ required: false, description: 'ISO datetime' }),
      do_not_disturb: booleanField({ required: false }),
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
          daily_spend: numberField({ required: false, min: 0, default: 0 }),
          spend_limit: numberField({ required: false, min: 1, default: 200 }),
        },
      },
      access_window: {
        type: 'object',
        required: false,
        properties: {
          start: stringField({ required: true, description: 'HH:MM:SS' }),
          end: stringField({ required: true, description: 'HH:MM:SS' }),
        },
        required: ['start', 'end'],
      },

      issue: stringField({ required: false }),
      severity: { type: 'string', enum: ['low', 'medium', 'high'], required: false },

      request_id: stringField({ required: false }),
    },

    config: {
      accessWindowStart: stringField({ required: false }),
      accessWindowEnd: stringField({ required: false }),
      api_key: apiKeyField({ required: false, description: 'API key opcional' }),
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
    const {
      action = 'create',
      guest_id,
      room,
      text,
      items,
      notes,
      priority = 'normal',
      type: explicitType,
      now,
      do_not_disturb,
      guest_profile,
      access_window,
      issue,
      severity,
      request_id,
    } = input;

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
          const okWindow = withinWindow(
            now,
            access_window,
            {
              start: config.accessWindowStart,
              end: config.accessWindowEnd,
            },
            do_not_disturb
          );
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
    } catch (e: any) {
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
  } catch (error) {
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

export default tool;