import { expect, test } from '@playwright/test';
import { DESKTOP_VIEWPORT } from './support.ts';

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
