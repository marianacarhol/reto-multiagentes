"use strict";
/*
 * src/chatbot.ts
 * Chatbot Inteligente para "agent-03-roomservice-maintenance-enhanced"
 *
 * Descripción:
 * - Interfaz conversacional (HTTP + simple web UI) que recibe mensajes de usuarios,
 *   los convierte en 'input_data' válidos para la API del agente (/api/execute) y
 *   reenvía la respuesta del agente al usuario.
 * - Soporta dos modos de NLU:
 *   1) Si está presente la variable OPENAI_API_KEY -> usa la API de OpenAI (Chat Completions)
 *      para parsear el mensaje a JSON estructurado (acción + campos).
 *   2) Si no hay key -> fallback rule-based (regex / heurísticas simples).
 *
 * Requisitos:
 * - Node.js 18+ (fetch disponible globalmente)
 * - Instalar dependencias: `npm i express cors dotenv`
 * - (Opcional) Para desarrollo TS rápido: `npm i -D ts-node @types/express @types/node`
 *
 * Variables de entorno (opcional):
 * - TOOL_URL (por defecto: http://localhost:3000/api/execute)
 * - TOOL_API_KEY (si el agente exige autenticación)
 * - OPENAI_API_KEY (para NLU avanzada)
 * - PORT (puerto donde corre este chatbot, por defecto 4000)
 *
 * Uso rápido:
 * 1) Levanta tu agente: `npm run dev` o `node dist/index.js` (asegúrate que exponga /api/execute)
 * 2) Levanta este chatbot (TypeScript):
 *    - Con ts-node: `npx ts-node src/chatbot.ts`
 *    - Compilar y ejecutar: `npx tsc && node dist/chatbot.js`
 * 3) Interactúa vía curl / UI. Ejemplo:
 *    curl -X POST http://localhost:4000/chat -H "Content-Type: application/json" -d '{"sessionId":"s1","message":"Quiero ordenar 2 pizzas a la habitación 502, soy huésped 1001"}'
 *
 * Nota: el chatbot intenta inferir guest_id/room si no están presentes; hace una mejor suposición
 * cuando se provee el OPENAI_API_KEY.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
require("dotenv/config");
const express_1 = tslib_1.__importDefault(require("express"));
const cors_1 = tslib_1.__importDefault(require("cors"));
// --- Config ---
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const TOOL_URL = process.env.TOOL_URL || 'http://localhost:3000/api/execute';
const TOOL_API_KEY = process.env.TOOL_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const USE_OPENAI = !!OPENAI_API_KEY;
const MAX_HISTORY = 12;
const SESSIONS = new Map();
function getSession(id) {
    const sid = id || `sess-${Date.now()}`;
    if (!SESSIONS.has(sid))
        SESSIONS.set(sid, { id: sid, history: [] });
    return SESSIONS.get(sid);
}
function pushMessage(session, role, text) {
    session.history.push({ role, text });
    if (session.history.length > MAX_HISTORY)
        session.history.shift();
}
// --- Tool call ---
async function callTool(input_data) {
    try {
        const res = await fetch(TOOL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(TOOL_API_KEY ? { 'x-api-key': TOOL_API_KEY } : {}),
            },
            body: JSON.stringify({ input_data, config: {} }),
        });
        const text = await res.text();
        try {
            return { ok: res.ok, status: res.status, data: JSON.parse(text) };
        }
        catch (e) {
            return { ok: res.ok, status: res.status, raw: text };
        }
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
// --- Heuristic (fallback) NLU ---
function ruleBasedParse(message) {
    const m = message.toLowerCase();
    // intent
    let action;
    if (m.includes('menu') || m.includes('¿qué hay') || m.includes('ver carta') || m.includes('ver menú') || m.includes('ver menu'))
        action = 'get_menu';
    if (!action && (m.includes('estado') || m.includes('status') || /req-?\d+/.test(m) || /pedido\s*#?\d+/.test(m)))
        action = 'status';
    if (!action && (m.includes('terminado') || m.includes('completado') || m.includes('entregado') || m.includes('completar')))
        action = 'complete';
    if (!action && (m.includes('calificación') || m.includes('califica') || m.includes('feedback') || m.includes('opinion')))
        action = 'feedback';
    if (!action && (m.includes('confirmar') || m.includes('confirmación') || m.includes('confirmar servicio')))
        action = 'confirm_service';
    // Order/create
    if (!action && (m.includes('quiero') || m.includes('pedir') || m.includes('ordenar') || m.includes('trae') || m.includes('me trae') || m.includes('por favor')))
        action = 'create';
    // try extract room or guest id
    let room;
    const roomMatch = m.match(/habitaci[oó]n\s*(\d{2,4})/i) || m.match(/hab(?:\.|)\s*(\d{2,4})/i);
    if (roomMatch)
        room = roomMatch[1];
    let guest_id;
    const guestMatch = m.match(/hu[eé]sped\s*(#|:|)?\s*(\w+)/i);
    if (guestMatch)
        guest_id = guestMatch[2];
    // items: naive split by "y" / commas and numbers
    const items = [];
    // try to find patterns like '2 pizzas' or 'dos pizzas'
    const quantityWordMap = { 'dos': 2, 'tres': 3, 'una': 1, 'un': 1 };
    const itemRegex = /(?:(\d+)\s+|\b(dos|tres|una|un)\s+)?([a-záéíóúñ0-9\s-]{3,30})(?:,| y |\.|$)/gi;
    let it;
    while ((it = itemRegex.exec(message)) !== null) {
        const q = it[1] ? parseInt(it[1], 10) : (it[2] ? quantityWordMap[it[2]] || 1 : undefined);
        const name = it[3] ? it[3].trim() : '';
        if (name && name.length > 1)
            items.push({ name, qty: q || 1 });
    }
    return { action: action || 'create', guest_id, room, items: items.length ? items : undefined };
}
// --- OpenAI-based NLU: prompts the model requesting a strict JSON output ---
async function openaiParse(message, session) {
    if (!OPENAI_API_KEY)
        throw new Error('OPENAI_API_KEY no configurada');
    const system = `Eres un asistente que extrae INTENCIÓN y PARÁMETROS de mensajes de huéspedes para un servicio de Room Service y Mantenimiento de hotel.\n
Devuelve SOLO un objeto JSON válido con las siguientes claves (puedes omitir las que no apliquen):\n- action: one of [\"create\",\"assign\",\"status\",\"complete\",\"feedback\",\"get_menu\",\"confirm_service\"]\n- guest_id: string (si se puede)
- room: string (si se puede)
- type: one of [\"food\",\"beverage\",\"maintenance\"]\n- items: array of { name, qty } when aplica\n- notes: string (observaciones)
- request_id: string (si el usuario pregunta por un número de solicitud)\n
Ejemplos:\nUser: \"Quiero pedir 2 pizzas a la habitación 502, soy huésped 1001\"\n=> {\"action\":\"create\",\"guest_id\":\"1001\",\"room\":\"502\",\"type\":\"food\",\"items\":[{\"name\":\"pizza\",\"qty\":2}]}\n
User: \"¿Cuál es el estado del pedido REQ-1690000000000?\"\n=> {\"action\":\"status\",\"request_id\":\"REQ-1690000000000\"}

IMPORTANTE: Devuelve SOLO el JSON, sin texto adicional.`;
    const body = {
        model: process.env.LLM_MODEL || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: message },
        ],
        max_tokens: 400,
        temperature: 0,
    };
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
    });
    const j = await resp.json();
    const content = j?.choices?.[0]?.message?.content ?? '';
    // Try to find the JSON within content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
        throw new Error('OpenAI no devolvió JSON parseable');
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed;
    }
    catch (e) {
        throw new Error('Falló parseo JSON desde OpenAI: ' + e);
    }
}
// --- Parse pipeline (try OpenAI, fallback to rules) ---
async function parseMessageToInput(message, session) {
    try {
        if (USE_OPENAI) {
            const parsed = await openaiParse(message, session);
            return parsed;
        }
    }
    catch (err) {
        console.warn('OpenAI parse failed, falling back to rules:', err);
    }
    return ruleBasedParse(message);
}
// --- Small formatter for tool responses to user-friendly text ---
function formatToolResponse(toolResp) {
    if (!toolResp)
        return 'No hay respuesta del agente.';
    if (!toolResp.ok)
        return `Error al contactar al agente: ${toolResp.error ?? JSON.stringify(toolResp)}`;
    const d = toolResp.data ?? toolResp;
    // Try to create a concise message
    if (d?.status === 'success' && d?.data) {
        const dd = d.data;
        if (dd.request_id)
            return `✔️ Solicitud creada: ${dd.request_id}. Estado inicial: ${dd.status || 'ACEPTADA'}.`;
        if (dd.message)
            return dd.message;
        return `✔️ Acción completada. Respuesta: ${JSON.stringify(dd)}`;
    }
    if (d?.status === 'error' || !toolResp.ok)
        return `⚠️ Error del agente: ${JSON.stringify(d)}`;
    return JSON.stringify(d);
}
// --- Express app (endpoints) ---
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/', (_req, res) => {
    res.send(`
    <h2>Chatbot Inteligente - RoomService</h2>
    <p>POST /chat -> JSON { sessionId, message }</p>
    <p>Ejemplo: <code>curl -X POST http://localhost:${PORT}/chat -H 'Content-Type: application/json' -d '{"sessionId":"s1","message":"Quiero 2 hamburguesas a la 501"}'</code></p>
  `);
});
app.post('/chat', async (req, res) => {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== 'string')
        return res.status(400).json({ success: false, error: 'message is required' });
    const session = getSession(sessionId);
    pushMessage(session, 'user', message);
    // Parse message -> input_data for agent
    let inputData = { guest_id: session.guest_id || undefined };
    try {
        const parsed = await parseMessageToInput(message, session);
        // Merge parsed into inputData
        inputData = { ...inputData, ...parsed };
    }
    catch (err) {
        console.warn('parse error', err);
        inputData = { ...inputData, action: 'create', notes: message };
    }
    // Ensure required fields: guest_id
    if (!inputData.guest_id)
        inputData.guest_id = session.guest_id || 'GUEST-UNKNOWN';
    // Call the agent
    const toolResp = await callTool(inputData);
    const reply = formatToolResponse(toolResp);
    pushMessage(session, 'assistant', reply);
    res.json({ success: true, sessionId: session.id, reply, tool: toolResp });
});
// Simple endpoint to inspect session (for debugging) - not for production
app.get('/session/:id', (req, res) => {
    const s = SESSIONS.get(req.params.id);
    if (!s)
        return res.status(404).json({ error: 'session not found' });
    return res.json(s);
});
app.listen(PORT, () => {
    console.log(`🤖 Chatbot inteligente corriendo en http://localhost:${PORT}`);
    console.log(`🔗 Enviando peticiones al agente en: ${TOOL_URL}`);
    console.log(`🔐 TOOL_API_KEY: ${TOOL_API_KEY ? 'SET' : 'no set'}`);
    console.log(`🧠 OPENAI: ${USE_OPENAI ? 'enabled' : 'disabled (fallback rules)'}`);
});
//# sourceMappingURL=chatbot.js.map