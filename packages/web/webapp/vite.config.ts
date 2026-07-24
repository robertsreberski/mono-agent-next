/// <reference types="vitest/config" />

import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "notification-sw.js"],
      manifest: {
        name: "mono-agent Console",
        short_name: "mono-agent",
        description: "Authenticated console for mono-agent operators.",
        theme_color: "#111310",
        background_color: "#111310",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        importScripts: ["notification-sw.js"],
        globPatterns: ["**/*.{js,css,html,svg,woff2,webmanifest}"],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/u, /^\/healthz$/u],
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 5050,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5051",
      "/healthz": "http://127.0.0.1:5051",
    },
  },
  preview: { host: "0.0.0.0", port: 5050, strictPort: true },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@assistant-ui")) return "assistant-ui";
          if (id.includes("react")) return "react";
          return undefined;
        },
      },
    },
  },
});
