import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// host: true so the dev server is reachable from the Pi touchscreen / LAN.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 5173 },
});
