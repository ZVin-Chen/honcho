import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built assets are served from /admin/ui/ by the honcho FastAPI app
// (see src/main.py). The base path must match or the index.html will
// reference assets at the wrong URL.
export default defineConfig({
  plugins: [react()],
  base: "/admin/ui/",
  server: {
    // For `npm run dev` against a running honcho-api on :8000.
    proxy: {
      "/admin/workspaces": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
