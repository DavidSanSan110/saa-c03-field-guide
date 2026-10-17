import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

interface Job {
  name?: string;
  run?: string;
  glob?: string | string[];
}

interface Lefthook {
  [hook: string]: { jobs?: Job[] } | undefined;
}

interface RootPackage {
  scripts?: Record<string, string>;
}

const lefthook = parse(readFileSync(join(REPO_ROOT, 'lefthook.yml'), 'utf8')) as Lefthook;
const rootPackage = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
) as RootPackage;

/** Expands the (possibly nested) `{a,b}` alternatives of a glob into plain globs. */
function expandBraces(glob: string): string[] {
  const found = /^(.*?)\{([^{}]*)\}(.*)$/.exec(glob);
  if (found === null) return [glob];
  const [, before = '', alternatives = '', after = ''] = found;
  return alternatives
    .split(',')
    .flatMap((alternative) => expandBraces(`${before}${alternative}${after}`));
}

/** Whether a Lefthook glob (such as `*.{md,txt}`) selects a file with this name. */
function globCovers(glob: string | string[] | undefined, fileName: string): boolean {
  const globs = typeof glob === 'string' ? [glob] : (glob ?? []);
  return globs.flatMap(expandBraces).some((pattern) => {
    const last = pattern.slice(pattern.lastIndexOf('/') + 1);
    return last.startsWith('*') && fileName.endsWith(last.slice(1));
  });
}

describe('package.json and lefthook.yml', () => {
  const job = (lefthook['pre-commit']?.jobs ?? []).find(
    (candidate) => candidate.name === 'similarity-check',
  );

  test('AC-20: the root package.json has a similarity-check script that runs this CLI', () => {
    const script = rootPackage.scripts?.['similarity-check'];

    expect(script).toBeDefined();
    expect(script).toContain('tools/similarity-check/src/cli.ts');
  });

  test('AC-20: lefthook.yml has a pre-commit job named similarity-check', () => {
    expect(job).toBeDefined();
  });

  test('AC-20: the job runs the CLI with --skip-without-corpus on the staged files', () => {
    expect(job?.run).toContain('similarity-check --skip-without-corpus {staged_files}');
  });

  test.each(['md', 'mdx', 'yaml', 'yml', 'txt'])('AC-20: the job glob covers .%s files', (ext) => {
    expect(globCovers(job?.glob, `page.${ext}`), JSON.stringify(job?.glob)).toBe(true);
  });

  test('AC-20: CI never runs the check (no workflow mentions it)', () => {
    const dir = join(REPO_ROOT, '.github', 'workflows');
    const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

    expect(workflows.length).toBeGreaterThan(0);
    for (const name of workflows) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('similarity-check');
    }
  });
});

describe('public sources', () => {
  const sources = readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));

  test('AC-21: the sources mention the corpus folder only as the default path, never a file in it', () => {
    const mentions = sources.flatMap(({ name, text }) =>
      [...text.matchAll(/.{0,20}similarity-corpus.{0,1}/g)].map((found) => ({
        name,
        context: found[0],
      })),
    );

    expect(mentions.length, 'the default corpus path private/similarity-corpus').toBeGreaterThan(0);
    for (const { name, context } of mentions) {
      expect(context, name).toMatch(/private\/similarity-corpus[^/\w.-]?$/);
    }
  });
});
