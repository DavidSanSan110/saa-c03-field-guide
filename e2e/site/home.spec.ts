import { expect, test } from '@playwright/test';
import { domains } from '../../packages/schema/src/index.ts';
import { DESKTOP_VIEWPORT, SITE_DESCRIPTION } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

// Literal weights from the spec, so a wrong use of the catalog cannot pass.
const weights = ['30%', '26%', '24%', '20%'] as const;

test.describe('home page', () => {
  test('AC-5: the page is English, titled and headed "SAA-C03 Field Guide"', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle(/SAA-C03 Field Guide/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('SAA-C03 Field Guide');
  });

  test('AC-5: the site description is visible', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText(SITE_DESCRIPTION).first()).toBeVisible();
  });

  test('AC-5: "Start with Domain 1" goes to /d1/', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Start with Domain 1' })).toHaveAttribute(
      'href',
      '/d1/',
    );
  });

  for (const [index, domain] of domains.entries()) {
    const weight = weights[index] ?? '';

    test(`AC-5: domain ${String(domain.id)} links to /d${String(domain.id)}/ and shows its ${weight} weight`, async ({
      page,
    }) => {
      await page.goto('/');
      const main = page.getByRole('main');

      await expect(main.getByRole('link', { name: domain.title }).first()).toHaveAttribute(
        'href',
        `/d${String(domain.id)}/`,
      );
      await expect(main.getByText(weight).first()).toBeVisible();
    });
  }
});
