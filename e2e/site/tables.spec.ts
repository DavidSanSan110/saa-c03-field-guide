/// <reference lib="dom" />
// Browser checks of the focusable content tables (spec 039, AC-11…AC-14 and AC-16), against the built
// site. AC-11…AC-14 use the fixture route /fixtures/tables/ (Markdown through the real pipeline).
// AC-1…AC-10 and AC-17 are unit tests (apps/site/src/markdown/), AC-15 is e2e/site/a11y-phone.spec.ts.
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { pixel7 } from './support.ts';

const FIXTURE_PATH = '/fixtures/tables/';
const PHONE = { width: 360, height: 780 };
const MAX_TABS = 30;

/** The five tables of the fixture, in page order. */
const EXPECTED_LABELS = [
  'Table',
  'Wide table',
  'The aws:PrincipalOrgID key',
  'The aws:PrincipalOrgID key (table 2)',
  'Narrow table',
];

function tablesOf(page: Page): Locator {
  return page.locator('main table');
}

/** Opens the fixture page (fresh load) and checks that it exists. */
async function openFixture(page: Page): Promise<void> {
  const response = await page.goto(FIXTURE_PATH);
  expect(response?.status(), `${FIXTURE_PATH} is served`).toBe(200);
  await page.waitForLoadState('load');
}

/** True when `locator`'s element is the page's active element. */
function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}

/**
 * Presses Tab from the top of the page, at most `MAX_TABS` times, until `target` has focus.
 * `previous` is whether `before` had focus just before the last Tab.
 */
async function tabTo(
  page: Page,
  target: Locator,
  before: Locator,
): Promise<{ reached: boolean; tabs: number; previousWasBefore: boolean }> {
  let previousWasBefore = false;
  for (let tabs = 1; tabs <= MAX_TABS; tabs += 1) {
    await page.keyboard.press('Tab');
    if (await isFocused(target)) return { reached: true, tabs, previousWasBefore };
    previousWasBefore = await isFocused(before);
  }
  return { reached: false, tabs: MAX_TABS, previousWasBefore };
}

// ---------------------------------------------------------------------------
// AC-11: every table is focusable and named
// ---------------------------------------------------------------------------

test.describe('tables of the fixture page', () => {
  test('AC-11: every table in main has tabindex="0"', async ({ page }) => {
    await openFixture(page);
    const tables = tablesOf(page);

    await expect(tables).toHaveCount(EXPECTED_LABELS.length);
    const tabindexes = await tables.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('tabindex')),
    );
    expect(tabindexes).toEqual(EXPECTED_LABELS.map(() => '0'));
  });

  test('AC-11: the tables are named after their headings, in page order', async ({ page }) => {
    await openFixture(page);
    const tables = tablesOf(page);

    await expect(tables).toHaveCount(EXPECTED_LABELS.length);
    const labels = await tables.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    );
    expect(labels).toEqual(EXPECTED_LABELS);
  });
});

// ---------------------------------------------------------------------------
// AC-12: a wide table is reachable and scrollable with the keyboard on a phone
// ---------------------------------------------------------------------------

test.describe('keyboard access on a phone', () => {
  test.use({ viewport: PHONE });

  test('AC-12: Tab reaches the wide table right after the first table, ArrowRight scrolls it', async ({
    page,
  }) => {
    await openFixture(page);
    const first = tablesOf(page).nth(0);
    const wide = tablesOf(page).nth(1);

    const overflow = await wide.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(overflow.scrollWidth, 'the wide table overflows at 360 px').toBeGreaterThan(
      overflow.clientWidth,
    );

    const result = await tabTo(page, wide, first);
    expect(result.reached, `the wide table is reached within ${String(MAX_TABS)} Tab presses`).toBe(
      true,
    );
    expect(result.previousWasBefore, 'the first table had focus just before').toBe(true);

    expect(await wide.evaluate((element) => element.scrollLeft)).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => wide.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-13: the focus ring
// ---------------------------------------------------------------------------

test.describe('focus ring', () => {
  test.use({ viewport: PHONE });

  for (const theme of ['light', 'dark'] as const) {
    test(`AC-13: a keyboard-focused table shows a solid accent outline in the ${theme} theme`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('starlight-theme', value);
      }, theme);
      await openFixture(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const first = tablesOf(page).nth(0);
      const wide = tablesOf(page).nth(1);
      // A probe styled with the accent colour tells what colour the ring must have in this theme.
      const accent = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.setProperty('color', 'var(--sl-color-text-accent)');
        (document.querySelector('main') ?? document.body).append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });

      const result = await tabTo(page, wide, first);
      expect(result.reached, 'the wide table is reached with the keyboard').toBe(true);

      const outline = await wide.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
          color: style.outlineColor,
        };
      });
      expect(outline.style).toBe('solid');
      expect(outline.width).toBeGreaterThanOrEqual(2);
      expect(outline.color).toBe(accent);
    });
  }

  test('AC-13: a table focused by a mouse click shows no outline', async ({ page }) => {
    await openFixture(page);
    const wide = tablesOf(page).nth(1);

    await wide.click();

    expect(await isFocused(wide), 'the click focuses the table').toBe(true);
    const outlineStyle = await wide.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outlineStyle).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// AC-14: axe on the fixture page
// ---------------------------------------------------------------------------

async function violationsOnFixture(page: Page) {
  await openFixture(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

test.describe('accessibility of the fixture page', () => {
  test.describe('at 360 x 780', () => {
    test.use({ viewport: PHONE });
    test('AC-14: axe finds no WCAG A/AA violations at 360 x 780', async ({ page }) => {
      expect(await violationsOnFixture(page)).toEqual([]);
    });
  });

  test.describe('on a Pixel 7', () => {
    test.use(pixel7);
    test('AC-14: axe finds no WCAG A/AA violations on a Pixel 7', async ({ page }) => {
      expect(await violationsOnFixture(page)).toEqual([]);
    });
  });

  test.describe('at 1440 x 900', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test('AC-14: axe finds no WCAG A/AA violations at 1440 x 900', async ({ page }) => {
      expect(await violationsOnFixture(page)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-16: the real content pages
// ---------------------------------------------------------------------------

const DIST = resolve(import.meta.dirname, '..', '..', 'apps', 'site', 'dist');
const SKIPPED_TOP_DIRS = new Set(['fixtures', 'practice', '_astro', 'pagefind']);

/** Every `index.html` under dist/ except the fixtures, the practice app and build assets, as a route. */
function docsRoutes(directory: string = DIST): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === DIST && SKIPPED_TOP_DIRS.has(entry.name)) continue;
      routes.push(...docsRoutes(path));
    } else if (entry.name === 'index.html') {
      const parts = relative(DIST, directory).split(sep).filter(Boolean);
      routes.push(parts.length === 0 ? '/' : `/${parts.join('/')}/`);
    }
  }
  return routes.sort();
}

test.describe('real content pages', () => {
  test('AC-16: every content table of every docs page is focusable and has a real name', async ({
    page,
  }) => {
    const routes = docsRoutes();
    expect(routes.length, 'the build contains docs pages').toBeGreaterThan(0);
    test.setTimeout(30_000 + routes.length * 5_000);

    let checked = 0;
    const problems: string[] = [];
    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} is served`).toBe(200);
      const tables = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.sl-markdown-content table'))
          .filter((table) => table.closest('.not-content') === null)
          .map((table) => ({
            tabindex: table.getAttribute('tabindex'),
            label: table.getAttribute('aria-label'),
          })),
      );
      for (const [index, table] of tables.entries()) {
        checked += 1;
        const where = `${route} table ${String(index + 1)}`;
        if (table.tabindex !== '0')
          problems.push(`${where}: tabindex is ${String(table.tabindex)}`);
        if (table.label === null || table.label.trim() === '') {
          problems.push(`${where}: no aria-label`);
        } else if (table.label.includes('Section titled')) {
          problems.push(`${where}: aria-label "${table.label}" contains the anchor link text`);
        }
      }
    }

    test.info().annotations.push({
      type: 'tables checked',
      description: `${String(checked)} tables on ${String(routes.length)} pages`,
    });
    console.log(`AC-16: checked ${String(checked)} tables on ${String(routes.length)} pages`);
    expect(problems).toEqual([]);
  });
});
