/**
 * Agent-03 RoomService & Maintenance Tool (Supabase-backed)
 *
 * Orquesta pedidos de A&B y tickets de mantenimiento:
 * - Clasificación (food | beverage | maintenance)
 * - Políticas (ventana de acceso, DND, límite de gasto)
 * - Despacho/estado e historial (persistente en Supabase)
 *
 * @fileoverview Main tool implementation for agent-03-roomservice-maintenance
 * @since 1.0.0
 */
import 'dotenv/config';
interface AgentInput {
    action?: 'create' | 'assign' | 'status' | 'complete' | 'feedback';
    guest_id: string;
    room: string;
    text?: string;
    type?: 'food' | 'beverage' | 'maintenance';
    items?: Array<{
        name: string;
        qty?: number;
        price?: number;
    }>;
    notes?: string;
    priority?: 'low' | 'normal' | 'high';
    now?: string;
    do_not_disturb?: boolean;
    guest_profile?: {
        tier?: 'standard' | 'gold' | 'platinum';
        daily_spend?: number;
        spend_limit?: number;
    };
    access_window?: {
        start: string;
        end: string;
    };
    issue?: string;
    severity?: 'low' | 'medium' | 'high';
    request_id?: string;
}
interface AgentConfig {
    accessWindowStart?: string;
    accessWindowEnd?: string;
    api_key?: string;
    default_count?: number;
}
declare const tool: import("@ai-spine/tools-core").Tool<AgentInput, AgentConfig>;
export default tool;
//# sourceMappingURL=index.d.ts.map