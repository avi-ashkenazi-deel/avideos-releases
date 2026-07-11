import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import glsl from 'vite-plugin-glsl';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// `base` defaults to '/' (custom domain / local dev). The GitHub Pages build
// sets VITE_BASE to the project subpath, e.g. '/avideos-releases/'.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    react(),
    glsl(),
    // While the site is changing rapidly, ship a self-destroying service
    // worker: it unregisters any previously-installed SW and clears its caches
    // so visitors always get the latest build instead of a stale one.
    VitePWA({ selfDestroying: true }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
