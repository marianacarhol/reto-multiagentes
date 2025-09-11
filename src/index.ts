/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant)
 * v2.3.2 - Errores corregidos
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
  type ToolInput,
  type ToolConfig,
  type ToolExecutionContext,
} from '@ai-spine/tools';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { llmService } from './llm/llmService'; // Importar nuestro servicio LLM
import { createServer } from 'http';
import { URL } from 'url';


type ServiceType = 'food' | 'beverage' | 'maintenance';
type TicketStatus = 'CREADO' | 'ACEPTADA' | 'EN_PROCESO' | 'COMPLETADA';

interface AgentInput extends ToolInput {
  action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service';

  // Identidad básica
  guest_id: string;
  room: string;

  // ✨ NUEVAS PROPIEDADES AGREGADAS
  natural_request?: string;
  auto_analyze?: boolean;

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

interface AgentConfig extends ToolConfig {
  accessWindowStart?: string;
  accessWindowEnd?: string;
  enable_stock_check?: boolean;
  enable_cross_sell?: boolean;
  cross_sell_threshold?: number;

  // opciones de cross-sell por categoría
  cross_sell_per_category?: boolean;          // compat (no se usa si false)
  cross_sell_per_category_count?: number;     // 1..3 (default 1)
  cross_sell_prefer_opposite?: boolean;       // prioriza opuesto SOLO si el ticket no es multi

  // LLM
  enable_llm?: boolean;
  llm_auto_analyze?: boolean;
  llm_confidence_threshold?: number; // Umbral mínimo de confianza
  llm_fallback_to_manual?: boolean;  // Fallback si LLM falla

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

// ✨ NUEVO: Helper para análisis inteligente
async function smartAnalyzeRequest(
  naturalRequest: string,
  guest_id: string,
  room: string,
  config: AgentConfig
): Promise<{ 
  agentInput: AgentInput | null; 
  response: string; 
  analysis: any; 
  confidence: number 
}> {
  try {
    // Obtener menú disponible para contexto
    const menu = await dbMenuUnion();
    const availableItems = menu
      .filter(m => m.is_active && m.stock_current > m.stock_minimum)
      .map(m => ({ name: m.name, restaurant: m.restaurant, category: m.category }));

    // Análisis LLM
    const analysis = await llmService.analyzeGuestRequest(naturalRequest, {
      guest_id,
      room,
      time: new Date().toISOString(),
      available_menu: availableItems
    });

    console.log('[SMART] LLM Analysis:', analysis);

    // Verificar confianza mínima
    const threshold = config.llm_confidence_threshold ?? 0.5;
    if (analysis.confidence < threshold) {
      return {
        agentInput: null,
        response: await llmService.generateGuestResponse(
          `El huésped solicita: "${naturalRequest}". Responde que necesitas más información específica para ayudarle mejor.`
        ),
        analysis,
        confidence: analysis.confidence
      };
    }

    // Convertir análisis a formato del agente
    const agentInput = llmService.analysisToAgentInput(analysis, guest_id, room, naturalRequest);
    
    if (!agentInput) {
      // Es una consulta/queja, no un servicio
      const response = await llmService.generateGuestResponse(
        `El huésped dice: "${naturalRequest}". Responde de forma útil y profesional.`,
        { intent: analysis.intent }
      );
      return { agentInput: null, response, analysis, confidence: analysis.confidence };
    }

    // Generar respuesta de confirmación
    const confirmationPrompt = analysis.intent === 'maintenance' 
      ? `El huésped reporta un problema: "${analysis.issue_description}". Confirma que atenderemos el problema.`
      : `El huésped solicita room service: ${analysis.items?.map(i => `${i.quantity}x ${i.name}`).join(', ')}. Confirma la orden.`;

    const response = await llmService.generateGuestResponse(confirmationPrompt, {
      intent: analysis.intent,
      items: analysis.items
    });

    return { agentInput, response, analysis, confidence: analysis.confidence };

  } catch (error) {
    console.error('[SMART] Analysis failed:', error);
    
    if (config.llm_fallback_to_manual) {
      return {
        agentInput: {
          guest_id,
          room,
          text: naturalRequest,
          action: 'create'
        },
        response: 'He recibido tu solicitud. La procesaré manualmente para asegurarme de ayudarte correctamente.',
        analysis: null,
        confidence: 0
      };
    }

    throw error;
  }
}

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
  const chosenRows: MenuRow[] = [];
  
  for (const it of chosen) {
    if (it.id) {
      const foundById = menu.find(m => m.id === it.id);
      if (foundById) chosenRows.push(foundById);
    } else {
      const nn = normName(it.name);
      const foundByName = byName.get(nn);
      if (foundByName) chosenRows.push(foundByName);
    }
  }

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
      const itemI = pool[i];
      const itemJ = pool[j];
      if (itemI && itemJ) {
        pool[i] = itemJ;
        pool[j] = itemI;
      }
    }
    const count = Math.max(1, Math.min(3, opts.perCategoryCount));
    for (const r of pool.slice(0, count)) {
      picks.push({ restaurant: r.restaurant, id: r.id, name: r.name, price: r.price, category: r.category });
    }
  }

  return picks;
}

// ============ Tool ============
const tool = createTool({
  metadata: {
    name: 'agent-03-roomservice-maintenance-split',
    version: '2.3.2',
    description: 'Room Service (rest1/rest2) + Maintenance con tablas separadas y cross-sell inter-restaurantes (multi-enabled)',
    capabilities: ['dynamic-menu','intelligent-cross-sell','ticket-tracking','feedback','policy-check'],
    author: 'Equipo A3',
    license: 'MIT',
  },

  schema: {
    input: {
      action: stringField({ required: false, enum: ['get_menu','create','status','complete','assign','feedback','confirm_service'], default: 'create' }),
      guest_id: stringField({ required: true }),
      room: stringField({ required: true }),

      natural_request: stringField({ required: false, description: 'Solicitud en lenguaje natural del huésped' }),
      auto_analyze: booleanField({ required: false, default: false, description: 'Activar análisis automático con LLM' }),

      restaurant: stringField({ required: false, enum: ['rest1','rest2','multi'] }), // acepta multi
      type: stringField({ required: false, enum: ['food','beverage','maintenance'] }),
      items: {
        type: 'array', 
        required: false, 
        items: {
          type: 'object', 
          required: false,
          properties: {
            id: stringField({ required: false }),          // opcional
            name: stringField({ required: true }),         // requerido
            qty: numberField({ required: false, default: 1, min: 1 }), // cantidad
          }
        }
      },

      issue: stringField({ required: false }),
      severity: stringField({ required: false, enum: ['low','medium','high'] }),

      text: stringField({ required: false }),
      notes: stringField({ required: false }),
      priority: stringField({ required: false, default: 'normal', enum: ['low','normal','high'] }),

      now: stringField({ required: false }),
      do_not_disturb: booleanField({ required: false }),
      guest_profile: {
        type: 'object', 
        required: false, 
        properties: {
          tier: stringField({ required: false, enum: ['standard','gold','platinum'] }),
          daily_spend: numberField({ required: false, min: 0 }),
          spend_limit: numberField({ required: false, min: 0 }),
          preferences: { 
            type: 'array', 
            required: false, 
            items: stringField({ required: false })
          }
        }
      },
      access_window: {
        type: 'object', 
        required: false, 
        properties: {
          start: stringField({ required: true }),
          end: stringField({ required: true }),
        }
      },

      request_id: stringField({ required: false }),
      service_rating: numberField({ required: false, min: 1, max: 5 }),
      service_feedback: stringField({ required: false }),
      service_completed_by: stringField({ required: false }),

      menu_category: stringField({ required: false, enum: ['food','beverage','dessert'] }),
    },

  config: {
    accessWindowStart: { type: 'string', required: false },
    accessWindowEnd: { type: 'string', required: false },
    enable_stock_check: { type: 'boolean', required: false, default: true },
    enable_cross_sell: { type: 'boolean', required: false, default: true },
    cross_sell_threshold: { type: 'number', required: false, default: 1 },
    cross_sell_per_category: { type: 'boolean', required: false, default: true },
    cross_sell_per_category_count: { type: 'number', required: false, default: 1 },
    cross_sell_prefer_opposite: { type: 'boolean', required: false, default: true },
    api_key: { type: 'string', required: false },
    default_count: { type: 'number', required: false, default: 1 },
    enable_llm: { type: 'boolean', required: false, default: true },
    llm_auto_analyze: { type: 'boolean', required: false, default: true },
    llm_confidence_threshold: { type: 'number', required: false, default: 0.5},
    llm_fallback_to_manual: { type: 'boolean', required: false, default: true },
    },
  },

  async execute (input: ToolInput, config: ToolConfig, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    // Cast types to our extended interfaces
    const agentInput = input as AgentInput;
    const agentConfig = config as AgentConfig;
    
    const { action = 'create', guest_id, room } = agentInput;

    if (!guest_id || !room || typeof guest_id !== 'string' || typeof room !== 'string') {
      return { 
        status: 'error', 
        error: { 
          code: 'VALIDATION_ERROR', 
          message: 'guest_id y room son requeridos (string)',
          type: 'validation_error'
        } 
      };
    }

    try {
      // ✨ Auto-análisis en create normal si hay natural_request
      if (action === 'create' && agentInput.natural_request && (agentConfig.enable_llm !== false)) {
        if (!agentInput.natural_request) {
          return { 
            status: 'error', 
            error: { 
              code: 'MISSING_NATURAL_REQUEST', 
              message: 'natural_request es requerido para smart_create',
              type: 'validation_error'
            } 
          };
        }

        const smartResult = await smartAnalyzeRequest(
          agentInput.natural_request,
          guest_id,
          room,
          agentConfig
        );

        if (!smartResult.agentInput) {
          // Es una consulta/queja, no crear ticket
          return {
            status: 'success',
            data: {
              type: 'inquiry',
              response: smartResult.response,
              analysis: smartResult.analysis,
              confidence: smartResult.confidence,
              no_ticket_created: true
            }
          };
        }

        // Ejecutar creación automática con los datos analizados
        const result = await executeAction(smartResult.agentInput, agentConfig);
        
        if (result.status === 'success') {
          // Enriquecer respuesta con información LLM
          return {
            status: 'success',
            data: {
              ...result.data,
              llm_analysis: smartResult.analysis,
              llm_confidence: smartResult.confidence,
              intelligent_response: smartResult.response,
              original_request: agentInput.natural_request
            }
          };
        }

        return result;
      }

      // ✨ Auto-análisis en create normal si hay natural_request
      if (action === 'create' && agentInput.natural_request && agentInput.auto_analyze && agentConfig.llm_auto_analyze) {
        try {
          const analysis = await llmService.analyzeGuestRequest(agentInput.natural_request, {
            guest_id, 
            room, 
            time: agentInput.now || new Date().toISOString()
          });

          if (analysis.confidence > (agentConfig.llm_confidence_threshold ?? 0.5)) {
            const enhancedInput = llmService.analysisToAgentInput(analysis, guest_id, room, agentInput.natural_request);
            if (enhancedInput) {
              // Merge con input original, dando prioridad a datos explícitos
              Object.assign(enhancedInput, agentInput);
              return await executeAction(enhancedInput, agentConfig);
            }
          }
        } catch (error) {
          console.warn('[LLM] Auto-analysis failed, continuing with original input:', error);
        }
      }

      return await executeAction(agentInput, agentConfig);

    } catch (e: any) {
      console.error('ERROR:', e?.message || e);
      return { 
        status: 'error', 
        error: { 
          code: 'INTERNAL_DB_ERROR', 
          message: String(e?.message || e),
          type: 'execution_error'
        } 
      };
    }
  },
});

// Función auxiliar para ejecutar acciones
// Función auxiliar para ejecutar acciones
async function executeAction(input: AgentInput, config: AgentConfig): Promise<ToolExecutionResult> {
  const { action = 'create', guest_id, room } = input;

  // Debug existente
  console.log('=== DEBUG executeAction ===');
  console.log('Action:', action);
  console.log('Natural request:', input.natural_request);
  console.log('Enable LLM:', config.enable_llm);
  
  // Debug para condiciones LLM
  console.log('=== DEBUG LLM CONDITIONS ===');
  console.log('action === create:', action === 'create');
  console.log('has natural_request:', !!input.natural_request);
  console.log('enable_llm !== false:', config.enable_llm !== false);
  console.log('Should trigger LLM:', action === 'create' && input.natural_request && (config.enable_llm !== false));
  console.log('==============================');

  // Determine domain by classification (once)
  const type = classify(input.text, input.items, input.type);
  const area = mapArea(type);

  // ---- GET MENU
  if (action === 'get_menu') {
    const menu = await dbMenuUnion();
    const cur = hhmm(input.now);

    const filtered = menu.filter(m =>
      (!input.menu_category || m.category === input.menu_category) &&
      m.is_active &&
      (!config.enable_stock_check || m.stock_current > m.stock_minimum) &&
      isInRange(cur, m.available_start.toString().slice(0,5), m.available_end.toString().slice(0,5))
    );

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

  // ---- CREATE
  if (action === 'create') {
    try {
      // Auto-análisis en create normal si hay natural_request
      if (action === 'create' && input.natural_request && (config.enable_llm !== false)) {
        console.log('🚀 ENTERING LLM ANALYSIS BLOCK');
        
        if (!input.natural_request) {
          return { 
            status: 'error', 
            error: { 
              code: 'MISSING_NATURAL_REQUEST', 
              message: 'natural_request es requerido para smart_create',
              type: 'validation_error'
            } 
          };
        }

        console.log('🔍 Calling smartAnalyzeRequest...');
        const smartResult = await smartAnalyzeRequest(
          input.natural_request,
          guest_id,
          room,
          config
        );

        if (!smartResult.agentInput) {
          // Es una consulta/queja, no crear ticket
          console.log('📋 LLM determined this is an inquiry, not a service request');
          return {
            status: 'success',
            data: {
              type: 'inquiry',
              response: smartResult.response,
              analysis: smartResult.analysis,
              confidence: smartResult.confidence,
              no_ticket_created: true
            }
          };
        }

        // Ejecutar creación automática con los datos analizados
        console.log('🎯 LLM analysis successful, executing automatic creation...');
        const result = await executeAction(smartResult.agentInput, config);
        
        if (result.status === 'success') {
          // Enriquecer respuesta con información LLM
          return {
            status: 'success',
            data: {
              ...result.data,
              llm_analysis: smartResult.analysis,
              llm_confidence: smartResult.confidence,
              intelligent_response: smartResult.response,
              original_request: input.natural_request
            }
          };
        }

        return result;
      }

      // Auto-análisis en create normal si hay natural_request y auto_analyze
      if (action === 'create' && input.natural_request && input.auto_analyze && config.llm_auto_analyze) {
        console.log('🔄 Executing auto-analysis mode...');
        try {
          const analysis = await llmService.analyzeGuestRequest(input.natural_request, {
            guest_id, 
            room, 
            time: input.now || new Date().toISOString()
          });

          if (analysis.confidence > (config.llm_confidence_threshold ?? 0.5)) {
            const enhancedInput = llmService.analysisToAgentInput(analysis, guest_id, room, input.natural_request);
            if (enhancedInput) {
              // Merge con input original, dando prioridad a datos explícitos
              Object.assign(enhancedInput, input);
              return await executeAction(enhancedInput, config);
            }
          }
        } catch (error) {
          console.warn('[LLM] Auto-analysis failed, continuing with original input:', error);
        }
      }

      console.log('📝 Proceeding with standard processing (no LLM)...');

      if (type === 'food' || type === 'beverage') {
        // Policies: ventana + DND
        const windowConfig = {
          ...(config.accessWindowStart && { start: config.accessWindowStart }),
          ...(config.accessWindowEnd && { end: config.accessWindowEnd })
        };
        
        const okWindow = withinWindow(
          input.now,
          input.access_window,
          windowConfig,
          input.do_not_disturb
        );
        
        if (!okWindow) {
          return { 
            status: 'error', 
            error: { 
              code: 'ACCESS_WINDOW_BLOCK', 
              message: 'Fuera de ventana o DND activo',
              type: 'validation_error'
            } 
          };
        }

        // construir items desde BD (precio/horario/stock/restaurante)
        const rawItems = input.items ?? [];
        if (!input.restaurant && rawItems.length === 0) {
          return { 
            status: 'error', 
            error: { 
              code: 'VALIDATION_ERROR', 
              message: 'Provee al menos un ítem',
              type: 'validation_error'
            } 
          };
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
          return { 
            status: 'error', 
            error: { 
              code: 'ITEMS_UNAVAILABLE', 
              message: String(e?.message || e),
              type: 'validation_error'
            } 
          };
        }

        // límite de gasto usando TOTAL real (de BD)
        let spendLimit = input.guest_profile?.spend_limit;
        if (spendLimit == null) {
          const fromGuest = await dbGetGuestSpendLimit(guest_id);
          if (typeof fromGuest === 'number') spendLimit = Number(fromGuest);
        }
        const dailySpend = input.guest_profile?.daily_spend ?? 0;
        if (spendLimit != null && (dailySpend + total) > spendLimit) {
          return { 
            status: 'error', 
            error: { 
              code: 'SPEND_LIMIT', 
              message: 'Límite de gasto excedido',
              type: 'validation_error'
            } 
          };
        }

        // etiqueta restaurante del ticket
        const anchor = (input.restaurant === 'rest1' || input.restaurant === 'rest2') ? input.restaurant : undefined;
        const ticketRestaurant:
          'rest1'|'rest2'|'multi' =
            input.restaurant === 'multi' ? 'multi'
            : restSet.size > 1 ? 'multi'
            : restSet.size === 1 ? Array.from(restSet)[0] as ('rest1'|'rest2')
            : anchor ?? 'multi';

        // crear ticket con items RESUELTOS (incluye price y restaurant ya validados)
        const id = `REQ-${Date.now()}`;
        const ticketData = {
          id,
          guest_id,
          room,
          restaurant: ticketRestaurant,
          status: 'CREADO' as TicketStatus,
          priority: input.priority ?? 'normal',
          items: resolved,
          total_amount: total,
          ...(input.notes && { notes: input.notes })
        };
        
        await rbCreateTicket(ticketData);
        await rbAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });
        await rbUpdateTicket(id, { status: 'ACEPTADA' });
        await rbAddHistory({ request_id: id, status: 'ACEPTADA', actor: ticketRestaurant });

        // "Ping" a cada restaurante involucrado (para visibilidad operacional)
        for (const r of restSet) {
          await rbAddHistory({ request_id: id, status: 'ACEPTADA', actor: r! });
        }

        // descuento de stock + consumo
        await decrementStock(resolved.map(r => ({ id: r.id, name: r.name, restaurant: r.restaurant, qty: r.qty })));
        if (total > 0) await addDailySpend(guest_id, total);

        // cross-sell (si NO es multi, prioriza opuesto; si es multi, neutral)
        let cross: any[] = [];
        if (config.enable_cross_sell && resolved.length >= (config.cross_sell_threshold ?? 1)) {
          const preferOpposite = (ticketRestaurant === 'rest1' || ticketRestaurant === 'rest2') && config.cross_sell_prefer_opposite
            ? (ticketRestaurant === 'rest1' ? 'rest2' : 'rest1')
            : undefined;

          const menu = await dbMenuUnion();
          const crossSellOpts: {
            nowHHMM: string;
            perCategoryCount: number;
            preferOppositeOf?: 'rest1' | 'rest2';
            explicitType?: 'food' | 'beverage' | 'maintenance';
            forbidSameCategoryIfPresent?: boolean;
          } = {
            nowHHMM: hhmm(input.now),
            perCategoryCount: Math.max(1, Math.min(3, config.cross_sell_per_category_count ?? 1)),
            forbidSameCategoryIfPresent: true
          };

          if (preferOpposite) {
            crossSellOpts.preferOppositeOf = preferOpposite;
          }

          if (input.type) {
            crossSellOpts.explicitType = input.type;
          }
          
          cross = pickCrossSellByCategory(menu, resolved, crossSellOpts);
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
        return { 
          status: 'error', 
          error: { 
            code: 'MISSING_ISSUE', 
            message: 'Describe el issue de mantenimiento',
            type: 'validation_error'
          } 
        };
      }

      const computedPriority = (input.severity === 'high') ? 'high' : (input.priority ?? 'normal');
      const id = `REQ-${Date.now()}`;
      const maintenanceTicketData = {
        id,
        guest_id,
        room,
        issue: input.issue,
        ...(input.severity && { severity: input.severity }),
        status: 'CREADO' as TicketStatus,
        priority: computedPriority,
        ...(input.notes && { notes: input.notes })
      };
      
      await mCreateTicket(maintenanceTicketData);
      await mAddHistory({ request_id: id, status: 'CREADO', actor: 'system' });
      await mUpdateTicket(id, { status: 'ACEPTADA' });
      await mAddHistory({ request_id: id, status: 'ACEPTADA', actor: 'maintenance' });

      return { status: 'success', data: { request_id: id, domain: 'm', type, area, status: 'ACEPTADA' } };

    } catch (e: any) {
      console.error('ERROR in executeAction CREATE:', e?.message || e);
      return { 
        status: 'error', 
        error: { 
          code: 'INTERNAL_DB_ERROR', 
          message: String(e?.message || e),
          type: 'execution_error'
        } 
      };
    }
  }

  // ---- Acciones posteriores (status/complete/assign/feedback/confirm)
  if (!input.request_id) {
    return { 
      status: 'error', 
      error: { 
        code: 'MISSING_REQUEST_ID', 
        message: 'request_id es requerido',
        type: 'validation_error'
      } 
    };
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
        const historyData = {
          request_id: input.request_id,
          status: 'COMPLETADA',
          actor: input.service_completed_by || rb.restaurant,
          ...(input.service_feedback && { 
            note: `Rating: ${input.service_rating ?? ''} - ${input.service_feedback}` 
          })
        };
        await rbAddHistory(historyData);
      }
      if (input.service_rating || input.service_feedback) {
        const feedbackData = {
          domain: 'rb' as const,
          guest_id,
          request_id: input.request_id,
          ...(input.service_feedback && { message: input.service_feedback }),
          ...(input.service_rating && { rating: input.service_rating })
        };
        await addFeedback(feedbackData);

        if ((input.service_rating ?? 5) <= 2 && rb.status !== 'COMPLETADA') {
          await rbUpdateTicket(input.request_id, { priority: 'high' });
          await rbAddHistory({ request_id: input.request_id, status: rb.status, actor: 'system', note: 'Escalado por feedback negativo' });
        }
      }
      return { status: 'success', data: { request_id: input.request_id, domain: 'rb', status: action === 'confirm_service' ? 'COMPLETADA' : rb.status, feedbackSaved: !!(input.service_rating || input.service_feedback) } };
    }
    return { 
      status: 'error', 
      error: { 
        code: 'UNKNOWN_ACTION', 
        message: 'Acción no soportada para RB',
        type: 'validation_error'
      } 
    };
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
        const historyData = {
          request_id: input.request_id,
          status: 'COMPLETADA',
          actor: input.service_completed_by || 'maintenance',
          ...(input.service_feedback && { 
            note: `Rating: ${input.service_rating ?? ''} - ${input.service_feedback}` 
          })
        };
        await mAddHistory(historyData);
      }
      if (input.service_rating || input.service_feedback) {
        const feedbackData = {
          domain: 'm' as const,
          guest_id,
          request_id: input.request_id,
          ...(input.service_feedback && { message: input.service_feedback }),
          ...(input.service_rating && { rating: input.service_rating })
        };
        await addFeedback(feedbackData);

        if ((input.service_rating ?? 5) <= 2 && mt.status !== 'COMPLETADA') {
          await mUpdateTicket(input.request_id, { priority: 'high' });
          await mAddHistory({ request_id: input.request_id, status: mt.status, actor: 'system', note: 'Escalado por feedback negativo' });
        }
      }
      return { status: 'success', data: { request_id: input.request_id, domain: 'm', status: action === 'confirm_service' ? 'COMPLETADA' : mt.status, feedbackSaved: !!(input.service_rating || input.service_feedback) } };
    }
    return { 
      status: 'error', 
      error: { 
        code: 'UNKNOWN_ACTION', 
        message: 'Acción no soportada para M',
        type: 'validation_error'
      } 
    };
  }

  return { 
    status: 'error', 
    error: { 
      code: 'NOT_FOUND', 
      message: 'request_id no existe ni en RB ni en M',
      type: 'validation_error'
    } 
  };
}

// ============ Server bootstrap ============
async function main(){
  try{
    // Debug de variables de entorno
    console.log('=== Environment Variables Check ===');
    console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
    console.log('Has SUPABASE_SERVICE_ROLE:', !!process.env.SUPABASE_SERVICE_ROLE);
    console.log('Has OPENAI_API_KEY:', !!process.env.OPENAI_API_KEY);
    console.log('=====================================');
    
    const port = parseInt(process.env.PORT || '3000');

    const server = createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '', `http://localhost:${port}`);
      
      // Health endpoint
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

// Execute endpoint
      if (url.pathname === '/api/execute' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {

          try {
            const data = JSON.parse(body);
            const { input_data } = data;

            // Debug logs...
            console.log('=== DEBUG SERVER ===');
            console.log('Input data:', JSON.stringify(input_data, null, 2));
      
            if (!input_data) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
              status: 'error',
              error: { code: 'MISSING_INPUT_DATA', message: 'input_data is required' }
            }));
          return;
        }

      // ESTA LÍNEA DEBE ESTAR AQUÍ DENTRO DEL TRY
      const result = await executeAction(input_data as AgentInput, {
        enable_llm: true,
        llm_auto_analyze: true,
        llm_confidence_threshold: 0.5,
        llm_fallback_to_manual: true
      } as AgentConfig);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      
    } catch (error) {
      console.error('API Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
      }));
    }
  });
  return;
}

      // 404 para otras rutas
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, () => {
      console.log('🚀 Agent-03 RS&M split server ready');
      console.log(`Health:  http://localhost:${port}/health`);
      console.log(`Execute: http://localhost:${port}/api/execute`);
    });

  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
}

process.on('SIGINT', async () => { console.log('SIGINT'); process.exit(0); });
process.on('SIGTERM', async () => { console.log('SIGTERM'); process.exit(0); });

if (require.main === module) { main(); }

export default tool;