import { createClient } from '@supabase/supabase-js';
import type { GuestRow, MenuRow, ResolvedItem, TicketStatus } from '../types';
import { nowISO, hhmm, isInRange, toHHMM, normName } from '../utils/utils';

export const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? ''
);

// ===== Guests =====
export async function dbGetGuestSpendLimit(guest_id: string){
  const { data, error } = await supabase.from('guests')
    .select('spend_limit')
    .eq('id', guest_id)
    .maybeSingle();
  if (error) throw error;
  return data?.spend_limit as number | null | undefined;
}

export async function dbGetGuestById(guest_id: string): Promise<GuestRow | null> {
  const { data, error } = await supabase
    .from('guests')
    .select('id, nombre, room, spend_limit')
    .eq('id', guest_id)
    .maybeSingle();
  if (error) throw error;
  return (data as GuestRow) ?? null;
}

export async function dbValidateGuestAndRoom(guest_id: string, room: string) {
  const g = await dbGetGuestById(guest_id);
  if (!g) {
    const err: any = new Error('GUEST_NOT_FOUND');
    err.code = 'GUEST_NOT_FOUND';
    err.message = `Huésped "${guest_id}" no existe`;
    throw err;
  }
  const dbRoom = (g.room ?? '').trim();
  const inRoom = (room ?? '').trim();
  if (dbRoom && inRoom && dbRoom !== inRoom) {
    const err: any = new Error('ROOM_MISMATCH');
    err.code = 'ROOM_MISMATCH';
    err.message = `La habitación no coincide (guest=${dbRoom}, input=${inRoom})`;
    throw err;
  }
  return g;
}

// ===== Spend / Ledger =====
export async function dbGetSpentToday(guest_id: string){
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

export async function ledgerInsertOnce(rec: {
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

export async function decrementGuestLimitIfEnough(guest_id: string, amount: number) {
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

export async function chargeGuestForRB(ticket: { id: string; guest_id: string; total_amount: number }) {
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

// ===== Menu / Stock =====
export async function dbMenuUnion(): Promise<MenuRow[]> {
  const { data, error } = await supabase.from('menu_union').select('*');
  if (error) throw error;
  return (data ?? []) as any;
}

export async function decrementStock(items: Array<{id?:string; name:string; restaurant?:'rest1'|'rest2'; qty?:number}>){
  if (!items?.length) return;
  const menu = await dbMenuUnion();

  const byId = new Map(menu.map(m => [m.id, m]));
  const byName = new Map(menu.map(m => [normName(m.name), m]));

  for (const it of items) {
    const row = it.id ? byId.get(it.id) : byName.get(normName(it.name));
    if (!row) continue;
    const table = row.restaurant === 'rest1' ? 'rest1_menu_items' : 'rest2_menu_items';
    const qty = Math.max(1, it.qty ?? 1);
    const newStock = Math.max(0, (row.stock_current ?? 0) - qty);
    const { error } = await supabase.from(table).update({ stock_current: newStock, updated_at: nowISO() }).eq('id', row.id);
    if (error) throw error;
  }
}

export async function resolveAndValidateItems(
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

// ===== Tickets RB =====
export async function rbCreateTicket(row: {
  id: string; guest_id: string; room: string; restaurant: 'rest1'|'rest2'|'multi';
  status: TicketStatus; priority: string; items: any; total_amount: number; notes?: string;
}){ const { error } = await supabase.from('tickets_rb').insert(row); if (error) throw error; }

export async function rbUpdateTicket(id: string, patch: Partial<{status: TicketStatus; priority:string; notes:string}>){
  const { error } = await supabase.from('tickets_rb').update({ ...patch, updated_at: nowISO() }).eq('id', id);
  if (error) throw error;
}

export async function rbGetTicket(id: string){
  const { data, error } = await supabase.from('tickets_rb').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as any | null;
}

export async function rbAddHistory(h: {request_id: string; status: string; actor: string; note?: string; feedback?: string}) {
  const { error } = await supabase
    .from('ticket_history_rb')
    .insert({ ...h, ts: nowISO() });
  if (error) throw error;
}

// ===== Cross-sell =====
export function pickCrossSellByCategory(
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

// ===== Feedback (compartido) =====
export async function addFeedback(rec: {
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
