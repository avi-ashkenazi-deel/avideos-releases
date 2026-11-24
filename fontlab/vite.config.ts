import { defineConfig } from 'vite';

export default defineConfig({
  // relative by default, so the built site works from any address or sub-folder without configuration
  base: process.env.FONTLAB_BASE ?? './',
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
} as any);
