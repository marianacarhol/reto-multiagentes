export type ServiceType = 'food' | 'beverage' | 'maintenance';
export type TicketStatus = 'CREADO' | 'ACEPTADA' | 'EN_PROCESO' | 'COMPLETADA' | 'RECHAZADA' | 'CANCELADO';
export type PriorityOut = {
    priority: 'low' | 'medium' | 'high';
    score: number;
    proba?: Record<string, number>;
    needs_review?: boolean;
    model?: string;
};
export type MenuRow = {
    restaurant: 'rest1' | 'rest2';
    id: string;
    name: string;
    price: number;
    category: 'food' | 'beverage' | 'dessert';
    available_start: string;
    available_end: string;
    stock_current: number;
    stock_minimum: number;
    is_active: boolean;
    cross_sell_items?: string[];
};
export type GuestRow = {
    id: string;
    nombre?: string | null;
    room?: string | null;
    spend_limit?: number | null;
};
export type ResolvedItem = {
    id: string;
    name: string;
    qty: number;
    price: number;
    restaurant: 'rest1' | 'rest2';
    category: 'food' | 'beverage' | 'dessert';
};
//# sourceMappingURL=types.d.ts.map