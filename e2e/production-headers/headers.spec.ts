// Spec 034, AC-19: every response of the production-headers server carries the headers of
// apps/site/headers.json, with exactly their values.
import { expect, test } from '@playwright/test';
import { readSiteHeaders } from './csp-violations.ts';

const PAGES = [
  { path: '/', status: 200 },
  { path: '/d1/1-1-secure-access/', status: 200 },
  { path: '/d1/1-3-data-security/', status: 200 },
  { path: '/practice/', status: 200 },
  { path: '/does-not-exist/', status: 404 },
];

function expectSiteHeaders(received: Record<string, string>): void {
  const expected = readSiteHeaders();
  expect(Object.keys(expected).length).toBeGreaterThan(0);
  for (const [name, value] of Object.entries(expected)) {
    expect(received[name.toLowerCase()], `header ${name}`).toBe(value);
  }
}

test.describe('response headers', () => {
  for (const { path, status } of PAGES) {
    test(`AC-19: ${path} (status ${String(status)}) carries every header of headers.json`, async ({
      request,
    }) => {
      const response = await request.get(path);

      expect(response.status()).toBe(status);
      expectSiteHeaders(response.headers());
    });
  }

  test('AC-19: the first <script src> of / carries every header of headers.json', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    const src = /<script\b[^>]*?\ssrc=["']([^"']+)["']/i.exec(html)?.[1];
    expect(src, 'a <script src> on the home page').toBeDefined();

    const response = await request.get(src ?? '');

    expect(response.status()).toBe(200);
    expectSiteHeaders(response.headers());
  });

  test('AC-19: the first <link rel="stylesheet"> of / carries every header of headers.json', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    const tag = (html.match(/<link\b[^>]*>/gi) ?? []).find((candidate) =>
      /\srel=["']?stylesheet["'\s>]/i.test(candidate),
    );
    const href = /\shref=["']([^"']+)["']/i.exec(tag ?? '')?.[1];
    expect(href, 'a <link rel="stylesheet"> on the home page').toBeDefined();

    const response = await request.get(href ?? '');

    expect(response.status()).toBe(200);
    expectSiteHeaders(response.headers());
  });
});
