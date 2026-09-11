import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test', testMatch: '*.spec.mjs', workers: 1, retries: 0,
  timeout: 90000, expect: { timeout: 8000 }, reporter: 'list',
});
