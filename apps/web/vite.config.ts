import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import { version } from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react", "@pierre/diffs/worker/worker.js"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (!normalizedId.includes("/node_modules/")) {
            return undefined;
          }
          if (normalizedId.includes("/node_modules/@pierre/diffs/react/")) {
            return "vendor-diffs-react";
          }
          if (normalizedId.includes("/node_modules/@pierre/diffs/worker/")) {
            return "vendor-diffs-worker";
          }
          if (normalizedId.includes("/node_modules/@shikijs/langs/")) {
            return "vendor-shiki-langs";
          }
          if (normalizedId.includes("/node_modules/@shikijs/themes/")) {
            return "vendor-shiki-themes";
          }
          if (
            normalizedId.includes("/node_modules/@shikijs/engine-") ||
            normalizedId.includes("/node_modules/@shikijs/vscode-textmate/")
          ) {
            return "vendor-shiki-engine";
          }
          if (
            normalizedId.includes("/node_modules/shiki/") ||
            normalizedId.includes("/node_modules/@shikijs/")
          ) {
            return "vendor-shiki-core";
          }
          if (normalizedId.includes("/node_modules/@pierre/diffs/")) {
            return "vendor-diffs-core";
          }
          if (normalizedId.includes("/node_modules/@xterm/")) {
            return "vendor-terminal";
          }
          if (
            normalizedId.includes("/node_modules/lexical/") ||
            normalizedId.includes("/node_modules/@lexical/")
          ) {
            return "vendor-lexical";
          }
          if (
            normalizedId.includes("/node_modules/react-markdown/") ||
            normalizedId.includes("/node_modules/remark-gfm/") ||
            normalizedId.includes("/node_modules/remark-") ||
            normalizedId.includes("/node_modules/rehype-") ||
            normalizedId.includes("/node_modules/unified/") ||
            normalizedId.includes("/node_modules/mdast-") ||
            normalizedId.includes("/node_modules/micromark/")
          ) {
            return "vendor-markdown";
          }
          if (normalizedId.includes("/node_modules/@clerk/")) {
            return "vendor-clerk";
          }
          if (
            normalizedId.includes("/node_modules/@radix-ui/") ||
            normalizedId.includes("/node_modules/@floating-ui/")
          ) {
            return "vendor-ui";
          }
          if (normalizedId.includes("/node_modules/effect/")) {
            return "vendor-effect";
          }
          if (normalizedId.includes("/node_modules/lucide-react/")) {
            return "vendor-icons";
          }
          if (normalizedId.includes("/node_modules/@tanstack/")) {
            return "vendor-tanstack";
          }
          if (
            normalizedId.includes("/node_modules/react/") ||
            normalizedId.includes("/node_modules/react-dom/") ||
            normalizedId.includes("/node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return "vendor-misc";
        },
      },
    },
  },
});
