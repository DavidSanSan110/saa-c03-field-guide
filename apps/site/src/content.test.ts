import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domains, tasks } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const docsRoot = join(siteRoot, 'src', 'content', 'docs');

/** Reads the `title` of a page's frontmatter (plain, 'single' or "double" quoted scalar). */
function readTitle(file: string): string {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)?.[1];
  if (frontmatter === undefined) throw new Error(`no frontmatter in ${file}`);

  const line = frontmatter.split('\n').find((candidate) => candidate.startsWith('title:'));
  if (line === undefined) throw new Error(`no title in ${file}`);

  const raw = line.slice('title:'.length).trim();
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return JSON.parse(raw) as string;
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function listFiles(directory: string): string[] {
  const ignored = new Set(['node_modules', 'dist', '.astro']);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe('site content contract', () => {
  test('AC-3: the home page and the practice-tests placeholder exist', () => {
    expect(existsSync(join(docsRoot, 'index.mdx'))).toBe(true);
    expect(existsSync(join(docsRoot, 'practice-tests.md'))).toBe(true);
  });

  test('AC-3: the home page is titled "SAA-C03 Field Guide"', () => {
    expect(readTitle(join(docsRoot, 'index.mdx'))).toBe('SAA-C03 Field Guide');
  });

  test('AC-3: the practice-tests placeholder is titled "Practice tests"', () => {
    expect(readTitle(join(docsRoot, 'practice-tests.md'))).toBe('Practice tests');
  });

  test.each(domains.map((domain) => [domain.id, domain] as const))(
    'AC-3: domain %i has d<n>/index.mdx titled "Domain <n>: <title>"',
    (_id, domain) => {
      const file = join(docsRoot, `d${String(domain.id)}`, 'index.mdx');

      expect(existsSync(file)).toBe(true);
      expect(readTitle(file)).toBe(`Domain ${String(domain.id)}: ${domain.title}`);
    },
  );

  test.each(tasks.map((task) => [task.id, task] as const))(
    'AC-3: task %s has d<n>/<slug>/index.md titled "Task <id>: <title>"',
    (_id, task) => {
      const file = join(docsRoot, `d${String(task.domain)}`, task.slug, 'index.md');

      expect(existsSync(file)).toBe(true);
      expect(readTitle(file)).toBe(`Task ${task.id}: ${task.title}`);
    },
  );

  test('AC-3: pins literal titles from the spec', () => {
    expect(readTitle(join(docsRoot, 'd1', 'index.mdx'))).toBe(
      'Domain 1: Design Secure Architectures',
    );
    expect(readTitle(join(docsRoot, 'd1', '1-3-data-security', 'index.md'))).toBe(
      'Task 1.3: Determine appropriate data security controls',
    );
  });

  test('AC-3: no file under apps/site is named like the blocked quiz page', () => {
    const blocked = 'quiz' + '.md';
    const offenders = listFiles(siteRoot).filter((file) => file.split(/[\\/]/).at(-1) === blocked);

    expect(offenders).toEqual([]);
  });
});
