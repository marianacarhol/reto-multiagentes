"use strict";
/*
 * src/chatbot-ws.ts
 * Paso 1: Chat UI simple + comunicación en tiempo real (WebSocket) usando Socket.IO
 *
 * - Sirve una UI minimalista en GET / (HTML embedido)
 * - Expone el endpoint POST /chat (compatibilidad con la versión anterior)
 * - Abre un servidor Socket.IO que acepta eventos 'user_message' y responde con 'bot_reply'
 * - Reusa la pipeline de parseo (OpenAI si está configurado, fallback a reglas)
 *
 * Instrucciones rápidas:
 * 1) Instala dependencias:
 *    npm install express cors dotenv socket.io
 *    npm i -D ts-node typescript @types/node @types/express @types/cors
 *
 * 2) Asegúrate de que tu agente (tool) esté corriendo en TOOL_URL (por defecto http://localhost:3000/api/execute)
 * 3) (Opcional) crea .env con TOOL_URL, TOOL_API_KEY, OPENAI_API_KEY, PORT
 * 4) Ejecuta:
 *    npx ts-node src/chatbot-ws.ts
 * 5) Abre http://localhost:4000 en tu navegador para la UI de chat en tiempo real.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
require("dotenv/config");
const express_1 = tslib_1.__importDefault(require("express"));
const cors_1 = tslib_1.__importDefault(require("cors"));
const http_1 = tslib_1.__importDefault(require("http"));
const socket_io_1 = require("socket.io");
// --- Config ---
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const TOOL_URL = process.env.TOOL_URL || 'http://localhost:3000/api/execute';
const TOOL_API_KEY = process.env.TOOL_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const USE_OPENAI = !!OPENAI_API_KEY;
const MAX_HISTORY = 24;
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
// --- Call the agent/tool ---
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
// --- Heuristic NLU (fallback) ---
function ruleBasedParse(message) {
    const m = message.toLowerCase();
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
    if (!action && (m.includes('quiero') || m.includes('pedir') || m.includes('ordenar') || m.includes('trae') || m.includes('me trae') || m.includes('por favor')))
        action = 'create';
    let room;
    const roomMatch = m.match(/habitaci[oó]n\s*(\d{2,4})/i) || m.match(/hab(?:\.|)\s*(\d{2,4})/i);
    if (roomMatch)
        room = roomMatch[1];
    let guest_id;
    const guestMatch = m.match(/hu[eé]sped\s*(#|:|)?\s*(\w+)/i);
    if (guestMatch)
        guest_id = guestMatch[2];
    const items = [];
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
// --- OpenAI-based NLU (if configured) ---
async function openaiParse(message, session) {
    if (!OPENAI_API_KEY)
        throw new Error('OPENAI_API_KEY no configurada');
    const system = `Eres un asistente que extrae INTENCIÓN y PARÁMETROS de mensajes de huéspedes para un servicio de Room Service y Mantenimiento de hotel.\n
Devuelve SOLO un objeto JSON válido con las siguientes claves (puedes omitir las que no apliquen):\n- action: one of [\"create\",\"assign\",\"status\",\"complete\",\"feedback\",\"get_menu\",\"confirm_service\"]\n- guest_id: string (si se puede)\n- room: string (si se puede)\n- type: one of [\"food\",\"beverage\",\"maintenance\"]\n- items: array of { name, qty } cuando aplica\n- notes: string (observaciones)\n- request_id: string (si el usuario pregunta por un número de solicitud)\n\nIMPORTANTE: Devuelve SOLO el JSON, sin texto adicional.`;
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
// --- Response formatter ---
function formatToolResponse(toolResp) {
    if (!toolResp)
        return 'No hay respuesta del agente.';
    if (!toolResp.ok)
        return `Error al contactar al agente: ${toolResp.error ?? JSON.stringify(toolResp)}`;
    const d = toolResp.data ?? toolResp;
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
// --- Express + Socket.IO server + UI ---
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Simple UI served at /
app.get('/', (_req, res) => {
    res.type('html').send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Chat - RoomService (WS)</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 760px; margin: 20px auto; }
    #messages { border: 1px solid #ccc; padding: 12px; height: 400px; overflow:auto; }
    .msg { margin:8px 0; }
    .user { text-align:right; }
    .bot { text-align:left; }
    .meta { font-size: 0.8em; color: #666 }
    form { margin-top:8px; display:flex; }
    input[type=text]{flex:1;padding:8px}
    button{padding:8px 12px}
  </style>
</head>
<body>
  <h2>Chat en tiempo real - RoomService</h2>
  <div id="messages"></div>
  <form id="fm"><input id="inp" autocomplete="off" placeholder="Escribe tu mensaje..." /><button>Enviar</button></form>
  <p>Conexión: <span id="status">desconectado</span></p>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const messages = document.getElementById('messages');
    const status = document.getElementById('status');
    const fm = document.getElementById('fm');
    const inp = document.getElementById('inp');

    function append(text, cls='bot'){
      const d = document.createElement('div'); d.className='msg '+cls; d.innerHTML = text; messages.appendChild(d); messages.scrollTop = messages.scrollHeight;
    }

    const socket = io();
    socket.on('connect', ()=>{ status.textContent='conectado'; console.log('connected', socket.id); });
    socket.on('disconnect', ()=>{ status.textContent='desconectado'; });

    socket.on('bot_reply', (payload)=>{
      if (payload && payload.reply) append(payload.reply, 'bot');
      if (payload && payload.tool) console.log('tool', payload.tool);
      // store session id if server returned it
      if (payload && payload.sessionId) localStorage.setItem('sessionId', payload.sessionId);
    });

    fm.addEventListener('submit', (e)=>{
      e.preventDefault();
      const txt = inp.value.trim(); if (!txt) return;
      append(txt, 'user');
      const sessionId = localStorage.getItem('sessionId');
      socket.emit('user_message', { sessionId, message: txt });
      inp.value=''; inp.focus();
    });
  </script>
</body>
</html>
  `);
});
// Keep POST /chat for compatibility
app.post('/chat', async (req, res) => {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== 'string')
        return res.status(400).json({ success: false, error: 'message is required' });
    const session = getSession(sessionId);
    pushMessage(session, 'user', message);
    let inputData = { guest_id: session.guest_id || undefined };
    try {
        const parsed = await parseMessageToInput(message, session);
        inputData = { ...inputData, ...parsed };
    }
    catch (err) {
        console.warn('parse error', err);
        inputData = { ...inputData, action: 'create', notes: message };
    }
    if (!inputData.guest_id)
        inputData.guest_id = session.guest_id || 'GUEST-UNKNOWN';
    const toolResp = await callTool(inputData);
    const reply = formatToolResponse(toolResp);
    pushMessage(session, 'assistant', reply);
    return res.json({ success: true, sessionId: session.id, reply, tool: toolResp });
});
// Create HTTP server and attach Socket.IO
const httpServer = http_1.default.createServer(app);
const io = new socket_io_1.Server(httpServer, { cors: { origin: '*' } });
io.on('connection', (socket) => {
    console.log('WS conectado:', socket.id);
    socket.on('user_message', async (payload) => {
        const sessionId = payload?.sessionId;
        const message = payload?.message;
        if (!message)
            return socket.emit('bot_reply', { reply: 'No se recibió mensaje' });
        const session = getSession(sessionId);
        pushMessage(session, 'user', message);
        let inputData = { guest_id: session.guest_id || undefined };
        try {
            const parsed = await parseMessageToInput(message, session);
            inputData = { ...inputData, ...parsed };
        }
        catch (err) {
            inputData = { ...inputData, action: 'create', notes: message };
        }
        if (!inputData.guest_id)
            inputData.guest_id = session.guest_id || 'GUEST-UNKNOWN';
        const toolResp = await callTool(inputData);
        const reply = formatToolResponse(toolResp);
        pushMessage(session, 'assistant', reply);
        socket.emit('bot_reply', { reply, tool: toolResp, sessionId: session.id });
    });
});
httpServer.listen(PORT, () => {
    console.log(`Chat WS corriendo en http://localhost:${PORT} -> TOOL_URL=${TOOL_URL}`);
    console.log(`OPENAI ${USE_OPENAI ? 'habilitado' : 'deshabilitado (fallback reglas)'} - TOOL_API_KEY ${TOOL_API_KEY ? 'SET' : 'no set'}`);
});
//# sourceMappingURL=chatbot-w.js.map