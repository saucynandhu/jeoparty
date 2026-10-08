import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3001";

// Dev: the client talks to the server through this proxy, so the browser sees a
// single origin and no CORS/websocket-upgrade surprises. In production the
// server serves the built client and the proxy is irrelevant.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/socket.io": { target: SERVER_URL, ws: true, changeOrigin: true },
      "/health": { target: SERVER_URL, changeOrigin: true },
    },
  },
});
