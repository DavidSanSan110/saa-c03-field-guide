// Spec 034, AC-25: the 404 page answers 404 and renders the site's not-found page with no violation.
import { expect, expectNoViolations, gotoUnderCsp, test } from './csp-violations.ts';

test.describe('the 404 page', () => {
  test('AC-25: /does-not-exist/ returns 404 and renders the not-found page with no CSP violation', async ({
    page,
    violations,
  }) => {
    await gotoUnderCsp(page, '/does-not-exist/', 404);

    await expect(page).toHaveTitle(/^404 \| SAA-C03 Field Guide/);
    await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
    await expect(page.getByText('Page not found.')).toBeVisible();
    expectNoViolations(violations);
  });
});
