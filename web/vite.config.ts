import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? process.env.ANEMO_WEB_PORT ?? 5180),
    // Host beibehalten (changeOrigin: false): der Server prüft bei ändernden Anfragen Origin gegen Host
    proxy: Object.fromEntries(['/api', '/health', '/go'].map((p) => [p, { target: `http://localhost:${process.env.ANEMO_PORT ?? 8090}`, changeOrigin: false }])),
  },
  build: { outDir: 'dist', sourcemap: true },
});
