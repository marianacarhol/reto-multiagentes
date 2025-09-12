// Jest setup file for common test configuration

// Aumentar timeout para tests de integración
jest.setTimeout(10000);

// Mock de console.log y console.error para reducir ruido
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeAll(() => {
  console.log = jest.fn();
  console.error = jest.fn();
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

// Utilidades globales para tests
global.testUtils = {
  // Crear input válido
  createValidInput: (overrides = {}) => ({
    input_data: {
      message: 'Test message',
      count: 1,
      uppercase: false,
      ...overrides,
    },
  }),

  // Crear input inválido
  createInvalidInput: (invalidField: string, invalidValue: any) => {
    const input = global.testUtils.createValidInput();
    input.input_data[invalidField] = invalidValue;
    return input;
  },

  // Esperar un tiempo (async)
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

// Tipos globales
declare global {
  namespace globalThis {
    var testUtils: {
      createValidInput: (overrides?: any) => any;
      createInvalidInput: (invalidField: string, invalidValue: any) => any;
      wait: (ms: number) => Promise<void>;
    };
  }
}

