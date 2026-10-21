// Spec 034, AC-20: the violation fixture itself works. Every other spec trusts it to see a violation,
// so this one provokes a real one: an inline script whose hash is not pinned.
import { expect, test } from './csp-violations.ts';

const APPEND_UNPINNED_SCRIPT = `(() => {
  const script = document.createElement('script');
  script.textContent = 'window.__unpinnedScript = "AC-20";';
  document.body.append(script);
})()`;

test.describe('the violation fixture', () => {
  test('AC-20: an inline script whose hash is not pinned records one script-src-elem violation', async ({
    page,
    violations,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(violations.entries).toEqual([]);

    await page.evaluate(APPEND_UNPINNED_SCRIPT);

    await expect.poll(() => violations.violations().length).toBe(1);
    expect(violations.violations()[0]?.effectiveDirective).toBe('script-src-elem');
    expect(violations.consoleMessages().length).toBeLessThanOrEqual(1);
    violations.clear();
  });

  test('AC-20: a violation on a first page is still recorded after navigating to a second page', async ({
    page,
    violations,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(APPEND_UNPINNED_SCRIPT);
    await expect.poll(() => violations.violations().length).toBe(1);

    await page.goto('/d1/', { waitUntil: 'networkidle' });

    expect(violations.violations()).toHaveLength(1);
    expect(violations.violations()[0]?.effectiveDirective).toBe('script-src-elem');
    // It was reported by the first page ("/"), not by the page the test is on now ("/d1/").
    expect(new URL(violations.violations()[0]?.page ?? '').pathname).toBe('/');
    expect(new URL(page.url()).pathname).toBe('/d1/');
    violations.clear();
  });
});
