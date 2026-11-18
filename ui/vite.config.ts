/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the UI runs on :5173 and forwards /api and /ws to the Python server (default :8765).
// Start the server with MINI_CLAUDE_DEV_ORIGINS=http://localhost:5173 so it accepts that origin.
const backend = process.env.MINI_CLAUDE_BACKEND ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend },
      "/ws": { target: backend, ws: true },
    },
  },
  // The syntax highlighter's language set makes the bundle about 600 kB (180 kB gzipped); fine for a local app.
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"], globals: true },
});
