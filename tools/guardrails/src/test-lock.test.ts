import { describe, expect, test } from 'vitest';
import type { Violation } from './rules.ts';
import { checkCommits, checkTestLock, isTestCommit, isTestPath } from './test-lock.ts';
import type { CommitChange, CommitInfo } from './test-lock.ts';

// Blocked strings are never written literally; they are assembled at runtime.
const TRAILER = 'Co-Authored-By' + ': ';
const AI_NAME = 'Clau' + 'de';
const AI_DOMAIN = 'anthro' + 'pic.com';

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
const SHA_C = 'c3d4e5f60718293a4b5c6d7e8f90123456789012';
const SHA_D = 'd4e5f60718293a4b5c6d7e8f9012345678901234';

/** The first seven characters, the shortest abbreviation git produces by default. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

function change(
  path: string,
  status: CommitChange['status'],
  added = 1,
  removed = 0,
  oldPath?: string,
): CommitChange {
  return oldPath === undefined
    ? { path, status, added, removed }
    : { path, status, oldPath, added, removed };
}

function commit(sha: string, subject: string, ...changes: CommitChange[]): CommitInfo {
  return { sha, subject, changes };
}

function files(violations: Violation[]): string[] {
  return violations.map((violation) => violation.file).sort();
}

function ruleIds(violations: Violation[]): string[] {
  return [...new Set(violations.map((violation) => violation.rule))].sort();
}

describe('isTestPath', () => {
  test.each([
    'packages/x/src/a.test.ts',
    'tools/g/src/cli.spec.mjs',
    'e2e/nav.spec.ts',
    'e2e/fixtures/q.yaml',
    'labs/00/tests/main.tftest.hcl',
    'src/__snapshots__/a.snap',
    'e2e/diagram.spec.ts-snapshots/a.png',
    'A.TEST.TS',
  ])('AC-1: %s is a test path', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  test.each([
    'packages/x/src/a.ts',
    'vitest.config.ts',
    'docs/testing.md',
    'latest.ts',
    'contest.ts',
  ])('AC-1: %s is not a test path', (path) => {
    expect(isTestPath(path)).toBe(false);
  });

  test.each([
    'a.test.tsx',
    'a.test.js',
    'a.test.mjs',
    'a.spec.ts',
    'a.spec.tsx',
    'a.spec.js',
    'apps/web/src/Widget.SPEC.TSX',
    'tests/foo-snapshots/a.png',
    'packages/x/__SNAPSHOTS__/a.snap',
  ])('AC-1: %s (other extension, depth or case) is a test path', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  test.each(['a.test.json', 'labs/00/main.tf', 'e2e-notes.md', 'src/snapshots.ts'])(
    'AC-1: %s is not a test path',
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );
});

describe('isTestCommit', () => {
  test.each(['test: x', 'test(schema): x', 'test!: x', 'test(schema)!: x'])(
    'AC-2: "%s" is a test commit',
    (subject) => {
      expect(isTestCommit(subject)).toBe(true);
    },
  );

  test.each(['feat: x', 'tests: x', 'chore(test): x', 'Test: x', 'test x', 'fix: test: x'])(
    'AC-2: "%s" is not a test commit',
    (subject) => {
      expect(isTestCommit(subject)).toBe(false);
    },
  );
});

describe('checkTestLock: non-test commits', () => {
  test.each([
    ['adds a test file', change('src/a.test.ts', 'A')],
    ['modifies a test file', change('src/a.test.ts', 'M', 2, 1)],
    ['deletes a test file', change('src/a.test.ts', 'D', 0, 5)],
    ['renames a test file', change('src/b.test.ts', 'R', 0, 0, 'src/a.test.ts')],
    ['moves a test file out of the test set', change('src/a.ts', 'R', 0, 0, 'src/a.test.ts')],
    ['moves a file into the test set', change('src/a.test.ts', 'R', 0, 0, 'src/a.ts')],
  ])('AC-3: a feat commit that %s gives a test-lock violation', (_name, c) => {
    const violations = checkTestLock([commit(SHA_A, 'feat: add y', c)]);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(ruleIds(violations)).toEqual(['test-lock']);
    for (const violation of violations) {
      expect([c.path, c.oldPath]).toContain(violation.file);
    }
  });

  test('AC-3: a new file with a test name added by a chore commit is flagged', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'chore: tidy', change('e2e/nav.spec.ts', 'A')),
    ]);
    expect(files(violations)).toEqual(['e2e/nav.spec.ts']);
  });

  test('AC-3: gives one violation per touched test file', () => {
    const violations = checkTestLock([
      commit(
        SHA_A,
        'fix: change behaviour',
        change('src/a.test.ts', 'M', 3, 3),
        change('e2e/nav.spec.ts', 'M', 1, 1),
        change('labs/00/tests/main.tftest.hcl', 'D', 0, 9),
        change('src/a.ts', 'M', 4, 4),
      ),
    ]);
    expect(files(violations)).toEqual([
      'e2e/nav.spec.ts',
      'labs/00/tests/main.tftest.hcl',
      'src/a.test.ts',
    ]);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-3: the message names the short sha and the subject', () => {
    const subject = 'fix: loosen the assertion';
    const [violation] = checkTestLock([commit(SHA_A, subject, change('src/a.test.ts', 'M', 1, 1))]);
    expect(violation).toBeDefined();
    expect(violation?.message).toContain(short(SHA_A));
    expect(violation?.message).toContain(subject);
  });

  test('AC-3: a non-test commit touching only non-test files gives none', () => {
    const violations = checkTestLock([
      commit(
        SHA_A,
        'feat: add y',
        change('src/a.ts', 'M', 10, 4),
        change('docs/testing.md', 'A', 12, 0),
        change('vitest.config.ts', 'D', 0, 3),
        change('src/old.ts', 'R', 0, 0, 'src/older.ts'),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-3: no commits gives no violations', () => {
    expect(checkTestLock([])).toEqual([]);
  });

  test('AC-3: a commit without changes gives no violations', () => {
    expect(checkTestLock([commit(SHA_A, 'chore: empty')])).toEqual([]);
  });
});

describe('checkTestLock: test commits', () => {
  test('AC-4: a test commit that adds test files gives no violation', () => {
    const violations = checkTestLock([
      commit(
        SHA_A,
        'test(guardrails): add tests',
        change('src/a.test.ts', 'A', 40, 0),
        change('e2e/nav.spec.ts', 'A', 25, 0),
        change('src/a.ts', 'A', 3, 0),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-4: a test commit that only adds lines to an existing test file gives no violation', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'test: one more case', change('src/a.test.ts', 'M', 8, 0)),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-4: a breaking test commit (test!:) is still a test commit', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'test!: new contract', change('src/a.test.ts', 'M', 8, 0)),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-4: a test commit may change non-test files freely', () => {
    const violations = checkTestLock([
      commit(
        SHA_A,
        'test: add stubs',
        change('src/a.ts', 'M', 2, 9),
        change('src/old.ts', 'D', 0, 20),
        change('src/new.ts', 'R', 0, 0, 'src/older.ts'),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-4: a test commit that removes a line from a test file gives a violation for it', () => {
    const violations = checkTestLock([
      commit(
        SHA_A,
        'test: reword',
        change('src/a.test.ts', 'M', 3, 1),
        change('src/b.test.ts', 'M', 2, 0),
      ),
    ]);
    expect(files(violations)).toEqual(['src/a.test.ts']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-4: a modified line counts as a removed line', () => {
    // git reports a modified line as one added plus one removed.
    const violations = checkTestLock([
      commit(SHA_A, 'test: tweak', change('e2e/nav.spec.ts', 'M', 1, 1)),
    ]);
    expect(files(violations)).toEqual(['e2e/nav.spec.ts']);
  });

  test('AC-4: a test commit that deletes a test file gives a violation for it', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'test: drop', change('src/a.test.ts', 'D', 0, 30)),
    ]);
    expect(files(violations)).toEqual(['src/a.test.ts']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-4: a test commit that renames a test file gives a violation even with no line changes', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'test: move', change('src/b.test.ts', 'R', 0, 0, 'src/a.test.ts')),
    ]);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(ruleIds(violations)).toEqual(['test-lock']);
    for (const violation of violations) {
      expect(['src/a.test.ts', 'src/b.test.ts']).toContain(violation.file);
    }
  });

  test('AC-4: the message names the short sha and the subject', () => {
    const subject = 'test: shorten';
    const [violation] = checkTestLock([commit(SHA_B, subject, change('src/a.test.ts', 'D', 0, 4))]);
    expect(violation).toBeDefined();
    expect(violation?.message).toContain(short(SHA_B));
    expect(violation?.message).toContain(subject);
  });
});

describe('checkTestLock: spec, tests, code sequences', () => {
  const testCommit = commit(
    SHA_A,
    'test(guardrails): add tests and stubs',
    change('src/a.test.ts', 'A', 60, 0),
    change('src/a.ts', 'A', 6, 0),
  );
  const featCommit = commit(SHA_B, 'feat(guardrails): implement a', change('src/a.ts', 'M', 40, 6));

  test('AC-5: a test commit followed by a source-only feat commit passes', () => {
    expect(checkTestLock([testCommit, featCommit])).toEqual([]);
  });

  test('AC-5: the same sequence plus a fix commit editing the test file fails, naming that commit', () => {
    const fixCommit = commit(
      SHA_C,
      'fix(guardrails): make the test pass',
      change('src/a.test.ts', 'M', 2, 2),
      change('src/a.ts', 'M', 1, 1),
    );
    const violations = checkTestLock([testCommit, featCommit, fixCommit]);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(files(violations)).toEqual(['src/a.test.ts']);
    for (const violation of violations) {
      expect(violation.rule).toBe('test-lock');
      expect(violation.message).toContain(short(SHA_C));
      expect(violation.message).not.toContain(short(SHA_A));
      expect(violation.message).not.toContain(short(SHA_B));
    }
  });

  test('AC-5: every offending commit in the range is reported', () => {
    const violations = checkTestLock([
      testCommit,
      commit(SHA_C, 'fix: weaken', change('src/a.test.ts', 'M', 0, 3)),
      commit(SHA_D, 'refactor: tidy', change('src/a.test.ts', 'M', 1, 1)),
    ]);
    const text = violations.map((violation) => violation.message).join('\n');
    expect(text).toContain(short(SHA_C));
    expect(text).toContain(short(SHA_D));
    expect(text).not.toContain(short(SHA_A));
  });

  test('AC-5: a later test commit that only appends to the test file passes', () => {
    const more = commit(SHA_C, 'test: more cases', change('src/a.test.ts', 'M', 12, 0));
    expect(checkTestLock([testCommit, featCommit, more])).toEqual([]);
  });
});

describe('checkCommits', () => {
  const aiTrailer = `${TRAILER}${AI_NAME} Opus 5.5 <noreply@${AI_DOMAIN}>`;

  test('AC-6: flags the commit whose message has an AI attribution trailer, naming the short sha', () => {
    const violations = checkCommits([
      { sha: SHA_A, message: 'feat: add y\n\nSome body.\n' },
      { sha: SHA_B, message: `fix: z\n\n${aiTrailer}\n` },
      { sha: SHA_C, message: 'docs: update\n' },
    ]);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(ruleIds(violations)).toEqual(['ai-attribution']);
    for (const violation of violations) {
      expect(violation.file.length).toBeGreaterThanOrEqual(7);
      expect(violation.file.length).toBeLessThan(40);
      expect(SHA_B.startsWith(violation.file)).toBe(true);
    }
  });

  test('AC-6: flags each offending commit', () => {
    const violations = checkCommits([
      { sha: SHA_A, message: `feat: add y\n\n${aiTrailer}\n` },
      { sha: SHA_B, message: 'feat: clean\n' },
      { sha: SHA_C, message: `fix: z\n\n${aiTrailer}\n` },
    ]);
    const flagged = new Set(violations.map((violation) => violation.file));
    expect(flagged.size).toBe(2);
    expect([...flagged].some((file) => SHA_A.startsWith(file))).toBe(true);
    expect([...flagged].some((file) => SHA_C.startsWith(file))).toBe(true);
  });

  test('AC-6: clean commits pass', () => {
    expect(
      checkCommits([
        { sha: SHA_A, message: 'feat: add y\n' },
        { sha: SHA_B, message: `fix: z\n\n${TRAILER}Jane <jane@example.com>\n` },
      ]),
    ).toEqual([]);
  });

  test('AC-6: no commits gives no violations', () => {
    expect(checkCommits([])).toEqual([]);
  });
});
