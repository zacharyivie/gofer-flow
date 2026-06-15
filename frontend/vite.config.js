import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiBaseUrl = process.env.VITE_API_BASE_URL || "http://127.0.0.1:8765";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiBaseUrl,
        changeOrigin: true,
      },
    },
  },
});
