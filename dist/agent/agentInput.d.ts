import type { ServiceType } from '../types';
export interface AgentInput {
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
//# sourceMappingURL=agentInput.d.ts.map