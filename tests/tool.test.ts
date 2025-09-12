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
        action: 'create',
        guest_id: 'G-1',
        room: '1205',
        items: [{ name: 'Tostadas de Tinga' }],
        notes: 'sin cebolla, porfa',
    };

    const res = await request(server)
      .post('/api/execute')
      .send(input)
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('request_id');
    expect(res.body.data.domain).toBe('rb');
    expect(res.body.data.cross_sell_suggestions).toBeInstanceOf(Array);
  });

  it('returns error when missing required fields', async () => {
    const input = {
      input_data: {
        action: 'create',
        // guest_id y room faltan
        items: [{ name: 'Tostadas de Tinga' }],
      },
    };

    const res = await request(server)
      .post('/api/execute')
      .send(input)
      .expect(400);

    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

