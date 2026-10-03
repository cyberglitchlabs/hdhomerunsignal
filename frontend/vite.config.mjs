import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server cannot reach the backend on its own, so proxy the API and
// the Socket.IO endpoint to it. Override the target with BACKEND_URL.
const backend = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  build: {
    // The Dockerfile copies frontend/build into the runtime image.
    outDir: 'build',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
