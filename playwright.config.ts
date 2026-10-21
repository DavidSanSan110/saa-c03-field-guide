import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4321';

const siteConfig = defineConfig({
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

// Spec 034: a second server and project serve the same dist/ with the headers of
// apps/site/headers.json, the way CloudFront will, and fail on any CSP violation.
const headersPort = 4322;
const headersURL = `http://127.0.0.1:${String(headersPort)}`;
const siteServers = [siteConfig.webServer ?? []].flat();

export default defineConfig({
  ...siteConfig,
  projects: [
    // The chromium project (astro preview, meta CSP only) must not run the header specs.
    ...(siteConfig.projects ?? []).map((project) => ({
      ...project,
      testIgnore: '**/e2e/production-headers/**',
    })),
    {
      name: 'production-headers',
      testDir: 'e2e/production-headers',
      use: { ...devices['Desktop Chrome'], baseURL: headersURL },
    },
  ],
  webServer: [
    // The existing build + preview entry first: it builds dist/, which the second server serves.
    ...siteServers,
    {
      command: 'node e2e/production-headers/server.mjs',
      url: `${headersURL}/`,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      env: { PORT: String(headersPort) },
    },
  ],
});
