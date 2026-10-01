import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test', testMatch: '**/browser.spec.ts', workers: 1, use: { headless: true }, timeout: 15000 });
