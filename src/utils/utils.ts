import 'dotenv/config';
import type { PriorityOut, ServiceType } from '../types';

// ===== Time and text utils =====
export const nowISO = () => new Date().toISOString();
const pad2 = (n: number) => String(n).padStart(2, '0');

export const hhmm = (nowStr?: string) => {
  const d = nowStr ? new Date(nowStr) : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const isInRange = (cur: string, start: string, end: string) =>
  start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);

export function toHHMM(s: string) { return s.toString().slice(0,5); }

export function normName(s?: string){
  return (s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim().replace(/\s+/g,' ');
}

// ===== Classify & mapping =====
export const classify = (text?: string, items?: Array<{name:string}>, explicit?: ServiceType): ServiceType => {
  if (explicit) return explicit;
  const blob = `${text ?? ''} ${(items ?? []).map(i=>i.name).join(' ')}`.toLowerCase();
  if (/(repair|leak|broken|fuga|mantenimiento|plomer|reparar|aire acondicionado|tv|luz|calefacci[oó]n|ducha|inodoro)/i.test(blob))
    return 'maintenance';
  if (/(beer|vino|coca|bebida|agua|jugo|drink|cerveza|whiskey|ron|vodka|cocktail)/i.test(blob))
    return 'beverage';
  return 'food';
};

export const mapArea = (type: ServiceType) =>
  type === 'maintenance' ? 'maintenance' : type === 'beverage' ? 'bar' : 'kitchen';

export const withinWindow = (
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

// ===== Priority API & rules =====
export const PRIORITY_API_URL = process.env.PRIORITY_API_URL || 'http://localhost:8000/predict';

export function calcEtaToSLA(params: {
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

export function hardRulesFallback(payload: { text?: string; vip?: boolean|number; eta_to_sla_min?: number; }): PriorityOut {
  const t = (payload.text || '').toLowerCase();
  const danger = /(fuga|leak|humo|incendio|chispa|descarga|sangre|shock|smoke|fire)/i.test(t);
  if (danger) return { priority: 'high', score: 95, model: 'rules' };
  const soon = (payload.eta_to_sla_min ?? 999) < 30;
  const vip = !!payload.vip;
  if (soon && vip) return { priority: 'high', score: 80, model: 'rules' };
  if (soon) return { priority: 'medium', score: 65, model: 'rules' };
  return { priority: 'low', score: 30, model: 'rules' };
}

export async function getPriorityFromAPI(input: {
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

// ===== CLI helpers =====
export function envBool(name: string, def = true) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return def;
  return ['1','true','t','yes','y','si','sí','on'].includes(raw);
}
export function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    // NOTA: readline se usa desde index.ts; la interfaz se mantiene igual
    const readline = require('readline') as typeof import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/n]: `, (answer: string) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes' || a === 's' || a === 'si' || a === 'sí');
    });
  });
}
