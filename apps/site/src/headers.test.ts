import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// Spec 034, section 1: apps/site/headers.json is the single source of the response headers.
const HEADERS_FILE = resolve(import.meta.dirname, '..', 'headers.json');

const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

const EXPECTED: [string, string][] = [
  ['Strict-Transport-Security', 'max-age=31536000'],
  ['Content-Security-Policy', CSP],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
];

function readHeaders(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(HEADERS_FILE, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('headers.json is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

describe('headers.json', () => {
  test('AC-1: holds exactly the 7 headers of the spec, in order', () => {
    const headers = readHeaders();

    expect(Object.keys(headers)).toEqual(EXPECTED.map(([name]) => name));
  });

  test.each(EXPECTED)('AC-1: %s has exactly the value of the spec', (name, value) => {
    const headers = readHeaders();

    expect(headers[name]).toBe(value);
  });

  test('AC-1: every value is a string', () => {
    const headers = readHeaders();

    expect(Object.values(headers).map((value) => typeof value)).toEqual(
      EXPECTED.map(() => 'string'),
    );
  });

  test('AC-2: the CSP value is at most 1783 characters (the CloudFront limit)', () => {
    const csp = readHeaders()['Content-Security-Policy'];

    expect(typeof csp).toBe('string');
    expect((csp as string).length).toBeLessThanOrEqual(1783);
  });

  test('AC-2: the CSP value has no line break', () => {
    const csp = readHeaders()['Content-Security-Policy'];

    expect(typeof csp).toBe('string');
    expect(csp as string).not.toMatch(/[\r\n]/);
  });

  test('AC-2: the CSP directive names are unique', () => {
    const csp = readHeaders()['Content-Security-Policy'];
    expect(typeof csp).toBe('string');

    const names = (csp as string)
      .split(';')
      .map((directive) => directive.trim().split(/\s+/)[0] ?? '')
      .filter((name) => name !== '');

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  test('AC-2: the HSTS value has neither includeSubDomains nor preload', () => {
    const hsts = readHeaders()['Strict-Transport-Security'];

    expect(typeof hsts).toBe('string');
    expect((hsts as string).toLowerCase()).not.toContain('includesubdomains');
    expect((hsts as string).toLowerCase()).not.toContain('preload');
  });
});
