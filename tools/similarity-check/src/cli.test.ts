import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for assertions that do not depend on the stream. */
  output: string;
}

/** Environment without the GIT_* variables that a hook would leak into the child process. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function runCli(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** A new temp working directory holding `files` (relative POSIX path -> content). */
function setup(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'similarity-'));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

function summary(checked: number, corpusFiles: number, minWords: number, matches: number): string {
  return `checked ${checked} files against ${corpusFiles} corpus files (min ${minWords} words): ${matches} matches`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The line of one match. The corpus file is exact (relative, `/`-separated); in the target path
 * either separator is accepted, because the spec fixes only the corpus side.
 */
function matchLine(
  file: string,
  line: number,
  length: number,
  corpusFile: string,
  corpusLine: number,
  matched: string,
): RegExp {
  const path = file.split('/').map(escapeRegExp).join('[\\\\/]');
  return new RegExp(
    `^${path}:${line}: ${length} words shared with ${escapeRegExp(corpusFile)}:${corpusLine}: "${escapeRegExp(matched)}"\\r?$`,
    'm',
  );
}

// Invented text only.
const RUN = 'lemon tarts cool slowly beside the quiet harbour window';
const RUN_SIX = 'lemon tarts cool slowly beside the';
const CORPUS_TEXT = [
  'Bakery notes for the zanzibarline harbour town.',
  `preamble ${RUN} postscript`,
  'Nothing else is written in this file.',
].join('\n');
const CLEAN_TEXT = 'The morning bakers sell rye loaves and seeded rolls at the market stall.';
const PAGE = ['# Harbour bakery', '', `Our visit notes say that ${RUN} today.`, ''].join('\n');

const CORPUS_FILES = {
  'corpus/guide/bakery.txt': CORPUS_TEXT,
  'corpus/guide/.gitkeep': '',
};

describe('similarity-check CLI', () => {
  test('AC-9: with no shared run it prints the summary with 0 matches and exits 0', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'corpus/notes.md': 'Invented notes about weather and kites.\nNothing to see here, really.',
      'corpus/data.json': '{}',
      'docs/a.md': CLEAN_TEXT,
      'docs/sub/b.txt': 'A second page about fresh bread and the early train.',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'docs']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(2, 2, 8, 0));
  });

  test('AC-9: a seven-word shared run is below the default minimum and prints 0 matches', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'docs/a.md': 'Fresh lemon tarts cool slowly beside the quiet garden gate.',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'docs']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-10: a shared run prints the match line and the summary and exits 1', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': PAGE });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:3: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-10: the matched words are printed normalised (lower case, no punctuation)', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md': 'Notes: Lemon Tarts, cool slowly -- beside the QUIET harbour window!',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:1: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-10: a sentence wrapped over two lines is reported at the line where it starts', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md':
        'Intro line.\n\nOur notes say that lemon tarts cool slowly\nbeside the quiet harbour window today.\n',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:3: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-10: a match in a file of a target folder names the file below the folder', () => {
    const dir = setup({ ...CORPUS_FILES, 'docs/deep/page.md': PAGE });

    const run = runCli(dir, ['--corpus', 'corpus', 'docs']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(matchLine('docs/deep/page.md', 3, 9, 'guide/bakery.txt', 2, RUN));
  });

  test('AC-10: two matches in one file are printed in line order, one line each', () => {
    const dir = setup({
      'corpus/a.txt': `${RUN}\nfiller words here\nrye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8`,
      'page.md': 'rye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8\n\nmiddle text\n' + RUN + '\n',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    const found = lines(run.output).filter((line) => line.includes(' words shared with '));
    expect(found).toEqual([
      'page.md:1: 8 words shared with a.txt:3: "rye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8"',
      `page.md:4: 9 words shared with a.txt:1: "${RUN}"`,
    ]);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 2));
  });

  test('AC-10: matches in two files are all printed and counted', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'docs/one.md': PAGE,
      'docs/two.yaml': `id: x\nstem: Which ${RUN} again?\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'docs']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(matchLine('docs/one.md', 3, 9, 'guide/bakery.txt', 2, RUN));
    expect(run.output).toMatch(matchLine('docs/two.yaml', 2, 9, 'guide/bakery.txt', 2, RUN));
    expect(lines(run.output)).toContain(summary(2, 1, 8, 2));
  });

  test('AC-11: with no path it checks the docs and questions folders, and only those', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'apps/site/src/content/docs/d1/page.md': PAGE,
      'questions/d1/q.yaml': `id: x\nstem: Which ${RUN} again?\n`,
      'other/ignored.md': PAGE,
    });

    const run = runCli(dir, ['--corpus', 'corpus']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(
      matchLine('apps/site/src/content/docs/d1/page.md', 3, 9, 'guide/bakery.txt', 2, RUN),
    );
    expect(run.output).toMatch(matchLine('questions/d1/q.yaml', 2, 9, 'guide/bakery.txt', 2, RUN));
    expect(run.output).not.toContain('ignored.md');
    expect(lines(run.output)).toContain(summary(2, 1, 8, 2));
  });

  test('AC-11: a missing default folder is skipped silently', () => {
    const dir = setup({ ...CORPUS_FILES, 'questions/d1/q.yaml': 'id: x\nstem: Clean text.\n' });

    const run = runCli(dir, ['--corpus', 'corpus']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
    expect(run.output).not.toMatch(/apps|docs/);
  });

  test('AC-11: with neither default folder it checks nothing and exits 0', () => {
    const dir = setup({ ...CORPUS_FILES });

    const run = runCli(dir, ['--corpus', 'corpus']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(0, 1, 8, 0));
  });

  test('AC-11: with paths it checks only those, files and folders, recursively', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'solo.md': PAGE,
      'tree/a/b/deep.txt': PAGE,
      'tree/clean.md': CLEAN_TEXT,
      'unlisted.md': PAGE,
      'apps/site/src/content/docs/default.md': PAGE,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'solo.md', 'tree']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(matchLine('solo.md', 3, 9, 'guide/bakery.txt', 2, RUN));
    expect(run.output).toMatch(matchLine('tree/a/b/deep.txt', 3, 9, 'guide/bakery.txt', 2, RUN));
    expect(run.output).not.toContain('unlisted.md');
    expect(run.output).not.toContain('default.md');
    expect(lines(run.output)).toContain(summary(3, 1, 8, 2));
  });

  test.each(['md', 'mdx', 'yaml', 'yml', 'txt'])('AC-12: a .%s target is read', (extension) => {
    const dir = setup({ ...CORPUS_FILES, [`target.${extension}`]: PAGE });

    const run = runCli(dir, ['--corpus', 'corpus', `target.${extension}`]);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(matchLine(`target.${extension}`, 3, 9, 'guide/bakery.txt', 2, RUN));
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-12: a given .ts file and .png are ignored and not counted as checked', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md': CLEAN_TEXT,
      'script.ts': `export const text = '${RUN}';\n`,
      'image.png': Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
        Buffer.from(` ${RUN} `),
      ]),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md', 'script.ts', 'image.png']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-12: other files inside a target folder are ignored too', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'docs/page.md': CLEAN_TEXT,
      'docs/script.ts': `export const text = '${RUN}';\n`,
      'docs/data.json': `{ "text": "${RUN}" }`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'docs']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-13: corpus files are the .txt and .md files under --corpus, recursively', () => {
    const first = 'rye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8';
    const second = 'oat1 oat2 oat3 oat4 oat5 oat6 oat7 oat8';
    const third = 'corn1 corn2 corn3 corn4 corn5 corn6 corn7 corn8';
    const fourth = 'bean1 bean2 bean3 bean4 bean5 bean6 bean7 bean8';
    const dir = setup({
      'corpus/a.txt': first,
      'corpus/deep/er/b.md': second,
      'corpus/c.json': third,
      'corpus/d.yaml': fourth,
      'corpus/.gitkeep': '',
      'page.md': [first, second, third, fourth].join('\n\nspacer words\n\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(`page.md:1: 8 words shared with a.txt:1: "${first}"`);
    expect(lines(run.output)).toContain(
      `page.md:5: 8 words shared with deep/er/b.md:1: "${second}"`,
    );
    expect(run.output).not.toContain('corn1');
    expect(run.output).not.toContain('bean1');
    expect(lines(run.output)).toContain(summary(1, 2, 8, 2));
  });

  test('AC-13: the default corpus folder is private/similarity-corpus below the current directory', () => {
    const dir = setup({
      'private/similarity-corpus/notes.txt': CORPUS_TEXT,
      'page.md': PAGE,
    });

    const run = runCli(dir, ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(`page.md:3: 9 words shared with notes.txt:2: "${RUN}"`);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-14: a missing corpus folder prints "no corpus at <dir>" and exits 1', () => {
    const dir = setup({ 'page.md': PAGE });

    const run = runCli(dir, ['--corpus', 'nowhere', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('no corpus at nowhere');
    expect(run.output).not.toContain('similarity check skipped');
    expect(run.output).not.toContain('words shared with');
  });

  test('AC-14: the default folder is named when it is missing', () => {
    const dir = setup({ 'page.md': PAGE });

    const run = runCli(dir, ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('no corpus at private/similarity-corpus');
  });

  test.each([
    ['only a .gitkeep', { 'corpus/.gitkeep': '' }],
    ['only other files', { 'corpus/data.json': '{}', 'corpus/table.yaml': 'a: 1' }],
    ['only a .gitkeep in a subfolder', { 'corpus/sub/.gitkeep': '' }],
    ['no files at all', {}],
  ])('AC-14: a corpus folder with %s has no corpus', (_label, files) => {
    const dir = setup({ 'page.md': PAGE, ...files });
    mkdirSync(join(dir, 'corpus'), { recursive: true });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('no corpus at corpus');
    expect(run.output).not.toContain('similarity check skipped');
  });

  test('AC-15: --skip-without-corpus with a missing corpus prints the skip notice and exits 0', () => {
    const dir = setup({ 'page.md': PAGE });

    const run = runCli(dir, ['--skip-without-corpus', '--corpus', 'nowhere', 'page.md']);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('no corpus at nowhere, similarity check skipped');
  });

  test('AC-15: --skip-without-corpus with only a .gitkeep in the corpus folder also skips', () => {
    const dir = setup({ 'corpus/.gitkeep': '', 'page.md': PAGE });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md', '--skip-without-corpus']);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('no corpus at corpus, similarity check skipped');
  });

  test('AC-15: the default folder is named in the skip notice', () => {
    const dir = setup({});

    const run = runCli(dir, ['--skip-without-corpus', 'page.md']);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain(
      'no corpus at private/similarity-corpus, similarity check skipped',
    );
  });

  test('AC-15: without a corpus the targets are not read, so a missing target is no error', () => {
    const dir = setup({});

    const run = runCli(dir, ['--skip-without-corpus', '--corpus', 'nowhere', 'does-not-exist.md']);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('no corpus at nowhere, similarity check skipped');
    expect(run.output).not.toContain('does-not-exist.md');
  });

  test('AC-15: with a corpus the flag changes nothing (match found, same lines, exit 1)', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': PAGE });

    const without = runCli(dir, ['--corpus', 'corpus', 'page.md']);
    const withFlag = runCli(dir, ['--corpus', 'corpus', '--skip-without-corpus', 'page.md']);

    expect(without.status, without.output).toBe(1);
    expect(withFlag.status, withFlag.output).toBe(1);
    expect(lines(withFlag.output)).toEqual(lines(without.output));
    expect(lines(withFlag.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-15: with a corpus the flag changes nothing (clean target, exit 0)', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': CLEAN_TEXT });

    const run = runCli(dir, ['--corpus', 'corpus', '--skip-without-corpus', 'page.md']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-15: with a corpus the flag still reads targets (a missing target is exit 2)', () => {
    const dir = setup({ ...CORPUS_FILES });

    const run = runCli(dir, ['--corpus', 'corpus', '--skip-without-corpus', 'missing.md']);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain('missing.md');
  });

  test('AC-16: --min-words 5 reports a 6-word shared run that the default minimum does not', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md': `Fresh ${RUN_SIX} oven door.\n`,
    });

    const byDefault = runCli(dir, ['--corpus', 'corpus', 'page.md']);
    const lowered = runCli(dir, ['--corpus', 'corpus', 'page.md', '--min-words', '5']);

    expect(byDefault.status, byDefault.output).toBe(0);
    expect(lines(byDefault.output)).toContain(summary(1, 1, 8, 0));
    expect(lowered.status, lowered.output).toBe(1);
    expect(lines(lowered.output)).toContain(
      `page.md:1: 6 words shared with guide/bakery.txt:2: "${RUN_SIX}"`,
    );
    expect(lines(lowered.output)).toContain(summary(1, 1, 5, 1));
  });

  test('AC-16: the lowest allowed minimum (3) is accepted and used', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': 'Fresh lemon tarts cool oven door.\n' });

    const run = runCli(dir, ['--min-words', '3', '--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(summary(1, 1, 3, 1));
  });

  test.each([
    ['2 (below 3)', ['--min-words', '2']],
    ['0', ['--min-words', '0']],
    ['3.5 (not an integer)', ['--min-words', '3.5']],
    ['abc (not a number)', ['--min-words', 'abc']],
    ['an empty value', ['--min-words', '']],
    ['a missing value at the end', ['--min-words']],
    ['a flag instead of the value', ['--min-words', '--skip-without-corpus']],
  ])('AC-17: --min-words with %s is a usage error', (_label, args) => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': CLEAN_TEXT });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md', ...args]);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('--min-words');
    expect(run.output).not.toContain('checked');
  });

  test('AC-17: --corpus without its value is a usage error', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': CLEAN_TEXT });

    const atEnd = runCli(dir, ['page.md', '--corpus']);
    const beforeFlag = runCli(dir, ['--corpus', '--skip-without-corpus', 'page.md']);

    for (const run of [atEnd, beforeFlag]) {
      expect(run.status, run.output).toBe(2);
      expect(run.output).toMatch(/usage/i);
      expect(run.output).toContain('--corpus');
    }
  });

  test.each(['--bogus', '-x', '--min-word'])(
    'AC-17: the unknown flag %s is a usage error that prints the usage text',
    (flag) => {
      const dir = setup({ ...CORPUS_FILES, 'page.md': CLEAN_TEXT });

      const run = runCli(dir, ['--corpus', 'corpus', flag, 'page.md']);

      expect(run.status, run.output).toBe(2);
      expect(run.output).toMatch(/usage/i);
      expect(run.output).toContain('--skip-without-corpus');
      expect(run.output).not.toContain('checked');
    },
  );

  test('AC-17: a usage error wins over a missing corpus', () => {
    const dir = setup({});

    const run = runCli(dir, ['--bogus']);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toMatch(/usage/i);
  });

  test('AC-18: a target path that does not exist is an error naming it (exit 2)', () => {
    const dir = setup({ ...CORPUS_FILES });

    const run = runCli(dir, ['--corpus', 'corpus', 'missing-page.md']);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain('missing-page.md');
  });

  test('AC-18: a missing target folder is named too, even next to a good target', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': PAGE });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md', 'no-such-folder']);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain('no-such-folder');
  });

  test('AC-19: only the matched words are printed, never the corpus text around them', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.md': PAGE });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(RUN);
    expect(run.output).not.toContain('preamble');
    expect(run.output).not.toContain('postscript');
    expect(run.output).not.toContain('zanzibarline');
    expect(run.output).not.toContain('Nothing else is written');
  });

  test('AC-19: the corpus file is named relative to the corpus folder, with / separators', () => {
    const dir = setup({
      'corpus/guide/deep/bakery.txt': CORPUS_TEXT,
      'page.md': PAGE,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:3: 9 words shared with guide/deep/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-19: an absolute corpus folder does not leak into the corpus file name', () => {
    const dir = setup({ 'corpus/guide/bakery.txt': CORPUS_TEXT, 'page.md': PAGE });

    const run = runCli(dir, ['--corpus', join(dir, 'corpus'), 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:3: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
    expect(run.output).not.toContain(dir);
  });
});

// Review round 1 (regression ACs).

/** Adds files (relative POSIX path -> content) below an existing directory. */
function addFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: cleanEnv(), encoding: 'utf8', windowsHide: true },
  );
  expect(result.status, `git ${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0);
}

/** A git checkout whose private/similarity-corpus (untracked, like the real one) holds x.txt. */
function makeMainCheckout(): string {
  const main = setup({
    'private/similarity-corpus/x.txt': CORPUS_TEXT,
    'README.md': 'main checkout\n',
  });
  git(main, ['init', '-q']);
  git(main, ['add', 'README.md']);
  git(main, ['commit', '-q', '--no-verify', '-m', 'init']);
  return main;
}

function addWorktree(main: string, relativePath: string, branch: string): string {
  const path = join(main, ...relativePath.split('/'));
  git(main, ['worktree', 'add', '-q', path, '-b', branch]);
  return path;
}

const MATCH_IN_X = `page.md:3: 9 words shared with x.txt:2: "${RUN}"`;

describe('default corpus location (review round 1)', () => {
  test('AC-22: a linked worktree inside the main checkout uses the main checkout corpus', () => {
    const main = makeMainCheckout();
    const linked = addWorktree(main, 'wt', 't1');
    addFiles(linked, { 'page.md': PAGE });

    const run = runCli(linked, ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(MATCH_IN_X);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-22: a worktree nested under .claude/worktrees uses the main checkout corpus', () => {
    const main = makeMainCheckout();
    const linked = addWorktree(main, '.claude/worktrees/w', 't2');
    addFiles(linked, { 'page.md': PAGE });

    const run = runCli(linked, ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(MATCH_IN_X);
  });

  test('AC-22: a subfolder of a linked worktree uses the main checkout corpus too', () => {
    const main = makeMainCheckout();
    const linked = addWorktree(main, 'wt', 't3');
    addFiles(linked, { 'sub/deep/page.md': PAGE });

    const run = runCli(join(linked, 'sub', 'deep'), ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(MATCH_IN_X);
  });

  test('AC-22: the main checkout itself, from a subfolder, uses its own corpus', () => {
    const main = makeMainCheckout();
    addFiles(main, { 'sub/page.md': PAGE });

    const run = runCli(join(main, 'sub'), ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(MATCH_IN_X);
  });

  test('AC-22: a corpus folder inside the linked worktree is not the default (the main one is)', () => {
    const main = makeMainCheckout();
    const linked = addWorktree(main, 'wt', 't4');
    addFiles(linked, {
      'private/similarity-corpus/z.txt': 'rye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8',
      'page.md': `${PAGE}\nrye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8\n`,
    });

    const run = runCli(linked, ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(MATCH_IN_X);
    expect(run.output).not.toContain('z.txt');
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-22: outside any git repository the default is private/similarity-corpus below the cwd', () => {
    const dir = setup({
      'private/similarity-corpus/x.txt': CORPUS_TEXT,
      'page.md': PAGE,
    });

    const run = runCli(dir, ['page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(MATCH_IN_X);
  });

  test('AC-22: --corpus overrides the main checkout corpus inside a linked worktree', () => {
    const main = makeMainCheckout();
    const linked = addWorktree(main, 'wt', 't5');
    const other = 'rye1 rye2 rye3 rye4 rye5 rye6 rye7 rye8';
    addFiles(linked, {
      'own/y.txt': other,
      'page.md': `${PAGE}\n${other}\n`,
    });

    const run = runCli(linked, ['--corpus', 'own', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(`page.md:5: 8 words shared with y.txt:1: "${other}"`);
    expect(run.output).not.toContain('x.txt');
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-22: --corpus naming a missing folder in a linked worktree does not fall back to the main one', () => {
    const main = makeMainCheckout();
    const linked = addWorktree(main, 'wt', 't6');
    addFiles(linked, { 'page.md': PAGE });

    const run = runCli(linked, ['--corpus', 'nowhere', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('no corpus at nowhere');
    expect(run.output).not.toContain('words shared with');
  });
});

describe('corpus file encodings (review round 1)', () => {
  const BOM_CHAR = String.fromCodePoint(0xfeff);

  test('AC-23: a UTF-16 LE corpus file with a BOM is decoded and matches', () => {
    const dir = setup({
      'corpus/utf16le.txt': Buffer.from(BOM_CHAR + CORPUS_TEXT, 'utf16le'),
      'page.md': PAGE,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(`page.md:3: 9 words shared with utf16le.txt:2: "${RUN}"`);
  });

  test('AC-23: a UTF-16 BE corpus file with a BOM is decoded and matches', () => {
    const dir = setup({
      'corpus/sub/utf16be.md': Buffer.from(BOM_CHAR + CORPUS_TEXT, 'utf16le').swap16(),
      'page.md': PAGE,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:3: 9 words shared with sub/utf16be.md:2: "${RUN}"`,
    );
  });

  test('AC-23: UTF-8 text with non-ASCII letters is a valid corpus file', () => {
    const sentence = 'the café on harbour street sells rye bread every single morning';
    const dir = setup({
      'corpus/cafe.txt': `Notes\n${sentence}\n`,
      'page.md': `Visit: ${sentence}!\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:1: 11 words shared with cafe.txt:2: "${sentence}"`,
    );
  });

  test('AC-23: a corpus file with NUL bytes fails the run, naming the file with / separators', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'corpus/bin/data.txt': Buffer.from('some text\u0000more text here'),
      'page.md': CLEAN_TEXT,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('corpus file bin/data.txt is not UTF-8');
  });

  test('AC-23: a corpus file with invalid UTF-8 bytes in the middle fails the run', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'corpus/broken.md': Buffer.concat([
        Buffer.from('fine text before '),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(' and after'),
      ]),
      'page.md': CLEAN_TEXT,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('corpus file broken.md is not UTF-8');
  });

  test('AC-23: a lone 0x93 byte (a cp1252 quote) is not UTF-8 and fails the run', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'corpus/legacy/quotes.txt': Buffer.concat([
        Buffer.from('he said '),
        Buffer.from([0x93]),
        Buffer.from('hello there my friend'),
      ]),
      'page.md': CLEAN_TEXT,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('corpus file legacy/quotes.txt is not UTF-8');
  });
});

describe('Markdown links and entities (review round 1)', () => {
  const LINKED = [
    '# Notes',
    '',
    `Our visit notes say that [lemon tarts cool slowly](https://example.com/some/long/path) beside the quiet harbour window today.`,
    '',
  ].join('\n');

  test.each(['md', 'mdx'])(
    'AC-25: a link target inside a copied run does not break it in a .%s target',
    (ext) => {
      const dir = setup({ ...CORPUS_FILES, [`page.${ext}`]: LINKED });

      const run = runCli(dir, ['--corpus', 'corpus', `page.${ext}`]);

      expect(run.status, run.output).toBe(1);
      expect(lines(run.output)).toContain(
        `page.${ext}:3: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
      );
    },
  );

  test('AC-25: the link text is kept and the line numbers stay right after a link', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md': [
        '# Notes',
        '',
        'See [the docs](https://example.com/a/b/c) for more.',
        '',
        'Our notes say that [lemon tarts cool slowly](https://example.com/x/y/z) beside the quiet harbour window today.',
        '',
      ].join('\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:5: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-25: a run starting on the line of a link and wrapped to the next line is reported there', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md': [
        '# Notes',
        '',
        'Our notes say that [lemon tarts cool slowly](https://example.com/x/y/z)',
        'beside the quiet harbour window today.',
        '',
      ].join('\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:3: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test.each([
    ['&rsquo;', 'baker&rsquo;s'],
    ['&#8217;', 'baker&#8217;s'],
  ])('AC-25: the entity %s inside a run does not break it', (_label, baker) => {
    const dir = setup({
      'corpus/shop.txt': `Intro\npreamble the baker’s lemon tarts cool slowly beside the quiet harbour window postscript`,
      'page.md': `Notes: the ${baker} lemon tarts cool slowly beside the quiet harbour window today.\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      'page.md:1: 11 words shared with shop.txt:2: "the bakers lemon tarts cool slowly beside the quiet harbour window"',
    );
  });

  test('AC-25: a &nbsp; entity between words does not break the run', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.md': `Our notes say that lemon tarts cool &nbsp; slowly beside the quiet harbour window today.\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:1: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-25: links and entities are removed from .md corpus files too', () => {
    const dir = setup({
      'corpus/notes.md': [
        'First line.',
        '',
        `preamble our [lemon tarts cool slowly](https://example.org/x/y/z) beside the quiet &nbsp; harbour window postscript`,
        '',
      ].join('\n'),
      'page.txt': `Our notes say that\n${RUN} today.\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.txt']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(`page.txt:2: 9 words shared with notes.md:3: "${RUN}"`);
  });

  test('AC-25: a .txt target is not stripped, so the words of a link target stay and break the run', () => {
    const dir = setup({ ...CORPUS_FILES, 'page.txt': LINKED });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.txt']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-25: a .yaml target is not stripped either', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'page.yaml': `id: x\nstem: Our notes say that lemon tarts cool &nbsp; slowly beside the quiet harbour window\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.yaml']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-25: in a .txt target the link words are real words and match a corpus that has them', () => {
    const dir = setup({
      'corpus/links.txt':
        'preamble [lemon tarts cool slowly](https://example.com/some/path) beside the quiet harbour window postscript',
      'page.txt':
        'Notes [lemon tarts cool slowly](https://example.com/some/path) beside the quiet harbour window today.\n',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.txt']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      'page.txt:1: 14 words shared with links.txt:1: "lemon tarts cool slowly https example com some path beside the quiet harbour window"',
    );
  });
});

// Spec 024: URLs in YAML targets. The AC ids below are spec 024's, not spec 021's.
describe('spec 024 URLs in YAML targets', () => {
  const URL_ONE = 'https://example.com/guide/storage/latest/userguide/buckets-overview.html';
  const URL_TWO = 'https://example.com/guide/storage/latest/userguide/lifecycle-rules.html';
  const URL_WORDS =
    'https example com guide storage latest userguide buckets overview html https example com guide storage latest userguide lifecycle rules html';
  const URL_WORD_COUNT = 20;
  /** A corpus file that cites the same two pages next to each other. */
  const DOCS_CORPUS = {
    'corpus/docs.txt': `Further reading\nsee ${URL_ONE} ${URL_TWO} for details\nEnd of the list.\n`,
  };
  const REFERENCES = ['references:', `  - ${URL_ONE}`, `  - ${URL_TWO}`];

  test.each(['yaml', 'yml'])(
    'AC-4: doc URLs shared with the corpus are not reported in a .%s target',
    (ext) => {
      const dir = setup({
        ...DOCS_CORPUS,
        [`question.${ext}`]: ['id: q-001', ...REFERENCES, ''].join('\n'),
      });

      const run = runCli(dir, ['--corpus', 'corpus', `question.${ext}`]);

      expect(run.status, run.output).toBe(0);
      expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
    },
  );

  test('AC-4: the same URLs in the target and the corpus do not count even with other fields around', () => {
    const dir = setup({
      ...DOCS_CORPUS,
      'question.yaml': [
        'id: q-001',
        `stem: ${CLEAN_TEXT}`,
        ...REFERENCES,
        'explanation: Seeded rolls stay fresh for two days in a paper bag.',
        '',
      ].join('\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'question.yaml']);

    expect(run.status, run.output).toBe(0);
    expect(lines(run.output)).toContain(summary(1, 1, 8, 0));
  });

  test('AC-5: a copied sentence after the URL lines is still reported at its own line', () => {
    const dir = setup({
      ...CORPUS_FILES,
      ...DOCS_CORPUS,
      'question.yaml': [
        'id: q-001',
        ...REFERENCES,
        `why: "Our visit notes say that ${RUN} today."`,
        '',
      ].join('\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'question.yaml']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `question.yaml:5: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
    expect(lines(run.output)).toContain(summary(1, 2, 8, 1));
  });

  test('AC-5: a copied sentence before the URL lines is reported on its line and not extended', () => {
    const dir = setup({
      ...CORPUS_FILES,
      ...DOCS_CORPUS,
      'question.yml': [`why: "Our visit notes say that ${RUN} today."`, ...REFERENCES, ''].join(
        '\n',
      ),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'question.yml']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `question.yml:1: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
    expect(lines(run.output)).toContain(summary(1, 2, 8, 1));
  });

  test('AC-6: a copied sentence with a URL in the middle is reported as one run', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'question.yaml': [
        'id: q-001',
        'why: "lemon tarts cool slowly https://example.com/a beside the quiet harbour window"',
        '',
      ].join('\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'question.yaml']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `question.yaml:2: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-6: the same holds for a .yml target', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'question.yml':
        'why: "lemon tarts cool slowly https://example.com/a?x=1#top beside the quiet harbour window"\n',
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'question.yml']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `question.yml:1: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-6: a URL on a line of its own inside a copied block still joins the two halves', () => {
    const dir = setup({
      ...CORPUS_FILES,
      'question.yaml': [
        'why: |',
        '  lemon tarts cool slowly',
        '  https://example.com/a',
        '  beside the quiet harbour window',
        '',
      ].join('\n'),
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'question.yaml']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `question.yaml:2: 9 words shared with guide/bakery.txt:2: "${RUN}"`,
    );
  });

  test('AC-7: a .txt target keeps the words of a URL shared with a .txt corpus line', () => {
    const dir = setup({
      ...DOCS_CORPUS,
      'page.txt': `Notes\nrefs ${URL_ONE} ${URL_TWO} here\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.txt']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.txt:2: ${URL_WORD_COUNT} words shared with docs.txt:2: "${URL_WORDS}"`,
    );
    expect(lines(run.output)).toContain(summary(1, 1, 8, 1));
  });

  test('AC-7: a URL that is plain text in a .md target keeps its words too', () => {
    const dir = setup({
      ...DOCS_CORPUS,
      'page.md': `Notes\nrefs ${URL_ONE} ${URL_TWO} here\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.md']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.md:2: ${URL_WORD_COUNT} words shared with docs.txt:2: "${URL_WORDS}"`,
    );
  });

  test('AC-7: the corpus is never URL-stripped, so a .txt target with the same URLs matches it', () => {
    const dir = setup({
      'corpus/docs.md': `Further reading\nsee ${URL_ONE} ${URL_TWO} for details\n`,
      'page.txt': `refs ${URL_ONE} ${URL_TWO} here\n`,
    });

    const run = runCli(dir, ['--corpus', 'corpus', 'page.txt']);

    expect(run.status, run.output).toBe(1);
    expect(lines(run.output)).toContain(
      `page.txt:1: ${URL_WORD_COUNT} words shared with docs.md:2: "${URL_WORDS}"`,
    );
  });
});
