import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DESKTOP_VIEWPORT, pixel7 } from './support.ts';

const PAGES = [
  { name: 'home page', path: '/', status: 200 },
  { name: 'domain page', path: '/d1/', status: 200 },
  { name: 'task page', path: '/d1/1-3-data-security/', status: 200 },
  { name: 'practice tests page', path: '/practice-tests/', status: 200 },
  { name: '404 page', path: '/no-such-page/', status: 404 },
] as const;

async function violationsOn(page: Page, path: string, status: number) {
  // Scan the real page (not Starlight's fallback 404 for a page that does not exist yet).
  const response = await page.goto(path);
  expect(response?.status()).toBe(status);
  await page.waitForLoadState('load');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

test.describe('accessibility on desktop', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  for (const { name, path, status } of PAGES) {
    test(`AC-13: axe finds no WCAG A/AA violations on the ${name} (${path}) on desktop`, async ({
      page,
    }) => {
      expect(await violationsOn(page, path, status)).toEqual([]);
    });
  }
});

test.describe('accessibility on mobile', () => {
  test.use(pixel7);

  for (const { name, path, status } of PAGES) {
    test(`AC-13: axe finds no WCAG A/AA violations on the ${name} (${path}) on a Pixel 7`, async ({
      page,
    }) => {
      expect(await violationsOn(page, path, status)).toEqual([]);
    });
  }
});
