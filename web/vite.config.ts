import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    // dev: talk to a real omprd on this machine
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8790", ws: true },
      "/diag": { target: "http://127.0.0.1:8790", rewrite: () => "/" },
    },
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
  },
});
