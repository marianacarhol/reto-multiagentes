import type { TicketStatus } from '../types';
export declare function mCreateTicket(row: {
    id: string;
    guest_id: string;
    room: string;
    issue: string;
    severity?: string;
    status: TicketStatus;
    priority: string;
    notes?: string;
    service_hours?: string | null;
    priority_score?: number;
    priority_model?: string;
    priority_proba?: any;
    needs_review?: boolean;
}): Promise<void>;
export declare function mGetTicket(id: string): Promise<any>;
export declare function mAddHistory(h: {
    request_id: string;
    status: string;
    actor: string;
    note?: string;
    feedback?: string;
    service_hours?: string;
}): Promise<void>;
//# sourceMappingURL=maintenanceApi.d.ts.map