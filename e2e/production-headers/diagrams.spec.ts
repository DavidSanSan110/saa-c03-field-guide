// Spec 034, AC-22: the animated diagrams run under the production headers with no CSP violation.
import type { Page } from '@playwright/test';
import { expect, expectNoViolations, gotoUnderCsp, test } from './csp-violations.ts';

const DIAGRAM_PAGES = [
  { path: '/d1/1-3-data-security/', id: 's3-sse-kms-upload' },
  { path: '/d2/2-2-high-availability/', id: 'alb-asg-az-failure' },
];

/** Opens the page and waits until the island is hydrated (`client:visible` needs it on screen). */
async function open(page: Page, path: string, id: string) {
  await gotoUnderCsp(page, path);
  const figure = page.locator(`figure[data-diagram="${id}"]`);
  const root = figure.locator('[data-diagram-view]');
  await figure.scrollIntoViewIfNeeded();
  await expect(root).toHaveAttribute('data-hydrated', 'true');
  return { figure, root };
}

for (const { path, id } of DIAGRAM_PAGES) {
  test.describe(`the diagram on ${path}`, () => {
    test('AC-22: the diagram renders', async ({ page, violations }) => {
      const { figure, root } = await open(page, path, id);

      await expect(figure).toBeVisible();
      await expect(root).toBeVisible();
      await expect(figure.getByRole('button', { name: 'Step forward' })).toBeVisible();
      expectNoViolations(violations);
    });

    test('AC-22: Step forward advances the step', async ({ page, violations }) => {
      const { figure, root } = await open(page, path, id);

      await figure.getByRole('button', { name: 'Step forward' }).click();
      await expect(root).toHaveAttribute('data-step', '0');
      await figure.getByRole('button', { name: 'Step forward' }).click();
      await expect(root).toHaveAttribute('data-step', '1');

      expectNoViolations(violations);
    });

    test('AC-22: Play starts the animation', async ({ page, violations }) => {
      const { figure, root } = await open(page, path, id);

      await figure.getByRole('button', { name: /^(Play|Pause|Replay)$/ }).click();

      await expect(root).toHaveAttribute('data-playing', 'true');
      expectNoViolations(violations);
    });
  });
}
