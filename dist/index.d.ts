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
type ServiceType = 'food' | 'beverage' | 'maintenance';
interface AgentInput {
    action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service' | 'accept' | 'reject' | 'cancel';
    guest_id?: string;
    room?: string;
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
    service_feedback?: string;
    service_completed_by?: string;
    menu_category?: 'food' | 'beverage' | 'dessert';
    service_hours?: string;
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