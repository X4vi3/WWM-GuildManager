import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    // В dev проксируем API на локальный бэкенд (server/index.mjs на :3001)
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  // Корень домена на VPS. Если кладёшь в подпапку — поменяй (напр. '/wwm/').
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
});
