import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { validateFrontendMode } from "./src/auth/authConfig";

export default defineConfig(({ mode }) => {
  validateFrontendMode(mode, loadEnv(mode, process.cwd(), "VITE_"));
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    resolve: {
      alias: {
        "@infralens/shared": fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url)
        )
      }
    }
  };
});
