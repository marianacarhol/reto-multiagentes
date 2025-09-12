import type { GuestRow, MenuRow, ResolvedItem, TicketStatus } from '../types';
export declare const supabase: import("@supabase/supabase-js").SupabaseClient<any, "public", "public", any, any>;
export declare function dbGetGuestSpendLimit(guest_id: string): Promise<number | null | undefined>;
export declare function dbGetGuestById(guest_id: string): Promise<GuestRow | null>;
export declare function dbValidateGuestAndRoom(guest_id: string, room: string): Promise<GuestRow>;
export declare function dbGetSpentToday(guest_id: string): Promise<number>;
export declare function ledgerInsertOnce(rec: {
    domain: 'rb' | 'm';
    request_id: string;
    guest_id: string;
    amount: number;
}): Promise<void>;
export declare function decrementGuestLimitIfEnough(guest_id: string, amount: number): Promise<void>;
export declare function chargeGuestForRB(ticket: {
    id: string;
    guest_id: string;
    total_amount: number;
}): Promise<void>;
export declare function dbMenuUnion(): Promise<MenuRow[]>;
export declare function decrementStock(items: Array<{
    id?: string;
    name: string;
    restaurant?: 'rest1' | 'rest2';
    qty?: number;
}>): Promise<void>;
export declare function resolveAndValidateItems(rawItems: Array<{
    id?: string;
    name: string;
    qty?: number;
}>, nowStr?: string, enableStockCheck?: boolean): Promise<{
    items: ResolvedItem[];
    total: number;
    restSet: Set<'rest1' | 'rest2'>;
}>;
export declare function rbCreateTicket(row: {
    id: string;
    guest_id: string;
    room: string;
    restaurant: 'rest1' | 'rest2' | 'multi';
    status: TicketStatus;
    priority: string;
    items: any;
    total_amount: number;
    notes?: string;
}): Promise<void>;
export declare function rbUpdateTicket(id: string, patch: Partial<{
    status: TicketStatus;
    priority: string;
    notes: string;
}>): Promise<void>;
export declare function rbGetTicket(id: string): Promise<any>;
export declare function rbAddHistory(h: {
    request_id: string;
    status: string;
    actor: string;
    note?: string;
    feedback?: string;
}): Promise<void>;
export declare function pickCrossSellByCategory(menu: MenuRow[], chosen: Array<{
    id?: string;
    name: string;
    restaurant?: 'rest1' | 'rest2';
}>, opts: {
    nowHHMM: string;
    perCategoryCount: number;
    preferOppositeOf?: 'rest1' | 'rest2';
    explicitType?: 'food' | 'beverage' | 'maintenance';
    forbidSameCategoryIfPresent?: boolean;
}): any[];
export declare function addFeedback(rec: {
    domain: 'rb' | 'm';
    guest_id: string;
    request_id: string;
    message?: string;
}): Promise<void>;
//# sourceMappingURL=rbApi.d.ts.map