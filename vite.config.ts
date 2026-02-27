import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    watch: {
      chokidar: {
        usePolling: true,
        interval: 300,
        binaryInterval: 500
      }
    },
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name][extname]"
      }
    }
  }
});
