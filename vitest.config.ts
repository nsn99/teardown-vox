import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tvox/core': r('./packages/core/src/index.ts'),
      '@tvox/game': r('./packages/game/src/index.ts'),
      '@tvox/render': r('./packages/render/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Физическое ядро и игровая логика — обязательное покрытие.
      // Рендер исключён: проверяется скриншот-регрессией, не юнит-тестами.
      include: ['packages/core/src/**/*.ts', 'packages/game/src/**/*.ts'],
      exclude: ['**/index.ts', '**/*.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
