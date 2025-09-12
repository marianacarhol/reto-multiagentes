import type { TicketStatus } from '../types';
import { nowISO } from '../utils/utils';
import { supabase } from './rbApi';

export async function mCreateTicket(row: {
  id: string; guest_id: string; room: string; issue: string; severity?: string;
  status: TicketStatus; priority: string; notes?: string;
  service_hours?: string | null;
  priority_score?: number; priority_model?: string; priority_proba?: any; needs_review?: boolean;
}) {
  const { error } = await supabase.from('tickets_m').insert(row);
  if (error) throw error;
}
export async function mGetTicket(id: string){
  const { data, error } = await supabase.from('tickets_m').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as any | null;
}
export async function mAddHistory(h: {request_id: string; status: string; actor: string; note?: string; feedback?: string; service_hours?: string}) {
  const { error } = await supabase
    .from('ticket_history_m')
    .insert({ ...h, ts: nowISO() });
  if (error) throw error;
}
