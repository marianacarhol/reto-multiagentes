import express from 'express';
import cors from 'cors';
import { SimpleChatbotWrapper } from './simple-wrapper';

const app = express();
const chatbot = new SimpleChatbotWrapper();

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Para servir la interfaz web

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
    
  } catch (error) {
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
  } catch (error) {
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

// Agregar después de tu POST /api/chat
app.get('/api/chat', (req, res) => {
  res.json({
    message: 'Chat endpoint activo - usa POST con JSON',
    endpoints: {
      chat: 'POST /api/chat',
      menu: 'GET /api/menu',
      health: 'GET /health'
    }
  });
});


const PORT = process.env.CHATBOT_PORT || 3100;

app.listen(PORT, () => {
  console.log(`🤖 Chatbot Server running on http://localhost:${PORT}`);
  console.log(`📱 Chat API: http://localhost:${PORT}/api/chat`);
  console.log(`🍽️ Menu API: http://localhost:${PORT}/api/menu`);
  console.log(`❤️ Health: http://localhost:${PORT}/health`);
});

export { app, chatbot };