import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // The empty prefix loads all variables, but only VITE_* ones are ever exposed
  // to browser code. API_PROXY_TARGET stays on the dev server.
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxyTarget = env.API_PROXY_TARGET ?? 'http://localhost:4000';

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // The browser calls /api/... on the same origin; Vite forwards it to the
      // backend (http://backend:4000 inside Docker). No CORS needed.
      proxy: {
        '/api': { target: apiProxyTarget, changeOrigin: true },
      },
      // File change events do not always cross Docker bind mounts on Windows/macOS.
      watch: env.CHOKIDAR_USEPOLLING === 'true' ? { usePolling: true, interval: 300 } : undefined,
    },
  };
});
