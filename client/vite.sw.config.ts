import { defineConfig } from "vite";

// The service worker (src/sw.ts), built after the app into the same dist/ as
// one self-contained classic script at /sw.js: no imports, no shared chunks,
// so every browser can run it and its scope is the whole site. See sw.ts.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    sourcemap: true,
    lib: { entry: "src/sw.ts", formats: ["iife"], name: "hdctlServiceWorker", fileName: () => "sw.js" },
  },
});
