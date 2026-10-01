import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
  server: {
    port: 5173,
    // /content is deliberately not proxied: it must stay a different origin (P1-06).
    // Keep the browser's Host (localhost:5173): the server tells the app host from the content
    // host (127.0.0.1 in development) by the Host header.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
