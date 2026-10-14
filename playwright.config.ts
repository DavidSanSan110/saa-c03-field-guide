import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4321';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'pnpm --filter @field-guide/site build && pnpm --filter @field-guide/site preview --host 127.0.0.1 --port 4321',
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    // Injects the /fixtures/diagram/ route of spec 012 into the built site.
    env: { FIELD_GUIDE_FIXTURES: '1' },
  },
});
