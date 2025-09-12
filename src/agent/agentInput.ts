import type { ServiceType } from '../types';

export interface AgentInput {
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
