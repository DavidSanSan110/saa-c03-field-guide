import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { variant } from './__mocks__/dedupe-fixtures.ts';
import { questionYaml } from './__mocks__/fixtures.ts';

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

/** Environment without the GIT_* variables that a hook would leak into the temp directories. */
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

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, path: string, content: string | Buffer): void {
  const full = join(dir, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(dir: string, path: string): Buffer {
  return readFileSync(join(dir, ...path.split('/')));
}

function exists(dir: string, path: string): boolean {
  return existsSync(join(dir, ...path.split('/')));
}

/** A sidecar (or any YAML file) read back as a plain value. */
function readYaml(dir: string, path: string): unknown {
  return parse(read(dir, path).toString('utf8'));
}

/** Every file (as hex bytes) and folder under `dir`, to prove that nothing was written or deleted. */
function snapshot(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        tree[`${path}/`] = '<dir>';
        walk(path);
      } else {
        tree[path] = readFileSync(join(dir, path)).toString('hex');
      }
    }
  };
  walk('');
  return tree;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DRAFTS = 'private/questions-drafts';
const BANK = 'questions';

/** A schema-valid question file at its correct path inside `folder`. Returns the path in the folder. */
function put(
  dir: string,
  folder: string,
  id: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): string {
  const parts = /^d(\d)-(\d\.\d)-/.exec(id);
  const path = `d${parts?.[1] ?? '1'}/${parts?.[2] ?? '1.3'}/${slug}.yaml`;
  write(dir, `${folder}/${path}`, questionYaml({ id, ...overrides }));
  return path;
}

/** A question of `group` (see `variant`): the same group and member give identical text. */
function putVariant(
  dir: string,
  folder: string,
  id: string,
  slug: string,
  group: string,
  member: string,
  options: { common?: number; status?: string } = {},
): string {
  const { common = 7, status } = options;
  const extra = status === undefined ? {} : { status };
  return put(dir, folder, id, slug, { ...variant(group, member, common), ...extra });
}

/** The sidecar path of a question path: d1/1.3/x.yaml → d1/1.3/x.check.yaml. */
function sidecar(path: string): string {
  return path.replace(/\.yaml$/, '.check.yaml');
}

interface PairLine {
  score: string;
  draftId: string;
  draftPath: string;
  otherId: string;
  otherPath: string;
}

/** The flagged-pair lines: `<score> <draft id> <drafts>/<path> ~ <other id> <folder>/<path>`. */
function pairLines(run: Run): PairLine[] {
  return lines(run.output)
    .filter((line) => line.includes(' ~ '))
    .map((line) => {
      const match = /^(\S+) (\S+) (\S+) ~ (\S+) (\S+)$/.exec(line.trim());
      if (match === null) throw new Error(`not a pair line: ${line}`);
      const [, score = '', draftId = '', draftPath = '', otherId = '', otherPath = ''] = match;
      return { score, draftId, draftPath, otherId, otherPath };
    });
}

/** `<kind>/<path>` where the folder is the literal kind (`drafts`, `bank`) or the folder as given. */
function printedPath(path: string, ...folders: string[]): RegExp {
  return new RegExp(`^(?:${folders.map(escapeRe).join('|')})/${escapeRe(path)}$`);
}

const IN_DRAFTS = ['drafts', DRAFTS];
const IN_BANK = ['bank', BANK];

/** The summary line: `pairs: <n> flagged of <m> compared (threshold <t>)`. */
function summaryOf(flagged: number, compared: number, threshold = 0.5): RegExp {
  return new RegExp(
    `pairs: ${String(flagged)} flagged of ${String(compared)} compared \\(threshold ${escapeRe(String(threshold))}(?:\\.0+)?0*\\)`,
  );
}

describe('dedupe report', () => {
  test('AC-13: no similar questions: 0 flagged, the number of compared pairs, exit 0', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'one', 'alpha', 'a', { status: 'draft' });
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'two', 'bravo', 'a', { status: 'verified' });
    putVariant(dir, BANK, 'd1-1.3-0003', 'three', 'charlie', 'a');
    putVariant(dir, BANK, 'd2-2.1-0001', 'four', 'delta', 'a');

    const run = runCli(dir, ['dedupe']);

    // 2 drafts x 2 bank questions + 1 pair of drafts.
    expect(run.output).toMatch(summaryOf(0, 5));
    expect(run.status).toBe(0);
    expect(pairLines(run)).toEqual([]);
  });

  test('AC-13: without any question the summary says 0 flagged of 0 compared', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['dedupe']);

    expect(run.output).toMatch(summaryOf(0, 0));
    expect(run.status).toBe(0);
  });

  test('AC-13: bank questions are not compared with each other', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'one', 'alpha', 'a');
    putVariant(dir, BANK, 'd1-1.3-0002', 'two', 'alpha', 'a');

    const run = runCli(dir, ['dedupe']);

    expect(run.output).toMatch(summaryOf(0, 0));
    expect(run.status).toBe(0);
  });

  test('AC-13: each pair of drafts is compared once', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'one', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'two', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0003', 'three', 'alpha', 'a');

    const run = runCli(dir, ['dedupe']);

    expect(run.output).toMatch(summaryOf(3, 3));
    expect(pairLines(run)).toHaveLength(3);
    expect(run.status).toBe(1);
  });

  test('AC-13: rejected drafts and sidecars are not compared', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'live', 'alpha', 'a');
    putVariant(dir, BANK, 'd1-1.3-0002', 'bank', 'bravo', 'a');
    // An identical copy of the live draft in rejected/, and a sidecar that looks like a question.
    putVariant(dir, `${DRAFTS}/rejected`, 'd1-1.3-0003', 'old', 'alpha', 'a');
    write(dir, `${DRAFTS}/d1/1.3/live.check.yaml`, questionYaml({ id: 'd1-1.3-0004' }));

    const run = runCli(dir, ['dedupe']);

    expect(run.output).toMatch(summaryOf(0, 1));
    expect(run.status).toBe(0);
  });

  test('AC-14: a draft that copies a bank question prints the score, both ids and both paths, exit 1', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'copy', 'alpha', 'a', { status: 'draft' });

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    const found = pairLines(run);
    expect(found).toHaveLength(1);
    const [line] = found as [PairLine];
    expect(line.score).toMatch(/^1(\.0+)?$/);
    expect(line.draftId).toBe('d1-1.3-0002');
    expect(line.draftPath).toMatch(printedPath('d1/1.3/copy.yaml', ...IN_DRAFTS));
    expect(line.otherId).toBe('d1-1.3-0001');
    expect(line.otherPath).toMatch(printedPath('d1/1.3/original.yaml', ...IN_BANK));
    expect(run.output).toMatch(summaryOf(1, 1));
  });

  test('AC-14: a pair of drafts names the draft with the smaller id first, both under drafts', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0020', 'aaa-large-id', 'alpha', 'a', { common: 13 });
    putVariant(dir, DRAFTS, 'd1-1.3-0010', 'zzz-small-id', 'alpha', 'b', { common: 13 });

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    const [line] = pairLines(run) as [PairLine];
    expect(line.score).toBe('0.52');
    expect(line.draftId).toBe('d1-1.3-0010');
    expect(line.draftPath).toMatch(printedPath('d1/1.3/zzz-small-id.yaml', ...IN_DRAFTS));
    expect(line.otherId).toBe('d1-1.3-0020');
    expect(line.otherPath).toMatch(printedPath('d1/1.3/aaa-large-id.yaml', ...IN_DRAFTS));
  });

  test('AC-14: lines are sorted by score (high first), then by the two ids', () => {
    const dir = makeTempDir();
    // Score 0.52 (11 of 21 shingles), ids that do not follow the group order.
    putVariant(dir, BANK, 'd1-1.3-0001', 'alpha-bank', 'alpha', 'b', { common: 13 });
    putVariant(dir, DRAFTS, 'd1-1.3-0030', 'alpha-draft', 'alpha', 'a', { common: 13 });
    putVariant(dir, BANK, 'd1-1.3-0002', 'bravo-bank', 'bravo', 'b', { common: 13 });
    putVariant(dir, DRAFTS, 'd1-1.3-0020', 'bravo-draft', 'bravo', 'a', { common: 13 });
    // Score 1, one draft against two identical bank questions.
    putVariant(dir, BANK, 'd1-1.3-0003', 'charlie-bank', 'charlie', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0040', 'charlie-draft', 'charlie', 'a');
    putVariant(dir, BANK, 'd1-1.3-0009', 'echo-bank-nine', 'echo', 'a');
    putVariant(dir, BANK, 'd1-1.3-0007', 'echo-bank-seven', 'echo', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0050', 'echo-draft', 'echo', 'a');

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    expect(pairLines(run).map((line) => `${line.score} ${line.draftId} ${line.otherId}`)).toEqual([
      expect.stringMatching(/^1(\.0+)? d1-1\.3-0040 d1-1\.3-0003$/),
      expect.stringMatching(/^1(\.0+)? d1-1\.3-0050 d1-1\.3-0007$/),
      expect.stringMatching(/^1(\.0+)? d1-1\.3-0050 d1-1\.3-0009$/),
      '0.52 d1-1.3-0020 d1-1.3-0002',
      '0.52 d1-1.3-0030 d1-1.3-0001',
    ]);
    // 4 drafts x 5 bank questions + 6 pairs of drafts.
    expect(run.output).toMatch(summaryOf(5, 26));
  });

  test('AC-14: the score is printed rounded to 2 decimals', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b', { common: 13 });
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a', { common: 13 });

    const run = runCli(dir, ['dedupe']);

    // 11 of 21 shingles are shared: 0.5238...
    expect(pairLines(run).map((line) => line.score)).toEqual(['0.52']);
  });

  test('AC-14: a pair exactly at the threshold (10 of 20 shingles, 0.5) is flagged', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b', { common: 12 });
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a', { common: 12 });

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    expect(pairLines(run).map((line) => line.score)).toEqual([expect.stringMatching(/^0\.50?$/)]);
  });

  test('AC-14: a pair just below the threshold (9 of 19 shingles) is not flagged', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b', { common: 11 });
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a', { common: 11 });

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(0);
    expect(run.output).toMatch(summaryOf(0, 1));
  });
});

/**
 * Drafts and bank for the sidecar tests. Returns the draft paths.
 *  - alpha-copy: identical to bank alpha-orig (score 1) and 0.52 against alpha-near (not an id
 *    order: orig has the larger id);
 *  - bravo-1 and bravo-2: a pair of drafts (0.52);
 *  - charlie: no pair (in another domain folder);
 *  - delta: no pair, and a sidecar of its own with other keys and a stale dedupe key.
 */
const DELTA_SIDECAR = [
  'verification:',
  '  verified_by: claude',
  '  checks:',
  '    - { name: facts, ok: true }',
  'other: 3',
  'dedupe:',
  '  threshold: 0.9',
  '  similar:',
  '    - { id: stale, folder: bank, path: stale.yaml, score: 0.99 }',
  '',
].join('\n');

function sidecarScenario(
  dir: string,
): Record<'alpha' | 'bravo1' | 'bravo2' | 'charlie' | 'delta', string> {
  putVariant(dir, BANK, 'd1-1.3-0003', 'alpha-orig', 'alpha', 'a', { common: 13 });
  putVariant(dir, BANK, 'd1-1.3-0002', 'alpha-near', 'alpha', 'b', { common: 13 });
  const paths = {
    alpha: putVariant(dir, DRAFTS, 'd1-1.3-0030', 'alpha-copy', 'alpha', 'a', { common: 13 }),
    bravo1: putVariant(dir, DRAFTS, 'd1-1.3-0011', 'bravo-1', 'bravo', 'a', { common: 13 }),
    bravo2: putVariant(dir, DRAFTS, 'd1-1.3-0012', 'bravo-2', 'bravo', 'b', { common: 13 }),
    charlie: putVariant(dir, DRAFTS, 'd2-2.1-0004', 'charlie', 'charlie', 'a'),
    delta: putVariant(dir, DRAFTS, 'd1-1.3-0050', 'delta', 'delta', 'a'),
  };
  write(dir, `${DRAFTS}/${sidecar(paths.delta)}`, DELTA_SIDECAR);
  return paths;
}

describe('dedupe --write', () => {
  test('AC-15: without --write no sidecar is created or changed, even when pairs are flagged', () => {
    const dir = makeTempDir();
    sidecarScenario(dir);
    const before = snapshot(dir);

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    expect(pairLines(run).length).toBeGreaterThan(0);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-15: without --write nothing is written when no pair is flagged either', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'one', 'alpha', 'a');
    putVariant(dir, BANK, 'd1-1.3-0002', 'two', 'bravo', 'a');
    write(dir, `${DRAFTS}/d1/1.3/one.check.yaml`, 'keep: me\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-16: every draft gets its sidecar, with the similar questions of AC-9', () => {
    const dir = makeTempDir();
    const paths = sidecarScenario(dir);

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(1);
    const dedupeOf = (path: string): unknown =>
      (readYaml(dir, `${DRAFTS}/${sidecar(path)}`) as { dedupe: unknown }).dedupe;
    expect(dedupeOf(paths.alpha)).toEqual({
      threshold: 0.5,
      similar: [
        { id: 'd1-1.3-0003', folder: 'bank', path: 'd1/1.3/alpha-orig.yaml', score: 1 },
        { id: 'd1-1.3-0002', folder: 'bank', path: 'd1/1.3/alpha-near.yaml', score: 0.52 },
      ],
    });
    expect(dedupeOf(paths.bravo1)).toEqual({
      threshold: 0.5,
      similar: [{ id: 'd1-1.3-0012', folder: 'drafts', path: 'd1/1.3/bravo-2.yaml', score: 0.52 }],
    });
    expect(dedupeOf(paths.bravo2)).toEqual({
      threshold: 0.5,
      similar: [{ id: 'd1-1.3-0011', folder: 'drafts', path: 'd1/1.3/bravo-1.yaml', score: 0.52 }],
    });
  });

  test('AC-16: a draft with no flagged pair gets similar: [] (dedupe ran), in its own folder', () => {
    const dir = makeTempDir();
    const paths = sidecarScenario(dir);

    runCli(dir, ['dedupe', '--write']);

    expect(readYaml(dir, `${DRAFTS}/d2/2.1/charlie.check.yaml`)).toEqual({
      dedupe: { threshold: 0.5, similar: [] },
    });
    expect(paths.charlie).toBe('d2/2.1/charlie.yaml');
  });

  test('AC-16: the other keys of an existing sidecar are kept, the dedupe key is replaced', () => {
    const dir = makeTempDir();
    const paths = sidecarScenario(dir);

    runCli(dir, ['dedupe', '--write']);

    expect(readYaml(dir, `${DRAFTS}/${sidecar(paths.delta)}`)).toEqual({
      verification: { verified_by: 'claude', checks: [{ name: 'facts', ok: true }] },
      other: 3,
      dedupe: { threshold: 0.5, similar: [] },
    });
  });

  test('AC-16: only the sidecars are created: drafts and the bank folder keep their bytes', () => {
    const dir = makeTempDir();
    const paths = sidecarScenario(dir);
    const before = snapshot(dir);

    runCli(dir, ['dedupe', '--write']);

    const after = snapshot(dir);
    const created = Object.keys(after)
      .filter((path) => !(path in before))
      .sort();
    expect(created).toEqual(
      [paths.alpha, paths.bravo1, paths.bravo2, paths.charlie]
        .map((path) => `${DRAFTS}/${sidecar(path)}`)
        .sort(),
    );
    for (const [path, bytes] of Object.entries(before)) {
      if (path === `${DRAFTS}/${sidecar(paths.delta)}`) continue;
      expect(after[path], path).toBe(bytes);
    }
    expect(Object.keys(after).filter((path) => path.startsWith(`${BANK}/`))).toEqual(
      Object.keys(before).filter((path) => path.startsWith(`${BANK}/`)),
    );
  });

  test('AC-16: with no flagged pair at all, every draft still gets similar: [] and the exit code is 0', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'one', 'alpha', 'a', { status: 'draft' });
    putVariant(dir, DRAFTS, 'd3-3.4-0002', 'two', 'bravo', 'a');
    putVariant(dir, BANK, 'd1-1.3-0003', 'three', 'charlie', 'a');

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(0);
    const expected = { dedupe: { threshold: 0.5, similar: [] } };
    expect(readYaml(dir, `${DRAFTS}/d1/1.3/one.check.yaml`)).toEqual(expected);
    expect(readYaml(dir, `${DRAFTS}/d3/3.4/two.check.yaml`)).toEqual(expected);
    expect(exists(dir, `${BANK}/d1/1.3/three.check.yaml`)).toBe(false);
  });

  test('AC-16: running it twice gives the same files (sidecars are not read as questions)', () => {
    const dir = makeTempDir();
    sidecarScenario(dir);

    const first = runCli(dir, ['dedupe', '--write']);
    const afterFirst = snapshot(dir);
    const second = runCli(dir, ['dedupe', '--write']);

    expect(first.status).toBe(1);
    expect(Object.keys(afterFirst)).toContain(`${DRAFTS}/d1/1.3/alpha-copy.check.yaml`);
    expect(second.status).toBe(first.status);
    expect(snapshot(dir)).toEqual(afterFirst);
    expect(pairLines(second)).toEqual(pairLines(first));
  });

  test('AC-16: the sidecar of a bank question is never created', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'copy', 'alpha', 'a');

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(1);
    expect(exists(dir, `${BANK}/d1/1.3/original.check.yaml`)).toBe(false);
    expect(readdirSync(join(dir, BANK, 'd1', '1.3'))).toEqual(['original.yaml']);
  });
});

describe('dedupe --threshold', () => {
  test('AC-17: --threshold 0.3 flags a pair (5 of 15 shingles) that the default 0.5 does not', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a');

    const byDefault = runCli(dir, ['dedupe']);
    const lowered = runCli(dir, ['dedupe', '--threshold', '0.3']);

    expect(byDefault.status).toBe(0);
    expect(byDefault.output).toMatch(summaryOf(0, 1));
    expect(lowered.status).toBe(1);
    expect(pairLines(lowered).map((line) => line.score)).toEqual(['0.33']);
  });

  test('AC-17: the threshold appears in the summary', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a');

    const run = runCli(dir, ['dedupe', '--threshold', '0.3']);

    expect(run.output).toMatch(summaryOf(1, 1, 0.3));
  });

  test('AC-17: the threshold appears in every sidecar, also in those without a flagged pair', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'flagged', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0003', 'alone', 'bravo', 'a');

    runCli(dir, ['dedupe', '--threshold', '0.3', '--write']);

    expect(readYaml(dir, `${DRAFTS}/d1/1.3/flagged.check.yaml`)).toEqual({
      dedupe: {
        threshold: 0.3,
        similar: [{ id: 'd1-1.3-0001', folder: 'bank', path: 'd1/1.3/bank.yaml', score: 0.33 }],
      },
    });
    expect(readYaml(dir, `${DRAFTS}/d1/1.3/alone.check.yaml`)).toEqual({
      dedupe: { threshold: 0.3, similar: [] },
    });
  });

  test('AC-17: the flag can come before the other options', () => {
    const dir = makeTempDir();
    putVariant(dir, 'other-bank', 'd1-1.3-0001', 'bank', 'alpha', 'b');
    putVariant(dir, 'other-drafts', 'd1-1.3-0002', 'draft', 'alpha', 'a');

    const run = runCli(dir, [
      'dedupe',
      '--threshold',
      '0.3',
      '--bank',
      'other-bank',
      '--drafts',
      'other-drafts',
    ]);

    expect(run.status).toBe(1);
    expect(run.output).toMatch(summaryOf(1, 1, 0.3));
  });

  test('AC-17: the flagging uses the unrounded score: 0.5454 is not flagged at 0.55', () => {
    const dir = makeTempDir();
    // 12 of 22 shingles are shared: 0.5454..., which is printed as 0.55 when it is flagged.
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'b', { common: 14 });
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a', { common: 14 });

    const below = runCli(dir, ['dedupe', '--threshold', '0.55']);
    const above = runCli(dir, ['dedupe', '--threshold', '0.54']);

    expect(below.status).toBe(0);
    expect(below.output).toMatch(summaryOf(0, 1, 0.55));
    expect(above.status).toBe(1);
    expect(pairLines(above).map((line) => line.score)).toEqual(['0.55']);
  });

  test('AC-17: --threshold 1 is valid and flags only identical questions', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank-near', 'alpha', 'b', { common: 13 });
    putVariant(dir, BANK, 'd1-1.3-0002', 'bank-same', 'alpha', 'a', { common: 13 });
    putVariant(dir, DRAFTS, 'd1-1.3-0003', 'draft', 'alpha', 'a', { common: 13 });

    const run = runCli(dir, ['dedupe', '--threshold', '1']);

    expect(run.status).toBe(1);
    expect(pairLines(run).map((line) => line.otherId)).toEqual(['d1-1.3-0002']);
    expect(run.output).toMatch(summaryOf(1, 2, 1));
  });

  test.each([
    ['0'],
    ['0.0'],
    ['1.5'],
    ['1.0001'],
    ['-0.5'],
    ['abc'],
    ['0.5x'],
    ['NaN'],
    ['Infinity'],
    [''],
    ['--write'],
  ])('AC-18: --threshold %j exits 2 with the usage text and writes nothing', (value) => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'bank', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a');
    const before = snapshot(dir);

    const run = runCli(dir, ['dedupe', '--write', '--threshold', value]);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('dedupe');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-18: --threshold without a value exits 2 with the usage text', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a');

    const run = runCli(dir, ['dedupe', '--threshold']);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('dedupe');
  });

  test.each([['1'], ['1.0'], ['0.01'], ['0.5']])(
    'AC-18: --threshold %s is a valid number in (0, 1]',
    (value) => {
      const dir = makeTempDir();
      putVariant(dir, DRAFTS, 'd1-1.3-0002', 'draft', 'alpha', 'a');

      const run = runCli(dir, ['dedupe', '--threshold', value]);

      expect(run.status).toBe(0);
      expect(run.output).toMatch(summaryOf(0, 0, Number(value)));
    },
  );
});

describe('dedupe with problems', () => {
  const setups: [string, string, (dir: string) => void][] = [
    [
      'invalid YAML in a draft',
      'broken.yaml',
      (dir) => {
        write(dir, `${DRAFTS}/d1/1.3/broken.yaml`, 'id: [unclosed\n');
      },
    ],
    [
      'a schema problem in a draft',
      'weak.yaml',
      (dir) => {
        write(dir, `${DRAFTS}/d1/1.3/weak.yaml`, 'id: d1-1.3-0009\nstem: too short\n');
      },
    ],
    [
      'invalid YAML in the bank',
      'broken.yaml',
      (dir) => {
        write(dir, `${BANK}/d1/1.3/broken.yaml`, 'id: [unclosed\n');
      },
    ],
    [
      'a draft-status question in the bank',
      'pending.yaml',
      (dir) => {
        putVariant(dir, BANK, 'd1-1.3-0009', 'pending', 'echo', 'a', { status: 'draft' });
      },
    ],
    [
      'a question in the wrong place in the bank',
      'misplaced.yaml',
      (dir) => {
        write(dir, `${BANK}/d2/misplaced.yaml`, questionYaml({ id: 'd1-1.3-0009' }));
      },
    ],
  ];

  describe.each([[['dedupe']], [['dedupe', '--write']]])('%j', (args) => {
    test.each(setups)('AC-19: %s: prints it, writes no sidecar, exit 1', (_name, file, setup) => {
      const dir = makeTempDir();
      putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
      putVariant(dir, DRAFTS, 'd1-1.3-0002', 'copy', 'alpha', 'a');
      write(dir, `${DRAFTS}/d1/1.3/copy.check.yaml`, 'keep: me\n');
      setup(dir);
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(run.output).toContain(file);
      expect(snapshot(dir)).toEqual(before);
    });

    test('AC-19: an id used in both folders is a problem: no sidecar, exit 1', () => {
      const dir = makeTempDir();
      putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
      putVariant(dir, DRAFTS, 'd1-1.3-0001', 'same-id', 'bravo', 'a');
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(snapshot(dir)).toEqual(before);
    });
  });

  test('AC-19: the problem is printed as <folder>/<file>: <message>, as in check', () => {
    const dir = makeTempDir();
    write(dir, `${DRAFTS}/d1/1.3/broken.yaml`, 'id: [unclosed\n');

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/d1/1.3/broken.yaml: invalid YAML`);
  });

  test('AC-19: the run stops: no pair is compared or printed', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'copy', 'alpha', 'a');
    write(dir, `${DRAFTS}/d1/1.3/broken.yaml`, 'id: [unclosed\n');

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(1);
    expect(pairLines(run)).toEqual([]);
    expect(run.output).not.toContain('flagged of');
  });
});

describe('dedupe with a bad sidecar', () => {
  const badSidecars: [string, string][] = [
    ['invalid YAML', 'a: [unclosed\n'],
    ['a sequence', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
  ];

  /** Three drafts in path order, the first one identical to a bank question. */
  function threeDrafts(dir: string): void {
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0011', 'aaa-first', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0012', 'mmm-middle', 'bravo', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0013', 'zzz-last', 'charlie', 'a');
    write(dir, `${DRAFTS}/d1/1.3/mmm-middle.check.yaml`, 'keep: me\n');
  }

  describe.each(badSidecars)('%s', (_name, content) => {
    test('AC-20: names the sidecar, writes no sidecar at all (the last draft is the bad one), exit 1', () => {
      const dir = makeTempDir();
      threeDrafts(dir);
      write(dir, `${DRAFTS}/d1/1.3/zzz-last.check.yaml`, content);
      const before = snapshot(dir);

      const run = runCli(dir, ['dedupe', '--write']);

      expect(run.status).toBe(1);
      expect(run.output).toContain('zzz-last.check.yaml');
      expect(snapshot(dir)).toEqual(before);
    });

    test('AC-20: names the sidecar, writes no sidecar at all (the first draft is the bad one), exit 1', () => {
      const dir = makeTempDir();
      threeDrafts(dir);
      write(dir, `${DRAFTS}/d1/1.3/aaa-first.check.yaml`, content);
      const before = snapshot(dir);

      const run = runCli(dir, ['dedupe', '--write']);

      expect(run.status).toBe(1);
      expect(run.output).toContain('aaa-first.check.yaml');
      expect(snapshot(dir)).toEqual(before);
    });
  });

  test('AC-20: every bad sidecar is named', () => {
    const dir = makeTempDir();
    threeDrafts(dir);
    write(dir, `${DRAFTS}/d1/1.3/aaa-first.check.yaml`, 'a: [unclosed\n');
    write(dir, `${DRAFTS}/d1/1.3/zzz-last.check.yaml`, '- a\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain('aaa-first.check.yaml');
    expect(run.output).toContain('zzz-last.check.yaml');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-20: the bad sidecar is named with its folder, as the other paths are', () => {
    const dir = makeTempDir();
    threeDrafts(dir);
    write(dir, `${DRAFTS}/d1/1.3/zzz-last.check.yaml`, '- a\n');

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.output).toContain(`${DRAFTS}/d1/1.3/zzz-last.check.yaml`);
  });

  test('AC-20: good sidecars are written normally', () => {
    const dir = makeTempDir();
    threeDrafts(dir);

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(1);
    expect(readYaml(dir, `${DRAFTS}/d1/1.3/mmm-middle.check.yaml`)).toEqual({
      keep: 'me',
      dedupe: { threshold: 0.5, similar: [] },
    });
  });
});

describe('dedupe folders', () => {
  test('AC-21: --drafts and --bank override the default folders', () => {
    const dir = makeTempDir();
    // The default folders hold a problem; the overrides are clean and hold a copy.
    write(dir, `${DRAFTS}/d1/1.3/default-bad.yaml`, 'id: [unclosed\n');
    write(dir, `${BANK}/d1/1.3/default-bad.yaml`, 'id: [unclosed\n');
    putVariant(dir, 'my-bank', 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, 'my-drafts', 'd1-1.3-0002', 'copy', 'alpha', 'a');

    const run = runCli(dir, ['dedupe', '--drafts', 'my-drafts', '--bank', 'my-bank']);

    expect(run.status).toBe(1);
    expect(run.output).not.toContain('default-bad');
    expect(run.output).toMatch(summaryOf(1, 1));
    const [line] = pairLines(run) as [PairLine];
    expect(line.draftPath).toMatch(printedPath('d1/1.3/copy.yaml', 'drafts', 'my-drafts'));
    expect(line.otherPath).toMatch(printedPath('d1/1.3/original.yaml', 'bank', 'my-bank'));
  });

  test('AC-21: --write writes the sidecars into the overridden drafts folder only', () => {
    const dir = makeTempDir();
    write(dir, `${DRAFTS}/d1/1.3/keep.txt`, 'default drafts\n');
    putVariant(dir, 'my-bank', 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, 'my-drafts', 'd1-1.3-0002', 'copy', 'alpha', 'a');
    const defaults = snapshot(join(dir, 'private'));
    const bank = snapshot(join(dir, 'my-bank'));

    runCli(dir, ['dedupe', '--drafts', 'my-drafts', '--bank', 'my-bank', '--write']);

    expect(readYaml(dir, 'my-drafts/d1/1.3/copy.check.yaml')).toEqual({
      dedupe: {
        threshold: 0.5,
        similar: [{ id: 'd1-1.3-0001', folder: 'bank', path: 'd1/1.3/original.yaml', score: 1 }],
      },
    });
    expect(snapshot(join(dir, 'private'))).toEqual(defaults);
    expect(snapshot(join(dir, 'my-bank'))).toEqual(bank);
  });

  test('AC-21: --bank alone overrides only the bank', () => {
    const dir = makeTempDir();
    write(dir, `${BANK}/d1/1.3/default-bad.yaml`, 'id: [unclosed\n');
    putVariant(dir, 'my-bank', 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'copy', 'alpha', 'a');

    const run = runCli(dir, ['dedupe', '--bank', 'my-bank']);

    expect(run.status).toBe(1);
    expect(run.output).not.toContain('default-bad');
    expect(run.output).toMatch(summaryOf(1, 1));
  });

  test('AC-21: the defaults are used without flags', () => {
    const dir = makeTempDir();
    putVariant(dir, 'my-bank', 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, 'my-drafts', 'd1-1.3-0002', 'copy', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0003', 'lonely', 'bravo', 'a');

    const run = runCli(dir, ['dedupe']);

    expect(run.status).toBe(0);
    expect(run.output).toMatch(summaryOf(0, 0));
  });

  test('AC-21: with no bank folder the notice is printed and the drafts are compared with each other', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'one', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'two', 'alpha', 'a');

    const run = runCli(dir, ['dedupe']);

    expect(run.output).toContain('no folder at questions, treated as empty');
    expect(run.output).not.toContain('no folder at private/questions-drafts');
    expect(run.output).toMatch(summaryOf(1, 1));
    expect(run.status).toBe(1);
    const [line] = pairLines(run) as [PairLine];
    expect(line.draftId).toBe('d1-1.3-0001');
    expect(line.otherId).toBe('d1-1.3-0002');
  });

  test('AC-21: --write with no bank folder writes the draft sidecars and does not create the bank', () => {
    const dir = makeTempDir();
    putVariant(dir, DRAFTS, 'd1-1.3-0001', 'one', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'two', 'alpha', 'a');

    runCli(dir, ['dedupe', '--write']);

    expect(readYaml(dir, `${DRAFTS}/d1/1.3/one.check.yaml`)).toEqual({
      dedupe: {
        threshold: 0.5,
        similar: [{ id: 'd1-1.3-0002', folder: 'drafts', path: 'd1/1.3/two.yaml', score: 1 }],
      },
    });
    expect(exists(dir, BANK)).toBe(false);
  });

  test('AC-21: with no drafts folder the notice is printed, nothing is compared, exit 0, nothing created', () => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
    const before = snapshot(dir);

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('no folder at private/questions-drafts, treated as empty');
    expect(run.output).not.toContain('no folder at questions');
    expect(run.output).toMatch(summaryOf(0, 0));
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-21: the notice names the folder as given', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['dedupe', '--drafts', 'nowhere', '--bank', 'nothing']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('no folder at nowhere, treated as empty');
    expect(run.output).toContain('no folder at nothing, treated as empty');
  });
});

describe('dedupe usage', () => {
  test('AC-22: the usage text lists dedupe', () => {
    const dir = makeTempDir();

    const run = runCli(dir, []);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('dedupe');
  });

  test.each([
    ['an unknown flag', ['dedupe', '--bogus']],
    ['a short unknown flag', ['dedupe', '-x']],
    ['-h', ['dedupe', '-h']],
    ['an unknown flag after a known one', ['dedupe', '--write', '--bogus']],
    ['--drafts without a value', ['dedupe', '--drafts']],
    ['--bank without a value', ['dedupe', '--bank']],
    ['--drafts followed by a flag', ['dedupe', '--drafts', '--write']],
    ['--dry-run, which only promote knows', ['dedupe', '--dry-run']],
  ])('AC-22: %s exits 2 with the usage text and touches nothing', (_name, args) => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');
    putVariant(dir, DRAFTS, 'd1-1.3-0002', 'copy', 'alpha', 'a');
    const before = snapshot(dir);

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('dedupe');
    expect(snapshot(dir)).toEqual(before);
  });

  test.each([
    ['check --write', ['check', '--write']],
    ['check --threshold 0.5', ['check', '--threshold', '0.5']],
    ['promote --write', ['promote', '--write']],
    ['next-id 1.3 --threshold 0.5', ['next-id', '1.3', '--threshold', '0.5']],
  ])('AC-22: %s is still an unknown flag: exit 2 with the usage text', (_name, args) => {
    const dir = makeTempDir();
    putVariant(dir, BANK, 'd1-1.3-0001', 'original', 'alpha', 'a');

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
  });
});
