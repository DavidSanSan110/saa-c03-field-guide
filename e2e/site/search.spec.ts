import { expect, test } from '@playwright/test';
import { DESKTOP_VIEWPORT } from './support.ts';
import { BANNER_TEXT, DISCLAIMER_TEXT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

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

  for (const term of ['November', 'sponsored']) {
    test(`AC-16: searching "${term}" finds nothing`, async ({ page }) => {
      await page.goto('/');

      await page.getByRole('button', { name: 'Search' }).click();
      const dialog = page.getByRole('dialog', { name: 'Search' });
      await dialog.getByRole('textbox').fill(term);

      // Wait for Pagefind to settle on its "No results" message instead of sleeping.
      await expect(dialog.getByText(/No results for/i)).toBeVisible();
      await expect(dialog.getByRole('link')).toHaveCount(0);
    });
  }

  test('AC-16: searching "data security" still finds the 1.3 task page', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('textbox').fill('data security');

    await expect(dialog.locator('a[href^="/d1/1-3-data-security/"]').first()).toBeVisible();
  });
});
