// Spec 034, AC-3 to AC-5: the meta CSP of every built page. Reads apps/site/dist (built by the first
// webServer of playwright.config.ts) and apps/site/csp-inline-hashes.json; no browser needed.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { uncoveredScripts } from '../../apps/site/src/csp/inline-hashes.ts';

const DIST = resolve(import.meta.dirname, '..', '..', 'apps', 'site', 'dist');
const HASH_FILE = resolve(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'site',
  'csp-inline-hashes.json',
);

interface Page {
  /** Path relative to dist/, with forward slashes. */
  name: string;
  html: string;
}

function builtPages(): Page[] {
  return readdirSync(DIST, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.html'))
    .sort()
    .map((entry) => ({
      name: relative(DIST, join(DIST, entry)).replaceAll('\\', '/'),
      html: readFileSync(join(DIST, entry), 'utf8'),
    }));
}

/** The attribute values of every <meta http-equiv="content-security-policy"> of the page. */
function metaPolicies(html: string): string[] {
  const policies: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(tag)) continue;
    const content = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    policies.push(
      (content?.[1] ?? content?.[2] ?? '')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"')
        .replaceAll('&amp;', '&'),
    );
  }
  return policies;
}

/** The sources of one directive of a policy, or undefined when the policy has no such directive. */
function directive(policy: string, name: string): string[] | undefined {
  for (const part of policy.split(';')) {
    const [first, ...sources] = part.trim().split(/\s+/);
    if (first === name) return sources;
  }
  return undefined;
}

function pinnedHashes(): string[] {
  return (JSON.parse(readFileSync(HASH_FILE, 'utf8')) as { scriptHashes: string[] }).scriptHashes;
}

test.describe('the built site', () => {
  test('AC-3: the pages checked include 404.html and fixtures/diagram/', () => {
    const names = builtPages().map((page) => page.name);

    expect(names).toContain('404.html');
    expect(names).toContain('fixtures/diagram/index.html');
    expect(names).toContain('index.html');
  });

  test('AC-3: every page has exactly one meta Content-Security-Policy', () => {
    const wrong = builtPages()
      .map((page) => `${page.name}: ${String(metaPolicies(page.html).length)} meta tags`)
      .filter((line) => !line.endsWith(': 1 meta tags'));

    expect(wrong).toEqual([]);
  });

  test("AC-3: every script-src has 'self' and 'wasm-unsafe-eval' and no 'unsafe-inline'", () => {
    const problems: string[] = [];
    for (const page of builtPages()) {
      const [policy = ''] = metaPolicies(page.html);
      const sources = directive(policy, 'script-src');
      if (sources === undefined) problems.push(`${page.name}: no script-src`);
      else {
        if (!sources.includes("'self'")) problems.push(`${page.name}: no 'self'`);
        if (!sources.includes("'wasm-unsafe-eval'"))
          problems.push(`${page.name}: no 'wasm-unsafe-eval'`);
        if (sources.includes("'unsafe-inline'")) problems.push(`${page.name}: has 'unsafe-inline'`);
      }
    }

    expect(problems).toEqual([]);
  });

  test("AC-3: every style-src is exactly 'self' 'unsafe-inline', without a sha256 source", () => {
    const wrong: string[] = [];
    for (const page of builtPages()) {
      const [policy = ''] = metaPolicies(page.html);
      const sources = directive(policy, 'style-src');
      if (sources?.join(' ') !== "'self' 'unsafe-inline'") {
        wrong.push(`${page.name}: style-src ${sources?.join(' ') ?? '(missing)'}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  test('AC-4: every pinned hash is in the script-src of every page', () => {
    const pinned = pinnedHashes();
    const missing: string[] = [];
    for (const page of builtPages()) {
      const [policy = ''] = metaPolicies(page.html);
      const sources = directive(policy, 'script-src') ?? [];
      for (const hash of pinned) {
        if (!sources.includes(`'${hash}'`)) missing.push(`${page.name}: ${hash}`);
      }
    }

    expect(missing).toEqual([]);
  });

  test('AC-5: no inline script of any page is uncovered by its meta CSP', () => {
    const uncovered: string[] = [];
    for (const page of builtPages()) {
      for (const script of uncoveredScripts(page.html)) {
        uncovered.push(`${page.name}: ${script.hash} ${script.snippet}`);
      }
    }

    expect(
      uncovered,
      `inline scripts not allowed by the meta CSP (run: pnpm csp-hashes, then rebuild):\n${uncovered.join('\n')}`,
    ).toEqual([]);
  });
});
