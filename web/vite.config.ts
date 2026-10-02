import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, requests to /api are proxied to the back end when
// SKYS_API_PROXY is set (e.g. SKYS_API_PROXY=http://localhost:8787).
const proxyTarget = process.env.SKYS_API_PROXY;

export default defineConfig({
  plugins: [react()],
  server: proxyTarget ? { proxy: { '/api': { target: proxyTarget, changeOrigin: true } } } : undefined,
});
