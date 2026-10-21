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

// Review round 1 (AC-27): the fixture must also see a violation raised while the page loads, and one
// on a page reached by navigation (a listener installed only after the first load would miss it).
const META_CSP_TAG = /<meta\b[^>]*\bhttp-equiv=["']?content-security-policy["']?[^>]*>/i;
const UNPINNED_LOAD_SCRIPT = '<script>window.__unpinnedAtLoad = "AC-27a";</script>';

test.describe('the violation fixture, review round 1', () => {
  test('AC-27: an unpinned inline script present in the loaded HTML records one script-src-elem violation', async ({
    page,
    violations,
  }) => {
    let injected = false;
    await page.route('**/d1/1-1-secure-access/', async (route) => {
      const response = await route.fetch();
      const original = await response.text();
      // Right after the meta CSP: a meta CSP only covers the content that follows it.
      const body = original.replace(META_CSP_TAG, (meta) => `${meta}${UNPINNED_LOAD_SCRIPT}`);
      injected = body !== original;
      await route.fulfill({
        response,
        body,
        headers: { ...response.headers(), 'content-length': String(Buffer.byteLength(body)) },
      });
    });

    await page.goto('/d1/1-1-secure-access/', { waitUntil: 'networkidle' });

    expect(injected, 'the meta CSP tag was found and the script inserted after it').toBe(true);
    await expect.poll(() => violations.violations().length).toBe(1);
    expect(violations.violations()[0]?.effectiveDirective).toBe('script-src-elem');
    violations.clear();
  });

  test('AC-27: an unpinned inline script appended on the second page of a navigation is recorded', async ({
    page,
    violations,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.goto('/d1/', { waitUntil: 'networkidle' });
    expect(violations.entries).toEqual([]);

    await page.evaluate(APPEND_UNPINNED_SCRIPT);

    await expect.poll(() => violations.violations().length).toBe(1);
    expect(violations.violations()[0]?.effectiveDirective).toBe('script-src-elem');
    expect(new URL(violations.violations()[0]?.page ?? '').pathname).toBe('/d1/');
    violations.clear();
  });
});
