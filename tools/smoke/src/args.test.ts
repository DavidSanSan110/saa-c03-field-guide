import { describe, expect, test } from 'vitest';
import { parseArgs } from './args.ts';

// Spec 036, tools/smoke: command line parsing (AC-17, AC-18).

const CF = 'd111111abcdef8.cloudfront.net';

describe('parseArgs: accepted command lines', () => {
  test.each(['https://example.org', 'https://example.org/'])(
    'AC-17: --url %s is accepted and no cloudfront domain is set',
    (url) => {
      const result = parseArgs(['--url', url]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.options.url).toBeInstanceOf(URL);
      expect(result.options.url.origin).toBe('https://example.org');
      expect(result.options.url.pathname).toBe('/');
      expect(result.options.cloudfrontDomain).toBeUndefined();
    },
  );

  test('AC-17: --url then --cloudfront-domain gives both values', () => {
    const result = parseArgs(['--url', 'https://example.org', '--cloudfront-domain', CF]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.url.origin).toBe('https://example.org');
    expect(result.options.cloudfrontDomain).toBe(CF);
  });

  test('AC-17: --cloudfront-domain then --url gives both values', () => {
    const result = parseArgs(['--cloudfront-domain', CF, '--url', 'https://example.org/']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.url.origin).toBe('https://example.org');
    expect(result.options.cloudfrontDomain).toBe(CF);
  });

  test('AC-17: a cloudfront.net site URL is accepted (the lab without a domain)', () => {
    const result = parseArgs(['--url', `https://${CF}`]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.url.host).toBe(CF);
  });
});

describe('parseArgs: rejected command lines', () => {
  const rejected: [string, string[]][] = [
    ['no arguments at all', []],
    ['no --url (only a cloudfront domain)', ['--cloudfront-domain', CF]],
    ['--url without a value', ['--url']],
    ['--url with an empty value', ['--url', '']],
    ['--url followed by another flag instead of a value', ['--url', '--cloudfront-domain', CF]],
    [
      '--cloudfront-domain without a value',
      ['--url', 'https://example.org', '--cloudfront-domain'],
    ],
    [
      '--cloudfront-domain with an empty value',
      ['--url', 'https://example.org', '--cloudfront-domain', ''],
    ],
    ['an http: URL', ['--url', 'http://example.org']],
    ['a URL that is not a URL', ['--url', 'example.org']],
    ['a URL with a path', ['--url', 'https://example.org/d1/']],
    ['a URL with a double slash path', ['--url', 'https://example.org//']],
    ['a URL with a query', ['--url', 'https://example.org/?a=1']],
    ['a URL with a query and no path', ['--url', 'https://example.org?a=1']],
    ['a URL with a fragment', ['--url', 'https://example.org/#top']],
    ['a URL with credentials (user and password)', ['--url', 'https://user:pass@example.org']],
    ['a URL with credentials (user only)', ['--url', 'https://user@example.org/']],
    ['a URL with a port', ['--url', 'https://example.org:8443']],
    ['a URL with a port and a slash', ['--url', 'https://example.org:8443/']],
  ];

  test.each(rejected)('AC-18: rejects %s', (_name, argv) => {
    const result = parseArgs(argv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  const badDomains: [string, string][] = [
    ['a name outside cloudfront.net', 'example.org'],
    ['just cloudfront.net', 'cloudfront.net'],
    ['a name that ends in cloudfront.net without the dot', 'evilcloudfront.net'],
    ['a name that only contains .cloudfront.net', 'd1.cloudfront.net.evil.example'],
    ['a name with a slash', 'd1.cloudfront.net/'],
    ['a name with a path', 'x/d1.cloudfront.net'],
    ['a name with a port', 'd1.cloudfront.net:443'],
    ['a name with credentials', 'user@d1.cloudfront.net'],
    ['a full URL', 'https://d1.cloudfront.net'],
  ];

  test.each(badDomains)('AC-18: rejects --cloudfront-domain that is %s', (_name, domain) => {
    const result = parseArgs(['--url', 'https://example.org', '--cloudfront-domain', domain]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  test('AC-18: rejects an unknown flag next to valid ones', () => {
    expect(parseArgs(['--url', 'https://example.org', '--bogus']).ok).toBe(false);
  });

  test('AC-18: rejects an unknown flag with a value', () => {
    expect(parseArgs(['--url', 'https://example.org', '--bogus', 'x']).ok).toBe(false);
  });

  test('AC-18: rejects an unknown flag on its own', () => {
    expect(parseArgs(['--bogus']).ok).toBe(false);
  });

  test('AC-18: rejects a repeated --url, even with the same value', () => {
    expect(parseArgs(['--url', 'https://example.org', '--url', 'https://example.org']).ok).toBe(
      false,
    );
  });

  test('AC-18: rejects a repeated --url with different values', () => {
    expect(parseArgs(['--url', 'https://example.org', '--url', 'https://example.net']).ok).toBe(
      false,
    );
  });

  test('AC-18: rejects a repeated --cloudfront-domain', () => {
    expect(
      parseArgs([
        '--url',
        'https://example.org',
        '--cloudfront-domain',
        CF,
        '--cloudfront-domain',
        CF,
      ]).ok,
    ).toBe(false);
  });
});
