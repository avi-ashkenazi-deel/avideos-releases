import { defineConfig } from '@playwright/test';

/** Tests against the BUILT site (dist/) behind a plain static server: run `npm run test:dist`. */
export default defineConfig({
  testDir: 'tests/dist',
  timeout: 120_000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5199', viewport: { width: 1400, height: 1000 } },
  webServer: { command: 'node scripts/serve-dist.mjs --port 5199 --base /sub/fontlab/', url: 'http://127.0.0.1:5199/', reuseExistingServer: false, timeout: 30_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}) } }],
});
