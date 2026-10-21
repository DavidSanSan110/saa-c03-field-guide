import { describe, expect, test } from 'vitest';
import { ASSET_CACHE_CONTROL, HTML_CACHE_CONTROL } from './cache.ts';
import { runSmoke } from './smoke.ts';
import type { CheckResult } from './smoke.ts';

// Spec 036, review round 1: AC-38, a request rejected twice is reported with the URL and, when the
// error has a cause with a code, that code.

const HOST = 'saa-c03.example.org';
const BANK_URL = `https://${HOST}/practice/bank.json`;
const RANDOM = '0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;

const HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
};

type FetchInput = Parameters<typeof fetch>[0];

function hrefOf(input: FetchInput): string {
  if (typeof input === 'string') return new URL(input).href;
  if (input instanceof URL) return input.href;
  return new URL(input.url).href;
}

function reply(
  status: number,
  contentType: string | undefined,
  cache: string | undefined,
  body: string,
  extra: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = { ...HEADERS, ...extra };
  if (contentType !== undefined) headers['Content-Type'] = contentType;
  if (cache !== undefined) headers['Cache-Control'] = cache;
  return new Response(body, { status, headers });
}

/** A fake fetch that serves a correct site, except that the bank URL is rejected with `rejection`. */
function fetchWithBankRejecting(rejection: Error): typeof fetch {
  const html = (): Response =>
    reply(200, 'text/html; charset=utf-8', HTML_CACHE_CONTROL, '<html>x</html>');
  const redirect = (location: string): Response =>
    reply(301, undefined, undefined, '', { Location: location });
  return (input: FetchInput) => {
    const url = new URL(hrefOf(input));
    if (url.href === BANK_URL) return Promise.reject(rejection);
    if (url.protocol === 'http:') {
      return Promise.resolve(redirect(`https://${url.host}${url.pathname}`));
    }
    if (url.pathname === '/d1') return Promise.resolve(redirect('/d1/'));
    if (url.pathname.startsWith('/_astro/')) {
      return Promise.resolve(reply(200, 'text/javascript', ASSET_CACHE_CONTROL, 'a'));
    }
    if (/^\/smoke-[0-9a-f]{16}\/$/.test(url.pathname) || url.pathname === '/404.html') {
      return Promise.resolve(reply(404, 'text/html; charset=utf-8', undefined, '<h1>404</h1>'));
    }
    return Promise.resolve(html());
  };
}

async function bankResult(rejection: Error): Promise<CheckResult> {
  const results = await runSmoke(
    { url: new URL(`https://${HOST}/`), headers: HEADERS },
    {
      fetch: fetchWithBankRejecting(rejection),
      tlsProbe: () =>
        Promise.resolve({
          ok: true,
          protocol: 'TLSv1.3',
          validTo: new Date(Date.now() + 60 * DAY),
        }),
      random: () => RANDOM,
    },
  );
  const found = results.find((result) => result.id === 'bank');
  if (found === undefined) throw new Error('no result for check bank');
  return found;
}

describe('a request rejected twice', () => {
  test('AC-38: the check fails and its detail has the full URL and the error code of the cause', async () => {
    const rejection = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const result = await bankResult(rejection);
    expect(result.status).toBe('fail');
    expect(result.detail ?? '').toContain(BANK_URL);
    expect(result.detail ?? '').toContain('ECONNREFUSED');
  });

  test('AC-38: with no cause, the check fails and its detail still has the full URL', async () => {
    const result = await bankResult(new TypeError('fetch failed'));
    expect(result.status).toBe('fail');
    expect(result.detail ?? '').toContain(BANK_URL);
  });
});
