import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@tvox/core': r('../../packages/core/src/index.ts'),
      '@tvox/game': r('../../packages/game/src/index.ts'),
      '@tvox/render': r('../../packages/render/src/index.ts'),
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true, port: 5173 },
  preview: { host: '127.0.0.1' },
});
