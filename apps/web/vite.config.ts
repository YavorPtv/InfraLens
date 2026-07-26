import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@infralens/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url)
      )
    }
  }
});
