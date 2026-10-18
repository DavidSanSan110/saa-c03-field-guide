import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { domains, taskPath, tasks } from '../../packages/schema/src/index.ts';

const dist = resolve(import.meta.dirname, '..', '..', 'apps', 'site', 'dist');

/** `/d1/1-3-data-security/` -> `<dist>/d1/1-3-data-security/index.html`. */
function pageFile(route: string): string {
  return join(dist, ...route.split('/').filter(Boolean), 'index.html');
}

test.describe('static build output', () => {
  test('AC-4: the build writes the home page, the practice tests page and the 404 page', () => {
    expect(existsSync(join(dist, 'index.html'))).toBe(true);
    expect(existsSync(pageFile('/practice/'))).toBe(true);
    expect(existsSync(join(dist, '404.html'))).toBe(true);
  });

  test('AC-26: the build writes no /practice-tests/ page any more', () => {
    expect(existsSync(pageFile('/practice-tests/'))).toBe(false);
  });

  for (const domain of domains) {
    test(`AC-4: the build writes the page of domain ${String(domain.id)}`, () => {
      expect(existsSync(pageFile(`/${domain.slug}/`))).toBe(true);
    });
  }

  for (const task of tasks) {
    test(`AC-4: the build writes the page of task ${task.id}`, () => {
      expect(existsSync(pageFile(taskPath(task.id)))).toBe(true);
    });
  }

  test('AC-4: the build writes a non-empty Pagefind index', () => {
    const pagefind = join(dist, 'pagefind');

    expect(existsSync(pagefind)).toBe(true);
    expect(readdirSync(pagefind).length).toBeGreaterThan(0);
  });
});
