/**
 * Agent-03 RoomService & Maintenance Tool (Multi-Restaurant, Split Tables)
 * v2.2.0
 *
 * - Menús separados por restaurante (rest1/rest2) + vista menu_union
 * - Cross-sell entre restaurantes
 * - Tickets separados: tickets_rb / tickets_m + historiales
 * - Feedback usando tu tabla (ticket_id)
 * - Límite de gasto (perfil inline o tabla guests)
 * - Seguimiento de estado
 * - Descuento de stock al crear RB
 * - Prioridad simple (severity 'high' y feedback <= 2)
 * - Registro de consumo en spend_ledger (opcional; ignora si no existe)
 */
import 'dotenv/config';
type ServiceType = 'food' | 'beverage' | 'maintenance';
interface AgentInput {
    action?: 'get_menu' | 'create' | 'status' | 'complete' | 'assign' | 'feedback' | 'confirm_service';
    guest_id: string;
    room: string;
    restaurant?: 'rest1' | 'rest2';
    type?: ServiceType;
    items?: Array<{
        id?: string;
        name: string;
        qty?: number;
        price?: number;
        restaurant?: 'rest1' | 'rest2';
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
    api_key?: string;
    default_count?: number;
}
declare const tool: import("@ai-spine/tools-core").Tool<AgentInput, AgentConfig>;
export default tool;
//# sourceMappingURL=index.d.ts.map