import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  outputDir: "../.artifacts/visual/electron-tests",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 8000 },
  reporter: "list",
});
