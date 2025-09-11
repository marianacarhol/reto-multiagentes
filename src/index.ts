/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant)
 * v2.3.1
 * - Menú dinámico por restaurante (rest1/rest2) con horarios
 * - Ítems de entrada: sólo name (+qty opcional); precio/stock/horario/restaurant desde BD
 * - Tickets RB/M, feedback y cross-sell
 */

import 'dotenv/config';
import {
  createTool,
  stringField,
  numberField,
  booleanField,
  type ToolExecutionResult,
} from '@ai-spine/tools';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

type ServiceType = 'food' | 'beverage' | 'maintenance';
type TicketStatus = 'CREADO' | 'ACEPTADA' | 'EN_PROCESO' | 'COMPLETADA' | 'RECHAZADA';

interface AgentInput {
  action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service';

  // Identidad básica
  guest_id: string;
  room: string;

  // Room Service
  restaurant?: 'rest1' | 'rest2' | 'multi'; // acepta 'multi'; si se omite se infiere por ítems
  type?: ServiceType;
  items?: Array<{ id?: string; name: string; qty?: number }>;

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
  enable_stock_check?: boolean;
  enable_cross_sell?: boolean;
  cross_sell_threshold?: number;

  // opciones de cross-sell por categoría
  cross_sell_per_category?: boolean;          // compat (no se usa si false)
  cross_sell_per_category_count?: number;     // 1..3 (default 1)
  cross_sell_prefer_opposite?: boolean;       // prioriza opuesto SOLO si el ticket no es multi

  api_key?: string;       // compat
  default_count?: number; // compat
}

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? ''
);

// ============ Utils ============
const nowISO = () => new Date().toISOString();
const pad2 = (n: number) => String(n).padStart(2, '0');

const hhmm = (nowStr?: string) => {
  const d = nowStr ? new Date(nowStr) : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const isInRange = (cur: string, start: string, end: string) => {
  // soporta rangos que cruzan medianoche
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
};

const classify = (text?: string, items?: Array<{name:string}>, explicit?: ServiceType): ServiceType => {
  if (explicit) return explicit;
  const blob = `${text ?? ''} ${(items ?? []).map(i=>i.name).join(' ')}`.toLowerCase();
  if (/(repair|leak|broken|fuga|mantenimiento|plomer|reparar|aire acondicionado|tv|luz|calefacci[oó]n|ducha|inodoro)/i.test(blob))
    return 'maintenance';
  if (/(beer|vino|coca|bebida|agua|jugo|drink|cerveza|whiskey|ron|vodka|cocktail)/i.test(blob))
    return 'beverage';
  return 'food';
};

const mapArea = (type: ServiceType) =>
  type === 'maintenance' ? 'maintenance' : type === 'beverage' ? 'bar' : 'kitchen';

const withinWindow = (
  nowStr: string | undefined,
  window: {start:string; end:string} | undefined,
  cfg: {start?:string; end?:string},
  dnd?: boolean
) => {
  if (dnd) return false;
  const start = window?.start ?? cfg.start;
  const end   = window?.end   ?? cfg.end;
  if (!start || !end) return true;
  return isInRange(hhmm(nowStr), start, end);
};

// ============ DB helpers ============

// guests (opcional para gastar)
async function dbGetGuestSpendLimit(guest_id: string){
  const { data, error } = await supabase.from('guests')
    .select('spend_limit')
    .eq('id', guest_id)
    .maybeSingle();
  if (error) throw error;
  return data?.spend_limit as number | null | undefined;
}

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
  cross_sell_items?: string[]; // opcional
};

async function dbMenuUnion(): Promise<MenuRow[]> {
  const { data, error } = await supabase.from('menu_union').select('*');
  if (error) throw error;
  return (data ?? []) as any;
}

// ------- Resolver de ítems desde BD (precio/horario/stock/restaurante) -------
function toHHMM(s: string) {
  return s.toString().slice(0,5);
}

function normName(s?: string){
  return (s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim().replace(/\s+/g,' ');
}

type ResolvedItem = {
  id: string;
  name: string;
  qty: number;
  price: number;
  restaurant: 'rest1'|'rest2';
  category: 'food'|'beverage'|'dessert';
};

async function resolveAndValidateItems(
  rawItems: Array<{id?: string; name: string; qty?: number}>,
  nowStr?: string,
  enableStockCheck: boolean = true
): Promise<{ items: ResolvedItem[]; total: number; restSet: Set<'rest1'|'rest2'>; }> {
  const menu = await dbMenuUnion();
  const cur = hhmm(nowStr);

  const byId = new Map(menu.map(m => [m.id, m]));
  const byName = new Map(menu.map(m => [normName(m.name), m]));

  const resolved: ResolvedItem[] = [];

  for (const it of (rawItems ?? [])) {
    const row = it.id ? byId.get(it.id) : byName.get(normName(it.name));
    if (!row) {
      throw new Error(`No encontrado en menú: ${it.name}`);
    }

    const active = row.is_active === true;
    const inTime = isInRange(cur, toHHMM(row.available_start as any), toHHMM(row.available_end as any));
    const stockOK = !enableStockCheck || (row.stock_current > row.stock_minimum);

    if (!active)  throw new Error(`Inactivo: ${row.name}`);
    if (!inTime)  throw new Error(`Fuera de horario: ${row.name}`);
    if (!stockOK) throw new Error(`Sin stock suficiente: ${row.name}`);

    const qty = Math.max(1, it.qty ?? 1);

    resolved.push({
      id: row.id,
      name: row.name,
      qty,
      price: Number(row.price),
      restaurant: row.restaurant as 'rest1'|'rest2',
      category: row.category as any,
    });
  }

  const total = resolved.reduce((acc, r) => acc + r.price * r.qty, 0);
  const restSet = new Set(resolved.map(r => r.restaurant));

  return { items: resolved, total, restSet };
}

// Room Service (RB)
async function rbCreateTicket(row: {
  id: string; guest_id: string; room: string; restaurant: 'rest1'|'rest2'|'multi';
  status: TicketStatus; priority: string; items: any; total_amount: number; notes?: string;
}){
  const { error } = await supabase.from('tickets_rb').insert(row);
  if (error) throw error;
}
async function rbUpdateTicket(id: string, patch: Partial<{status: TicketStatus; priority:string; notes:string}>){
  const { error } = await supabase.from('tickets_rb')
    .update({ ...patch, updated_at: nowISO() }).eq('id', id);
  if (error) throw error;
}
async function rbGetTicket(id: string){
  const { data, error } = await supabase.from('tickets_rb').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as any | null;
}
async function rbAddHistory(h: {request_id: string; status: string; actor: string; note?: string}){
  const { error } = await supabase.from('ticket_history_rb').insert({ ...h, ts: nowISO() });
  if (error) throw error;
}

// Mantenimiento (M)
async function mCreateTicket(row: {
  id: string; guest_id: string; room: string; issue: string; severity?: string;
  status: TicketStatus; priority: string; notes?: string;
}){
  const { error } = await supabase.from('tickets_m').insert(row);
  if (error) throw error;
}
async function mUpdateTicket(id: string, patch: Partial<{status: TicketStatus; priority:string; notes:string}>){
  const { error } = await supabase.from('tickets_m')
    .update({ ...patch, updated_at: nowISO() }).eq('id', id);
  if (error) throw error;
}
async function mGetTicket(id: string){
  const { data, error } = await supabase.from('tickets_m').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as any | null;
}
async function mAddHistory(h: {request_id: string; status: string; actor: string; note?: string}){
  const { error } = await supabase.from('ticket_history_m').insert({ ...h, ts: nowISO() });
  if (error) throw error;
}

// Feedback (usa tu tabla con request_id)
async function addFeedback(rec: {
  domain: 'rb'|'m';
  guest_id: string;
  request_id: string;
  message?: string;
  rating?: number;
}){
  const { error } = await supabase.from('feedback').insert({
    domain: rec.domain,
    guest_id: rec.guest_id,
    request_id: rec.request_id,
    message: rec.message ?? null,
    rating: rec.rating ?? null,
    created_at: nowISO(),
  });
  if (error) throw error;
}

// Descontar stock al crear RB
async function decrementStock(items: Array<{id?:string; name:string; restaurant?:'rest1'|'rest2'; qty?:number}>){
  if (!items?.length) return;
  const menu = await dbMenuUnion();
  for (const it of items) {
    const row = it.id
      ? menu.find(m => m.id === it.id)
      : menu.find(m => m.name.toLowerCase() === it.name.toLowerCase());
    if (!row) continue;

    const table = row.restaurant === 'rest1' ? 'rest1_menu_items' : 'rest2_menu_items';
    const qty = Math.max(1, it.qty ?? 1);
    const newStock = Math.max(0, (row.stock_current ?? 0) - qty);

    const { error } = await supabase
      .from(table)
      .update({ stock_current: newStock, updated_at: nowISO() })
      .eq('id', row.id);

    if (error) throw error;
  }
}

// Registrar consumo (opcional). Si la tabla no existe, se ignora.
async function addDailySpend(guest_id: string, amount: number){
  try {
    const { error } = await supabase.from('spend_ledger').insert({
      guest_id,
      amount,
      occurred_at: nowISO(),
    });
    if (error) {
      console.warn('spend_ledger insert skipped:', error.message);
    }
  } catch (e:any) {
    console.warn('spend_ledger insert skipped:', e?.message || e);
  }
}

// Helpers de cross-sell
function pickCrossSellByCategory(
  menu: MenuRow[],
  chosen: Array<{id?:string; name:string; restaurant?:'rest1'|'rest2'}>,
  opts: {
    nowHHMM: string;
    perCategoryCount: number;
    preferOppositeOf?: 'rest1'|'rest2';
    explicitType?: 'food'|'beverage'|'maintenance';
    forbidSameCategoryIfPresent?: boolean;
  }
){
  const chosenIds = new Set(chosen.map(c => c.id).filter(Boolean) as string[]);
  const chosenNames = new Set(chosen.map(c => normName(c.name)));

  // Mapear items elegidos a filas del menú
  const byName = new Map(menu.map(m => [normName(m.name), m]));
  const chosenRows: MenuRow[] = chosen.map(it => {
    if (it.id) return menu.find(m => m.id === it.id);
    const nn = normName(it.name);
    return byName.get(nn);
  }).filter(Boolean) as MenuRow[];

  // Categorías ya elegidas
  const chosenCats = new Set<'food'|'beverage'|'dessert'>(
    chosenRows.map(r => r.category) as any
  );

  if (opts.explicitType === 'food' || opts.explicitType === 'beverage') {
    if (!chosenCats.has(opts.explicitType)) {
      chosenCats.add(opts.explicitType);
    }
  }

  // Determinar categorías faltantes
  const allCats = ['food','beverage','dessert'] as const;
  const targetCats: Array<'food'|'beverage'|'dessert'> = [];
  for (const cat of allCats) {
    if (opts.forbidSameCategoryIfPresent && chosenCats.has(cat)) continue;
    if (!chosenCats.has(cat)) targetCats.push(cat);
  }
  if (targetCats.length === 0) return [];

  // Pool disponible
  const available = menu.filter(r =>
    r.is_active &&
    r.stock_current > r.stock_minimum &&
    isInRange(opts.nowHHMM, (r.available_start as any).toString().slice(0,5), (r.available_end as any).toString().slice(0,5)) &&
    !chosenIds.has(r.id) &&
    !chosenNames.has(normName(r.name))
  );

  const byCat = new Map<'food'|'beverage'|'dessert', MenuRow[]>();
  for (const c of allCats) byCat.set(c, []);
  for (const r of available) byCat.get(r.category as any)!.push(r);

  // Priorizar restaurante opuesto si se pide (y solo cuando el ticket no es multi)
  if (opts.preferOppositeOf) {
    for (const cat of allCats) {
      const arr = byCat.get(cat)!;
      arr.sort((a,b)=>{
        if (a.restaurant === opts.preferOppositeOf && b.restaurant !== opts.preferOppositeOf) return -1;
        if (a.restaurant !== opts.preferOppositeOf && b.restaurant === opts.preferOppositeOf) return 1;
        return 0;
      });
    }
  }

  // Random simple por categoría faltante (shuffle + slice)
  const picks: any[] = [];
  for (const cat of targetCats) {
    const pool = byCat.get(cat) ?? [];
    if (!pool.length) continue;
    for (let i = pool.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = Math.max(1, Math.min(3, opts.perCategoryCount));
    for (const r of pool.slice(0, count)) {
      picks.push({ restaurant: r.restaurant, id: r.id, name: r.name, price: r.price, category: r.category });
    }
  }

  return picks;
}

// ============ Tool ============
const tool = ({
  metadata: {
    name: 'agent-03-roomservice-maintenance-split',
    version: '2.3.1',
    description: 'Room Service (rest1/rest2) + Maintenance con tablas separadas y cross-sell inter-restaurantes (multi-enabled)',
    capabilities: ['dynamic-menu','intelligent-cross-sell','ticket-tracking','feedback','policy-check'],
    author: 'Equipo A3',
    license: 'MIT',
  },

  schema: {
    input: {
      action: { type: 'string', enum: ['get_menu','create','status','complete','assign','feedback','confirm_service', 'accept', 'reject'], required: false, default: 'create' },
      guest_id: stringField({ required: true }),
      room: stringField({ required: true }),

      restaurant: { type: 'string', required: false, enum: ['rest1','rest2','multi'] }, // acepta multi
      type: { type: 'string', required: false, enum: ['food','beverage','maintenance'] },
      items: {
        type: 'array', required: false, items: {
          type: 'object', properties: {
            id: stringField({ required: false }),          // opcional
            name: stringField({ required: true }),         // requerido
            qty: numberField({ required: false, default: 1, min: 1 }), // cantidad
          }
        }
      },

      issue: stringField({ required: false }),
      severity: { type: 'string', required: false, enum: ['low','medium','high'] },

      text: stringField({ required: false }),
      notes: stringField({ required: false }),
      priority: { type: 'string', required: false, default: 'normal', enum: ['low','normal','high'] },

      now: stringField({ required: false }),
      do_not_disturb: booleanField({ required: false }),
      guest_profile: {
        type: 'object', required: false, properties: {
          tier: { type: 'string', required: false, enum: ['standard','gold','platinum'] },
          daily_spend: numberField({ required: false, min: 0 }),
          spend_limit: numberField({ required: false, min: 0 }),
          preferences: { type: 'array', required: false, items: { type: 'string' } }
        }
      },
      access_window: {
        type: 'object', required: false, properties: {
          start: stringField({ required: true }),
          end: stringField({ required: true }),
        }
      },

      request_id: stringField({ required: false }),
      service_rating: numberField({ required: false, min: 1, max: 5 }),
      service_feedback: stringField({ required: false }),
      service_completed_by: stringField({ required: false }),

      menu_category: { type: 'string', required: false, enum: ['food','beverage','dessert'] },
    },

    config: {
      accessWindowStart: stringField({ required: false }),
      accessWindowEnd:   stringField({ required: false }),
      enable_stock_check: booleanField({ required: false, default: true }),
      enable_cross_sell:  booleanField({ required: false, default: true }),
      cross_sell_threshold: numberField({ required: false, default: 1 }),
      cross_sell_per_category: booleanField({ required: false, default: true }),
      cross_sell_per_category_count: numberField({ required: false, default: 1, min: 1, max: 3 }),
      cross_sell_prefer_opposite: booleanField({ required: false, default: true }),
      api_key: stringField({ required: false }),
      default_count: numberField({ required: false, default: 1 }),
    },
  },

async execute(input: AgentInput, config: any): Promise<ToolExecutionResult> {
  const { action = 'create', guest_id, room } = input;

  // ---- Validación básica
  if (action === 'create' && (!guest_id || !room || typeof guest_id !== 'string' || typeof room !== 'string')) {
  return { status: 'error', error: { code: 'VALIDATION_ERROR', message: 'guest_id y room son requeridos (string) para crear ticket' } };
}


  try {
    const nowHHMM = hhmm(input.now);

    // ---- GET MENU (solo RB)
    if (action === 'get_menu') {
      const menu = await dbMenuUnion();
      const filtered = menu.filter(m =>
        (!input.menu_category || m.category === input.menu_category) &&
        m.is_active &&
        (!config.enable_stock_check || m.stock_current > m.stock_minimum) &&
        isInRange(nowHHMM, m.available_start.toString().slice(0,5), m.available_end.toString().slice(0,5))
      );
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

    // ---- Determinar tipo y área
    const type = classify(input.text, input.items, input.type);
    const area = mapArea(type);

    // ---- CREAR TICKET
    if (action === 'create') {
      // ---- Room Service
      if (type === 'food' || type === 'beverage') {
        const okWindow = withinWindow(input.now, input.access_window, { start: config.accessWindowStart, end: config.accessWindowEnd }, input.do_not_disturb);
        if (!okWindow) {
          return { status: 'error', error: { code: 'ACCESS_WINDOW_BLOCK', message: 'Fuera de ventana o DND activo' } };
        }

        const rawItems = input.items ?? [];
        if (!input.restaurant && rawItems.length === 0) {
          return { status: 'error', error: { code: 'VALIDATION_ERROR', message: 'Provee al menos un ítem' } };
        }

        let resolved: ResolvedItem[] = [];
        let total = 0;
        let restSet = new Set<'rest1'|'rest2'>();
        try {
          const res = await resolveAndValidateItems(rawItems, input.now, config.enable_stock_check !== false);
          resolved = res.items;
          total = res.total;
          restSet = res.restSet;
        } catch (e:any) {
          return { status: 'error', error: { code: 'ITEMS_UNAVAILABLE', message: String(e?.message || e) } };
        }

        // ---- Límite de gasto
        let spendLimit = input.guest_profile?.spend_limit ?? await dbGetGuestSpendLimit(guest_id);
        const dailySpend = input.guest_profile?.daily_spend ?? 0;
        if (spendLimit != null && (dailySpend + total) > spendLimit) {
          return { status: 'error', error: { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' } };
        }

        // ---- Determinar restaurante
        const anchor = (input.restaurant === 'rest1' || input.restaurant === 'rest2') ? input.restaurant : undefined;
        const ticketRestaurant: 'rest1'|'rest2'|'multi' =
          input.restaurant === 'multi' ? 'multi'
          : restSet.size > 1 ? 'multi'
          : restSet.size === 1 ? Array.from(restSet)[0] as ('rest1'|'rest2')
          : anchor ?? 'multi';

        // ---- Crear ticket en estado CREADO
        const id = `REQ-${Date.now()}`;
        await rbCreateTicket({
          id,
          guest_id,
          room,
          restaurant: ticketRestaurant,
          status: 'CREADO',
          priority: input.priority ?? 'normal',
          items: resolved,
          total_amount: total,
          notes: input.notes ?? undefined
        });
        await rbAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });

        return {
          status: 'success',
          data: {
            request_id: id,
            domain: 'rb',
            type,
            area,
            status: 'CREADO',
            message: 'Ticket creado. Usa action "accept" o "reject" para procesarlo.'
          }
        };
      }

      // ---- Mantenimiento
      if (!input.issue) {
        return { status: 'error', error: { code: 'MISSING_ISSUE', message: 'Describe el issue de mantenimiento' } };
      }

      const computedPriority = input.severity === 'high' ? 'high' : input.priority ?? 'normal';
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

      return { 
        status: 'success', 
        data: { 
          request_id: id, 
          domain: 'm', 
          type, 
          area, 
          status: 'CREADO', 
          message: 'Ticket creado. Usa action "accept" o "reject" para procesarlo.' 
        } 
      };
    }

    // ---- ACCIONES POSTERIORES (accept/reject/status/complete)
    if (!input.request_id) {
      return { status: 'error', error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' } };
    }
    
async function handleRB(input: AgentInput, ticket: any) {
  let newStatus: TicketStatus = ticket.status;

  if (input.action === 'accept') newStatus = 'ACEPTADA';
  else if (input.action === 'reject') newStatus = 'RECHAZADA';
  else if (input.action === 'complete') newStatus = 'COMPLETADA';
  else if (input.action === 'status') {
    // sólo devolver estado actual
    return { status: 'success', data: { request_id: ticket.id, status: ticket.status } };
  }

  // ✅ usar id (no request_id) y tocar updated_at
  const { error } = await supabase
    .from('tickets_rb')
    .update({ status: newStatus, updated_at: nowISO() })
    .eq('id', ticket.id);

  if (error) throw error;

  await rbAddHistory({
    request_id: ticket.id,
    status: newStatus,
    actor: 'agent',
    note: input.notes
  });

  return { status: 'success', data: { request_id: ticket.id, status: newStatus } };
}

async function handleM(input: AgentInput, ticket: any) {
  let newStatus: TicketStatus = ticket.status;

  if (input.action === 'accept') newStatus = 'ACEPTADA';
  else if (input.action === 'reject') newStatus = 'RECHAZADA';
  else if (input.action === 'complete') newStatus = 'COMPLETADA';
  else if (input.action === 'status') {
    return { status: 'success', data: { request_id: ticket.id, status: ticket.status } };
  }

  const { error } = await supabase
    .from('tickets_m')
    .update({ status: newStatus, updated_at: nowISO() })
    .eq('id', ticket.id);

  if (error) throw error;

  await mAddHistory({
    request_id: ticket.id,
    status: newStatus,
    actor: 'agent',
    note: input.notes
  });

  return { status: 'success', data: { request_id: ticket.id, status: newStatus } };
}

    // --- Intentar Room Service
    const rb = await rbGetTicket(input.request_id);
    if (rb) return await handleRB(input, rb);

    // --- Intentar Mantenimiento
    const mt = await mGetTicket(input.request_id);
    if (mt) return await handleM(input, mt);

    return { status: 'error', error: { code: 'NOT_FOUND', message: 'request_id no existe ni en RB ni en M' } };

  } catch (e: any) {
    console.error('ERROR:', e?.message || e);
    return { status: 'error', error: { code: 'INTERNAL_DB_ERROR', message: String(e?.message || e) } };
  }
},


  async start(config: any) {
    console.log(`Servidor arrancado en puerto ${config.port}`);
  }
});

async function interactiveTicketLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const askAction = () => {
    rl.question('Ingresa acción (accept/reject) o "exit" para salir: ', async (action) => {
      if (action === 'exit') {
        rl.close();
        console.log('Saliendo del loop interactivo...');
        return;
      }

      rl.question('Ingresa request_id del ticket: ', async (request_id) => {
        const input: AgentInput = {
          action: action as any, // 'accept' | 'reject'
          request_id,
          actor: 'staff01' // opcional
        };

        try {
          const result = await tool.execute(input, {});
          console.log('Resultado:', result);
        } catch (e:any) {
          console.error('Error ejecutando acción:', e?.message || e);
        }

        askAction(); // vuelve a preguntar
      });
    });
  };

  console.log('=== Ticket Loop interactivo iniciado ===');
  askAction();
}

// ============ Server bootstrap ============
async function main(){
  try{
    // 1️⃣ Leer JSON de ticket
    const jsonPath = path.resolve('./input.json');
    if (fs.existsSync(jsonPath)) {
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const inputData = JSON.parse(raw) as AgentInput;

      console.log('🔹 Creando ticket desde input.json...');
      const result = await tool.execute(inputData, {});
      console.log('✅ Ticket creado:', result);
      await interactiveTicketLoop();

    } else {
      console.log('No se encontró ticket.json, se salta creación automática.');
    }

    await tool.start({
      port: process.env.PORT ? parseInt(process.env.PORT,10) : 3000,
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
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);

  }
}

process.on('SIGINT', async () => { console.log('SIGINT'); await tool.stop(); process.exit(0); });
process.on('SIGTERM', async () => { console.log('SIGTERM'); await tool.stop(); process.exit(0); });

if (require.main === module) { main(); }

export default tool;
