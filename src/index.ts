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
type TicketStatus = 'CREADO' | 'ACEPTADA' | 'EN_PROCESO' | 'COMPLETADA' | 'RECHAZADA' | 'CANCELADO';

interface AgentInput {
  action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service' | 'accept' | 'reject' | 'cancel';

  // Identidad básica
  guest_id?: string;
  room?: string;

  // Room Service
  restaurant?: 'rest1' | 'rest2' | 'multi';
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
  service_feedback?: string;
  service_completed_by?: string;

  // Filtros get_menu
  menu_category?: 'food'|'beverage'|'dessert';

  service_hours?: string;
}

interface AgentConfig {
  accessWindowStart?: string;
  accessWindowEnd?: string;
  enable_stock_check?: boolean;
  enable_cross_sell?: boolean;
  cross_sell_threshold?: number;

  cross_sell_per_category?: boolean;
  cross_sell_per_category_count?: number;     // 1..3
  cross_sell_prefer_opposite?: boolean;

  api_key?: string;
  default_count?: number;
}

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? ''
);

// ===== Utils
const nowISO = () => new Date().toISOString();
const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmm = (nowStr?: string) => {
  const d = nowStr ? new Date(nowStr) : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const isInRange = (cur: string, start: string, end: string) =>
  start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);

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

function toHHMM(s: string) { return s.toString().slice(0,5); }
function normName(s?: string){
  return (s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim().replace(/\s+/g,' ');
}

// ===== PRIORITY (TF-IDF + LogReg servido en FastAPI) =====
const PRIORITY_API_URL = process.env.PRIORITY_API_URL || 'http://localhost:8000/predict';

function calcEtaToSLA(params: {
  domain: 'rb'|'m';
  type?: ServiceType;
  createdAtISO?: string;
}) {
  const now = new Date();
  const created = params.createdAtISO ? new Date(params.createdAtISO) : now;
  const elapsedMin = Math.floor((now.getTime() - created.getTime()) / 60000);
  const slaMin = params.domain === 'rb' ? 45 : 120; // ajusta a tus SLAs reales
  return slaMin - elapsedMin;
}

type PriorityOut = {
  priority: 'low'|'medium'|'high';
  score: number;
  proba?: Record<string, number>;
  needs_review?: boolean;
  model?: string;
};

function hardRulesFallback(payload: { text?: string; vip?: boolean|number; eta_to_sla_min?: number; }): PriorityOut {
  const t = (payload.text || '').toLowerCase();
  const danger = /(fuga|leak|humo|incendio|chispa|descarga|sangre|shock|smoke|fire)/i.test(t);
  if (danger) return { priority: 'high', score: 95, model: 'rules' };
  const soon = (payload.eta_to_sla_min ?? 999) < 30;
  const vip = !!payload.vip;
  if (soon && vip) return { priority: 'high', score: 80, model: 'rules' };
  if (soon) return { priority: 'medium', score: 65, model: 'rules' };
  return { priority: 'low', score: 30, model: 'rules' };
}

async function getPriorityFromAPI(input: {
  text: string;
  domain: 'rb'|'m';
  vip: 0|1;
  spend30d: number;
  eta_to_sla_min: number;
}): Promise<PriorityOut> {
  try {
    const res = await fetch(PRIORITY_API_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`priority api ${res.status}`);
    const json = await res.json();
    let p = (json.priority || '').toLowerCase();
    if (!['low','medium','high'].includes(p)) p = 'medium';
    return {
      priority: p as 'low'|'medium'|'high',
      score: Number(json.score ?? 0),
      proba: json.proba,
      needs_review: !!json.needs_review,
      model: json.model || 'tfidf_logreg_v1'
    };
  } catch (_e) {
    return hardRulesFallback({
      text: input.text,
      vip: input.vip,
      eta_to_sla_min: input.eta_to_sla_min
    });
  }
}

// ===== DB helpers
async function dbGetGuestSpendLimit(guest_id: string){
  const { data, error } = await supabase.from('guests')
    .select('spend_limit')
    .eq('id', guest_id)
    .maybeSingle();
  if (error) throw error;
  return data?.spend_limit as number | null | undefined;
}

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
  cross_sell_items?: string[];
};

type GuestRow = {
  id: string;
  nombre?: string | null;
  room?: string | null;
  spend_limit?: number | null;
};

async function dbGetGuestById(guest_id: string): Promise<GuestRow | null> {
  const { data, error } = await supabase
    .from('guests')
    .select('id, nombre, room, spend_limit')
    .eq('id', guest_id)
    .maybeSingle();
  if (error) throw error;
  return (data as GuestRow) ?? null;
}

async function dbValidateGuestAndRoom(guest_id: string, room: string) {
  const g = await dbGetGuestById(guest_id);
  if (!g) {
    const err: any = new Error('GUEST_NOT_FOUND');
    err.code = 'GUEST_NOT_FOUND';
    err.message = `Huésped "${guest_id}" no existe`;
    throw err;
  }
  // si tu columna room puede venir null, permitimos crear sólo si input.room también es null/igual
  const dbRoom = (g.room ?? '').trim();
  const inRoom = (room ?? '').trim();
  if (dbRoom && inRoom && dbRoom !== inRoom) {
    const err: any = new Error('ROOM_MISMATCH');
    err.code = 'ROOM_MISMATCH';
    err.message = `La habitación no coincide (guest=${dbRoom}, input=${inRoom})`;
    throw err;
  }
  return g; // por si luego quieres usar spend_limit, nombre, etc.
}

// ===== Spend helpers =====
async function dbGetSpentToday(guest_id: string){
  const start = new Date();
  start.setUTCHours(0,0,0,0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 1);

  const { data, error } = await supabase
    .from('spend_ledger')
    .select('amount, occurred_at')
    .eq('guest_id', guest_id)
    .gte('occurred_at', start.toISOString())
    .lt('occurred_at', end.toISOString());

  if (error) throw error;
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
}

// Inserta en ledger una sola vez por (guest_id, request_id)
async function ledgerInsertOnce(rec: {
  domain: 'rb'|'m',
  request_id: string,
  guest_id: string,
  amount: number
}) {
  const { error } = await supabase
    .from('spend_ledger')
    .upsert(
      [{
        domain: rec.domain,
        request_id: rec.request_id,
        guest_id: rec.guest_id,
        amount: rec.amount,
        occurred_at: nowISO(),
      }],
      { onConflict: 'guest_id,request_id', ignoreDuplicates: true }
    );
  if (error) throw error;
}

// Intenta RPC decremental atómica; si no existe la RPC, hace fallback 2 pasos
async function decrementGuestLimitIfEnough(guest_id: string, amount: number) {
  try {
    const { data, error } = await supabase
      .rpc('decrement_guest_limit_if_enough', { p_guest_id: guest_id, p_amount: amount });
    if (error) throw error;
    if (!data || (data as any).updated_rows !== 1) {
      const err: any = new Error('SPEND_LIMIT_EXCEEDED');
      err.code = 'SPEND_LIMIT';
      throw err;
    }
    return;
  } catch (_e) {
    const { data, error } = await supabase
      .from('guests')
      .select('spend_limit')
      .eq('id', guest_id)
      .maybeSingle();
    if (error) throw error;
    const current = Number(data?.spend_limit ?? 0);
    if (current < amount) {
      const err: any = new Error('SPEND_LIMIT_EXCEEDED');
      err.code = 'SPEND_LIMIT';
      throw err;
    }
    const newVal = Number((current - amount).toFixed(2));
    const { error: e2 } = await supabase
      .from('guests')
      .update({ spend_limit: newVal })
      .eq('id', guest_id);
    if (e2) throw e2;
  }
}

// Cobra un ticket RB
async function chargeGuestForRB(ticket: { id: string; guest_id: string; total_amount: number }) {
  const amount = Number(ticket.total_amount || 0);
  if (amount <= 0) return;
  await ledgerInsertOnce({ domain: 'rb', request_id: ticket.id, guest_id: ticket.guest_id, amount });
  try {
    await decrementGuestLimitIfEnough(ticket.guest_id, amount);
  } catch (e:any) {
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

async function dbMenuUnion(): Promise<MenuRow[]> {
  const { data, error } = await supabase.from('menu_union').select('*');
  if (error) throw error;
  return (data ?? []) as any;
}

// ------- Resolver & validar ítems desde BD --------
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
    if (!row) throw new Error(`No encontrado en menú: ${it.name}`);

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

// ===== RB / M
async function rbCreateTicket(row: {
  id: string; guest_id: string; room: string; restaurant: 'rest1'|'rest2'|'multi';
  status: TicketStatus; priority: string; items: any; total_amount: number; notes?: string;
}){ const { error } = await supabase.from('tickets_rb').insert(row); if (error) throw error; }

async function rbUpdateTicket(id: string, patch: Partial<{status: TicketStatus; priority:string; notes:string}>){
  const { error } = await supabase.from('tickets_rb').update({ ...patch, updated_at: nowISO() }).eq('id', id);
  if (error) throw error;
}
async function rbGetTicket(id: string){ const { data, error } = await supabase.from('tickets_rb').select('*').eq('id', id).maybeSingle(); if (error) throw error; return data as any | null; }
async function rbAddHistory(h: {request_id: string; status: string; actor: string; note?: string; feedback?: string}) {
  const { error } = await supabase
    .from('ticket_history_rb')
    .insert({ ...h, ts: nowISO() });
  if (error) throw error;
}

async function mCreateTicket(row: {
  id: string; guest_id: string; room: string; issue: string; severity?: string;
  status: TicketStatus; priority: string; notes?: string;
  service_hours?: string | null;
  priority_score?: number; priority_model?: string; priority_proba?: any; needs_review?: boolean;
}) {
  const { error } = await supabase.from('tickets_m').insert(row);
  if (error) throw error;
}
async function mGetTicket(id: string){ const { data, error } = await supabase.from('tickets_m').select('*').eq('id', id).maybeSingle(); if (error) throw error; return data as any | null; }
async function mAddHistory(h: {request_id: string; status: string; actor: string; note?: string; feedback?: string; service_hours?: string}) {
  const { error } = await supabase
    .from('ticket_history_m')
    .insert({ ...h, ts: nowISO() });
  if (error) throw error;
}


// Feedback
async function addFeedback(rec: {
  domain: 'rb'|'m';
  guest_id: string;
  request_id: string;
  message?: string;
}){
  const { error } = await supabase.from('feedback').insert({
    domain: rec.domain,
    guest_id: rec.guest_id,
    request_id: rec.request_id,
    message: rec.message ?? null,
    created_at: nowISO(),
  });
  if (error) throw error;
}

// Descontar stock
async function decrementStock(items: Array<{id?:string; name:string; restaurant?:'rest1'|'rest2'; qty?:number}>){
  if (!items?.length) return;
  const menu = await dbMenuUnion();

  const byId = new Map(menu.map(m => [m.id, m]));
  const byName = new Map(menu.map(m => [normName(m.name), m]));

  for (const it of items) {
    const row = it.id ? byId.get(it.id) : byName.get(normName(it.name));
    if (!row) continue; // si no está, no descuenta
    const table = row.restaurant === 'rest1' ? 'rest1_menu_items' : 'rest2_menu_items';
    const qty = Math.max(1, it.qty ?? 1);
    const newStock = Math.max(0, (row.stock_current ?? 0) - qty);
    const { error } = await supabase.from(table).update({ stock_current: newStock, updated_at: nowISO() }).eq('id', row.id);
    if (error) throw error;
  }
}

// Cross-sell (usado si habilitas cross-sell)
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
  const norm = (s?: string) => (s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim().replace(/\s+/g,' ');

  const chosenIds = new Set(chosen.map(c => c.id).filter(Boolean) as string[]);
  const chosenNames = new Set(chosen.map(c => norm(c.name)));

  const byName = new Map(menu.map(m => [norm(m.name), m]));
  const chosenRows: MenuRow[] = chosen.map(it => it.id ? menu.find(m => m.id === it.id) : byName.get(norm(it.name))).filter(Boolean) as MenuRow[];

  const chosenCats = new Set<'food'|'beverage'|'dessert'>(chosenRows.map(r => r.category) as any);
  if (opts.explicitType === 'food' || opts.explicitType === 'beverage') {
    if (!chosenCats.has(opts.explicitType)) chosenCats.add(opts.explicitType);
  }

  const allCats = ['food','beverage','dessert'] as const;
  const targetCats: Array<'food'|'beverage'|'dessert'> = [];
  for (const cat of allCats) {
    if (opts.forbidSameCategoryIfPresent && chosenCats.has(cat)) continue;
    if (!chosenCats.has(cat)) targetCats.push(cat);
  }
  if (targetCats.length === 0) return [];

  const available = menu.filter(r =>
    r.is_active && r.stock_current > r.stock_minimum &&
    isInRange(opts.nowHHMM, (r.available_start as any).toString().slice(0,5), (r.available_end as any).toString().slice(0,5)) &&
    !chosenIds.has(r.id) && !chosenNames.has(norm(r.name))
  );

  const byCat = new Map<'food'|'beverage'|'dessert', MenuRow[]>();
  for (const c of allCats) byCat.set(c, []);
  for (const r of available) byCat.get(r.category as any)!.push(r);

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

  const picks: any[] = [];
  for (const cat of targetCats) {
    const pool = byCat.get(cat) ?? [];
    if (!pool.length) continue;
    for (let i = pool.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = Math.max(1, Math.min(3, opts.perCategoryCount));
    for (const r of pool.slice(0, count)) picks.push({ restaurant: r.restaurant, id: r.id, name: r.name, price: r.price, category: r.category });
  }
  return picks;
}

// ===== Tool
const tool = createTool<AgentInput, AgentConfig>({
  metadata: {
    name: 'agent-03-roomservice-maintenance-split',
    version: '2.3.4',
    description: 'Room Service (rest1/rest2) + Maintenance con tablas separadas y cross-sell inter-restaurantes (multi-enabled)',
    capabilities: ['dynamic-menu','intelligent-cross-sell','ticket-tracking','feedback','policy-check'],
    author: 'Equipo A3',
    license: 'MIT',
  },

  schema: {
    input: {
      action: { type: 'string', enum: ['get_menu','create','status','complete','assign','feedback','confirm_service','accept','reject','cancel'], required: false, default: 'create' },
      guest_id: stringField({ required: false }),
      room: stringField({ required: false }),

      service_hours: stringField({ required: false }),

      restaurant: { type: 'string', required: false, enum: ['rest1','rest2','multi'] },
      type: { type: 'string', required: false, enum: ['food','beverage','maintenance'] },
      items: { type: 'array', required: false, items: { type: 'object', properties: {
        id: stringField({ required: false }),
        name: stringField({ required: true }),
        qty: numberField({ required: false, default: 1, min: 1 }),
      } }},

      issue: stringField({ required: false }),
      severity: { type: 'string', required: false, enum: ['low','medium','high'] },

      text: stringField({ required: false }),
      notes: stringField({ required: false }),
      priority: { type: 'string', required: false, default: 'normal', enum: ['low','normal','high'] },

      now: stringField({ required: false }),
      do_not_disturb: booleanField({ required: false }),
      guest_profile: { type: 'object', required: false, properties: {
        tier: { type: 'string', required: false, enum: ['standard','gold','platinum'] },
        daily_spend: numberField({ required: false, min: 0 }),
        spend_limit: numberField({ required: false, min: 0 }),
        preferences: { type: 'array', required: false, items: { type: 'string' } }
      }},
      access_window: { type: 'object', required: false, properties: {
        start: stringField({ required: true }),
        end: stringField({ required: true }),
      }},

      request_id: stringField({ required: false }),
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

  async execute(input, config, _context): Promise<ToolExecutionResult> {
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
        await dbValidateGuestAndRoom(guest_id!, room!);
      } catch (e: any) {
        return {
          status: 'error',
          error: { code: e?.code || 'GUEST_VALIDATION', message: e?.message || 'Validación de huésped falló' }
        };
      }
    }

    try {
      const nowHHMM = hhmm(input.now);

      // GET MENU
      if (action === 'get_menu') {
        const menu = await dbMenuUnion();
        const filtered = menu.filter(m =>
          (!input.menu_category || m.category === input.menu_category) &&
          m.is_active &&
          (config.enable_stock_check !== false ? (m.stock_current > m.stock_minimum) : true) &&
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

      const type = classify(input.text, input.items, input.type);
      const area = mapArea(type);

      // CREATE
      if (action === 'create') {
        // ======== ROOM SERVICE (food/beverage) ========
        if (type === 'food' || type === 'beverage') {
          const okWindow = withinWindow(input.now, input.access_window, { start: config.accessWindowStart, end: config.accessWindowEnd }, input.do_not_disturb);
          if (!okWindow) return { status: 'error', error: { code: 'ACCESS_WINDOW_BLOCK', message: 'Fuera de ventana o DND activo' } };

          const rawItems = input.items ?? [];
          if (rawItems.length === 0) {
            return {
              status: 'error',
              error: { code: 'NEED_ITEMS', message: 'Debes proporcionar al menos un ítem del menú.' }
            };
          }

          let resolved: ResolvedItem[] = [];
          let total = 0;
          let restSet = new Set<'rest1'|'rest2'>();
          try {
            const res = await resolveAndValidateItems(rawItems, input.now, config.enable_stock_check !== false);
            resolved = res.items; total = res.total; restSet = res.restSet;
          } catch (e:any) {
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
          let spendLimit = input.guest_profile?.spend_limit ?? (guest_id ? await dbGetGuestSpendLimit(guest_id) : null);
          if (spendLimit != null) {
            const spentToday = guest_id ? await dbGetSpentToday(guest_id) : 0;
            if ((spentToday + total) > Number(spendLimit)) {
              return { status: 'error', error: { code: 'SPEND_LIMIT', message: 'Límite de gasto excedido' } };
            }
          }

          const anchor = (input.restaurant === 'rest1' || input.restaurant === 'rest2') ? input.restaurant : undefined;
          const ticketRestaurant: 'rest1'|'rest2'|'multi' =
            restSet.size > 1 ? 'multi' :
            restSet.size === 1 ? Array.from(restSet)[0] as ('rest1'|'rest2') :
            'multi';

          const id = `REQ-${Date.now()}`;
          const priorityLabelRB = input.priority ?? 'normal';

          // ---- CROSS-SELL (opcional)
          let crossSell: Array<{restaurant:'rest1'|'rest2'; id:string; name:string; price:number; category:'food'|'beverage'|'dessert'}> = [];
          if (config.enable_cross_sell !== false) {
            // Preferir “opuesto” cuando el pedido viene de un solo restaurant
            const preferOppositeOf =
              (config.cross_sell_prefer_opposite && (input.restaurant === 'rest1' || input.restaurant === 'rest2'))
                ? (input.restaurant === 'rest1' ? 'rest2' : 'rest1')
                : undefined;

            const menu = await dbMenuUnion();
            crossSell = pickCrossSellByCategory(
              menu,
              resolved, // lo que ya eligió el huésped
              {
                nowHHMM,
                perCategoryCount: Math.max(1, Math.min(3, config.cross_sell_per_category_count ?? 1)),
                preferOppositeOf: preferOppositeOf as ('rest1'|'rest2'|undefined),
                explicitType: type, // 'food' o 'beverage'
                // si ya trae p.ej. food, intenta sugerir categorías distintas cuando está activo per-category
                forbidSameCategoryIfPresent: !!config.cross_sell_per_category
              }
            );

            // Si quieres umbral mínimo de ítems comprados antes de sugerir
            const threshold = Number(config.cross_sell_threshold ?? 1);
            if ((resolved?.length ?? 0) < threshold) crossSell = [];
          }
          const crossSellNames = crossSell.map(s => s.name);

          await rbCreateTicket({
            id,
            guest_id: guest_id!,
            room: room!,
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
        if (!input.issue) return { status: 'error', error: { code: 'MISSING_ISSUE', message: 'Describe el issue de mantenimiento' } };

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
        const priorityLabelM =
          severityM === 'high' ? 'high' :
          severityM === 'low'  ? 'low'  :
          (input.priority ?? 'normal');

        // Ventana local para la CREACIÓN
        const serviceHoursCreate =
          input.access_window
            ? `${toHHMM(input.access_window.start)}-${toHHMM(input.access_window.end)}`
            : (input.service_hours ?? null);

        await mCreateTicket({
          id, guest_id: guest_id!, room: room!,
          issue: input.issue, severity: severityM,
          status: 'CREADO', priority: priorityLabelM,
          notes: input.notes ?? undefined,
          service_hours: serviceHoursCreate,
          priority_score: priM.score,
          priority_model: priM.model,
          priority_proba: priM.proba ?? null,
          needs_review: !!priM.needs_review
        });

        await mAddHistory({
          request_id: id,
          status: 'CREADO',
          actor: 'system',
          service_hours: serviceHoursCreate,
        });

        return { status: 'success', data: { request_id: id, domain: 'm', type, area, status: 'CREADO', message: 'Ticket creado. Usa action "accept" o "reject".' } };
      }

      // POST-actions
      if (!input.request_id) return { status: 'error', error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' } };

      async function handleRB(ticket: any) {
        let newStatus: TicketStatus = ticket.status;

        if (action === 'accept') newStatus = 'ACEPTADA';
        else if (action === 'reject') newStatus = 'RECHAZADA';
        else if (action === 'complete') newStatus = 'COMPLETADA';
        else if (action === 'status') {
          return { status: 'success', data: { request_id: ticket.id, status: ticket.status } };
        }
        else if (action === 'cancel') newStatus = 'CANCELADO';

        const { error } = await supabase
          .from('tickets_rb')
          .update({ status: newStatus, updated_at: nowISO() })
          .eq('id', ticket.id);
        if (error) throw error;

        await rbAddHistory({ request_id: ticket.id, status: newStatus, actor: 'agent', note: input.notes });

        if (action === 'accept') {
          try {
            await chargeGuestForRB({ id: ticket.id, guest_id: ticket.guest_id, total_amount: ticket.total_amount });
            await decrementStock(ticket.items || []);
            const restSet = new Set<string>((ticket.items || []).map((i: any) => i.restaurant).filter(Boolean));
            for (const r of restSet) {
              await rbAddHistory({ request_id: ticket.id, status: newStatus, actor: r });
            }
          } catch (e:any) {
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

      async function handleM(ticket: any) {
        let newStatus: TicketStatus = ticket.status;
        if (action === 'accept') newStatus = 'ACEPTADA';
        else if (action === 'reject') newStatus = 'RECHAZADA';
        else if (action === 'complete') newStatus = 'COMPLETADA';
        else if (action === 'status') return { status: 'success', data: { request_id: ticket.id, status: ticket.status } };
        else if (action === 'cancel') newStatus = 'CANCELADO';

        // Normaliza/arrastra ventana para transiciones
        const serviceHours =
          input.access_window
            ? `${toHHMM(input.access_window.start)}-${toHHMM(input.access_window.end)}`
            : (input.service_hours ?? ticket.service_hours ?? null);

        const patch: any = { status: newStatus, updated_at: nowISO() };
        if (serviceHours != null) patch.service_hours = serviceHours;        

        const { error: mUpdErr } = await supabase
          .from('tickets_m')
          .update(patch)
          .eq('id', ticket.id);
        if (mUpdErr) throw mUpdErr;
        await mAddHistory({
          request_id: ticket.id,
          status: newStatus,
          actor: 'agent',
          note: input.notes,
          service_hours: serviceHours,
        });

        return { status: 'success', data: { request_id: ticket.id, status: newStatus } };
      }

      if (action === 'feedback') {
        if (!input.request_id) {
          return { status: 'error', error: { code: 'MISSING_REQUEST_ID', message: 'request_id es requerido' } };
        }

        const ticketRB = await rbGetTicket(input.request_id);
        const ticketM  = ticketRB ? null : await mGetTicket(input.request_id);
        if (!ticketRB && !ticketM) {
          return { status: 'error', error: { code: 'NOT_FOUND', message: 'Ticket no encontrado' } };
        }

        const domain: 'rb'|'m' = ticketRB ? 'rb' : 'm';
        const guest_id = (ticketRB ?? ticketM)!.guest_id;

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

        } else {
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
      if (rb) return await handleRB(rb);
      const mt = await mGetTicket(input.request_id);
      if (mt) return await handleM(mt);
      return { status: 'error', error: { code: 'NOT_FOUND', message: 'request_id no existe ni en RB ni en M' } };

    } catch (e: any) {
      console.error('ERROR:', e?.message || e);
      return { status: 'error', error: { code: 'INTERNAL_DB_ERROR', message: String(e?.message || e) } };
    }
  },
});

// ===== Helpers CLI
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/n]: `, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes' || a === 's' || a === 'si' || a === 'sí');
    });
  });
}

function envBool(name: string, def = true) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return def; // si no está seteado, usa default
  return ['1','true','t','yes','y','si','sí','on'].includes(raw);
}

// ===== INIT: create -> accept/reject -> complete/cancel -> feedback (solo askYesNo) =====
async function runInitFlow(baseUrl: string) {
  try {
    const resolvedPath = path.resolve(process.env.INIT_JSON_PATH ?? './input.json');
    console.log(`[INIT] CWD: ${process.cwd()}`);
    console.log(`[INIT] INIT_JSON_PATH (resuelto): ${resolvedPath}`);

    if (!fs.existsSync(resolvedPath)) {
      console.log(`[INIT] No se encontró archivo en ${resolvedPath}. Se omite INIT.`);
      return;
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    console.log(`[INIT] input.json bytes=${raw.length}`);
    console.log(`[INIT] preview: ${raw.slice(0, 200).replace(/\n/g, ' ')}${raw.length > 200 ? '…' : ''}`);

    const parsed = JSON.parse(raw);
    const inputData = parsed?.input_data && typeof parsed.input_data === 'object' ? parsed.input_data : parsed;
    if (!inputData || typeof inputData !== 'object') {
      console.error('[INIT] El JSON no es un objeto válido ni contiene "input_data" objeto.');
      return;
    }
    if (!inputData.action) inputData.action = 'create';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKeyAuth = (process.env.API_KEY_AUTH ?? '').toLowerCase() === 'true';
    if (apiKeyAuth && process.env.VALID_API_KEYS) {
      headers['X-API-Key'] = process.env.VALID_API_KEYS.split(',')[0]!.trim();
    }

    // 1) CREATE
    console.log('[INIT] POST /api/execute (create)…');
    const createResp = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input_data: inputData }),
    });
    const createTxt = await createResp.text();
    let createJson: any = {};
    try { createJson = JSON.parse(createTxt); } catch {}
    console.log(
      '[INIT] create status=',
      createResp.status,
      JSON.stringify(createJson, null, 2)
    );

    const requestId =
      createJson?.output_data?.request_id ||
      createJson?.data?.request_id ||
      createJson?.request_id;

    if (!requestId) {
      console.error('[INIT] No se obtuvo request_id del create. Abortando flujo.');
      return;
    }
    console.log(`[INIT] request_id=${requestId}`);

    // 2) ACCEPT o REJECT
    const interactive = ['1','true','t','yes','y','si','sí','on'].includes((process.env.INTERACTIVE_DECIDE ?? 'false').trim().toLowerCase());
    const initDecisionRaw = (process.env.INIT_DECISION ?? 'accept').trim().toLowerCase();
    let decision: 'accept' | 'reject';
    if (interactive) {
      const yes = await askYesNo(`¿Aceptar pedido ${requestId}?`);
      decision = yes ? 'accept' : 'reject';
    } else {
      decision = initDecisionRaw === 'reject' ? 'reject' : 'accept';
    }

    console.log(`[INIT] decision=${decision}`);
    const firstAct = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input_data: { action: decision, request_id: requestId } }),
    });
    const firstTxt = await firstAct.text();
    let firstJson: any = {};
    try { firstJson = JSON.parse(firstTxt); } catch {}
    console.log(
      `[INIT] ${decision} status=${firstAct.status} body=`,
      JSON.stringify(firstJson, null, 2)
    );

    // 3) Si fue ACCEPT, COMPLETE o CANCEL
    let finalAction: 'complete' | 'cancel' | 'reject' = decision === 'reject' ? 'reject' : 'cancel';
    if (decision === 'accept') {
      const done = await askYesNo(`¿Se completó el pedido ${requestId}?`);
      finalAction = done ? 'complete' : 'cancel';

      const secondAct = await fetch(`${baseUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input_data: { action: finalAction, request_id: requestId } }),
      });
      const secondTxt = await secondAct.text();
      let secondJson: any = {};
      try { secondJson = JSON.parse(secondTxt); } catch {}
      console.log(
        `[INIT] ${finalAction} status=${secondAct.status} body=`,
        JSON.stringify(secondJson, null, 2)
      );
    }

    // 4) Feedback (opcional). Solo askYesNo; si dice que sí, pedimos texto inline sin helper extra.
    const wantsFeedback = await askYesNo('¿Quieres agregar un comentario/feedback?');
    if (wantsFeedback) {
      // Abrimos readline aquí mismo (inline).
      const comment: string = await new Promise((resolve) => {
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
        let fbJson: any = {};
        try { fbJson = JSON.parse(fbTxt); } catch {}
        console.log(
          `[INIT] feedback status=${fbResp.status} body=`,
          JSON.stringify(fbJson, null, 2)
        );
      } else {
        console.log('[INIT] feedback omitido (vacío).');
      }
    } else {
      console.log('[INIT] feedback saltado por usuario.');
    }

  } catch (e: any) {
    console.error('[INIT] flow error:', e?.message || e);
  }
}


// ===== Server bootstrap =====
async function main(){
  try{
    const port = process.env.PORT ? parseInt(process.env.PORT,10) : 3000;
    const host = process.env.HOST || '0.0.0.0';

    // 1) Arranca server HTTP
    await tool.start({ port, host });
    const baseUrl = `http://localhost:${port}`;
    console.log('🚀 Agent-03 RS&M split server ready');
    console.log(`Health:  ${baseUrl}/health`);
    console.log(`Execute: ${baseUrl}/api/execute`);

    // 2) INIT opcional (controlado por ENV, con logs claros)
    const initOnStart = envBool('INIT_ON_START', true);
    const initJsonPath = process.env.INIT_JSON_PATH ?? './input.json';
    const interactive = envBool('INTERACTIVE_DECIDE', false);
    const initDecisionRaw = (process.env.INIT_DECISION ?? 'accept').toLowerCase();

    console.log(`[INIT] INIT_ON_START=${initOnStart}  (crudo="${process.env.INIT_ON_START ?? '<unset>'}")`);
    console.log(`[INIT] INIT_JSON_PATH="${initJsonPath}"`);
    console.log(`[INIT] INTERACTIVE_DECIDE=${interactive}  (crudo="${process.env.INTERACTIVE_DECIDE ?? '<unset>'}")`);
    console.log(`[INIT] INIT_DECISION="${initDecisionRaw}"`);

    if (initOnStart) {
      await runInitFlow(baseUrl);
    } else {
      console.log('[INIT] Saltado porque INIT_ON_START=false');
    }

  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
}

process.on('SIGINT', async () => { console.log('SIGINT'); await tool.stop(); process.exit(0); });
process.on('SIGTERM', async () => { console.log('SIGTERM'); await tool.stop(); process.exit(0); });

if (require.main === module) { main(); }

export default tool;