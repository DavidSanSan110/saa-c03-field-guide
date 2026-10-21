// Spec 034, AC-24: Pagefind search (WASM under 'wasm-unsafe-eval') runs with no CSP violation.
import { expect, expectNoViolations, gotoUnderCsp, test } from './csp-violations.ts';

test.describe('search', () => {
  test('AC-24: typing "security" in the search dialog shows at least one result', async ({
    page,
    violations,
  }) => {
    await gotoUnderCsp(page, '/');

    await page.getByRole('button', { name: 'Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill('security');

    await expect(dialog.getByRole('link').first()).toBeVisible();
    expectNoViolations(violations);
  });
});
