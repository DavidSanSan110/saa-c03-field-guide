// The checks of the smoke test (spec 036): requests to the live site and TLS probes, no side effects.
import { randomBytes } from 'node:crypto';
import type { SmokeOptions } from './args.ts';
import { ASSET_CACHE_CONTROL, HTML_CACHE_CONTROL } from './cache.ts';
import { tlsProbe as defaultTlsProbe } from './tls.ts';

export interface CheckResult {
  id: string;
  status: 'ok' | 'fail' | 'skip';
  detail?: string;
}

export interface SmokeDeps {
  fetch?: typeof fetch;
  tlsProbe?: typeof defaultTlsProbe;
  random?: () => string;
  timeoutMs?: number;
}

interface Reply {
  status: number;
  headers: Headers;
  body: Buffer;
}

interface Asset {
  url: URL;
  kind: 'script' | 'stylesheet';
}

const MIN_CERTIFICATE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCRIPT_TYPES = ['text/javascript', 'application/javascript'];

/** The media type of a Content-Type header, without parameters. */
function mediaType(reply: Reply): string {
  return (reply.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Passes when there is no problem, otherwise fails with all of them. */
function fromProblems(problems: string[]): Omit<CheckResult, 'id'> {
  return problems.length === 0 ? { status: 'ok' } : { status: 'fail', detail: problems.join('; ') };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The attributes of one HTML tag, names in lower case. Good enough for the pages Astro builds. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attributes.set((match[1] as string).toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

export function runSmoke(
  options: SmokeOptions & { headers: Record<string, string> },
  deps: SmokeDeps = {},
): Promise<CheckResult[]> {
  const doFetch = deps.fetch ?? fetch;
  const probe = deps.tlsProbe ?? defaultTlsProbe;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const random = deps.random ?? (() => randomBytes(8).toString('hex'));

  const { url, cloudfrontDomain } = options;
  const host = url.host;
  const customDomain = !url.hostname.endsWith('.cloudfront.net');
  const notFoundPath = `/smoke-${random()}/`;

  /** GET without following redirects; one retry after a network error or a timeout. */
  async function get(target: string): Promise<Reply> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await doFetch(target, {
          redirect: 'manual',
          headers: { 'User-Agent': 'field-guide-smoke' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          status: response.status,
          headers: response.headers,
          body: Buffer.from(await response.arrayBuffer()),
        };
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }

  const getPath = (path: string): Promise<Reply> => get(new URL(path, url).href);

  /** Expects a status and, when given, a media type; returns the problems found. */
  function expectReply(
    label: string,
    reply: Reply,
    status: number,
    type?: string | string[],
  ): string[] {
    const problems: string[] = [];
    if (reply.status !== status)
      problems.push(`${label}: status ${reply.status}, expected ${status}`);
    const types = type === undefined ? [] : [type].flat();
    if (types.length > 0 && !types.includes(mediaType(reply))) {
      problems.push(
        `${label}: content type ${mediaType(reply) || 'none'}, expected ${types.join(' or ')}`,
      );
    }
    return problems;
  }

  function expectRedirect(label: string, reply: Reply, location: string): string[] {
    const found = reply.headers.get('location');
    return [
      ...expectReply(label, reply, 301),
      ...(found === location
        ? []
        : [`${label}: Location ${found ?? 'missing'}, expected ${location}`]),
    ];
  }

  /** The same-origin scripts and stylesheets of the home page. */
  async function findAssets(): Promise<Asset[]> {
    const html = (await getPath('/')).body.toString('utf8');
    const assets = new Map<string, Asset>();
    for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const attributes = attributesOf(tag);
      const isScript = tag.toLowerCase().startsWith('<script');
      const reference = isScript ? attributes.get('src') : attributes.get('href');
      const stylesheet = (attributes.get('rel') ?? '')
        .toLowerCase()
        .split(/\s+/)
        .includes('stylesheet');
      if (reference === undefined || !(isScript || stylesheet)) continue;
      const asset = new URL(reference, url);
      if (asset.protocol === 'https:' && asset.host === host) {
        assets.set(asset.href, { url: asset, kind: isScript ? 'script' : 'stylesheet' });
      }
    }
    return [...assets.values()];
  }

  const checks: [string, () => Promise<Omit<CheckResult, 'id'>>][] = [
    [
      'pages',
      async () => {
        const problems: string[] = [];
        for (const path of ['/', '/d1/', '/practice/']) {
          problems.push(...expectReply(path, await getPath(path), 200, 'text/html'));
        }
        return fromProblems(problems);
      },
    ],
    [
      'folder-redirect',
      async () => fromProblems(expectRedirect('/d1', await getPath('/d1'), '/d1/')),
    ],
    [
      'bank',
      async () => {
        const path = '/practice/bank.json';
        const reply = await getPath(path);
        const problems = expectReply(path, reply, 200, 'application/json');
        if (problems.length > 0) return fromProblems(problems);
        const bank: unknown = JSON.parse(reply.body.toString('utf8'));
        const questions = (bank as { questions?: unknown } | null)?.questions;
        const valid = !Array.isArray(bank) && Array.isArray(questions) && questions.length > 0;
        return fromProblems(valid ? [] : [`${path}: no non-empty "questions" array`]);
      },
    ],
    [
      'not-found',
      async () => {
        const page = await getPath('/404.html');
        const missing = await getPath(notFoundPath);
        return fromProblems([
          ...expectReply('/404.html', page, 200, 'text/html'),
          ...expectReply(notFoundPath, missing, 404, 'text/html'),
          ...(missing.body.equals(page.body)
            ? []
            : [`${notFoundPath}: body differs from /404.html`]),
        ]);
      },
    ],
    [
      'no-fixtures',
      async () => {
        const path = '/fixtures/diagram/';
        return fromProblems(expectReply(path, await getPath(path), 404));
      },
    ],
    [
      'https-redirect',
      async () =>
        fromProblems(
          expectRedirect(
            `http://${host}/d1/`,
            await get(`http://${host}/d1/`),
            `https://${host}/d1/`,
          ),
        ),
    ],
    [
      'host-redirect',
      async () => {
        if (!customDomain) return { status: 'skip', detail: 'cloudfront-only mode' };
        if (cloudfrontDomain === undefined)
          return { status: 'skip', detail: 'no --cloudfront-domain' };
        const from = `https://${cloudfrontDomain}/d1/?smoke=1`;
        return fromProblems(expectRedirect(from, await get(from), `https://${host}/d1/?smoke=1`));
      },
    ],
    [
      'headers',
      async () => {
        const assets = await findAssets().catch(() => []);
        const paths = ['/', '/d1/', notFoundPath, '/d1', '/practice/bank.json'];
        if (assets[0] !== undefined) paths.push(assets[0].url.pathname);
        const problems: string[] = [];
        for (const path of paths) {
          let reply: Reply;
          try {
            reply = await getPath(path);
          } catch (error) {
            problems.push(`${path}: ${errorMessage(error)}`);
            continue;
          }
          for (const [name, expected] of Object.entries(options.headers)) {
            const actual = reply.headers.get(name);
            if (actual !== expected) {
              problems.push(`${path}: ${name} is ${actual ?? 'missing'}, expected ${expected}`);
            }
          }
        }
        return fromProblems(problems);
      },
    ],
    [
      'assets',
      async () => {
        const assets = await findAssets();
        if (assets.length === 0) return fromProblems(['no script or stylesheet found on /']);
        const problems: string[] = [];
        for (const { url: asset, kind } of assets) {
          const types = kind === 'script' ? SCRIPT_TYPES : ['text/css'];
          problems.push(...expectReply(asset.pathname, await get(asset.href), 200, types));
        }
        return fromProblems(problems);
      },
    ],
    [
      'cache-control',
      async () => {
        const wanted = new Map<string, string>([
          ['/', HTML_CACHE_CONTROL],
          ['/practice/bank.json', HTML_CACHE_CONTROL],
        ]);
        const assets = (await findAssets()).filter(({ url: asset }) =>
          asset.pathname.startsWith('/_astro/'),
        );
        for (const { url: asset } of assets) wanted.set(asset.pathname, ASSET_CACHE_CONTROL);
        const problems = assets.length === 0 ? ['no /_astro/ asset found on /'] : [];
        for (const [path, expected] of wanted) {
          const actual = (await getPath(path)).headers.get('cache-control');
          if (actual !== expected) {
            problems.push(`${path}: Cache-Control is ${actual ?? 'missing'}, expected ${expected}`);
          }
        }
        return fromProblems(problems);
      },
    ],
    [
      'certificate',
      async () => {
        const result = await probe(url.hostname, 'TLSv1.2', timeoutMs);
        if (!result.ok) return fromProblems([`TLSv1.2 handshake failed: ${result.code}`]);
        const days = (result.validTo.getTime() - Date.now()) / DAY_MS;
        return fromProblems(
          days >= MIN_CERTIFICATE_DAYS
            ? []
            : [
                `the certificate expires in ${Math.floor(days)} days, at least ${MIN_CERTIFICATE_DAYS} needed`,
              ],
        );
      },
    ],
    [
      'tls-legacy',
      async () => {
        if (!customDomain)
          return {
            status: 'skip',
            detail: 'cloudfront-only mode: the default certificate allows TLS 1.0',
          };
        const problems: string[] = [];
        for (const version of ['TLSv1', 'TLSv1.1'] as const) {
          const result = await probe(url.hostname, version, timeoutMs);
          if (result.ok) problems.push(`${version} handshake completed`);
          else if (!result.serverRefused) {
            problems.push(`${version} was not refused by the server (${result.code})`);
          }
        }
        return fromProblems(problems);
      },
    ],
  ];

  return (async () => {
    const results: CheckResult[] = [];
    for (const [id, check] of checks) {
      try {
        results.push({ id, ...(await check()) });
      } catch (error) {
        results.push({ id, status: 'fail', detail: errorMessage(error) });
      }
    }
    return results;
  })();
}

export function formatResults(results: CheckResult[]): { text: string; exitCode: 0 | 1 } {
  const lines = results.map(({ id, status, detail }) => {
    if (status === 'ok') return `ok   ${id}`;
    return `${status === 'fail' ? 'FAIL' : 'skip'} ${id}: ${detail ?? ''}`;
  });
  const count = (status: CheckResult['status']): number =>
    results.filter((result) => result.status === status).length;
  lines.push(`smoke: ${count('ok')} ok, ${count('fail')} failed, ${count('skip')} skipped`);
  return { text: `${lines.join('\n')}\n`, exitCode: count('fail') > 0 ? 1 : 0 };
}
