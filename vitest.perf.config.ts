import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Отдельный прогон перф-регрессии — без покрытия.
 *
 * Инструментовка v8 замедляет тесные циклы в разы: меширование чанка под
 * ней стоит сто миллисекунд вместо двадцати. Мерить бюджеты в таких
 * условиях бессмысленно, поэтому конфиг свой.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@tvox/core': r('./packages/core/src/index.ts'),
      '@tvox/game': r('./packages/game/src/index.ts'),
      '@tvox/render': r('./packages/render/src/index.ts'),
    },
  },
  test: {
    include: ['packages/game/test/perf.test.ts'],
    environment: 'node',
  },
});
