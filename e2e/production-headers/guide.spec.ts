// Spec 034, AC-21: guide pages and the theme toggle run with no CSP violation.
import { expect, expectNoViolations, gotoUnderCsp, test } from './csp-violations.ts';

test.describe('guide pages', () => {
  for (const path of ['/', '/d1/', '/d1/1-1-secure-access/']) {
    test(`AC-21: ${path} loads with no CSP violation`, async ({ page, violations }) => {
      await gotoUnderCsp(page, path);

      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expectNoViolations(violations);
    });
  }

  test('AC-21: the theme select switches data-theme to dark and back to light with no CSP violation', async ({
    page,
    violations,
  }) => {
    await gotoUnderCsp(page, '/d1/');
    const select = page.getByLabel('Select theme').first();

    await select.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await select.selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    expectNoViolations(violations);
  });
});
