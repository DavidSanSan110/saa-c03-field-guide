// The violation fixture of spec 034, section 5. It installs, before any page script, a
// `securitypolicyviolation` listener that reports through `page.exposeBinding`, so the record lives
// in the test process and survives navigations. Console messages that mention the Content Security
// Policy are recorded separately (kind "console"). After each test the record must be empty.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

export { expect };

export interface ViolationEntry {
  kind: 'violation';
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  /** The URL of the page that reported it. */
  page: string;
}

export interface ConsoleEntry {
  kind: 'console';
  text: string;
  page: string;
}

export type CspEntry = ViolationEntry | ConsoleEntry;

export interface ViolationLog {
  /** Everything recorded so far, across navigations. */
  readonly entries: readonly CspEntry[];
  /** Only the securitypolicyviolation events. */
  violations(): ViolationEntry[];
  /** Only the console messages that mention the Content Security Policy. */
  consoleMessages(): ConsoleEntry[];
  /** Forgets everything recorded so far (for tests that expect a violation on purpose). */
  clear(): void;
}

const BINDING = '__recordCspViolation';

// Runs in every frame before the page's own scripts. A string, so this file needs no DOM types.
const INIT_SCRIPT = `
window.addEventListener(
  'securitypolicyviolation',
  (event) => {
    window.${BINDING}({
      effectiveDirective: event.effectiveDirective,
      blockedURI: event.blockedURI,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
    });
  },
  true,
);
`;

/** Every entry, one per line, for the failure message. */
export function describeEntries(entries: readonly CspEntry[]): string {
  return entries
    .map((entry) =>
      entry.kind === 'violation'
        ? `violation ${entry.effectiveDirective} blocked=${entry.blockedURI} at ${entry.sourceFile}:${String(entry.lineNumber)} (page ${entry.page})`
        : `console "${entry.text}" (page ${entry.page})`,
    )
    .join('\n');
}

/**
 * Opens `path` and waits for the network to settle. It also checks that the policies are really in
 * force (the CSP header on the response and one meta CSP in the page), so that "no violation" cannot
 * pass on a page that has no policy at all.
 */
export async function gotoUnderCsp(page: Page, path: string, status = 200) {
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status(), `status of ${path}`).toBe(status);
  expect(response?.headers()['content-security-policy'], `CSP header of ${path}`).toBeTruthy();
  await expect(page.locator('meta[http-equiv="content-security-policy" i]')).toHaveCount(1);
  return response;
}

/** Fails with every recorded entry printed when anything was recorded. */
export function expectNoViolations(log: ViolationLog): void {
  expect(log.entries, `CSP violations recorded:\n${describeEntries(log.entries)}`).toEqual([]);
}

export const test = base.extend<{ violations: ViolationLog }>({
  violations: [
    async ({ page }, use) => {
      const entries: CspEntry[] = [];

      await page.exposeBinding(BINDING, (source, report: Omit<ViolationEntry, 'kind' | 'page'>) => {
        entries.push({ kind: 'violation', ...report, page: source.page.url() });
      });
      await page.addInitScript(INIT_SCRIPT);
      page.on('console', (message) => {
        if (message.text().includes('Content Security Policy')) {
          entries.push({ kind: 'console', text: message.text(), page: page.url() });
        }
      });

      const log: ViolationLog = {
        get entries() {
          return entries;
        },
        violations: () =>
          entries.filter((entry): entry is ViolationEntry => entry.kind === 'violation'),
        consoleMessages: () =>
          entries.filter((entry): entry is ConsoleEntry => entry.kind === 'console'),
        clear: () => {
          entries.length = 0;
        },
      };

      await use(log);

      expect(entries, `CSP violations recorded:\n${describeEntries(entries)}`).toEqual([]);
    },
    { auto: true },
  ],
});

const HEADERS_FILE = resolve(import.meta.dirname, '..', '..', 'apps', 'site', 'headers.json');

/** The headers the server must send: apps/site/headers.json, name -> value. */
export function readSiteHeaders(): Record<string, string> {
  return JSON.parse(readFileSync(HEADERS_FILE, 'utf8')) as Record<string, string>;
}
