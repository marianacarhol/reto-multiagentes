# Agent-03 — Room Service & Maintenance (Multi-Restaurant)

Sistema inteligente para hoteles que unifica **Room Service** (rest1/rest2) y **Mantenimiento** con:
- Gestión de tickets (creación, aceptación, completado, cancelación, feedback)
- Control de inventario y decremento de stock
- Límites de gasto por huésped y ledger diario
- Cross-sell inter-restaurantes con sugerencias inteligentes
- Priorización de incidentes vía API externa (FastAPI + scikit-learn) con _fallback_ por reglas
- Ventanas de acceso, DND y validación de horarios
- Supabase como backend de datos

## Arquitectura

```
Cliente → /api/execute ──┐
                         │             ┌──────────┐
                         ├─ Room Service│ tickets_rb│←── stock/menu (rest1/rest2)
                         │             └──────────┘
Agent-03 (Node/TS) ──────┤
                         │             ┌──────────┐
                         ├─ Maintenance│ tickets_m │←── Priority API (FastAPI)
                         │             └──────────┘
                         └─ Historial  ticket_history_*  +  feedback

Ledger/Guests: spend_ledger, guests
```

- **Supabase** (Postgres + supabase-js): `guests`, `menu_union`, `tickets_rb`, `tickets_m`, `ticket_history_rb`, `ticket_history_m`, `spend_ledger`, `feedback`.
- **Priority API** (opcional): FastAPI en `http://localhost:8000/predict` (configurable por `PRIORITY_API_URL`).

---

## Requisitos

- Node.js 20+
- npm 9+
- Supabase (URL + Service Role)
- Python 3.10+ (para el servicio de prioridad opcional)
- (Opcional) Docker / Docker Compose

---

## Instalación rápida

```bash
# 1) Instalar dependencias
npm install

# 2) Copiar y completar variables de entorno
cp .env.example .env
# edita SUPABASE_URL / SUPABASE_SERVICE_ROLE / PRIORITY_API_URL si aplica

# 3) Compilar
npm run build

# 4) Iniciar en desarrollo (tsx) o producción
npm run dev
# o
npm start
```

---

## Variables de entorno

Ver plantilla completa en **`.env.example`** (incluida en este repo). Campos principales:

- **Servidor**: `PORT` (3000), `HOST` (0.0.0.0)
- **Supabase**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`
- **Priority API**: `PRIORITY_API_URL` (ej. `http://localhost:8000/predict`)
- **INIT Flow**: `INIT_ON_START`, `INIT_JSON_PATH`, `INTERACTIVE_DECIDE`, `INIT_DECISION`
- **Acceso**: `ACCESSWINDOWSTART`, `ACCESSWINDOWEND`
- **Seguridad**: `API_KEY_AUTH`, `VALID_API_KEYS`, `CORS_ORIGIN`
- Otros: `LOG_LEVEL`, `AI_SPINE_VERBOSE`, etc.

---

## Ejecución

### Desarrollo
```bash
npm run dev
```

### Producción
```bash
npm run build
npm start
```

Al iniciar verás:
```
Health:  http://localhost:3000/health
Execute: http://localhost:3000/api/execute
```

> **Sugerencia:** Desactiva el flujo INIT en desarrollo si no quieres ejecuciones automáticas  
> `INIT_ON_START=false` en `.env`.

---

## Endpoints del Tool

### `GET /health`
Devuelve estado del servicio y metadatos.

### `POST /api/execute`
Ejecuta acciones. `input_data` (ver tipos en `src/agent/agentInput.ts`):

Acciones soportadas:
- `get_menu`
- `create` (Room Service o Maintenance)
- `accept` / `reject` / `complete` / `cancel` / `status`
- `feedback`

Campos comunes:
- `guest_id`, `room`, `text`, `notes`, `priority`, `now`, `do_not_disturb`, `guest_profile`, `access_window`
- `request_id` (post-acciones)

Room Service:
- `restaurant: 'rest1'|'rest2'|'multi'`
- `items: [{ id?, name, qty? }]`
- `menu_category: 'food'|'beverage'|'dessert'`

Maintenance:
- `issue`, `severity: 'low'|'medium'|'high'`

---

## Ejemplos de uso (curl)

### Health
```bash
curl http://localhost:3000/health
```

### Crear ticket Room Service
```bash
curl -X POST http://localhost:3000/api/execute   -H "Content-Type: application/json"   -d '{
    "input_data": {
      "action": "create",
      "guest_id": "G-1",
      "room": "1205",
      "items": [{ "name": "Tostadas de Tinga" }],
      "notes": "sin cebolla, porfa"
    }
  }'
```

Respuesta (éxito):
```json
{
  "status": "success",
  "data": {
    "request_id": "REQ-1757...",
    "domain": "rb",
    "type": "food",
    "area": "kitchen",
    "status": "CREADO",
    "message": "Ticket creado. Usa action "accept" o "reject".",
    "cross_sell_suggestions": ["Mojito","Pastel Tres Leches"]
  }
}
```

### Obtener menú disponible
```bash
curl -X POST http://localhost:3000/api/execute   -H "Content-Type: application/json"   -d '{
    "input_data": { "action": "get_menu", "menu_category": "food", "now": "2025-09-12T12:00:00Z" }
  }'
```

### Flujo post-creación
```bash
# Aceptar
curl -X POST http://localhost:3000/api/execute   -H "Content-Type: application/json"   -d '{ "input_data": { "action": "accept", "request_id": "REQ-1757..." } }'

# Completar
curl -X POST http://localhost:3000/api/execute   -H "Content-Type: application/json"   -d '{ "input_data": { "action": "complete", "request_id": "REQ-1757..." } }'

# Feedback
curl -X POST http://localhost:3000/api/execute   -H "Content-Type: application/json"   -d '{ "input_data": { "action": "feedback", "request_id": "REQ-1757...", "service_feedback": "Todo excelente" } }'
```

---

## Modelo de Prioridad (API FastAPI)

El sistema puede consultar una API externa para priorizar tickets de **Mantenimiento**. Si falla la API, se usa un _fallback_ por reglas.

### Entrenamiento del modelo

Archivo (Python, scikit-learn) — entrena TF-IDF + Regresión Logística y guarda `priority_model.joblib`.

```python
# pip install scikit-learn joblib pandas numpy
# (fragmento clave)
pipe.fit(Xtr, ytr)
joblib.dump(pipe, MODEL_PATH)
```

El dataset CSV incluido (múltiples filas con `text, domain, vip, spend30d, eta_to_sla_min, label`) sirve para entrenamiento.

### Servicio de inferencia

Servicio FastAPI mínimo:

```python
# pip install fastapi uvicorn joblib pandas numpy pydantic
from fastapi import FastAPI
from pydantic import BaseModel
import joblib, pandas as pd

pipe = joblib.load("priority_model.joblib")
LABELS = list(pipe.classes_)
THRESH_NEEDS_REVIEW = 0.55

class Payload(BaseModel):
    text: str
    domain: str  # 'rb' | 'm'
    vip: int
    spend30d: float
    eta_to_sla_min: float

app = FastAPI(title="PriorityModel v1")

@app.post("/predict")
def predict(p: Payload):
    X = pd.DataFrame([{
        "text": p.text, "domain": p.domain, "vip": int(p.vip),
        "spend30d": float(p.spend30d), "eta_to_sla_min": float(p.eta_to_sla_min),
    }])
    proba = pipe.predict_proba(X)[0]
    score = float(proba.max())
    label = LABELS[proba.argmax()]
    needs_review = score < THRESH_NEEDS_REVIEW
    return {
        "priority": label,
        "score": round(100*score),
        "proba": {lab: float(pr) for lab, pr in zip(LABELS, proba)},
        "needs_review": needs_review,
        "model": "tfidf_logreg_v1"
    }
```

Ejecutar la API:
```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Configura `PRIORITY_API_URL=http://localhost:8000/predict` en `.env`.

---

## Esquema de datos en Supabase

Tablas usadas (nombres esperados en código):
- `guests(id, room, spend_limit, nombre?)`
- `menu_union(id, restaurant, name, price, category, available_start, available_end, stock_current, stock_minimum, is_active, cross_sell_items?)`
- `tickets_rb(id, guest_id, room, restaurant, status, priority, items, total_amount, notes?, feedback?, updated_at)`
- `ticket_history_rb(request_id, status, actor, note?, feedback?, ts)`
- `tickets_m(id, guest_id, room, issue, severity, status, priority, notes?, service_hours?, feedback?, priority_score?, priority_model?, priority_proba?, needs_review?, updated_at)`
- `ticket_history_m(request_id, status, actor, note?, feedback?, service_hours?, ts)`
- `spend_ledger(domain, request_id, guest_id, amount, occurred_at)`
- `feedback(domain, guest_id, request_id, message, created_at)`

Funciones/RPC opcionales:
- `decrement_guest_limit_if_enough(p_guest_id, p_amount)`  
  (o _fallback_ manual que actualiza `guests.spend_limit`).

> **Importante:** crea una **vista** `menu_union` que unifique menús de `rest1_menu_items` y `rest2_menu_items` con el esquema de `MenuRow`.

---

## Testing

### Unit/Integración (Jest + Supertest)
Ejemplo mínimo (un éxito y un error por validación):

```ts
import request from 'supertest';
import tool from '../src/index';

describe('Agent-03 Tool - Minimal Tests', () => {
  let server: any;

  beforeAll(async () => {
    await tool.start({ port: 0 });
    // @ts-ignore
    server = tool.server;
  });

  afterAll(async () => {
    await tool.stop();
  });

  it('ejecuta con éxito con input válido', async () => {
    const input = {
      input_data: {
        action: 'create',
        guest_id: 'G-1',
        room: '1205',
        items: [{ name: 'Tostadas de Tinga' }],
        notes: 'sin cebolla, porfa',
      },
    };

    const res = await request(server).post('/api/execute').send(input);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('request_id');
    expect(res.body.data.domain).toBe('rb');
  });

  it('devuelve error si faltan guest_id/room', async () => {
    const badInput = {
      input_data: { action: 'create', items: [{ name: 'Tostadas de Tinga' }] },
    };
    const res = await request(server).post('/api/execute').send(badInput);
    expect([200,400]).toContain(res.status);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
```

Correr tests:
```bash
npm test
```

---

## Docker / Compose

### Dockerfile (Node 20 + runtime)
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production INIT_ON_START=false INTERACTIVE_DECIDE=false
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Comandos
```bash
docker build -t agent-03:latest .
docker run --rm -p 3000:3000 --env-file .env agent-03:latest
```

### docker-compose.yml (opcional)
```yaml
services:
  agent03:
    build: .
    image: agent-03:latest
    ports: ["3000:3000"]
    env_file: .env
    environment:
      INIT_ON_START: "false"
      INTERACTIVE_DECIDE: "false"
```

---

## Estructura del proyecto

```
agent-03/
├── src/
│   ├── index.ts                  # Bootstrap y ejecución del Tool
│   ├── api/
│   │   ├── rbApi.ts              # Menú, stock, ledger, tickets RB, feedback, cross-sell
│   │   └── maintenanceApi.ts     # Tickets de mantenimiento
│   ├── utils/utils.ts            # Horarios, clasificación, prioridad (API), helpers
│   ├── agent/
│   │   ├── agentInput.ts         # Tipado de entrada
│   │   └── agentConfig.ts        # Tipado de config
│   └── types.ts                  # Tipos compartidos
├── tests/                        # Pruebas (Jest/Supertest)
├── ai_priority/                  # Dataset y modelo (Python)
│   ├── tickets_priority_dataset.csv
│   ├── train_priority.py         # Entrenamiento (sklearn)
│   └── priority_api.py           # FastAPI /predict
├── .env.example
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

## Licencia

MIT — © Mariana Carrillo Holguin, Zuleyca Guadalupe Balles Soto, María Regina Orduño López, Mariana Islas Mondragón, Miguel Degollado Macías
