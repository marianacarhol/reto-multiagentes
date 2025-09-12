import 'dotenv/config';
import type { PriorityOut, ServiceType } from '../types';
export declare const nowISO: () => string;
export declare const hhmm: (nowStr?: string) => string;
export declare const isInRange: (cur: string, start: string, end: string) => boolean;
export declare function toHHMM(s: string): string;
export declare function normName(s?: string): string;
export declare const classify: (text?: string, items?: Array<{
    name: string;
}>, explicit?: ServiceType) => ServiceType;
export declare const mapArea: (type: ServiceType) => "maintenance" | "bar" | "kitchen";
export declare const withinWindow: (nowStr: string | undefined, window: {
    start: string;
    end: string;
} | undefined, cfg: {
    start?: string;
    end?: string;
}, dnd?: boolean) => boolean;
export declare const PRIORITY_API_URL: string;
export declare function calcEtaToSLA(params: {
    domain: 'rb' | 'm';
    type?: ServiceType;
    createdAtISO?: string;
}): number;
export declare function hardRulesFallback(payload: {
    text?: string;
    vip?: boolean | number;
    eta_to_sla_min?: number;
}): PriorityOut;
export declare function getPriorityFromAPI(input: {
    text: string;
    domain: 'rb' | 'm';
    vip: 0 | 1;
    spend30d: number;
    eta_to_sla_min: number;
}): Promise<PriorityOut>;
export declare function envBool(name: string, def?: boolean): boolean;
export declare function askYesNo(question: string): Promise<boolean>;
//# sourceMappingURL=utils.d.ts.map