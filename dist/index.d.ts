/**
 * Agent-03 RoomService & Maintenance Tool (Enhanced Version) - CORREGIDO
 *
 * Funcionalidades completas:
 * - Menús dinámicos por hora/stock
 * - Cross-sell inteligente
 * - Confirmación de servicios
 * - Gestión de stock
 * - Políticas avanzadas
 *
 * @fileoverview Enhanced implementation for agent-03-roomservice-maintenance
 * @since 2.0.0
 */
import 'dotenv/config';
type ServiceType = 'food' | 'beverage' | 'maintenance';
interface AgentInput {
    action?: 'create' | 'assign' | 'status' | 'complete' | 'feedback' | 'get_menu' | 'confirm_service';
    guest_id: string;
    room: string;
    text?: string;
    type?: ServiceType;
    items?: Array<{
        name: string;
        qty?: number;
        price?: number;
        id?: string;
    }>;
    notes?: string;
    priority?: 'low' | 'normal' | 'high';
    now?: string;
    do_not_disturb?: boolean;
    guest_profile?: {
        tier?: 'standard' | 'gold' | 'platinum';
        daily_spend?: number;
        spend_limit?: number;
        preferences?: string[];
    };
    access_window?: {
        start: string;
        end: string;
    };
    issue?: string;
    severity?: 'low' | 'medium' | 'high';
    request_id?: string;
    service_rating?: number;
    service_feedback?: string;
    service_completed_by?: string;
}
interface AgentConfig {
    accessWindowStart?: string;
    accessWindowEnd?: string;
    api_key?: string;
    default_count?: number;
    enable_stock_check?: boolean;
    enable_cross_sell?: boolean;
    cross_sell_threshold?: number;
}
declare const tool: import("@ai-spine/tools-core").Tool<AgentInput, AgentConfig>;
export default tool;
//# sourceMappingURL=index.d.ts.map