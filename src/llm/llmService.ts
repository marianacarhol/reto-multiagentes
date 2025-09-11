/**
 * LLM Service - Servicio centralizado para integración con múltiples proveedores LLM
 * Soporta: OpenAI, Anthropic (Claude), Google Gemini
 */
import OpenAI from 'openai';
import { z } from 'zod';

// Schemas para validación
const RequestAnalysisSchema = z.object({
  intent: z.enum(['room_service', 'maintenance', 'inquiry', 'complaint', 'cancellation', 'multi']),
  items: z.array(z.object({
    name: z.string(),
    quantity: z.number().min(1).default(1),
    category: z.enum(['food', 'beverage', 'dessert']).optional(),
    restaurant_hint: z.enum(['rest1', 'rest2', 'both']).optional()
  })).optional(),
  restaurant_preference: z.enum(['rest1', 'rest2', 'multi', 'any']).optional(),
  issue_description: z.string().optional().nullable(),
  severity: z.enum(['low', 'medium', 'high']).optional().nullable(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  special_instructions: z.string().optional().nullable(),
  urgency: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional() // ← Agregar esta línea
});

type RequestAnalysis = z.infer<typeof RequestAnalysisSchema>;

interface LLMProvider {
  name: string;
  analyze: (prompt: string, context?: any) => Promise<RequestAnalysis>;
  generateResponse: (prompt: string) => Promise<string>;
}

// ===============================
// OPENAI PROVIDER
// ===============================
class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async analyze(prompt: string, context?: any): Promise<RequestAnalysis> {
    const systemPrompt = `Eres un asistente experto en análisis de solicitudes de hotel para Room Service y Mantenimiento.
 CONTEXTO DEL HOTEL:
- Tenemos 2 restaurantes: rest1 (comida internacional) y rest2 (comida local/mexicana)
- Servicios: room service (comida/bebida) y mantenimiento
- Horarios de servicio disponibles en el menú dinámico

INSTRUCCIONES:
1. Analiza la solicitud del huésped y determina la intención principal
2. Extrae ítems específicos con cantidades si es room service
3. Identifica problemas de mantenimiento con severidad
4. Sugiere el restaurante más apropiado según el tipo de comida
5. Detecta urgencia e instrucciones especiales

Responde SOLO con JSON válido siguiendo este schema:
{
  "intent": "room_service" | "maintenance" | "inquiry" | "complaint" | "cancellation",
  "items": [{"name": "string", "quantity": number, "category": "food"|"beverage"|"dessert"}],
  "restaurant_preference": "rest1" | "rest2" | "multi" | "any",
  "issue_description": "string",
  "severity": "low" | "medium" | "high",
  "priority": "low" | "normal" | "high",
  "special_instructions": "string",
  "urgency": boolean,
  "confidence": number (0-1)
}`;

    

    

    const response = await this.client.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.3'),
      max_tokens: parseInt(process.env.LLM_MAX_TOKENS || '1000'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Solicitud del huésped: "${prompt}"\n\nContexto adicional: ${JSON.stringify(context || {})}` }
      ]
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('No response from OpenAI');

    try {
      const parsed = JSON.parse(content);
      return RequestAnalysisSchema.parse(parsed);
    } catch (error) {
      console.warn('Error parsing OpenAI response:', error);
      return {
        intent: 'inquiry',
        confidence: 0.1,
        special_instructions: prompt
      };
    }
  }

  async generateResponse(prompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 300,
      messages: [
        { 
          role: 'system', 
          content: 'Eres un asistente amigable de hotel. Responde de forma cortés y profesional en español.'
        },
        { role: 'user', content: prompt }
      ]
    });

    return response.choices[0]?.message?.content || 'Lo siento, no pude procesar tu solicitud.';
  }
}

// ===============================
// ANTHROPIC (CLAUDE) PROVIDER
// ===============================
class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyze(prompt: string, context?: any): Promise<RequestAnalysis> {
    const systemPrompt = `Eres un asistente experto en análisis de solicitudes de hotel para Room Service y Mantenimiento.

CONTEXTO DEL HOTEL:
- Tenemos 2 restaurantes: rest1 (comida internacional) y rest2 (comida local/mexicana)
- Servicios: room service (comida/bebida) y mantenimiento

INSTRUCCIONES:
1. Analiza la solicitud del huésped y determina la intención principal
2. Extrae ítems específicos con cantidades si es room service
3. Identifica problemas de mantenimiento con severidad
4. Sugiere el restaurante más apropiado según el tipo de comida

Responde SOLO con JSON válido siguiendo este schema:
{
  "intent": "room_service" | "maintenance" | "inquiry" | "complaint" | "cancellation",
  "items": [{"name": "string", "quantity": number, "category": "food"|"beverage"|"dessert"}],
  "restaurant_preference": "rest1" | "rest2" | "multi" | "any",
  "issue_description": "string",
  "severity": "low" | "medium" | "high",
  "priority": "low" | "normal" | "high",
  "special_instructions": "string",
  "urgency": boolean,
  "confidence": number (0-1)
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: parseInt(process.env.LLM_MAX_TOKENS || '1000'),
        temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.3'),
        system: systemPrompt,
        messages: [
          { 
            role: 'user', 
            content: `Solicitud del huésped: "${prompt}"\n\nContexto adicional: ${JSON.stringify(context || {})}` 
          }
        ]
      })
    });

    const data = await response.json();
    const content = data.content?.[0]?.text;

    if (!content) throw new Error('No response from Claude');

    try {
      const parsed = JSON.parse(content);
      return RequestAnalysisSchema.parse(parsed);
    } catch (error) {
      console.warn('Error parsing Claude response:', error);
      return {
        intent: 'inquiry',
        confidence: 0.1,
        special_instructions: prompt
      };
    }
  }

  async generateResponse(prompt: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 300,
        temperature: 0.7,
        system: 'Eres un asistente amigable de hotel. Responde de forma cortés y profesional en español.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    return data.content?.[0]?.text || 'Lo siento, no pude procesar tu solicitud.';
  }
}

// ===============================
// GOOGLE GEMINI PROVIDER
// ===============================
class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

// En GeminiProvider, modifica solo el método analyze:
async analyze(prompt: string, context?: any): Promise<RequestAnalysis> {
  const systemPrompt = `Eres un asistente experto en análisis de solicitudes de hotel para Room Service y Mantenimiento.

CONTEXTO DEL HOTEL:
- rest1: Restaurante internacional (hamburguesas, pizzas, pasta, comida occidental)
- rest2: Restaurante mexicano/local (tacos, tortas, horchata, comida tradicional)

INSTRUCCIONES CRÍTICAS:
1. DETECTA TODOS LOS ÍTEMS mencionados en la solicitud, no solo uno
2. Asigna cantidad específica a cada ítem
3. Categoriza correctamente cada ítem (food/beverage/dessert)
4. Si hay ítems de ambos restaurantes, usar "multi"

EJEMPLOS:
- "hamburguesa y tacos al pastor y horchata" → 3 ítems separados
- "dos pizzas y una coca" → pizza cantidad 2, coca cantidad 1

Responde SOLO con JSON válido:
{
  "intent": "room_service",
  "items": [{"name": "string", "quantity": number, "category": "food"|"beverage"|"dessert", "restaurant_hint": "rest1"|"rest2"}],
  "restaurant_preference": "rest1" | "rest2" | "multi" | "any",
  "issue_description": null,
  "severity": null,
  "priority": "normal",
  "special_instructions": null,
  "urgency": false,
  "confidence": number (0-1),
  "reasoning": "explicación del análisis"
}`;

  console.log('[GEMINI] Making request to API...');
  
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: `${systemPrompt}\n\nAnaliza: "${prompt}"\nContexto: ${JSON.stringify(context || {})}` }]
      }],
      generationConfig: {
        temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.2'),
        maxOutputTokens: parseInt(process.env.LLM_MAX_TOKENS || '1500'),
      }
    })
  });

  const data = await response.json();
  console.log('[GEMINI] Response data:', JSON.stringify(data, null, 2));
  
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
 console.log('[GEMINI] Raw response from API:', content);

  if (!content) throw new Error('No response from Gemini');

  try {
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleanContent);
    return RequestAnalysisSchema.parse(parsed);
  } catch (error) {
    console.warn('Error parsing Gemini response:', error);
    return this.fallbackAnalysis(prompt);
  }
}

private fallbackAnalysis(prompt: string): RequestAnalysis {
  const text = prompt.toLowerCase();
  const items = [];

  // Detección mejorada de múltiples ítems
  const itemPatterns = [
    { pattern: /hamburguesas?/g, name: 'hamburguesa', category: 'food', restaurant: 'rest1' },
    { pattern: /pizzas?/g, name: 'pizza', category: 'food', restaurant: 'rest1' },
    { pattern: /tacos?\s*(al\s+pastor)?/g, name: 'tacos al pastor', category: 'food', restaurant: 'rest2' },
    { pattern: /horchatas?/g, name: 'horchata', category: 'beverage', restaurant: 'rest2' },
    { pattern: /cocas?|coca\s+colas?/g, name: 'coca cola', category: 'beverage', restaurant: 'rest1' }
  ];

  for (const itemPattern of itemPatterns) {
    const matches = Array.from(text.matchAll(itemPattern.pattern));
    if (matches.length > 0) {
      items.push({
        name: itemPattern.name,
        quantity: 1,
        category: itemPattern.category as 'food' | 'beverage',
        restaurant_hint: itemPattern.restaurant as 'rest1' | 'rest2'
      });
    }
  }

  const restaurants = new Set(items.map(item => item.restaurant_hint));
  const restaurant_preference = restaurants.size > 1 ? 'multi' : 
                              restaurants.size === 1 ? Array.from(restaurants)[0] : 'any';

  return {
    intent: items.length > 0 ? 'room_service' : 'inquiry',
    items: items.length > 0 ? items : undefined,
    restaurant_preference: restaurant_preference as any,
    confidence: 0.7,
    reasoning: `Análisis Gemini mejorado: ${items.length} ítems detectados`
  };
}

  async generateResponse(prompt: string): Promise<string> {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `Eres un asistente amigable de hotel. Responde de forma cortés y profesional en español.\n\n${prompt}` }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300,
        }
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Lo siento, no pude procesar tu solicitud.';
  }
}

// ===============================
// SERVICIO PRINCIPAL LLM
// ===============================
class LLMService {
  private provider: LLMProvider;

  constructor() {
    const providerName = process.env.LLM_PROVIDER || 'openai';
    
    switch (providerName.toLowerCase()) {
      case 'openai':
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not found');
        this.provider = new OpenAIProvider(process.env.OPENAI_API_KEY);
        break;
      case 'anthropic':
      case 'claude':
        if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not found');
        this.provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
        break;
      case 'gemini':
      case 'google':
        if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not found');
        this.provider = new GeminiProvider(process.env.GOOGLE_API_KEY);
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${providerName}`);
    }

    console.log(`[LLM] Initialized with provider: ${this.provider.name}`);
  }

  /**
   * Analiza una solicitud de huésped en lenguaje natural
   */
  async analyzeGuestRequest(request: string, context?: {
    guest_id?: string;
    room?: string;
    time?: string;
    guest_profile?: any;
    available_menu?: any[];
  }): Promise<RequestAnalysis> {
    try {
      const analysis = await this.provider.analyze(request, context);
      console.log(`[LLM] Analysis completed with confidence: ${analysis.confidence}`);
      return analysis;
    } catch (error) {
      console.error('[LLM] Analysis failed:', error);
      // Fallback: análisis básico por palabras clave
      return this.basicAnalysis(request);
    }
  }

  /**
   * Genera respuestas inteligentes para el huésped
   */
  async generateGuestResponse(
    situation: string, 
    _context?: any
  ): Promise<string> {
    try {
      return await this.provider.generateResponse(situation);
    } catch (error) {
      console.error('[LLM] Response generation failed:', error);
      return 'Gracias por contactarnos. Hemos recibido tu solicitud y la procesaremos a la brevedad.';
    }
  }

  /**
   * Convierte análisis LLM a formato del agente
   */
  analysisToAgentInput(
    analysis: RequestAnalysis,
    guest_id: string,
    room: string,
    originalText: string
  ): any {
    const base = {
      guest_id,
      room,
      text: originalText,
      now: new Date().toISOString()
    };

    switch (analysis.intent) {
      case 'room_service':
        return {
          ...base,
          action: 'create',
          type: this.inferServiceType(analysis.items),
          restaurant: analysis.restaurant_preference === 'any' ? undefined : analysis.restaurant_preference,
          items: analysis.items?.map(item => ({
            name: item.name,
            qty: item.quantity
          })) || [],
          priority: analysis.priority || (analysis.urgency ? 'high' : 'normal'),
          notes: analysis.special_instructions
        };

      case 'maintenance':
        return {
          ...base,
          action: 'create',
          type: 'maintenance',
          issue: analysis.issue_description || originalText,
          severity: analysis.severity || (analysis.urgency ? 'high' : 'medium'),
          priority: analysis.priority || (analysis.urgency ? 'high' : 'normal'),
          notes: analysis.special_instructions
        };

      case 'multi':

        // Para casos mixtos, priorizar mantenimiento por seguridad
        if (analysis.issue_description) {

            return {
                ...base,
                action: 'create',
                type: 'maintenance' ,
                issue: analysis.issue_description,
                severity: analysis.severity || 'medium',
                priority: analysis.priority || 'normal',
                notes: `Solicitud mixta: ${originalText}`
            };
        }


  // Si no hay issue, tratar como room service
        return {
            ...base,
            action: 'create',
            type: 'food',
            items: analysis.items || [],
            notes: `Solicitud mixta: ${originalText}`
        };

        

      default:
        // Para inquiries, complaints, etc., no creamos tickets
        return null;
    }
  }

  private basicAnalysis(request: string): RequestAnalysis {
    const text = request.toLowerCase();
    
    // Detección básica de mantenimiento
    if (/(reparar|arreglar|roto|fuga|no funciona|averiado|mantenimiento|aire)/i.test(text)) {
      return {
        intent: 'maintenance',
        issue_description: request,
        severity: /urgente|importante|grave/i.test(text) ? 'high' : 'medium',
        confidence: 0.6
      };
    }

    // Detección básica de bebidas
    if (/(sed|coca|cola|agua|beber|bebida|refresco|horchata|cerveza)/i.test(text)) {
      const items = [];
      if (/coca|cola/i.test(text)) items.push({ name: 'Coca Cola', quantity: 1, category: 'beverage' as const });
      if (/agua/i.test(text)) items.push({ name: 'Agua Natural', quantity: 1, category: 'beverage' as const });
      if (/horchata/i.test(text)) items.push({ name: 'Horchata', quantity: 1, category: 'beverage' as const });
      
      return {
        intent: 'room_service',
        items: items.length > 0 ? items : [{ name: 'Coca Cola', quantity: 1, category: 'beverage' as const }],
        restaurant_preference: 'any',
        confidence: 0.7
      };
    }

    // Detección básica de comida
    if (/(quiero|solicito|pedir|ordenar|comida|hambre|pizza|taco|hamburguesa)/i.test(text)) {
      const items = [];
      if (/pizza/i.test(text)) items.push({ name: 'Pizza Margherita', quantity: 1, category: 'food' as const });
      if (/taco/i.test(text)) items.push({ name: 'Tacos al Pastor', quantity: 3, category: 'food' as const });
      if (/hamburguesa/i.test(text)) items.push({ name: 'Hamburguesa Clásica', quantity: 1, category: 'food' as const });
      
      return {
        intent: 'room_service',
        items: items.length > 0 ? items : [{ name: 'Hamburguesa Clásica', quantity: 1, category: 'food' as const }],
        restaurant_preference: /taco|horchata|mexicana/i.test(text) ? 'rest2' : 'rest1',
        confidence: 0.6
      };
    }

    return {
      intent: 'inquiry',
      confidence: 0.3
    };
  }

  private inferServiceType(items?: Array<{name: string; category?: 'food' | 'beverage' | 'dessert' | undefined}>): 'food' | 'beverage' | undefined {
    if (!items?.length) return undefined;
    
    const categories = items.map(i => i.category).filter(Boolean);
    if (categories.every(c => c === 'beverage')) return 'beverage';
    if (categories.some(c => c === 'food' || c === 'dessert')) return 'food';
    
    return undefined;
  }
}

// Singleton
export const llmService = new LLMService();
export type { RequestAnalysis };
export { LLMService };