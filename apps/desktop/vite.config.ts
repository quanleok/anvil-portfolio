import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/release/**", "**/dist/**", "**/node_modules/**", "**/.forge/**"],
    },
  },
  build: {
    outDir: "dist",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "vendor-react";
          }
          if (
            id.includes("node_modules/@codemirror") ||
            id.includes("node_modules/codemirror") ||
            id.includes("node_modules/@lezer")
          ) {
            return "codemirror";
          }
        },
      },
    },
  },
});
