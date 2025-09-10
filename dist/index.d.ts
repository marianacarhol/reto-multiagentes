/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant)
 * v2.3.1
 * - Menú dinámico por restaurante (rest1/rest2) con horarios
 * - Ítems de entrada: sólo name (+qty opcional); precio/stock/horario/restaurant desde BD
 * - Tickets RB/M, feedback y cross-sell
 */
import 'dotenv/config';
type ServiceType = 'food' | 'beverage' | 'maintenance';
interface AgentInput {
    action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service';
    guest_id: string;
    room: string;
    restaurant?: 'rest1' | 'rest2' | 'multi';
    type?: ServiceType;
    items?: Array<{
        id?: string;
        name: string;
        qty?: number;
    }>;
    issue?: string;
    severity?: 'low' | 'medium' | 'high';
    text?: string;
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
    request_id?: string;
    service_rating?: number;
    service_feedback?: string;
    service_completed_by?: string;
    menu_category?: 'food' | 'beverage' | 'dessert';
}
interface AgentConfig {
    accessWindowStart?: string;
    accessWindowEnd?: string;
    enable_stock_check?: boolean;
    enable_cross_sell?: boolean;
    cross_sell_threshold?: number;
    cross_sell_per_category?: boolean;
    cross_sell_per_category_count?: number;
    cross_sell_prefer_opposite?: boolean;
    api_key?: string;
    default_count?: number;
}
declare const tool: import("@ai-spine/tools-core").Tool<AgentInput, AgentConfig>;
export default tool;
//# sourceMappingURL=index.d.ts.map