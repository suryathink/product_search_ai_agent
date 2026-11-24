import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No dev proxy: the app calls the backend directly at VITE_API_BASE_URL (default http://localhost:3001).
// The backend allows this origin via its CORS allowlist (CORS_ORIGINS).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
