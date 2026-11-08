import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:client` serves the app with hot reload and sends /api to a
// local `wrangler dev` (npm run dev -w worker) on 8787.
//
// __HDCTL_BUILD__ is the build id the Worker also reports in X-Hdctl-Build
// (deploy.yml sets both to the git SHA). An open tab that sees a different
// one reloads, so a deploy never leaves an old bundle running.
export default defineConfig({
  plugins: [react()],
  define: { __HDCTL_BUILD__: JSON.stringify(process.env.HDCTL_BUILD_ID ?? "dev") },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
