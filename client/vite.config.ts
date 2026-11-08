import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:client` serves the app with hot reload and sends /api to a
// local `wrangler dev` (npm run dev -w worker) on 8787.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
