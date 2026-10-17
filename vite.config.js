import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import desktopSecurity from "./electron/security.js";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), {
    name: "desktop-content-security-policy",
    transformIndexHtml(html, context) {
      const { contentSecurityPolicy } = desktopSecurity.createRendererSecurity({
        rendererPath: path.resolve("index.html"),
        devServerUrl: process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5179",
        isDev: Boolean(context.server),
        getWindows: () => [],
      });
      return html.replace("__MISSIONS_CSP__", contentSecurityPolicy);
    },
  }],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5179,
  },
});
