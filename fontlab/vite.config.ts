import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.FONTLAB_BASE ?? '/',
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
} as any);
