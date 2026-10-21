import { afterEach, describe, expect, test, vi } from 'vitest';
import { ASSET_CACHE_CONTROL, HTML_CACHE_CONTROL } from './cache.ts';
import { formatResults, runSmoke } from './smoke.ts';
import type { CheckResult } from './smoke.ts';
import { isServerRefusal } from './tls.ts';
import type { tlsProbe } from './tls.ts';

// Spec 036, tools/smoke: the checks (AC-20 ... AC-34). A fake fetch answers from a route table
// and a fake tlsProbe answers per TLS version, so no test touches the network.
//
// Conventions of the fake site (the test's, not the implementation's):
//  * the not-found check asks for /smoke-<deps.random()>/ ; deps.random returns 16 hex characters;
//  * a request for a URL with no route rejects (like a network error), so a check that asks for
//    something unexpected fails visibly.

type Deps = NonNullable<Parameters<typeof runSmoke>[1]>;
type FetchInput = Parameters<typeof fetch>[0];
type TlsVersion = Parameters<typeof tlsProbe>[1];
type TlsResult = Awaited<ReturnType<typeof tlsProbe>>;

const HOST = 'saa-c03.example.org';
const CF = 'd111111abcdef8.cloudfront.net';
const RANDOM = '0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;

const IDS = [
  'pages',
  'folder-redirect',
  'bank',
  'not-found',
  'no-fixtures',
  'https-redirect',
  'host-redirect',
  'headers',
  'assets',
  'cache-control',
  'certificate',
  'tls-legacy',
];

/** Stands in for apps/site/headers.json: the value of the CSP has `; ` to test inner whitespace. */
const HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const NOT_FOUND_BODY = '<!doctype html><title>Not found</title><h1>404</h1>';

const HOME =
  '<!doctype html><html><head><title>Home</title>' +
  '<script>console.log("inline")</script>' +
  '<script type="module" src="/_astro/a.js"></script>' +
  '<link rel="stylesheet" href="/_astro/b.css">' +
  '</head><body>home</body></html>';

// ---- The fake site ---------------------------------------------------------------------------------

interface Route {
  status: number;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

interface Call {
  url: string;
  method: string;
  init: RequestInit | undefined;
}

function route(
  status: number,
  contentType: string | undefined,
  cache: string | undefined,
  body?: string | Uint8Array,
  extra: Record<string, string> = {},
): Route {
  const headers: Record<string, string> = { ...HEADERS };
  if (contentType !== undefined) headers['Content-Type'] = contentType;
  if (cache !== undefined) headers['Cache-Control'] = cache;
  const result: Route = { status, headers: { ...headers, ...extra } };
  if (body !== undefined) result.body = body;
  return result;
}

function withoutHeader(source: Route, name: string): Route {
  const headers = Object.fromEntries(
    Object.entries(source.headers).filter(([key]) => key.toLowerCase() !== name.toLowerCase()),
  );
  return { ...source, headers };
}

function withHeader(source: Route, name: string, value: string): Route {
  return {
    ...withoutHeader(source, name),
    headers: { ...withoutHeader(source, name).headers, [name]: value },
  };
}

function toResponse(source: Route): Response {
  const body =
    source.body === undefined
      ? null
      : typeof source.body === 'string'
        ? new TextEncoder().encode(source.body)
        : source.body;
  return new Response(body, { status: source.status, headers: source.headers });
}

function hrefOf(input: FetchInput): string {
  if (typeof input === 'string') return new URL(input).href;
  if (input instanceof URL) return input.href;
  return new URL(input.url).href;
}

class FakeSite {
  readonly routes = new Map<string, Route>();
  readonly calls: Call[] = [];
  notFound: Route = route(404, 'text/html; charset=utf-8', undefined, NOT_FOUND_BODY);

  constructor(readonly host: string) {}

  url(path: string, host: string = this.host): string {
    return new URL(path, `https://${host}`).href;
  }

  set(path: string, source: Route): void {
    this.routes.set(this.url(path), source);
  }

  setUrl(href: string, source: Route): void {
    this.routes.set(new URL(href).href, source);
  }

  get(path: string): Route {
    const found = this.routes.get(this.url(path));
    if (found === undefined) throw new Error(`test bug: no route for ${path}`);
    return found;
  }

  /** href of every request made, in order. */
  hrefs(): string[] {
    return this.calls.map((call) => call.url);
  }

  readonly fetch: typeof fetch = (input: FetchInput, init?: RequestInit) => {
    const href = hrefOf(input);
    const method =
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    this.calls.push({ url: href, method, init });
    const url = new URL(href);
    let found = this.routes.get(href);
    if (
      found === undefined &&
      url.protocol === 'https:' &&
      url.host === this.host &&
      /^\/smoke-[0-9a-f]{16}\/$/.test(url.pathname)
    ) {
      found = this.notFound;
    }
    if (found === undefined) return Promise.reject(new Error(`no route for ${method} ${href}`));
    return Promise.resolve(toResponse(found));
  };
}

/** A correct site on `host`; `cfHost` is the cloudfront.net name whose /d1/ redirects to `host`. */
function standardSite(host: string = HOST, cfHost: string | null = CF): FakeSite {
  const site = new FakeSite(host);
  const html = (body: string): Route =>
    route(200, 'text/html; charset=utf-8', HTML_CACHE_CONTROL, body);
  site.set('/', html(HOME));
  site.set('/d1/', html('<html>d1</html>'));
  site.set('/practice/', html('<html>practice</html>'));
  site.set('/d1', route(301, undefined, undefined, undefined, { Location: '/d1/' }));
  site.set(
    '/practice/bank.json',
    route(
      200,
      'application/json',
      HTML_CACHE_CONTROL,
      JSON.stringify({ questions: [{ id: 'q1' }] }),
    ),
  );
  site.set('/404.html', html(NOT_FOUND_BODY));
  site.set('/fixtures/diagram/', site.notFound);
  site.set('/_astro/a.js', route(200, 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL, 'a'));
  site.set('/_astro/b.css', route(200, 'text/css; charset=utf-8', ASSET_CACHE_CONTROL, 'b'));
  site.setUrl(`http://${host}/d1/`, {
    status: 301,
    headers: { Location: `https://${host}/d1/` },
  });
  if (cfHost !== null) {
    site.setUrl(`https://${cfHost}/d1/?smoke=1`, {
      status: 301,
      headers: { Location: `https://${host}/d1/?smoke=1` },
    });
  }
  return site;
}

// ---- The fake TLS probe ----------------------------------------------------------------------------

const REFUSED: TlsResult = {
  ok: false,
  code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  serverRefused: true,
};

interface ProbeCall {
  host: string;
  version: TlsVersion;
  timeoutMs: number;
}

class FakeProbe {
  readonly calls: ProbeCall[] = [];
  readonly answers = new Map<TlsVersion, TlsResult>();

  readonly probe: typeof tlsProbe = (host, version, timeoutMs) => {
    this.calls.push({ host, version, timeoutMs });
    const answer = this.answers.get(version);
    if (answer !== undefined) return Promise.resolve(answer);
    if (version === 'TLSv1' || version === 'TLSv1.1') return Promise.resolve(REFUSED);
    return Promise.resolve({
      ok: true,
      protocol: version,
      validTo: new Date(Date.now() + 60 * DAY),
    });
  };

  versions(): TlsVersion[] {
    return this.calls.map((call) => call.version);
  }
}

// ---- Running ---------------------------------------------------------------------------------------

interface RunConfig {
  /** The domain given to --cloudfront-domain; null for none. Default: CF on the custom domain. */
  cloudfront?: string | null;
  headers?: Record<string, string>;
  probe?: FakeProbe;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** false to let runSmoke use its own random source. */
  fixedRandom?: boolean;
  random?: () => string;
}

async function run(site: FakeSite, config: RunConfig = {}): Promise<CheckResult[]> {
  const probe = config.probe ?? new FakeProbe();
  const cloudfront =
    config.cloudfront === undefined ? (site.host === HOST ? CF : null) : config.cloudfront;
  const deps: Deps = { fetch: config.fetch ?? site.fetch, tlsProbe: probe.probe };
  if (config.timeoutMs !== undefined) deps.timeoutMs = config.timeoutMs;
  if (config.random !== undefined) deps.random = config.random;
  else if (config.fixedRandom !== false) deps.random = () => RANDOM;
  return runSmoke(
    {
      url: new URL(`https://${site.host}/`),
      headers: config.headers ?? HEADERS,
      ...(cloudfront === null ? {} : { cloudfrontDomain: cloudfront }),
    },
    deps,
  );
}

function find(results: CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  if (found === undefined) throw new Error(`no result for check ${id}`);
  return found;
}

function statusOf(results: CheckResult[], id: string): CheckResult['status'] {
  return find(results, id).status;
}

function expectFail(results: CheckResult[], id: string): string {
  const result = find(results, id);
  expect(result.status, `${id}: ${result.detail ?? ''}`).toBe('fail');
  expect(result.detail ?? '').not.toBe('');
  return result.detail ?? '';
}

function expectOk(results: CheckResult[], id: string): void {
  const result = find(results, id);
  expect(result.status, `${id}: ${result.detail ?? ''}`).toBe('ok');
}

function html(body: string): Route {
  return route(200, 'text/html; charset=utf-8', HTML_CACHE_CONTROL, body);
}

afterEach(() => {
  vi.useRealTimers();
});

// =================================================================================================
// AC-20: a correct site
// =================================================================================================

describe('a correct site', () => {
  test('AC-20: every check is ok, in the order of the table', async () => {
    const results = await run(standardSite());
    expect(results.map((result) => result.id)).toEqual(IDS);
    expect(results.map((result) => result.status)).toEqual(IDS.map(() => 'ok'));
  });

  test('AC-20: formatResults prints one ok line per check and the summary, exit code 0', async () => {
    const results = await run(standardSite());
    const { text, exitCode } = formatResults(results);
    expect(exitCode).toBe(0);
    expect(text.trimEnd().split(/\r?\n/)).toEqual([
      ...IDS.map((id) => `ok   ${id}`),
      'smoke: 12 ok, 0 failed, 0 skipped',
    ]);
  });
});

// =================================================================================================
// AC-21 ... AC-25: pages, redirects, bank, not-found, fixtures
// =================================================================================================

describe('pages', () => {
  test.each(['/', '/d1/', '/practice/'])(
    'AC-21: %s answering 404 fails, naming the path',
    async (path) => {
      const site = standardSite();
      site.set(path, route(404, 'text/html', HTML_CACHE_CONTROL, 'x'));
      const detail = expectFail(await run(site), 'pages');
      expect(detail).toContain(path);
    },
  );

  test.each(['/', '/d1/', '/practice/'])('AC-21: %s answering 302 fails', async (path) => {
    const site = standardSite();
    site.set(path, route(302, 'text/html', undefined, 'x', { Location: '/elsewhere/' }));
    expectFail(await run(site), 'pages');
  });

  test.each(['/', '/d1/', '/practice/'])(
    'AC-21: %s served as application/json fails',
    async (path) => {
      const site = standardSite();
      site.set(path, route(200, 'application/json', HTML_CACHE_CONTROL, '{}'));
      const detail = expectFail(await run(site), 'pages');
      expect(detail).toContain(path);
    },
  );

  test.each(['/', '/d1/', '/practice/'])('AC-21: %s with no Content-Type fails', async (path) => {
    const site = standardSite();
    site.set(path, route(200, undefined, HTML_CACHE_CONTROL, 'x'));
    expectFail(await run(site), 'pages');
  });

  test('AC-21: text/htmlx is not text/html', async () => {
    const site = standardSite();
    site.set('/d1/', route(200, 'text/htmlx', HTML_CACHE_CONTROL, 'x'));
    expectFail(await run(site), 'pages');
  });

  test('AC-21: a bare text/html (no parameters) passes', async () => {
    const site = standardSite();
    site.set('/', route(200, 'text/html', HTML_CACHE_CONTROL, HOME));
    site.set('/d1/', route(200, 'text/html', HTML_CACHE_CONTROL, 'x'));
    site.set('/practice/', route(200, 'text/html', HTML_CACHE_CONTROL, 'x'));
    expectOk(await run(site), 'pages');
  });

  test('AC-21: a failing page does not stop the other checks', async () => {
    const site = standardSite();
    site.set('/practice/', route(500, 'text/html', undefined, 'x'));
    const results = await run(site);
    expect(results.map((result) => result.id)).toEqual(IDS);
    expectOk(results, 'folder-redirect');
    expectOk(results, 'bank');
  });
});

describe('folder-redirect', () => {
  const ok301 = (location: string): Route =>
    route(301, undefined, undefined, undefined, { Location: location });

  test('AC-22: a 200 on /d1 fails', async () => {
    const site = standardSite();
    site.set('/d1', html('x'));
    expectFail(await run(site), 'folder-redirect');
  });

  test('AC-22: a 302 to /d1/ fails', async () => {
    const site = standardSite();
    site.set('/d1', { ...ok301('/d1/'), status: 302 });
    expectFail(await run(site), 'folder-redirect');
  });

  test('AC-22: a 301 to https://<host>/d1/ fails (the Location is exactly /d1/)', async () => {
    const site = standardSite();
    site.set('/d1', ok301(`https://${HOST}/d1/`));
    expectFail(await run(site), 'folder-redirect');
  });

  test('AC-22: a 301 to /d1 fails', async () => {
    const site = standardSite();
    site.set('/d1', ok301('/d1'));
    expectFail(await run(site), 'folder-redirect');
  });

  test('AC-22: a 301 with no Location fails', async () => {
    const site = standardSite();
    site.set('/d1', route(301, undefined, undefined));
    expectFail(await run(site), 'folder-redirect');
  });
});

describe('bank', () => {
  const bank = (contentType: string, body: string): Route =>
    route(200, contentType, HTML_CACHE_CONTROL, body);

  test.each<[string, Route]>([
    ['a body that is not JSON', bank('application/json', 'not json')],
    ['text/html even with a valid body', bank('text/html', '{"questions":[{"id":"q"}]}')],
    ['no Content-Type', route(200, undefined, HTML_CACHE_CONTROL, '{"questions":[{"id":"q"}]}')],
    ['no questions', bank('application/json', '{"questions":[]}')],
    ['questions that is not an array', bank('application/json', '{"questions":"x"}')],
    ['no questions key', bank('application/json', '{"items":[1]}')],
    ['a JSON array', bank('application/json', '[]')],
    ['a JSON array that holds the object', bank('application/json', '[{"questions":[1]}]')],
    ['a 404', route(404, 'application/json', undefined, '{"questions":[1]}')],
  ])('AC-23: %s fails', async (_name, response) => {
    const site = standardSite();
    site.set('/practice/bank.json', response);
    expectFail(await run(site), 'bank');
  });

  test('AC-23: application/json with a charset parameter passes', async () => {
    const site = standardSite();
    site.set('/practice/bank.json', bank('application/json; charset=utf-8', '{"questions":[1]}'));
    expectOk(await run(site), 'bank');
  });
});

describe('not-found', () => {
  test('AC-24: a 200 for the random path fails', async () => {
    const site = standardSite();
    site.notFound = html(NOT_FOUND_BODY);
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: a 403 for the random path fails', async () => {
    const site = standardSite();
    site.notFound = route(403, 'text/html; charset=utf-8', undefined, NOT_FOUND_BODY);
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: a 404 that is not text/html fails', async () => {
    const site = standardSite();
    site.notFound = route(404, 'text/plain', undefined, NOT_FOUND_BODY);
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: a body that differs from /404.html by one byte fails', async () => {
    const site = standardSite();
    site.notFound = route(404, 'text/html; charset=utf-8', undefined, `${NOT_FOUND_BODY}\n`);
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: a body with different bytes of the same length fails', async () => {
    const site = standardSite();
    site.notFound = route(
      404,
      'text/html; charset=utf-8',
      undefined,
      NOT_FOUND_BODY.replace('404', '405'),
    );
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: an empty 404 body fails', async () => {
    const site = standardSite();
    site.notFound = route(404, 'text/html; charset=utf-8', undefined, '');
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: /404.html answering 404 fails', async () => {
    const site = standardSite();
    site.set('/404.html', route(404, 'text/html; charset=utf-8', undefined, NOT_FOUND_BODY));
    expectFail(await run(site), 'not-found');
  });

  test('AC-24: the random segment comes from deps.random', async () => {
    const site = standardSite();
    const random = vi.fn(() => 'deadbeefdeadbeef');
    site.routes.set(site.url('/smoke-deadbeefdeadbeef/'), site.notFound);
    const results = await run(site, { random });
    expectOk(results, 'not-found');
    expect(site.hrefs()).toContain(site.url('/smoke-deadbeefdeadbeef/'));
    expect(random).toHaveBeenCalled();
  });

  test('AC-24: it also requests /404.html', async () => {
    const site = standardSite();
    await run(site);
    expect(site.hrefs()).toContain(site.url('/404.html'));
  });

  test('AC-24: by default two runs request different smoke paths', async () => {
    const first = standardSite();
    const second = standardSite();
    await run(first, { fixedRandom: false });
    await run(second, { fixedRandom: false });
    const smokePaths = (site: FakeSite): string[] =>
      site
        .hrefs()
        .map((href) => new URL(href).pathname)
        .filter((path) => path.startsWith('/smoke-'));
    const a = smokePaths(first);
    const b = smokePaths(second);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    for (const path of [...a, ...b]) expect(path).toMatch(/^\/smoke-[0-9a-f]{16}\/$/);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe('no-fixtures', () => {
  test('AC-25: a 200 for /fixtures/diagram/ fails', async () => {
    const site = standardSite();
    site.set('/fixtures/diagram/', html('fixture'));
    const detail = expectFail(await run(site), 'no-fixtures');
    expect(detail).toContain('/fixtures/diagram/');
  });

  test('AC-25: a 403 for /fixtures/diagram/ fails (the expected status is 404)', async () => {
    const site = standardSite();
    site.set('/fixtures/diagram/', route(403, 'text/html', undefined, 'x'));
    expectFail(await run(site), 'no-fixtures');
  });
});

// =================================================================================================
// AC-26, AC-27: http -> https and cloudfront.net -> custom domain
// =================================================================================================

describe('https-redirect', () => {
  const redirect = (status: number, location: string): Route => ({
    status,
    headers: { Location: location },
  });

  test('AC-26: it requests http://<host>/d1/', async () => {
    const site = standardSite();
    await run(site);
    expect(site.hrefs()).toContain(`http://${HOST}/d1/`);
  });

  test('AC-26: a 200 on the http URL fails', async () => {
    const site = standardSite();
    site.setUrl(`http://${HOST}/d1/`, { status: 200, headers: { 'Content-Type': 'text/html' } });
    expectFail(await run(site), 'https-redirect');
  });

  test('AC-26: a 301 to another host fails', async () => {
    const site = standardSite();
    site.setUrl(`http://${HOST}/d1/`, redirect(301, 'https://evil.example.net/d1/'));
    expectFail(await run(site), 'https-redirect');
  });

  test('AC-26: a 301 to the http URL fails', async () => {
    const site = standardSite();
    site.setUrl(`http://${HOST}/d1/`, redirect(301, `http://${HOST}/d1/`));
    expectFail(await run(site), 'https-redirect');
  });

  test('AC-26: a 301 to another path fails', async () => {
    const site = standardSite();
    site.setUrl(`http://${HOST}/d1/`, redirect(301, `https://${HOST}/`));
    expectFail(await run(site), 'https-redirect');
  });

  test('AC-26: a 302 to the right URL fails', async () => {
    const site = standardSite();
    site.setUrl(`http://${HOST}/d1/`, redirect(302, `https://${HOST}/d1/`));
    expectFail(await run(site), 'https-redirect');
  });

  test('AC-26: in cloudfront-only mode the redirect is checked on the cloudfront.net name', async () => {
    const site = standardSite(CF, null);
    const results = await run(site);
    expectOk(results, 'https-redirect');
    expect(site.hrefs()).toContain(`http://${CF}/d1/`);
  });
});

describe('host-redirect', () => {
  const target = `https://${CF}/d1/?smoke=1`;
  const location = `https://${HOST}/d1/?smoke=1`;

  test('AC-27: it requests https://<cf>/d1/?smoke=1 and passes on a 301 to the exact Location', async () => {
    const site = standardSite();
    const results = await run(site);
    expectOk(results, 'host-redirect');
    expect(site.hrefs()).toContain(target);
  });

  test('AC-27: a 200 fails', async () => {
    const site = standardSite();
    site.setUrl(target, html('x'));
    expectFail(await run(site), 'host-redirect');
  });

  test('AC-27: a 301 that drops the query fails', async () => {
    const site = standardSite();
    site.setUrl(target, { status: 301, headers: { Location: `https://${HOST}/d1/` } });
    expectFail(await run(site), 'host-redirect');
  });

  test('AC-27: a 302 to the exact Location fails', async () => {
    const site = standardSite();
    site.setUrl(target, { status: 302, headers: { Location: location } });
    expectFail(await run(site), 'host-redirect');
  });

  test('AC-27: a 301 to another host fails', async () => {
    const site = standardSite();
    site.setUrl(target, {
      status: 301,
      headers: { Location: 'https://evil.example.net/d1/?smoke=1' },
    });
    expectFail(await run(site), 'host-redirect');
  });

  test('AC-27: without --cloudfront-domain it is skipped and no request goes to cloudfront.net', async () => {
    const site = standardSite(HOST, null);
    const results = await run(site, { cloudfront: null });
    expect(statusOf(results, 'host-redirect')).toBe('skip');
    expect(find(results, 'host-redirect').detail ?? '').not.toBe('');
    for (const href of site.hrefs())
      expect(new URL(href).host.endsWith('.cloudfront.net')).toBe(false);
  });

  test('AC-27: in cloudfront-only mode it is skipped, with and without --cloudfront-domain', async () => {
    for (const cloudfront of [null, CF]) {
      const site = standardSite(CF, null);
      const results = await run(site, { cloudfront });
      expect(statusOf(results, 'host-redirect')).toBe('skip');
      expect(site.hrefs().some((href) => href.includes('smoke=1'))).toBe(false);
    }
  });

  test('AC-27: cloudfront-only mode gives 10 ok and 2 skipped, in the order of the table', async () => {
    const results = await run(standardSite(CF, null));
    expect(results.map((result) => result.id)).toEqual(IDS);
    expect(results.filter((result) => result.status === 'skip').map((result) => result.id)).toEqual(
      ['host-redirect', 'tls-legacy'],
    );
    expect(formatResults(results).exitCode).toBe(0);
    expect(formatResults(results).text.trimEnd().split(/\r?\n/).pop()).toBe(
      'smoke: 10 ok, 0 failed, 2 skipped',
    );
  });
});

// =================================================================================================
// AC-28: security headers
// =================================================================================================

describe('headers', () => {
  const SIX: [string, (site: FakeSite, change: (source: Route) => Route) => void, RegExp][] = [
    ['/', (site, change) => site.set('/', change(site.get('/'))), /\//],
    ['/d1/', (site, change) => site.set('/d1/', change(site.get('/d1/'))), /\/d1\//],
    [
      `/smoke-${RANDOM}/`,
      (site, change) => {
        site.notFound = change(site.notFound);
      },
      new RegExp(`/smoke-${RANDOM}/`),
    ],
    [
      '/d1 (the folder redirect)',
      (site, change) => site.set('/d1', change(site.get('/d1'))),
      /\/d1(?!\/)/,
    ],
    [
      '/practice/bank.json',
      (site, change) => site.set('/practice/bank.json', change(site.get('/practice/bank.json'))),
      /\/practice\/bank\.json/,
    ],
    [
      '/_astro/a.js (the first asset)',
      (site, change) => site.set('/_astro/a.js', change(site.get('/_astro/a.js'))),
      /\/_astro\/a\.js/,
    ],
  ];

  test.each(SIX)(
    'AC-28: a missing header on %s fails, naming the path and the header',
    async (_name, apply, path) => {
      const site = standardSite();
      apply(site, (source) => withoutHeader(source, 'X-Frame-Options'));
      const detail = expectFail(await run(site), 'headers');
      expect(detail).toMatch(path);
      expect(detail.toLowerCase()).toContain('x-frame-options');
    },
  );

  test.each(SIX)('AC-28: a value that differs only in case on %s fails', async (_name, apply) => {
    const site = standardSite();
    apply(site, (source) => withHeader(source, 'X-Frame-Options', 'deny'));
    expectFail(await run(site), 'headers');
  });

  test.each(SIX)('AC-28: a value with two spaces after a ; on %s fails', async (_name, apply) => {
    const site = standardSite();
    apply(site, (source) =>
      withHeader(
        source,
        'Content-Security-Policy',
        HEADERS['Content-Security-Policy']?.replace('; ', ';  ') ?? '',
      ),
    );
    expectFail(await run(site), 'headers');
  });

  test('AC-28: every header of the file is checked, not only the first', async () => {
    for (const name of Object.keys(HEADERS)) {
      const site = standardSite();
      site.set('/practice/bank.json', withoutHeader(site.get('/practice/bank.json'), name));
      const detail = expectFail(await run(site), 'headers');
      expect(detail.toLowerCase(), name).toContain(name.toLowerCase());
    }
  });

  test('AC-28: a header name that differs only in case passes', async () => {
    const lower = Object.fromEntries(
      Object.entries(HEADERS).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expectOk(await run(standardSite(), { headers: lower }), 'headers');
  });

  test('AC-28: the headers come from the headers argument, not from a fixed list', async () => {
    const site = standardSite();
    const results = await run(site, { headers: { ...HEADERS, 'X-Smoke-Extra': '1' } });
    const detail = expectFail(results, 'headers');
    expect(detail.toLowerCase()).toContain('x-smoke-extra');
  });

  test('AC-28: a header missing only on the second asset does not fail (only the first asset is checked)', async () => {
    const site = standardSite();
    site.set('/_astro/b.css', withoutHeader(site.get('/_astro/b.css'), 'X-Frame-Options'));
    expectOk(await run(site), 'headers');
  });

  test('AC-28: with no asset found the other five responses are checked: all good, headers is ok', async () => {
    const site = standardSite();
    site.set('/', html('<html><body>no assets</body></html>'));
    const results = await run(site);
    expectFail(results, 'assets');
    expectOk(results, 'headers');
  });

  test('AC-28: with no asset found a header missing on bank.json still fails headers', async () => {
    const site = standardSite();
    site.set('/', html('<html><body>no assets</body></html>'));
    site.set(
      '/practice/bank.json',
      withoutHeader(site.get('/practice/bank.json'), 'Referrer-Policy'),
    );
    const detail = expectFail(await run(site), 'headers');
    expect(detail).toContain('/practice/bank.json');
  });
});

// =================================================================================================
// AC-29: assets
// =================================================================================================

describe('assets', () => {
  const asset = (contentType: string): Route => route(200, contentType, ASSET_CACHE_CONTROL, 'x');

  test('AC-29: a script and a stylesheet with other attributes and single quotes are found', async () => {
    const site = standardSite();
    site.set(
      '/',
      html(
        "<script src='/_astro/single.js' defer></script><link media='all' href='/_astro/single.css' rel='stylesheet'>",
      ),
    );
    site.set('/_astro/single.js', asset('text/javascript'));
    site.set('/_astro/single.css', asset('text/css'));
    expectOk(await run(site), 'assets');
    expect(site.hrefs()).toContain(site.url('/_astro/single.js'));
    expect(site.hrefs()).toContain(site.url('/_astro/single.css'));
  });

  test('AC-29: absolute URLs on the site origin are found', async () => {
    const site = standardSite();
    site.set(
      '/',
      html(
        `<script src="https://${HOST}/_astro/abs.js"></script><link rel="stylesheet" crossorigin href="https://${HOST}/_astro/abs.css">`,
      ),
    );
    site.set('/_astro/abs.js', asset('text/javascript'));
    site.set('/_astro/abs.css', asset('text/css'));
    expectOk(await run(site), 'assets');
    expect(site.hrefs()).toContain(site.url('/_astro/abs.js'));
    expect(site.hrefs()).toContain(site.url('/_astro/abs.css'));
  });

  test('AC-29: a script served as application/javascript passes', async () => {
    const site = standardSite();
    site.set('/_astro/a.js', asset('application/javascript'));
    expectOk(await run(site), 'assets');
  });

  test('AC-29: other-origin and data: URLs, icons and inline scripts are ignored (not requested)', async () => {
    const site = standardSite();
    site.set(
      '/',
      html(
        '<link rel="icon" href="/favicon.svg">' +
          '<script src="https://cdn.example.net/lib.js"></script>' +
          '<link rel="stylesheet" href="//cdn.example.net/x.css">' +
          `<script src="https://${HOST}.evil.example.net/y.js"></script>` +
          '<script src="data:text/javascript,alert(1)"></script>' +
          '<link rel="stylesheet" href="data:text/css,a{}">' +
          '<script>inline()</script>' +
          '<script type="module" src="/_astro/a.js"></script>' +
          '<link rel="stylesheet" href="/_astro/b.css">',
      ),
    );
    const results = await run(site);
    expectOk(results, 'assets');
    for (const href of site.hrefs()) {
      expect(href).not.toContain('cdn.example.net');
      expect(href).not.toContain('evil.example.net');
      expect(href).not.toContain('data:');
      expect(href).not.toContain('favicon');
    }
  });

  test('AC-29: a 404 asset fails, naming it', async () => {
    const site = standardSite();
    site.set('/_astro/a.js', route(404, 'text/html', undefined, 'x'));
    const detail = expectFail(await run(site), 'assets');
    expect(detail).toContain('/_astro/a.js');
  });

  test.each(['text/plain', 'application/octet-stream', 'text/css'])(
    'AC-29: a script served as %s fails',
    async (contentType) => {
      const site = standardSite();
      site.set('/_astro/a.js', asset(contentType));
      const detail = expectFail(await run(site), 'assets');
      expect(detail).toContain('/_astro/a.js');
    },
  );

  test.each(['text/plain', 'text/javascript', 'application/octet-stream'])(
    'AC-29: a stylesheet served as %s fails',
    async (contentType) => {
      const site = standardSite();
      site.set('/_astro/b.css', asset(contentType));
      const detail = expectFail(await run(site), 'assets');
      expect(detail).toContain('/_astro/b.css');
    },
  );

  test('AC-29: a page with no script and no stylesheet fails', async () => {
    const site = standardSite();
    site.set('/', html('<html><body>plain</body></html>'));
    expectFail(await run(site), 'assets');
  });

  test('AC-29: a page with only inline, other-origin and data: scripts fails', async () => {
    const site = standardSite();
    site.set(
      '/',
      html(
        '<script>x()</script><script src="https://cdn.example.net/lib.js"></script><link rel="stylesheet" href="data:text/css,a{}">',
      ),
    );
    expectFail(await run(site), 'assets');
  });
});

// =================================================================================================
// AC-30: cache headers
// =================================================================================================

describe('cache-control', () => {
  test('AC-30: / with max-age=3600 fails', async () => {
    const site = standardSite();
    site.set('/', route(200, 'text/html; charset=utf-8', 'max-age=3600', HOME));
    const detail = expectFail(await run(site), 'cache-control');
    expect(detail).toContain('/');
  });

  test('AC-30: / without the header fails', async () => {
    const site = standardSite();
    site.set('/', route(200, 'text/html; charset=utf-8', undefined, HOME));
    expectFail(await run(site), 'cache-control');
  });

  test('AC-30: the value must be exact (no spaces after the commas fails)', async () => {
    const site = standardSite();
    site.set(
      '/',
      route(200, 'text/html; charset=utf-8', HTML_CACHE_CONTROL.replace(/, /g, ','), HOME),
    );
    expectFail(await run(site), 'cache-control');
  });

  test('AC-30: /practice/bank.json without the header fails', async () => {
    const site = standardSite();
    site.set('/practice/bank.json', route(200, 'application/json', undefined, '{"questions":[1]}'));
    const detail = expectFail(await run(site), 'cache-control');
    expect(detail).toContain('/practice/bank.json');
  });

  test('AC-30: an /_astro/ asset without immutable fails', async () => {
    const site = standardSite();
    site.set('/_astro/b.css', route(200, 'text/css', 'public, max-age=31536000', 'b'));
    const detail = expectFail(await run(site), 'cache-control');
    expect(detail).toContain('/_astro/b.css');
  });

  test('AC-30: every /_astro/ asset is checked, the first one being fine does not hide a bad second', async () => {
    const site = standardSite();
    site.set('/_astro/b.css', route(200, 'text/css', HTML_CACHE_CONTROL, 'b'));
    expectFail(await run(site), 'cache-control');
  });

  test('AC-30: a page with no /_astro/ asset fails', async () => {
    const site = standardSite();
    site.set('/', html('<script src="/other/x.js"></script>'));
    site.set('/other/x.js', route(200, 'text/javascript', ASSET_CACHE_CONTROL, 'x'));
    const results = await run(site);
    expectOk(results, 'assets');
    expectFail(results, 'cache-control');
  });

  test('AC-30: a page with no asset at all fails', async () => {
    const site = standardSite();
    site.set('/', html('<html></html>'));
    expectFail(await run(site), 'cache-control');
  });

  test('AC-30: other pages are not checked (the /d1/ page may have other cache headers)', async () => {
    const site = standardSite();
    site.set('/d1/', route(200, 'text/html', 'no-cache', 'x'));
    expectOk(await run(site), 'cache-control');
  });
});

// =================================================================================================
// AC-31, AC-32: TLS
// =================================================================================================

describe('certificate', () => {
  test('AC-31: it probes TLSv1.2 on the site host', async () => {
    const probe = new FakeProbe();
    await run(standardSite(), { probe });
    const call = probe.calls.find((candidate) => candidate.version === 'TLSv1.2');
    expect(call).toBeDefined();
    expect(call?.host).toBe(HOST);
    expect(call?.timeoutMs).toBeGreaterThan(0);
  });

  test('AC-31: a failing probe fails the check', async () => {
    const probe = new FakeProbe();
    probe.answers.set('TLSv1.2', { ok: false, code: 'CERT_HAS_EXPIRED', serverRefused: false });
    expectFail(await run(standardSite(), { probe }), 'certificate');
  });

  test('AC-31: a probe failing with a server refusal also fails the check', async () => {
    const probe = new FakeProbe();
    probe.answers.set('TLSv1.2', REFUSED);
    expectFail(await run(standardSite(), { probe }), 'certificate');
  });

  describe('with a fixed clock', () => {
    const NOW = new Date('2026-10-22T12:00:00Z');

    async function runWithExpiry(validTo: Date): Promise<CheckResult[]> {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const probe = new FakeProbe();
      probe.answers.set('TLSv1.2', { ok: true, protocol: 'TLSv1.2', validTo });
      return run(standardSite(), { probe });
    }

    test('AC-31: a certificate that expires in 13 days fails', async () => {
      expectFail(await runWithExpiry(new Date(NOW.getTime() + 13 * DAY)), 'certificate');
    });

    test('AC-31: a certificate that expires one second short of 14 days fails', async () => {
      expectFail(await runWithExpiry(new Date(NOW.getTime() + 14 * DAY - 1000)), 'certificate');
    });

    test('AC-31: a certificate that expires in exactly 14 days passes', async () => {
      expectOk(await runWithExpiry(new Date(NOW.getTime() + 14 * DAY)), 'certificate');
    });

    test('AC-31: a certificate that expires in 90 days passes', async () => {
      expectOk(await runWithExpiry(new Date(NOW.getTime() + 90 * DAY)), 'certificate');
    });

    test('AC-31: an already expired certificate fails', async () => {
      expectFail(await runWithExpiry(new Date(NOW.getTime() - DAY)), 'certificate');
    });
  });

  test('AC-31: in cloudfront-only mode the certificate of the cloudfront.net name is probed', async () => {
    const probe = new FakeProbe();
    await run(standardSite(CF, null), { probe });
    expect(probe.calls.find((call) => call.version === 'TLSv1.2')?.host).toBe(CF);
  });
});

describe('tls-legacy', () => {
  test('AC-32: it probes TLSv1 and TLSv1.1 on the site host', async () => {
    const probe = new FakeProbe();
    await run(standardSite(), { probe });
    const legacy = probe.calls.filter(
      (call) => call.version === 'TLSv1' || call.version === 'TLSv1.1',
    );
    expect(legacy.map((call) => call.version).sort()).toEqual(['TLSv1', 'TLSv1.1']);
    for (const call of legacy) expect(call.host).toBe(HOST);
  });

  test.each<TlsVersion>(['TLSv1', 'TLSv1.1'])(
    'AC-32: a completed %s handshake fails the check',
    async (version) => {
      const probe = new FakeProbe();
      probe.answers.set(version, {
        ok: true,
        protocol: version,
        validTo: new Date(Date.now() + 60 * DAY),
      });
      const detail = expectFail(await run(standardSite(), { probe }), 'tls-legacy');
      expect(detail).toContain(version);
    },
  );

  test.each<TlsVersion>(['TLSv1', 'TLSv1.1'])(
    'AC-32: a %s probe that failed client side (not refused by the server) fails the check',
    async (version) => {
      const probe = new FakeProbe();
      probe.answers.set(version, {
        ok: false,
        code: 'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
        serverRefused: false,
      });
      expectFail(await run(standardSite(), { probe }), 'tls-legacy');
    },
  );

  test('AC-32: both probes refused by the server pass', async () => {
    const probe = new FakeProbe();
    probe.answers.set('TLSv1', {
      ok: false,
      code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
      serverRefused: true,
    });
    probe.answers.set('TLSv1.1', REFUSED);
    expectOk(await run(standardSite(), { probe }), 'tls-legacy');
  });

  test('AC-32: in cloudfront-only mode it is skipped and no legacy probe is made', async () => {
    const probe = new FakeProbe();
    const results = await run(standardSite(CF, null), { probe });
    expect(statusOf(results, 'tls-legacy')).toBe('skip');
    expect(probe.versions()).not.toContain('TLSv1');
    expect(probe.versions()).not.toContain('TLSv1.1');
  });

  test.each([
    ['ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', true],
    ['ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', true],
    ['ERR_SSL_NO_PROTOCOLS_AVAILABLE', false],
    ['ECONNRESET', false],
    ['ETIMEDOUT', false],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', false],
  ])('AC-32: isServerRefusal(%s) is %s', (code, expected) => {
    expect(isServerRefusal(code)).toBe(expected);
  });
});

// =================================================================================================
// AC-33: how requests are made
// =================================================================================================

describe('requests', () => {
  test('AC-33: every request has redirect manual, the User-Agent and an abort signal', async () => {
    const site = standardSite();
    await run(site, { timeoutMs: 4321 });
    expect(site.calls.length).toBeGreaterThan(12);
    for (const call of site.calls) {
      expect(call.init?.redirect, call.url).toBe('manual');
      expect(new Headers(call.init?.headers).get('user-agent'), call.url).toBe('field-guide-smoke');
      expect(call.init?.signal, call.url).toBeInstanceOf(AbortSignal);
      expect(call.init?.signal?.aborted, call.url).toBe(false);
    }
  });

  test('AC-33: requests are GET requests', async () => {
    const site = standardSite();
    await run(site);
    for (const call of site.calls) expect(call.method.toUpperCase(), call.url).toBe('GET');
  });

  test('AC-33: a request that never answers is aborted after deps.timeoutMs, then retried once', async () => {
    const site = standardSite();
    const hung = site.url('/fixtures/diagram/');
    let attempts = 0;
    const hanging = ((input: FetchInput, init?: RequestInit) => {
      if (hrefOf(input) !== hung) return site.fetch(input, init);
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      });
    }) as typeof fetch;
    const results = await run(site, { fetch: hanging, timeoutMs: 40 });
    expect(attempts).toBe(2);
    expectFail(results, 'no-fixtures');
    expect(results.map((result) => result.id)).toEqual(IDS);
  });

  /** A fetch that rejects the first `failures` requests for `/fixtures/diagram/`, counting them. */
  function flaky(
    site: FakeSite,
    failures: number,
  ): { fetch: typeof fetch; attempts: () => number } {
    const target = site.url('/fixtures/diagram/');
    let attempts = 0;
    const wrapped = ((input: FetchInput, init?: RequestInit) => {
      if (hrefOf(input) !== target) return site.fetch(input, init);
      attempts += 1;
      if (attempts <= failures) return Promise.reject(new Error('socket hang up'));
      return site.fetch(input, init);
    }) as typeof fetch;
    return { fetch: wrapped, attempts: () => attempts };
  }

  test('AC-33: one rejected fetch is retried once and the check passes', async () => {
    const site = standardSite();
    const { fetch: wrapped, attempts } = flaky(site, 1);
    const results = await run(site, { fetch: wrapped });
    expectOk(results, 'no-fixtures');
    expect(attempts()).toBe(2);
  });

  test('AC-33: a request rejected twice fails the check with the error, and the other checks still run', async () => {
    const site = standardSite();
    const { fetch: wrapped, attempts } = flaky(site, 99);
    const results = await run(site, { fetch: wrapped });
    const detail = expectFail(results, 'no-fixtures');
    expect(detail).toContain('socket hang up');
    expect(attempts()).toBe(2);
    expect(results.map((result) => result.id)).toEqual(IDS);
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(11);
  });

  test('AC-33: a wrong status is not retried', async () => {
    const site = standardSite();
    site.set('/fixtures/diagram/', route(500, 'text/html', undefined, 'boom'));
    const { fetch: wrapped, attempts } = flaky(site, 0);
    const results = await run(site, { fetch: wrapped });
    expectFail(results, 'no-fixtures');
    expect(attempts()).toBe(1);
  });

  test('AC-33: an unreachable home page fails its checks and leaves the others running', async () => {
    const site = standardSite();
    const home = site.url('/');
    const wrapped = ((input: FetchInput, init?: RequestInit) =>
      hrefOf(input) === home
        ? Promise.reject(new Error('ECONNRESET'))
        : site.fetch(input, init)) as typeof fetch;
    const results = await run(site, { fetch: wrapped });
    expect(results.map((result) => result.id)).toEqual(IDS);
    expectFail(results, 'pages');
    expectFail(results, 'assets');
    expectOk(results, 'folder-redirect');
    expectOk(results, 'bank');
    expectOk(results, 'certificate');
  });
});

// =================================================================================================
// AC-34: formatResults
// =================================================================================================

describe('formatResults', () => {
  const lines = (text: string): string[] => text.trimEnd().split(/\r?\n/);

  test('AC-34: prints ok, FAIL and skip lines and the summary, exit code 1 when a check failed', () => {
    const { text, exitCode } = formatResults([
      { id: 'pages', status: 'ok' },
      { id: 'bank', status: 'fail', detail: 'bank.json is not JSON' },
      { id: 'host-redirect', status: 'skip', detail: 'no --cloudfront-domain' },
    ]);
    expect(exitCode).toBe(1);
    expect(lines(text)).toEqual([
      'ok   pages',
      'FAIL bank: bank.json is not JSON',
      'skip host-redirect: no --cloudfront-domain',
      'smoke: 1 ok, 1 failed, 1 skipped',
    ]);
  });

  test('AC-34: exit code 0 when every check is ok or skipped', () => {
    const { text, exitCode } = formatResults([
      { id: 'pages', status: 'ok' },
      { id: 'tls-legacy', status: 'skip', detail: 'cloudfront-only mode' },
      { id: 'bank', status: 'ok' },
    ]);
    expect(exitCode).toBe(0);
    expect(lines(text)).toEqual([
      'ok   pages',
      'skip tls-legacy: cloudfront-only mode',
      'ok   bank',
      'smoke: 2 ok, 0 failed, 1 skipped',
    ]);
  });

  test('AC-34: exit code 1 when the only non-ok check is a failure', () => {
    const { text, exitCode } = formatResults([{ id: 'pages', status: 'fail', detail: 'x' }]);
    expect(exitCode).toBe(1);
    expect(lines(text)).toEqual(['FAIL pages: x', 'smoke: 0 ok, 1 failed, 0 skipped']);
  });

  test('AC-34: counts several failures', () => {
    const { text } = formatResults([
      { id: 'a', status: 'fail', detail: 'one' },
      { id: 'b', status: 'fail', detail: 'two' },
      { id: 'c', status: 'ok' },
    ]);
    expect(lines(text).pop()).toBe('smoke: 1 ok, 2 failed, 0 skipped');
  });
});
