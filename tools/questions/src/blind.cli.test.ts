import { afterEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';
import { makeQuestion } from './__mocks__/fixtures.ts';
import type { Raw } from './__mocks__/fixtures.ts';
import {
  DRAFTS,
  cleanTempDirs,
  lines,
  makeTempDir,
  put,
  runCli,
  sidecarOf,
  snapshot,
  write,
} from './__mocks__/cli-harness.ts';
import { digestOf } from './__mocks__/verify-fixtures.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

const stemOf = (id: string): string => `The stem of question ${id} is long enough to be valid.`;

/** A draft with a known stem and markers in every field that must not reach the verifier. */
function draft(dir: string, id: string, slug: string, overrides: Raw = {}): string {
  return put(dir, DRAFTS, id, slug, {
    status: 'draft',
    stem: stemOf(id),
    cue: `CUEMARKER-${id}`,
    ...overrides,
  });
}

/** The blind block the CLI must print for a draft made by `draft` (single, default options). */
function blockOf(id: string): string {
  return [
    `id: ${id}`,
    'type: single (choose 1)',
    '',
    stemOf(id),
    '',
    'A. SSE-S3',
    'B. SSE-KMS',
    'C. SSE-C',
    'D. None of them',
  ].join('\n');
}

const SEPARATOR = '\n\n---\n\n';

/** The ids printed on `id:` lines. */
function idsPrinted(stdout: string): string[] {
  return lines(stdout)
    .map((line) => /^id: (\S+)$/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe('blind with files', () => {
  test('AC-18: a single file prints exactly its block and exits 0', () => {
    const dir = makeTempDir();
    const path = draft(dir, 'd1-1.3-0001', 'only');

    const run = runCli(dir, ['blind', `${DRAFTS}/${path}`]);

    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe(blockOf('d1-1.3-0001'));
  });

  test('AC-18: two files print both blocks in id order, not argument or path order', () => {
    const dir = makeTempDir();
    // Id order is 0001, 0002; path order is aaa (0002), zzz (0001); the arguments follow path order.
    const small = draft(dir, 'd1-1.3-0001', 'zzz-small-id');
    const large = draft(dir, 'd1-1.3-0002', 'aaa-large-id');

    const run = runCli(dir, ['blind', `${DRAFTS}/${large}`, `${DRAFTS}/${small}`]);

    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe(
      [blockOf('d1-1.3-0001'), blockOf('d1-1.3-0002')].join(SEPARATOR),
    );
  });

  test('AC-18: the blocks are separated by a --- line with a blank line before and after', () => {
    const dir = makeTempDir();
    const first = draft(dir, 'd1-1.3-0003', 'one');
    const second = draft(dir, 'd1-1.3-0004', 'two');
    const third = draft(dir, 'd2-2.1-0001', 'three');

    const run = runCli(dir, [
      'blind',
      `${DRAFTS}/${third}`,
      `${DRAFTS}/${first}`,
      `${DRAFTS}/${second}`,
    ]);

    expect(run.status).toBe(0);
    const rows = run.stdout.replace(/\r/g, '').split('\n');
    const separators = rows.flatMap((row, index) => (row === '---' ? [index] : []));
    expect(separators).toHaveLength(2);
    for (const index of separators) {
      expect(rows[index - 1]).toBe('');
      expect(rows[index + 1]).toBe('');
    }
    expect(idsPrinted(run.stdout)).toEqual(['d1-1.3-0003', 'd1-1.3-0004', 'd2-2.1-0001']);
  });

  test('AC-18: nothing but the blocks is printed on stdout', () => {
    const dir = makeTempDir();
    const path = draft(dir, 'd1-1.3-0001', 'only', {
      cue: 'CUEMARKER about the answer',
      difficulty: 'hard',
      services: ['svcmarker'],
      references: ['https://docs.aws.amazon.com/REFMARKER/guide.html'],
      links: { guide: '/GUIDEMARKER/' },
    });

    const run = runCli(dir, ['blind', `${DRAFTS}/${path}`]);

    expect(run.status).toBe(0);
    for (const secret of [
      'CUEMARKER',
      'svcmarker',
      'REFMARKER',
      'GUIDEMARKER',
      'docs.aws.amazon.com',
      'AWS creates and owns the keys',
      'The caller sends the key',
      'hard',
      'private/',
      'provenance',
      'claude',
    ]) {
      expect(run.stdout).not.toContain(secret);
    }
    expect(run.stdout).not.toMatch(/\bcorrect\b|\btrue\b|\bwhy\b/i);
  });

  test('AC-18: a file that is not a valid question exits 1, names it on stderr, prints nothing', () => {
    const dir = makeTempDir();
    const good = draft(dir, 'd1-1.3-0001', 'good');
    write(
      dir,
      `${DRAFTS}/d1/1.3/broken.yaml`,
      stringify({ ...makeQuestion({ id: 'd1-1.3-0002' }), stem: 'short' }),
    );

    const run = runCli(dir, ['blind', `${DRAFTS}/${good}`, `${DRAFTS}/d1/1.3/broken.yaml`]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('broken.yaml');
  });

  test('AC-18: a file that is not YAML exits 1, names it on stderr, prints nothing', () => {
    const dir = makeTempDir();
    write(dir, `${DRAFTS}/d1/1.3/garbage.yaml`, 'a: [unclosed\n');

    const run = runCli(dir, ['blind', `${DRAFTS}/d1/1.3/garbage.yaml`]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('garbage.yaml');
  });

  test('AC-18: a file that does not exist exits 1 and prints nothing on stdout', () => {
    const dir = makeTempDir();
    const good = draft(dir, 'd1-1.3-0001', 'good');

    const run = runCli(dir, ['blind', `${DRAFTS}/${good}`, `${DRAFTS}/d1/1.3/missing.yaml`]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('missing.yaml');
  });

  test('AC-18: blind never writes anything', () => {
    const dir = makeTempDir();
    const path = draft(dir, 'd1-1.3-0001', 'only');
    const before = snapshot(dir);

    const run = runCli(dir, ['blind', `${DRAFTS}/${path}`]);

    expect(run.status).toBe(0);

    expect(snapshot(dir)).toEqual(before);
  });
});

/** Writes the sidecar of a draft with a `verification` key holding `digest`. */
function verified(dir: string, path: string, digest: string): void {
  write(
    dir,
    `${DRAFTS}/${sidecarOf(path)}`,
    stringify({ verification: { result: 'verified', digest } }),
  );
}

/** Drafts for the --pending tests; the ids do not follow the path order. */
interface PendingPaths {
  none: string;
  noKey: string;
  stale: string;
  current: string;
  rejected: string;
}

function pendingFixture(dir: string): PendingPaths {
  // No sidecar at all.
  const none = draft(dir, 'd1-1.3-0004', 'a-no-sidecar');
  // A sidecar without a verification key.
  const noKey = draft(dir, 'd1-1.3-0003', 'b-no-verification-key');
  write(
    dir,
    `${DRAFTS}/${sidecarOf(noKey)}`,
    stringify({ dedupe: { threshold: 0.5, similar: [] } }),
  );
  // A verification whose digest belongs to an older version of the question.
  const stale = draft(dir, 'd1-1.3-0002', 'c-stale-digest');
  verified(dir, stale, digestOf(makeQuestion({ id: 'd1-1.3-0002', stem: 'The older stem.' })));
  // A verification whose digest matches the draft as it is now.
  const current = draft(dir, 'd1-1.3-0001', 'd-current-digest');
  verified(
    dir,
    current,
    digestOf(makeQuestion({ id: 'd1-1.3-0001', stem: stemOf('d1-1.3-0001') })),
  );
  // A draft in rejected/ with no sidecar.
  const rejected = put(dir, `${DRAFTS}/rejected`, 'd1-1.3-0005', 'e-rejected', {
    status: 'draft',
    stem: stemOf('d1-1.3-0005'),
  });
  return { none, noKey, stale, current, rejected };
}

describe('blind --pending', () => {
  test('AC-19: prints drafts with no sidecar, no verification key or a different digest, in id order', () => {
    const dir = makeTempDir();
    pendingFixture(dir);

    const run = runCli(dir, ['blind', '--pending']);

    expect(run.status).toBe(0);
    expect(idsPrinted(run.stdout)).toEqual(['d1-1.3-0002', 'd1-1.3-0003', 'd1-1.3-0004']);
    expect(run.stdout.trimEnd()).toBe(
      [blockOf('d1-1.3-0002'), blockOf('d1-1.3-0003'), blockOf('d1-1.3-0004')].join(SEPARATOR),
    );
  });

  test('AC-19: a draft whose digest matches the current question is skipped', () => {
    const dir = makeTempDir();
    pendingFixture(dir);

    const run = runCli(dir, ['blind', '--pending']);

    expect(idsPrinted(run.stdout)).toContain('d1-1.3-0004');
    expect(run.stdout).not.toContain('d1-1.3-0001');
  });

  test('AC-19: a draft under rejected/ is skipped', () => {
    const dir = makeTempDir();
    pendingFixture(dir);

    const run = runCli(dir, ['blind', '--pending']);

    expect(idsPrinted(run.stdout)).toContain('d1-1.3-0004');
    expect(run.stdout).not.toContain('d1-1.3-0005');
  });

  test('AC-19: changing the key of a verified draft makes it pending again', () => {
    const dir = makeTempDir();
    const path = draft(dir, 'd1-1.3-0001', 'only');
    verified(dir, path, digestOf(makeQuestion({ id: 'd1-1.3-0001', stem: stemOf('d1-1.3-0001') })));
    expect(runCli(dir, ['blind', '--pending']).stdout).toBe('');
    const options = (makeQuestion().options as Raw[]).map((option) => ({
      ...option,
      correct: option.key === 'B',
    }));

    draft(dir, 'd1-1.3-0001', 'only', { options });

    expect(idsPrinted(runCli(dir, ['blind', '--pending']).stdout)).toEqual(['d1-1.3-0001']);
  });

  test('AC-19: changing the stem of a verified draft makes it pending again', () => {
    const dir = makeTempDir();
    const path = draft(dir, 'd1-1.3-0001', 'only');
    verified(dir, path, digestOf(makeQuestion({ id: 'd1-1.3-0001', stem: stemOf('d1-1.3-0001') })));

    draft(dir, 'd1-1.3-0001', 'only', { stem: 'A different stem that is long enough.' });

    expect(idsPrinted(runCli(dir, ['blind', '--pending']).stdout)).toEqual(['d1-1.3-0001']);
  });

  test('AC-19: with nothing pending stdout is empty, stderr says nothing pending, exit 0', () => {
    const dir = makeTempDir();
    const path = draft(dir, 'd1-1.3-0001', 'only');
    verified(dir, path, digestOf(makeQuestion({ id: 'd1-1.3-0001', stem: stemOf('d1-1.3-0001') })));

    const run = runCli(dir, ['blind', '--pending']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing pending');
  });

  test('AC-19: with no drafts folder at all nothing is pending either', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['blind', '--pending']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing pending');
  });

  test('AC-19: files given on the command line are added to the pending ones', () => {
    const dir = makeTempDir();
    const paths = pendingFixture(dir);

    const run = runCli(dir, ['blind', '--pending', `${DRAFTS}/${paths.current}`]);

    expect(run.status).toBe(0);
    expect(idsPrinted(run.stdout)).toEqual([
      'd1-1.3-0001',
      'd1-1.3-0002',
      'd1-1.3-0003',
      'd1-1.3-0004',
    ]);
  });

  test('AC-19: a draft that is both given and pending is printed once', () => {
    const dir = makeTempDir();
    const paths = pendingFixture(dir);

    const run = runCli(dir, ['blind', `${DRAFTS}/${paths.none}`, '--pending']);

    expect(idsPrinted(run.stdout)).toEqual(['d1-1.3-0002', 'd1-1.3-0003', 'd1-1.3-0004']);
  });

  test('AC-19: --drafts points --pending at another folder', () => {
    const dir = makeTempDir();
    put(dir, 'other-drafts', 'd1-1.3-0009', 'elsewhere', {
      status: 'draft',
      stem: stemOf('d1-1.3-0009'),
    });
    draft(dir, 'd1-1.3-0001', 'in-the-default-folder');

    const run = runCli(dir, ['blind', '--pending', '--drafts', 'other-drafts']);

    expect(run.status).toBe(0);
    expect(idsPrinted(run.stdout)).toEqual(['d1-1.3-0009']);
  });

  test('AC-19: --pending writes nothing', () => {
    const dir = makeTempDir();
    pendingFixture(dir);
    const before = snapshot(dir);

    const run = runCli(dir, ['blind', '--pending']);

    expect(run.status).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });
});
