/**
 * Agent-03 RoomService & Maintenance Tool
 *
 * AI Spine tool que orquesta pedidos de A&B y tickets de mantenimiento:
 * - Clasificación (food | beverage | maintenance)
 * - Políticas (ventana de acceso, DND, límite de gasto)
 * - Despacho/estado e historial básico (in-memory demo)
 *
 * @fileoverview Main tool implementation for agent-03-roomservice-maintenance
 * @author
 * @since 1.0.0
 */

import {
  createTool,
  stringField,
  numberField,
  booleanField,
  apiKeyField,
} from '@ai-spine/tools';

/* =======================
   Tipos de entrada/config
   ======================= */
interface AgentInput {
  action?: 'create' | 'assign' | 'status' | 'complete' | 'feedback';
  guest_id: string;
  room: string;
  text?: string;
  type?: 'food' | 'beverage' | 'maintenance';
  items?: Array<{ name: string; qty?: number; price?: number }>;
  notes?: string;
  priority?: 'low' | 'normal' | 'high';

  now?: string; // ISO datetime
  do_not_disturb?: boolean;
  guest_profile?: {
    tier?: 'standard' | 'gold' | 'platinum';
    daily_spend?: number;
    spend_limit?: number;
  };
  access_window?: { start: string; end: string }; // HH:MM:SS

  // mantenimiento
  issue?: string;
  severity?: 'low' | 'medium' | 'high';

  // requerido para acciones != create
  request_id?: string;
}

interface AgentConfig {
  // overrides opcionales desde config/env
  accessWindowStart?: string;
  accessWindowEnd?: string;
  api_key?: string;       // por si el template lo requiere
  default_count?: number; // ignorado en este agente; dejado por compat.
}

/* =======================
   Implementación del Tool
   ======================= */
const myAwesomeToolTool = createTool<AgentInput, AgentConfig>({
  // 1) METADATA — nombre único, versión, descripción, capabilities
  metadata: {
    name: 'agent-03-roomservice-maintenance',
    version: '1.0.0',
    description:
      'Agente 3: Room Service (A&B) y Mantenimiento. Orquesta pedidos A&B y tickets de mantenimiento con políticas de horario, límite de gasto y escalamiento.',
    capabilities: ['classification', 'policy-check', 'dispatch', 'ticket-tracking'],
    author: 'Equipo A3',
    license: 'MIT',
  },

  // 2) SCHEMA — valida input y config (tipos, requeridos, enums, defaults)
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

    // Config opcional (env/overrides)
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

  // 3) EXECUTE — lógica de negocio del agente
  async execute(input, config, context) {
    // -------- helpers --------
    const nowISO = () => new Date().toISOString();

    const classify = (
      text?: string,
      items?: Array<{ name: string }>,
      explicit?: 'food' | 'beverage' | 'maintenance',
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
      dnd?: boolean,
    ) => {
      if (dnd) return false;
      if (!win && !(config.accessWindowStart && config.accessWindowEnd)) return true;
      const windowEff = win ?? { start: config.accessWindowStart!, end: config.accessWindowEnd! };
      const now = nowStr ? new Date(nowStr) : new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const cur = `${hh}:${mm}:${ss}`;
      return windowEff.start <= cur && cur <= windowEff.end;
    };

    const enforceSpend = (
      items?: Array<{ qty?: number; price?: number }>,
      profile?: { daily_spend?: number; spend_limit?: number },
    ) => {
      const total = (items ?? []).reduce((a, i) => a + (i.price ?? 0) * (i.qty ?? 1), 0);
      const daily = profile?.daily_spend ?? 0;
      const limit = profile?.spend_limit ?? Infinity;
      return { ok: daily + total <= limit, total };
    };

    const crossSell = (items?: Array<{ name: string }>) => {
      const names = new Set((items ?? []).map(i => i.name.toLowerCase()));
      const s: string[] = [];
      if (names.has('hamburguesa')) s.push('brownie');
      if (names.has('pizza')) s.push('vino tinto');
      if (names.has('ensalada')) s.push('agua mineral');
      return s;
    };

    // -------- storage demo (in-memory) --------
    (globalThis as any)._TICKETS_ ??= new Map<string, any>();
    const TICKETS: Map<string, any> = (globalThis as any)._TICKETS_;

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

    // --- CREATE ---
    if (action === 'create') {
      const type = classify(text, items, explicitType);
      const area = mapArea(type);

      if (type === 'food' || type === 'beverage') {
        if (!withinWindow(now, access_window, do_not_disturb)) {
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
      const ticket = {
        id,
        guest_id,
        room,
        type,
        area,
        items,
        notes,
        priority,
        status: 'CREADO' as const,
        history: [{ status: 'CREADO', actor: 'system', timestamp: nowISO() }],
      };
      TICKETS.set(id, ticket);

      ticket.status = 'ACEPTADA';
      ticket.history.push({ status: 'ACEPTADA', actor: area, timestamp: nowISO() });

      const suggestions = type !== 'maintenance' ? crossSell(items) : [];

      return {
        status: 'success',
        data: { request_id: id, type, area, status: ticket.status, suggestions },
      };
    }

    if (!request_id) {
      return {
        status: 'error',
        error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' },
      };
    }
    const t = TICKETS.get(request_id);
    if (!t) {
      return { status: 'error', error: { code: 'NOT_FOUND', message: 'No existe el ticket' } };
    }

    if (action === 'status') {
      t.status = 'EN_PROCESO';
      t.history.push({ status: 'EN_PROCESO', actor: t.area, timestamp: nowISO() });
      return { status: 'success', data: { request_id, type: t.type, area: t.area, status: t.status } };
    }

    if (action === 'complete') {
      t.status = 'COMPLETADA';
      t.history.push({ status: 'COMPLETADA', actor: t.area, timestamp: nowISO() });
      return { status: 'success', data: { request_id, type: t.type, area: t.area, status: t.status } };
    }

    if (action === 'assign') {
      t.area = mapArea(t.type);
      t.history.push({ status: t.status, actor: t.area, timestamp: nowISO(), note: 'Reassigned' });
      return { status: 'success', data: { request_id, type: t.type, area: t.area, status: t.status } };
    }

    if (action === 'feedback') {
      t.history.push({ status: t.status, actor: 'guest', timestamp: nowISO(), note: 'Feedback' });
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
  },
});

/* =======================
   Arranque del servidor
   ======================= */
async function main() {
  try {
    await myAwesomeToolTool.start({
      port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
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
    console.log(`🔗 Execute: http://localhost:${process.env.PORT || 3000}/execute`);
  } catch (error) {
    console.error('Failed to start tool server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🔄 SIGINT -> shutting down...');
  await myAwesomeToolTool.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM -> shutting down...');
  await myAwesomeToolTool.stop();
  process.exit(0);
});

if (require.main === module) {
  main();
}

export default myAwesomeToolTool;