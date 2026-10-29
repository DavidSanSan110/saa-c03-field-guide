// Spec 039, AC-15: axe finds no WCAG A/AA violations at 360 x 780 on every page linked from the sidebar,
// so a future guide page with a wide table nobody can focus fails CI.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { buildSidebar } from '../../apps/site/src/sidebar.ts';

const PHONE = { width: 360, height: 780 };

/** The `link` of every sidebar entry: 4 domain pages, 14 task pages and the practice page. */
const SIDEBAR_PATHS = buildSidebar().flatMap((entry) =>
  'items' in entry ? entry.items.map((item) => item.link) : [entry.link],
);

test.use({ viewport: PHONE });

test('AC-15: the sidebar lists the 19 pages this check covers', () => {
  expect(SIDEBAR_PATHS).toHaveLength(19);
  expect(new Set(SIDEBAR_PATHS).size).toBe(19);
});

for (const path of SIDEBAR_PATHS) {
  test(`AC-15: axe finds no WCAG A/AA violations at 360 x 780 on ${path}`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await page.waitForLoadState('load');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  });
}
