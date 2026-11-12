import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore Node-side middleware is deliberately plain ESM, shared with production.
import { localApi } from './server/local.mjs';

export default defineConfig({
  plugins: [react(), {
    name: 'kaishi-local',
    configureServer(server) {
      const api = localApi(server.config.root);
      api.listen(server.httpServer);
      server.middlewares.use(api.handler);
    },
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false, fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**'] } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
