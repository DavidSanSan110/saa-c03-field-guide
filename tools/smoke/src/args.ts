// Command line of the smoke test (spec 036): --url <https://host> [--cloudfront-domain <name>].

export interface SmokeOptions {
  url: URL;
  cloudfrontDomain?: string;
}

export type ParseResult = { ok: true; options: SmokeOptions } | { ok: false; error: string };

const CLOUDFRONT_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.cloudfront\.net$/i;

/** The site URL: an https origin and nothing else (no path, query, fragment, credentials or port). */
function parseSiteUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const originOnly =
      url.protocol === 'https:' && url.port === '' && url.href === `${url.origin}/`;
    return originOnly ? url : undefined;
  } catch {
    return undefined;
  }
}

export function parseArgs(argv: string[]): ParseResult {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    if (flag !== '--url' && flag !== '--cloudfront-domain') {
      return { ok: false, error: `unknown argument: ${flag}` };
    }
    if (values.has(flag)) return { ok: false, error: `${flag} was given twice` };
    const value = argv[i + 1];
    if (value === undefined || value === '') {
      return { ok: false, error: `${flag} needs a value` };
    }
    values.set(flag, value);
  }

  const rawUrl = values.get('--url');
  if (rawUrl === undefined) return { ok: false, error: '--url is required' };
  const url = parseSiteUrl(rawUrl);
  if (url === undefined) {
    return {
      ok: false,
      error: `--url must be an https origin such as https://example.org, got: ${rawUrl}`,
    };
  }

  const cloudfrontDomain = values.get('--cloudfront-domain');
  if (cloudfrontDomain === undefined) return { ok: true, options: { url } };
  if (!CLOUDFRONT_DOMAIN.test(cloudfrontDomain)) {
    return {
      ok: false,
      error: `--cloudfront-domain must be a name ending in .cloudfront.net, got: ${cloudfrontDomain}`,
    };
  }
  return { ok: true, options: { url, cloudfrontDomain } };
}
