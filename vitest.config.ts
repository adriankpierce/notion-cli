import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    exclude: ['node_modules/**', '.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'test/**',
        'dist/**',
        '**/*.config.ts',
        '**/types.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
  },
});
