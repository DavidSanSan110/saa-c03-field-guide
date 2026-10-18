// Review round 1 (regression ACs) of spec 022, blind CLI: AC-36 (--pending) and AC-38.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';
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
import { makeQuestion } from './__mocks__/fixtures.ts';
import { digestOf } from './__mocks__/verify-fixtures.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

const STEM = 'The stem of this question is long enough to be valid.';

/** A draft plus a sidecar whose verification has the given result and the current digest. */
function verifiedAs(dir: string, id: string, slug: string, result: string): void {
  const path = put(dir, DRAFTS, id, slug, { status: 'draft', stem: STEM });
  const digest = digestOf(makeQuestion({ id, stem: STEM }));
  write(dir, `${DRAFTS}/${sidecarOf(path)}`, stringify({ verification: { result, digest } }));
}

const idsPrinted = (stdout: string): string[] =>
  lines(stdout)
    .map((line) => /^id: (\S+)$/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);

describe('blind --pending skips every verdict with the current digest', () => {
  test.each(['mismatch', 'unsupported', 'verified'])(
    'AC-36: a draft whose verification result is %s with the current digest is not pending',
    (result) => {
      const dir = makeTempDir();
      verifiedAs(dir, 'd1-1.3-0001', 'already-judged', result);
      put(dir, DRAFTS, 'd1-1.3-0002', 'not-judged', { status: 'draft', stem: STEM });

      const run = runCli(dir, ['blind', '--pending']);

      expect(run.status).toBe(0);
      expect(idsPrinted(run.stdout)).toEqual(['d1-1.3-0002']);
    },
  );

  test('AC-36: when every draft has a verdict with the current digest nothing is pending', () => {
    const dir = makeTempDir();
    verifiedAs(dir, 'd1-1.3-0001', 'one', 'mismatch');
    verifiedAs(dir, 'd1-1.3-0002', 'two', 'unsupported');

    const run = runCli(dir, ['blind', '--pending']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing pending');
  });

  test('AC-36: a mismatch with an old digest is pending again', () => {
    const dir = makeTempDir();
    const path = put(dir, DRAFTS, 'd1-1.3-0001', 'edited', { status: 'draft', stem: STEM });
    const oldDigest = digestOf(makeQuestion({ id: 'd1-1.3-0001', stem: `${STEM} (older)` }));
    write(
      dir,
      `${DRAFTS}/${sidecarOf(path)}`,
      stringify({ verification: { result: 'mismatch', digest: oldDigest } }),
    );

    const run = runCli(dir, ['blind', '--pending']);

    expect(idsPrinted(run.stdout)).toEqual(['d1-1.3-0001']);
  });
});

describe('blind with nothing to print', () => {
  test.each([
    ['no argument', ['blind']],
    ['only --drafts', ['blind', '--drafts', 'my-drafts']],
    ['only --bank', ['blind', '--bank', 'my-bank']],
  ])('AC-38: %s exits 2 with the usage text', (_name, args) => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one', { status: 'draft', stem: STEM });
    put(dir, 'my-drafts', 'd1-1.3-0002', 'two', { status: 'draft', stem: STEM });
    const before = snapshot(dir);

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toMatch(/\bquestions blind\b/);
    expect(run.stdout).not.toContain('id: ');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-38: --pending alone is not a usage error', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['blind', '--pending']);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('nothing pending');
  });
});
