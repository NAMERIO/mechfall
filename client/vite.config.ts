import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      "/api": { target: "http://localhost:3001", xfwd: true },
      "/health": "http://localhost:3001",
      "/play": { target: "ws://localhost:3001", ws: true }
    }
  },
  build: {
    target: "es2022",
    sourcemap: true
  }
});
