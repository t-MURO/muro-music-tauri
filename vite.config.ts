import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Electron loads the production renderer with file://, so emitted assets
  // must resolve relative to dist/index.html rather than the filesystem root.
  base: "./",
  plugins: [react()],
  publicDir: fromHere("./public"),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@muro/desktop/runtime": fromHere("./src/desktop/runtime.ts"),
      "@muro/desktop/events": fromHere("./src/desktop/events.ts"),
      "@muro/desktop/paths": fromHere("./src/desktop/paths.ts"),
      "@muro/desktop/dialogs": fromHere("./src/desktop/dialogs.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
