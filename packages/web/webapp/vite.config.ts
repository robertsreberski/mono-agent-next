/// <reference types="vitest/config" />

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png", "favicon.ico", "notification-sw.js"],
      manifest: {
        name: "mono-agent Console",
        short_name: "mono-agent",
        description: "Always-on local console for your mono-agent fleet.",
        theme_color: "#111210",
        background_color: "#111210",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" }
        ]
      },
      workbox: {
        importScripts: ["notification-sw.js"],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz$/],
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: {
    host: "0.0.0.0",
    port: 5050,
    strictPort: true,
    allowedHosts: [".ts.net"]
  },
  preview: {
    host: "0.0.0.0",
    port: 5050,
    strictPort: true,
    allowedHosts: [".ts.net"]
  },
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          if (id.includes("@assistant-ui/react-markdown")) return "markdown";
          if (id.includes("@assistant-ui")) return "assistant-ui";
          return undefined;
        }
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true
  }
});
