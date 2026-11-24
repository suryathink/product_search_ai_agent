import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No dev proxy: the app calls the backend directly at VITE_API_BASE_URL (default http://localhost:3001,
// the same port the backend uses in production behind nginx).
// strictPort: fail instead of silently moving to 5174 when 5173 is busy (CORS allowlists name this exact origin).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
