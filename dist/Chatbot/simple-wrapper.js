"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimpleChatbotWrapper = void 0;
const tslib_1 = require("tslib");
const index_1 = tslib_1.__importDefault(require("../index")); // Tu herramienta actual
class SimpleChatbotWrapper {
    contexts = new Map();
    async processMessage(message, guestId, room) {
        // 1. Obtener o crear contexto
        let context = this.contexts.get(guestId) || {
            guestId,
            room,
            messages: []
        };
        // 2. Agregar mensaje del usuario
        context.messages.push({
            role: 'user',
            content: message,
            timestamp: new Date().toISOString()
        });
        try {
            // 3. Analizar mensaje y convertir a input del agente
            const agentInput = this.messageToAgentInput(message, context);
            // 4. Llamar a tu herramienta existente 
            const result = await index_1.default.execute(agentInput, {
                enable_stock_check: true,
                enable_cross_sell: true,
                accessWindowStart: '06:00',
                accessWindowEnd: '23:59'
            });
            // 5. Convertir resultado a respuesta natural
            const response = this.resultToNaturalResponse(result, agentInput.action);
            // 6. Guardar respuesta en contexto
            context.messages.push({
                role: 'assistant',
                content: response,
                timestamp: new Date().toISOString()
            });
            // 7. Actualizar último request_id si aplica
            if (result.status === 'success' && result.data?.request_id) {
                context.lastRequestId = result.data.request_id;
            }
            this.contexts.set(guestId, context);
            return { response, context };
        }
        catch (error) {
            console.error('Error en processMessage:', error);
            console.error('Stack:', error instanceof Error ? error.stack : 'No stack available');
            console.error('Input data:', { message, guestId, room });
            const errorResponse = `❌ Error específico: ${error instanceof Error ? error.message : String(error)}`;
            context.messages.push({
                role: 'assistant',
                content: errorResponse,
                timestamp: new Date().toISOString()
            });
            return { response: errorResponse, context };
        }
    }
    messageToAgentInput(message, context) {
        const lowerMessage = message.toLowerCase();
        // Input básico
        const input = {
            guest_id: context.guestId,
            room: context.room,
            now: new Date().toISOString(),
            text: message
        };
        // Detectar acción basada en el mensaje
        if (lowerMessage.includes('menú') || lowerMessage.includes('carta')) {
            input.action = 'get_menu';
            if (lowerMessage.includes('bebida'))
                input.type = 'beverage';
            if (lowerMessage.includes('comida'))
                input.type = 'food';
        }
        else if (lowerMessage.includes('estado') || lowerMessage.includes('req-')) {
            input.action = 'status';
            input.request_id = this.extractRequestId(message, context);
        }
        else if (this.isMaintenanceRequest(lowerMessage)) {
            input.action = 'create';
            input.type = 'maintenance';
            input.issue = message;
            input.severity = this.detectSeverity(lowerMessage);
        }
        else if (this.isFoodOrder(lowerMessage)) {
            input.action = 'create';
            input.type = 'food';
            input.items = this.extractItems(message, 'food');
            input.notes = `Pedido via chat: ${message}`;
        }
        else if (this.isBeverageOrder(lowerMessage)) {
            input.action = 'create';
            input.type = 'beverage';
            input.items = this.extractItems(message, 'beverage');
            input.notes = `Pedido via chat: ${message}`;
        }
        else {
            // Default: crear como food
            input.action = 'create';
            input.type = 'food';
            input.items = [{ name: message, qty: 1 }];
        }
        return input;
    }
    resultToNaturalResponse(result, action) {
        if (result.status === 'error') {
            return this.formatErrorResponse(result.error);
        }
        if (result.status === 'success') {
            switch (action) {
                case 'get_menu':
                    return this.formatMenuResponse(result.data);
                case 'create':
                    return this.formatCreateResponse(result.data);
                case 'status':
                    return this.formatStatusResponse(result.data);
                default:
                    return '✅ Solicitud procesada correctamente.';
            }
        }
        return 'No pude procesar tu solicitud. ¿Podrías ser más específico?';
    }
    formatMenuResponse(data) {
        if (!data.menu || data.menu.length === 0) {
            return '❌ No hay items disponibles en este momento.';
        }
        let response = `🍽️ **Menú Disponible** (${data.current_time})\n\n`;
        const foodItems = data.menu.filter((item) => item.category === 'food');
        const beverageItems = data.menu.filter((item) => item.category === 'beverage');
        if (foodItems.length > 0) {
            response += '**🍕 Comidas:**\n';
            foodItems.forEach((item) => {
                response += `• ${item.name} - $${item.price}\n`;
            });
            response += '\n';
        }
        if (beverageItems.length > 0) {
            response += '**🥤 Bebidas:**\n';
            beverageItems.forEach((item) => {
                response += `• ${item.name} - $${item.price}\n`;
            });
            response += '\n';
        }
        response += '¿Qué te gustaría pedir? Solo escríbeme el nombre del plato.';
        return response;
    }
    formatCreateResponse(data) {
        if (data.type === 'maintenance') {
            return `🔧 **Mantenimiento Registrado**
      
📋 Solicitud: ${data.request_id}
⏱️ Tiempo estimado: ${data.estimated_time || 'Variable'}
🚨 Estado: ${data.status}

Nuestro equipo técnico atenderá tu solicitud pronto. Te notificaré cuando haya novedades.`;
        }
        let response = `✅ **Pedido Confirmado**

📋 ID: ${data.request_id}
⏱️ Tiempo estimado: ${data.estimated_time}
💰 Total: $${data.total_cost?.toFixed(2) || '0.00'}
📍 Estado: ${data.status}`;
        if (data.cross_sell_suggestions && data.cross_sell_suggestions.length > 0) {
            response += '\n\n🤔 **¿Te interesa agregar algo más?**\n';
            data.cross_sell_suggestions.forEach((item) => {
                response += `• ${item.name} - $${item.price}\n`;
            });
            response += '\nSolo escríbeme el nombre si quieres agregarlo.';
        }
        return response;
    }
    formatStatusResponse(data) {
        return `📋 **Estado de tu solicitud**

🔖 ID: ${data.request_id}
📊 Estado: ${data.status}
⏱️ Última actualización: ${new Date().toLocaleTimeString()}

${data.confirmation || 'Tu solicitud está siendo procesada.'}`;
    }
    formatErrorResponse(error) {
        const messages = {
            'ACCESS_WINDOW_BLOCK': '⏰ El servicio no está disponible en este momento.',
            'SPEND_LIMIT': '💳 Has alcanzado tu límite de gasto diario.',
            'ITEMS_UNAVAILABLE': '❌ Algunos items no están disponibles ahora.',
            'NOT_FOUND': '🔍 No encontré esa solicitud.',
            'MISSING_ISSUE': '❓ Por favor describe el problema con más detalle.',
            'VALIDATION_ERROR': '⚠️ Hay un error en tu solicitud.'
        };
        // Usar type assertion con validación
        const errorCode = error.code;
        return messages[errorCode] || '❌ Ha ocurrido un error. Por favor intenta de nuevo.';
    }
    // Métodos de detección simples
    isMaintenanceRequest(message) {
        const keywords = [
            'reparar', 'roto', 'fuga', 'problema', 'mantenimiento',
            'aire acondicionado', 'tv', 'luz', 'ducha', 'inodoro'
        ];
        return keywords.some(keyword => message.includes(keyword));
    }
    isFoodOrder(message) {
        const keywords = [
            'pizza', 'hamburguesa', 'ensalada', 'brownie',
            'comida', 'comer', 'pedido', 'quiero'
        ];
        return keywords.some(keyword => message.includes(keyword));
    }
    isBeverageOrder(message) {
        const keywords = [
            'vino', 'coca', 'agua', 'jugo', 'bebida',
            'cerveza', 'refresco', 'tomar'
        ];
        return keywords.some(keyword => message.includes(keyword));
    }
    extractItems(message, type) {
        // Extracción simple basada en palabras clave
        const items = [];
        const lowerMessage = message.toLowerCase();
        if (type === 'food') {
            if (lowerMessage.includes('pizza'))
                items.push({ name: 'Pizza Margarita', qty: 1 });
            if (lowerMessage.includes('hamburguesa'))
                items.push({ name: 'Hamburguesa Clásica', qty: 1 });
            if (lowerMessage.includes('ensalada'))
                items.push({ name: 'Ensalada César', qty: 1 });
            if (lowerMessage.includes('brownie'))
                items.push({ name: 'Brownie con Helado', qty: 1 });
        }
        else {
            if (lowerMessage.includes('vino'))
                items.push({ name: 'Vino Tinto Casa', qty: 1 });
            if (lowerMessage.includes('coca'))
                items.push({ name: 'Coca-Cola', qty: 1 });
            if (lowerMessage.includes('agua'))
                items.push({ name: 'Agua Mineral', qty: 1 });
            if (lowerMessage.includes('jugo'))
                items.push({ name: 'Jugo Natural Naranja', qty: 1 });
        }
        // Si no encontró nada específico, usar el mensaje como item genérico
        if (items.length === 0) {
            items.push({ name: message, qty: 1 });
        }
        return items;
    }
    extractRequestId(message, context) {
        // Buscar REQ- en el mensaje
        const match = message.match(/REQ-\d+/);
        if (match)
            return match[0];
        // Si no encuentra, usar el último del contexto
        return context.lastRequestId;
    }
    detectSeverity(message) {
        if (message.includes('urgente') || message.includes('emergency'))
            return 'high';
        if (message.includes('roto') || message.includes('fuga'))
            return 'medium';
        return 'low';
    }
}
exports.SimpleChatbotWrapper = SimpleChatbotWrapper;
//# sourceMappingURL=simple-wrapper.js.map