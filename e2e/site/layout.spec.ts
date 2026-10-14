import { expect, test, type Page } from '@playwright/test';
import {
  BANNER_TEXT,
  DESKTOP_VIEWPORT,
  DISCLAIMER_TEXT,
  LAYOUT_PAGES,
  LICENSE_CONTENT_URL,
  LICENSE_URL,
} from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

const NOT_FOUND_PAGE = { name: '404 page', path: '/no-such-page/' } as const;

async function expectFooter(page: Page): Promise<void> {
  const footer = page.locator('footer', { hasText: DISCLAIMER_TEXT }).first();

  await expect(footer).toBeVisible();
  await expect(footer.getByText(DISCLAIMER_TEXT)).toBeVisible();
  await expect(footer.getByRole('link', { name: 'MIT', exact: true })).toHaveAttribute(
    'href',
    LICENSE_URL,
  );
  await expect(footer.getByRole('link', { name: 'CC BY-SA 4.0', exact: true })).toHaveAttribute(
    'href',
    LICENSE_CONTENT_URL,
  );
}

test.describe('banner', () => {
  for (const { name, path } of [...LAYOUT_PAGES, NOT_FOUND_PAGE]) {
    test(`AC-9: the under-construction banner is visible on the ${name} (${path})`, async ({
      page,
    }) => {
      await page.goto(path);

      await expect(page.getByText(BANNER_TEXT)).toBeVisible();
    });
  }
});

test.describe('footer', () => {
  for (const { name, path } of [...LAYOUT_PAGES, NOT_FOUND_PAGE]) {
    test(`AC-10: the disclaimer and the licence links are in a footer on the ${name} (${path})`, async ({
      page,
    }) => {
      await page.goto(path);

      await expectFooter(page);
    });
  }
});

test.describe('404 page', () => {
  test('AC-11: an unknown page answers HTTP 404', async ({ page }) => {
    const response = await page.goto(NOT_FOUND_PAGE.path);

    expect(response?.status()).toBe(404);
  });

  test('AC-11: the 404 page still shows the site title', async ({ page }) => {
    await page.goto(NOT_FOUND_PAGE.path);

    await expect(
      page.getByRole('link', { name: 'SAA-C03 Field Guide', exact: true }),
    ).toBeVisible();
  });

  test('AC-11: the 404 page still shows the banner', async ({ page }) => {
    await page.goto(NOT_FOUND_PAGE.path);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible();
  });

  test('AC-11: the 404 page still shows the footer', async ({ page }) => {
    await page.goto(NOT_FOUND_PAGE.path);

    await expectFooter(page);
  });
});

const LICENCE_LINE = 'Licensed MIT (code) and CC BY-SA 4.0 (content).';

test.describe('licence line', () => {
  for (const { name, path } of [...LAYOUT_PAGES, NOT_FOUND_PAGE]) {
    test(`AC-15: the footer licence line reads without run-together words on the ${name} (${path})`, async ({
      page,
    }) => {
      await page.goto(path);

      const footer = page.locator('footer', { hasText: DISCLAIMER_TEXT }).first();
      const line = footer.getByText(/^Licensed/);
      const text = ((await line.textContent()) ?? '').replace(/\s+/g, ' ').trim();

      expect(text).toBe(LICENCE_LINE);
    });
  }
});
