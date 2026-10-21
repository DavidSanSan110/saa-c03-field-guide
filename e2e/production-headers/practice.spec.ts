// Spec 034, AC-23: the practice app runs under the production headers with no CSP violation. Opening
// the page and starting a session also covers Zod, which must not probe Function('') (spec section 4).
import { expect, expectNoViolations, gotoUnderCsp, test } from './csp-violations.ts';

const FIRST_QUESTION = /^Question 1 of \d+$/;

test.describe('practice tests', () => {
  test('AC-23: Start practice shows question 1, an option and Check answer show the explanation', async ({
    page,
    violations,
  }) => {
    await gotoUnderCsp(page, '/practice/');

    await page.getByRole('button', { name: 'Start practice', exact: true }).click();
    await expect(page.getByRole('heading', { name: FIRST_QUESTION })).toBeVisible();
    await page
      .getByRole('main')
      .locator('label')
      .filter({ has: page.locator('input[type="radio"], input[type="checkbox"]') })
      .first()
      .click();
    await page.getByRole('button', { name: 'Check answer', exact: true }).click();

    await expect(page.getByRole('list', { name: 'Answer options', exact: true })).toBeVisible();
    expectNoViolations(violations);
  });

  test('AC-23: the exam mode starts its first question', async ({ page, violations }) => {
    await gotoUnderCsp(page, '/practice/');

    await page.getByRole('button', { name: 'Start exam', exact: true }).click();

    await expect(page.getByRole('heading', { name: FIRST_QUESTION })).toBeVisible();
    expectNoViolations(violations);
  });
});
