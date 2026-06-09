import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname, "src/admin/ui"),
  base: "/admin-ui/",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/admin-ui"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, "src/admin/ui/index.html"),
    },
    // Don't inline small assets — all woff2/js/css must be served as files
    assetsInlineLimit: 0,
  },
  // In dev mode: backend runs on 3100, Vite HMR proxies API calls
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/admin-ui": "http://127.0.0.1:3100",
    },
  },
});
