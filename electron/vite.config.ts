import { defineConfig } from "vite-plus";
import path from "node:path";

const root = import.meta.dirname;
export default defineConfig({
  root: path.join(root, "src/ui"),
  base: "./",
  build: {
    outDir: path.join(root, "dist/app/ui"),
    emptyOutDir: true,
    target: "chrome152",
    modulePreload: false,
    rolldownOptions: {
      output: { entryFileNames: "renderer.js", assetFileNames: "style.css" },
    },
  },
  pack: [
    {
      entry: { main: "src/main.ts", "history-worker": "src/history-worker.ts" },
      outDir: "dist/app",
      clean: false,
      minify: true,
      format: "esm",
      target: "node24",
      platform: "node",
      dts: false,
      deps: { neverBundle: ["electron"] },
      outExtensions: () => ({ js: ".mjs" }),
    },
    {
      entry: { preload: "src/preload.ts" },
      outDir: "dist/app",
      clean: false,
      minify: true,
      format: "cjs",
      target: "node24",
      platform: "node",
      dts: false,
      deps: { neverBundle: ["electron"] },
      outExtensions: () => ({ js: ".cjs" }),
    },
    {
      entry: { main: "test/baseline/main.ts" },
      outDir: "dist/baseline",
      clean: false,
      minify: true,
      format: "esm",
      target: "node24",
      platform: "node",
      dts: false,
      deps: { neverBundle: ["electron"] },
      outExtensions: () => ({ js: ".mjs" }),
    },
  ],
  test: {
    root,
    include: ["test/*.test.ts"],
    environment: "node",
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 30000,
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    // Playwright requires a destructured fixture argument, even when unused.
    overrides: [{ files: ["test/*.spec.ts"], rules: { "no-empty-pattern": "off" } }],
  },
});
