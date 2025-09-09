import tool from '../index'; // Tu herramienta actual

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatContext {
  guestId: string;
  room: string;
  messages: ChatMessage[];
  lastRequestId?: string;
}
 
// Definir tipos para los códigos de error
type ErrorCode = 'ACCESS_WINDOW_BLOCK' | 'SPEND_LIMIT' | 'ITEMS_UNAVAILABLE' | 'NOT_FOUND' | 'MISSING_ISSUE' | 'VALIDATION_ERROR';

export class SimpleChatbotWrapper {
  private contexts = new Map<string, ChatContext>();
  
  async processMessage(
    message: string, 
    guestId: string, 
    room: string
  ): Promise<{ response: string; context: ChatContext }> {
    
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
      
      // 4. Llamar a tu herramienta existente (corregido: usar call en lugar de execute)
      const result = await tool.execute( agentInput, {
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
      
    } catch (error) {
      const errorResponse = '❌ Lo siento, ha ocurrido un error. ¿Podrías intentar de nuevo?';
      
      context.messages.push({
        role: 'assistant',
        content: errorResponse,
        timestamp: new Date().toISOString()
      });
      
      return { response: errorResponse, context };
    }
  }
  
  private messageToAgentInput(message: string, context: ChatContext): any {
    const lowerMessage = message.toLowerCase();
    
    // Input básico
    const input: any = {
      guest_id: context.guestId,
      room: context.room,
      now: new Date().toISOString(),
      text: message
    };
    
    // Detectar acción basada en el mensaje
    if (lowerMessage.includes('menú') || lowerMessage.includes('carta')) {
      input.action = 'get_menu';
      if (lowerMessage.includes('bebida')) input.type = 'beverage';
      if (lowerMessage.includes('comida')) input.type = 'food';
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
  
  private resultToNaturalResponse(result: any, action: string): string {
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
  
  private formatMenuResponse(data: any): string {
    if (!data.menu || data.menu.length === 0) {
      return '❌ No hay items disponibles en este momento.';
    }
    
    let response = `🍽️ **Menú Disponible** (${data.current_time})\n\n`;
    
    const foodItems = data.menu.filter((item: { category: string }) => item.category === 'food');
    const beverageItems = data.menu.filter((item: { category: string }) => item.category === 'beverage');
    
    if (foodItems.length > 0) {
      response += '**🍕 Comidas:**\n';
      foodItems.forEach((item: { name: string; price: number; category: string }) => {
        response += `• ${item.name} - $${item.price}\n`;
      });
      response += '\n';
    }
    
    if (beverageItems.length > 0) {
      response += '**🥤 Bebidas:**\n';
      beverageItems.forEach((item: { name: string; price: number; category: string }) => {
        response += `• ${item.name} - $${item.price}\n`;
      });
      response += '\n';
    }
    
    response += '¿Qué te gustaría pedir? Solo escríbeme el nombre del plato.';
    
    return response;
  }
  
  private formatCreateResponse(data: any): string {
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
      data.cross_sell_suggestions.forEach((item: { name: string; price: number }) => {
        response += `• ${item.name} - $${item.price}\n`;
      });
      response += '\nSolo escríbeme el nombre si quieres agregarlo.';
    }
    
    return response;
  }
  
  private formatStatusResponse(data: any): string {
    return `📋 **Estado de tu solicitud**

🔖 ID: ${data.request_id}
📊 Estado: ${data.status}
⏱️ Última actualización: ${new Date().toLocaleTimeString()}

${data.confirmation || 'Tu solicitud está siendo procesada.'}`;
  }
  
  private formatErrorResponse(error: any): string {
    const messages: Record<ErrorCode, string> = {
      'ACCESS_WINDOW_BLOCK': '⏰ El servicio no está disponible en este momento.',
      'SPEND_LIMIT': '💳 Has alcanzado tu límite de gasto diario.',
      'ITEMS_UNAVAILABLE': '❌ Algunos items no están disponibles ahora.',
      'NOT_FOUND': '🔍 No encontré esa solicitud.',
      'MISSING_ISSUE': '❓ Por favor describe el problema con más detalle.',
      'VALIDATION_ERROR': '⚠️ Hay un error en tu solicitud.'
    };
    
    // Usar type assertion con validación
    const errorCode = error.code as ErrorCode;
    return messages[errorCode] || '❌ Ha ocurrido un error. Por favor intenta de nuevo.';
  }
  
  // Métodos de detección simples
  private isMaintenanceRequest(message: string): boolean {
    const keywords = [
      'reparar', 'roto', 'fuga', 'problema', 'mantenimiento',
      'aire acondicionado', 'tv', 'luz', 'ducha', 'inodoro'
    ];
    return keywords.some(keyword => message.includes(keyword));
  }
  
  private isFoodOrder(message: string): boolean {
    const keywords = [
      'pizza', 'hamburguesa', 'ensalada', 'brownie',
      'comida', 'comer', 'pedido', 'quiero'
    ];
    return keywords.some(keyword => message.includes(keyword));
  }
  
  private isBeverageOrder(message: string): boolean {
    const keywords = [
      'vino', 'coca', 'agua', 'jugo', 'bebida',
      'cerveza', 'refresco', 'tomar'
    ];
    return keywords.some(keyword => message.includes(keyword));
  }
  
  private extractItems(message: string, type: 'food' | 'beverage'): Array<{name: string, qty: number}> {
    // Extracción simple basada en palabras clave
    const items = [];
    const lowerMessage = message.toLowerCase();
    
    if (type === 'food') {
      if (lowerMessage.includes('pizza')) items.push({name: 'Pizza Margarita', qty: 1});
      if (lowerMessage.includes('hamburguesa')) items.push({name: 'Hamburguesa Clásica', qty: 1});
      if (lowerMessage.includes('ensalada')) items.push({name: 'Ensalada César', qty: 1});
      if (lowerMessage.includes('brownie')) items.push({name: 'Brownie con Helado', qty: 1});
    } else {
      if (lowerMessage.includes('vino')) items.push({name: 'Vino Tinto Casa', qty: 1});
      if (lowerMessage.includes('coca')) items.push({name: 'Coca-Cola', qty: 1});
      if (lowerMessage.includes('agua')) items.push({name: 'Agua Mineral', qty: 1});
      if (lowerMessage.includes('jugo')) items.push({name: 'Jugo Natural Naranja', qty: 1});
    }
    
    // Si no encontró nada específico, usar el mensaje como item genérico
    if (items.length === 0) {
      items.push({name: message, qty: 1});
    }
    
    return items;
  }
  
  private extractRequestId(message: string, context: ChatContext): string | undefined {
    // Buscar REQ- en el mensaje
    const match = message.match(/REQ-\d+/);
    if (match) return match[0];
    
    // Si no encuentra, usar el último del contexto
    return context.lastRequestId;
  }
  
  private detectSeverity(message: string): 'low' | 'medium' | 'high' {
    if (message.includes('urgente') || message.includes('emergency')) return 'high';
    if (message.includes('roto') || message.includes('fuga')) return 'medium';
    return 'low';
  }
}