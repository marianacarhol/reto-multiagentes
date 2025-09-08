"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatbot = exports.app = void 0;
const tslib_1 = require("tslib");
const express_1 = tslib_1.__importDefault(require("express"));
const cors_1 = tslib_1.__importDefault(require("cors"));
const simple_wrapper_1 = require("./simple-wrapper");
const app = (0, express_1.default)();
exports.app = app;
const chatbot = new simple_wrapper_1.SimpleChatbotWrapper();
exports.chatbot = chatbot;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.static('public')); // Para servir la interfaz web
// Endpoint principal del chatbot
app.post('/api/chat', async (req, res) => {
    try {
        console.log('📨 Request received:', req.body);
        const { message, guest_id, room } = req.body;
        if (!message || !guest_id || !room) {
            console.log('❌ Missing parameters');
            return res.status(400).json({
                error: 'Faltan parámetros requeridos: message, guest_id, room'
            });
        }
        console.log('🤖 Processing message:', { message, guest_id, room });
        const result = await chatbot.processMessage(message, guest_id, room);
        console.log('✅ Result:', result);
        return res.json({
            success: true,
            response: result.response,
            context: {
                messageCount: result.context.messages.length,
                lastRequestId: result.context.lastRequestId
            }
        });
    }
    catch (error) {
        console.error('❌ Chat Error:', error);
        return res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});
// Endpoint para obtener menú directamente
app.get('/api/menu', async (_, res) => {
    try {
        const result = await chatbot.processMessage('ver menú', 'demo', '101');
        res.json({
            success: true,
            menu: result.response
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: 'Error al obtener menú'
        });
    }
});
// Health check
app.get('/health', (_, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'hotel-chatbot'
    });
});
const PORT = process.env.CHATBOT_PORT || 3100;
app.listen(PORT, () => {
    console.log(`🤖 Chatbot Server running on http://localhost:${PORT}`);
    console.log(`📱 Chat API: http://localhost:${PORT}/api/chat`);
    console.log(`🍽️ Menu API: http://localhost:${PORT}/api/menu`);
    console.log(`❤️ Health: http://localhost:${PORT}/health`);
});
//# sourceMappingURL=express-server.js.map