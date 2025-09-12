"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mCreateTicket = mCreateTicket;
exports.mGetTicket = mGetTicket;
exports.mAddHistory = mAddHistory;
const utils_1 = require("../utils/utils");
const rbApi_1 = require("./rbApi");
async function mCreateTicket(row) {
    const { error } = await rbApi_1.supabase.from('tickets_m').insert(row);
    if (error)
        throw error;
}
async function mGetTicket(id) {
    const { data, error } = await rbApi_1.supabase.from('tickets_m').select('*').eq('id', id).maybeSingle();
    if (error)
        throw error;
    return data;
}
async function mAddHistory(h) {
    const { error } = await rbApi_1.supabase
        .from('ticket_history_m')
        .insert({ ...h, ts: (0, utils_1.nowISO)() });
    if (error)
        throw error;
}
//# sourceMappingURL=maintenanceApi.js.map