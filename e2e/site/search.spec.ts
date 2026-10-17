import { expect, test, type Page } from '@playwright/test';
import { DESKTOP_VIEWPORT } from './support.ts';
import { BANNER_TEXT, DISCLAIMER_TEXT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

interface IndexedPage {
  url: string;
  content: string;
}

/** Queries Pagefind's JS API in the page and returns the indexed text of every result. */
async function searchIndex(page: Page, term: string): Promise<IndexedPage[]> {
  return page.evaluate(async (query) => {
    interface PagefindApi {
      init?: () => Promise<void>;
      search: (q: string) => Promise<{
        results: { data: () => Promise<{ url: string; content: string }> }[];
      }>;
    }
    // A variable specifier keeps TypeScript from resolving the import at compile time.
    const specifier = '/pagefind/pagefind.js';
    const pagefind = (await import(/* @vite-ignore */ specifier)) as PagefindApi;
    await pagefind.init?.();
    const search = await pagefind.search(query);
    return Promise.all(
      search.results.map(async (result) => {
        const data = await result.data();
        return { url: data.url, content: data.content };
      }),
    );
  }, term);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

test.describe('search', () => {
  test('AC-12: searching "data security" lists a result linking to the 1.3 task page', async ({
    page,
  }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill('data security');

    await expect(dialog.locator('a[href^="/d1/1-3-data-security/"]').first()).toBeVisible();
  });
});

test.describe('search index', () => {
  test('AC-16: the banner is excluded from the search index', async ({ page }) => {
    await page.goto('/');

    // The ignore attribute sits on the banner element or on a wrapper around it.
    await expect(
      page.locator('[data-pagefind-ignore]').filter({ hasText: BANNER_TEXT }),
    ).not.toHaveCount(0);
  });

  test('AC-16: the site footer is excluded from the search index', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.locator('[data-pagefind-ignore]').filter({ hasText: DISCLAIMER_TEXT }),
    ).not.toHaveCount(0);
  });

  test('AC-16: searching "affiliated" only finds the home page, never the footer on other pages', async ({
    page,
  }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('textbox').fill('affiliated');

    // The home page tagline legitimately says "Not affiliated with AWS", so exactly that page matches.
    await expect(dialog.getByText(/^1 result for affiliated/)).toBeVisible();
    await expect(dialog.getByRole('link').first()).toBeVisible();
    const hrefs = await Promise.all(
      (await dialog.getByRole('link').all()).map((link) => link.getAttribute('href')),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => href !== '/' && !href?.startsWith('/#'))).toEqual([]);
  });

  test('AC-16: searching "sponsored" finds nothing', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('textbox').fill('sponsored');

    // Wait for Pagefind to settle on its "No results" message instead of sleeping.
    await expect(dialog.getByText(/No results for/i)).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(0);
  });

  test('AC-16a: no page in the search index contains the banner', async ({ page }) => {
    await page.goto('/');

    // Pagefind also matches "November" to the standalone word "no", so results may exist; what
    // matters is that none of their indexed text holds the banner.
    const results = await searchIndex(page, 'November');

    const withBanner = results
      .filter((result) => collapseWhitespace(result.content).includes('launching November 2026'))
      .map((result) => result.url);
    expect(withBanner).toEqual([]);
  });

  test('AC-16b: the index returns the home page text for "affiliated" (AC-16a is not vacuous)', async ({
    page,
  }) => {
    await page.goto('/');

    const results = await searchIndex(page, 'affiliated');

    const home = results.find((result) => /^\/(index\.html)?$/.test(result.url));
    expect(home, `no home page in ${JSON.stringify(results.map((r) => r.url))}`).toBeDefined();
    expect(collapseWhitespace(home?.content ?? '')).toContain('Not affiliated with AWS');
  });

  test('AC-16: searching "data security" still finds the 1.3 task page', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('textbox').fill('data security');

    await expect(dialog.locator('a[href^="/d1/1-3-data-security/"]').first()).toBeVisible();
  });
});
