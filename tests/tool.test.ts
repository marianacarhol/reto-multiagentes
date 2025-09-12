import request from 'supertest';
import tool from '../src/index';

describe('Agent-03 Tool - Minimal Tests', () => {
  let server: any;

  beforeAll(async () => {
    // Arranca el tool en memoria
    await tool.start({ port: 0 }); // puerto 0 evita conflictos
    server = tool.server; // instancia del server
  });

  afterAll(async () => {
    await tool.stop();
  });

  it('executes successfully with valid input', async () => {
    const input = {
      input_data: {
        action: 'create',
        guest_id: 'G-1',
        room: '1205',
        items: [{ name: 'Tostadas de Tinga' }],
        notes: 'sin cebolla, porfa',
      },
    };

    const res = await request(server)
      .post('/api/execute')
      .send(input)
      .expect(200);

    // Tu tool devuelve output_data
    expect(res.body.status).toBe('success');
    expect(res.body.output_data).toHaveProperty('request_id');
    expect(res.body.output_data.domain).toBe('rb');
    expect(res.body.output_data.cross_sell_suggestions).toBeInstanceOf(Array);
  });

  it('returns error when missing required fields', async () => {
    const input = {
      input_data: {
        action: 'create',
        
        items: [{ name: 'Tostadas de Tinga' }],
      },
    };

    const res = await request(server)
      .post('/api/execute')
      .send(input)
      .expect(500);

    
    expect(res.body.status).toBe('error');
    expect(res.body.error_code).toBe('VALIDATION_ERROR');
    expect(res.body.error_message).toBe('guest_id y room son requeridos (string) para crear ticket');
  });
});

