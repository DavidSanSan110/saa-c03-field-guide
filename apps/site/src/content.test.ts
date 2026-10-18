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
  test('AC-3: the home page exists and the practice-tests placeholder is gone (AC-26)', () => {
    expect(existsSync(join(docsRoot, 'index.mdx'))).toBe(true);
    expect(existsSync(join(docsRoot, 'practice-tests.md'))).toBe(false);
  });

  test('AC-3: the home page is titled "SAA-C03 Field Guide"', () => {
    expect(readTitle(join(docsRoot, 'index.mdx'))).toBe('SAA-C03 Field Guide');
  });

  test('AC-26: the placeholder is replaced by the practice page at pages/practice/index.astro', () => {
    expect(existsSync(join(docsRoot, 'practice-tests.mdx'))).toBe(false);
    expect(existsSync(join(siteRoot, 'src', 'pages', 'practice', 'index.astro'))).toBe(true);
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
    'AC-3: task %s has exactly one of d<n>/<slug>/index.md and index.mdx, titled "Task <id>: <title>" (AC-13)',
    (_id, task) => {
      const folder = join(docsRoot, `d${String(task.domain)}`, task.slug);
      const files = ['index.md', 'index.mdx'].map((name) => join(folder, name)).filter(existsSync);

      expect(files).toHaveLength(1);
      expect(readTitle(files[0] as string)).toBe(`Task ${task.id}: ${task.title}`);
    },
  );

  test('AC-3: pins literal titles from the spec (AC-13)', () => {
    const taskFolder = join(docsRoot, 'd1', '1-3-data-security');
    const taskFile = existsSync(join(taskFolder, 'index.mdx'))
      ? join(taskFolder, 'index.mdx')
      : join(taskFolder, 'index.md');

    expect(readTitle(join(docsRoot, 'd1', 'index.mdx'))).toBe(
      'Domain 1: Design Secure Architectures',
    );
    expect(readTitle(taskFile)).toBe('Task 1.3: Determine appropriate data security controls');
  });

  test('AC-3: no file under apps/site is named like the blocked quiz page', () => {
    const blocked = 'quiz' + '.md';
    const offenders = listFiles(siteRoot).filter((file) => file.split(/[\\/]/).at(-1) === blocked);

    expect(offenders).toEqual([]);
  });
});
