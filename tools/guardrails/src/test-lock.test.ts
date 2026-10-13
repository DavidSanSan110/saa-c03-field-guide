import { describe, expect, test } from 'vitest';
import type { Violation } from './rules.ts';
import { checkCommits, checkTestLock, isTestCommit, isTestPath } from './test-lock.ts';
import type { CommitChange, CommitInfo } from './test-lock.ts';
import {
  checkNoMerges,
  checkTestControl,
  isTestControlLine,
  isTestControlPath,
} from './test-lock.ts';

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

// ---- Spec 005: test-control files, test-control lines and merge commits -----------------------

/** A change that carries the diff lines the CLI collects for package.json files. */
function withLines(
  path: string,
  added: string[],
  removed: string[] = [],
  status: CommitChange['status'] = 'M',
): CommitChange {
  return { path, status, added: added.length, removed: removed.length, lines: { added, removed } };
}

describe('isTestControlPath', () => {
  test.each([
    'vitest.config.ts',
    'packages/schema/vitest.config.ts',
    'apps/site/vitest.config.mts',
    'vitest.workspace.ts',
    'vite.config.js',
    'playwright.config.ts',
    'PLAYWRIGHT.CONFIG.TS',
    'stryker.config.mjs',
    'stryker.conf.json',
    'vitest.setup.ts',
    'e2e-support/auth.setup.ts',
    'src/setupTests.tsx',
    'test/setup-tests.js',
    'global-setup.ts',
    'tests/setup.ts',
    'packages/x/test/setup.mts',
    'src/__mocks__/fs.ts',
    'packages\\x\\vitest.config.ts',
  ])('AC-1: %s is a test-control path', (path) => {
    expect(isTestControlPath(path)).toBe(true);
  });

  test.each([
    'package.json',
    'tsconfig.json',
    'src/config.ts',
    'src/setup.ts',
    'docs/vitest.config.md',
    'astro.config.mjs',
    'eslint.config.js',
    'src/setup-guide.ts',
    'vitest.config.ts.bak',
  ])('AC-1: %s is not a test-control path', (path) => {
    expect(isTestControlPath(path)).toBe(false);
  });

  test.each([
    'vitest.config.cjs',
    'vitest.config.cts',
    'vitest.workspace.mjs',
    'vite.config.mts',
    'playwright.config.js',
    'stryker.conf.ts',
    'stryker.config.json',
    'a.setup.jsx',
    'setupTests.ts',
    'test-setup.cts',
    'global-teardown.mjs',
    'packages/x/Tests/Setup.TS',
    'packages/x/src/__mocks__/deep/dir/thing.json',
  ])('AC-1: %s (other extension, depth or case) is a test-control path', (path) => {
    expect(isTestControlPath(path)).toBe(true);
  });

  test.each([
    '.setup.ts',
    'vitest.config.json',
    'vite.config.tsx',
    'stryker.config.yaml',
    'setup.ts',
    'src/test/helpers.ts',
    'src/test/nested/setup.ts',
    'src/mocks/fs.ts',
  ])('AC-1: %s is not a test-control path', (path) => {
    expect(isTestControlPath(path)).toBe(false);
  });
});

describe('isTestControlLine', () => {
  test.each([
    '    "e2e": "playwright test --pass-with-no-tests",',
    '"test": "vitest run --passWithNoTests"',
    '"test:unit": "vitest run"',
    '  "coverage": "vitest run --coverage",',
    '"e2e:ui": "playwright test --ui"',
    'passwithnotests: true',
  ])('AC-2: %s is a test-control line', (line) => {
    expect(isTestControlLine(line)).toBe(true);
  });

  test.each([
    '"vitest": "^5.0.3",',
    '"typecheck": "tsc -p tsconfig.json"',
    '"testing-library": "^1.0.0",',
    '"lint": "eslint ."',
    '"name": "e2e-helpers",',
  ])('AC-2: %s is not a test-control line', (line) => {
    expect(isTestControlLine(line)).toBe(false);
  });

  test.each([
    '"coverage:ci": "vitest run --coverage"',
    '"e2e:smoke": "playwright test smoke"',
    '"build": "vitest run --PASS-WITH-NO-TESTS"',
    '\t"test"  :  "vitest run"',
  ])('AC-2: %s (other script name, spacing or case) is a test-control line', (line) => {
    expect(isTestControlLine(line)).toBe(true);
  });

  test.each(['"pretest": "node check.js"', '"latest": "1.0.0"', '"coverage-report": "open x"', ''])(
    'AC-2: "%s" is not a test-control line',
    (line) => {
      expect(isTestControlLine(line)).toBe(false);
    },
  );
});

describe('checkTestControl: non-test commits and test-control files', () => {
  test.each([
    ['adds a runner config', change('vitest.config.ts', 'A')],
    ['modifies a runner config', change('packages/x/vitest.config.ts', 'M', 2, 1)],
    ['deletes a setup file', change('vitest.setup.ts', 'D', 0, 7)],
    ['deletes a mock', change('src/__mocks__/fs.ts', 'D', 0, 7)],
    ['modifies a setup file in a tests directory', change('tests/setup.ts', 'M', 1, 1)],
    ['adds a Playwright config', change('playwright.config.ts', 'A', 30, 0)],
  ])('AC-3: a feat commit that %s gives one test-lock violation for it', (_name, c) => {
    const violations = checkTestControl([commit(SHA_A, 'feat: add y', c)]);
    expect(files(violations)).toEqual([c.path]);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-3: a rename away from a test-control path reports the old path', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'refactor: move', change('src/vitest.ts', 'R', 0, 0, 'vitest.config.ts')),
    ]);
    expect(files(violations)).toEqual(['vitest.config.ts']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-3: a rename into a test-control path reports the new path', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'refactor: move', change('vitest.config.ts', 'R', 0, 0, 'src/vitest.ts')),
    ]);
    expect(files(violations)).toEqual(['vitest.config.ts']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-3: a rename from one test-control path to another reports the new path once', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'refactor: move', change('vitest.config.mts', 'R', 0, 0, 'vitest.config.ts')),
    ]);
    expect(files(violations)).toEqual(['vitest.config.mts']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-3: gives one violation per touched test-control file', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'fix: change behaviour',
        change('vitest.config.ts', 'M', 3, 3),
        change('packages/x/vitest.setup.ts', 'M', 1, 1),
        change('src/__mocks__/fs.ts', 'D', 0, 9),
        change('src/a.ts', 'M', 4, 4),
      ),
    ]);
    expect(files(violations)).toEqual([
      'packages/x/vitest.setup.ts',
      'src/__mocks__/fs.ts',
      'vitest.config.ts',
    ]);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-3: the message names the short sha, the subject and test-control', () => {
    const subject = 'fix: stop running the slow suite';
    const [violation] = checkTestControl([
      commit(SHA_B, subject, change('vitest.config.ts', 'M', 1, 1)),
    ]);
    expect(violation).toBeDefined();
    expect(violation?.message).toContain(short(SHA_B));
    expect(violation?.message).toContain(subject);
    expect(violation?.message).toContain('test-control');
  });

  test('AC-3: a non-test commit touching only ordinary source gives none', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'feat: add y',
        change('src/a.ts', 'M', 10, 4),
        change('src/setup.ts', 'M', 2, 2),
        change('src/config.ts', 'D', 0, 5),
        change('astro.config.mjs', 'M', 1, 1),
        change('eslint.config.js', 'A', 9, 0),
        change('docs/vitest.config.md', 'A', 3, 0),
        change('tsconfig.json', 'M', 1, 1),
        change('package.json', 'M', 1, 1),
        change('src/old.ts', 'R', 0, 0, 'src/older.ts'),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-3: a non-test commit touching only test files gives none (that is checkTestLock)', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'fix: change behaviour',
        change('src/a.test.ts', 'M', 3, 3),
        change('e2e/nav.spec.ts', 'D', 0, 9),
        change('labs/00/tests/main.tftest.hcl', 'A', 4, 0),
        change('src/b.test.ts', 'R', 0, 0, 'src/a.test.ts'),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-3: no commits and a commit without changes give no violations', () => {
    expect(checkTestControl([])).toEqual([]);
    expect(checkTestControl([commit(SHA_A, 'chore: empty')])).toEqual([]);
  });

  test('AC-3: a violation in one commit does not hide the others in the range', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'feat: add y', change('src/a.ts', 'M', 1, 1)),
      commit(SHA_B, 'fix: loosen', change('vitest.config.ts', 'M', 1, 1)),
      commit(SHA_C, 'chore: tidy', change('vitest.setup.ts', 'D', 0, 1)),
    ]);
    const text = violations.map((violation) => violation.message).join('\n');
    expect(text).toContain(short(SHA_B));
    expect(text).toContain(short(SHA_C));
    expect(text).not.toContain(short(SHA_A));
  });
});

describe('checkTestControl: test commits and test-control files', () => {
  test.each([
    ['adds', change('vitest.config.ts', 'A', 12, 0)],
    ['modifies, removing lines from,', change('playwright.config.ts', 'M', 3, 2)],
    ['deletes', change('vitest.setup.ts', 'D', 0, 7)],
    ['renames', change('vitest.config.mts', 'R', 0, 0, 'vitest.config.ts')],
    ['deletes a mock in', change('src/__mocks__/fs.ts', 'D', 0, 4)],
  ])('AC-4: a test commit that %s a test-control file gives no violation', (_name, c) => {
    expect(checkTestControl([commit(SHA_A, 'test(guardrails): adjust the runner', c)])).toEqual([]);
  });

  test('AC-4: a breaking test commit (test!:) may also change test-control files', () => {
    expect(
      checkTestControl([commit(SHA_A, 'test!: new runner', change('vitest.config.ts', 'M', 4, 4))]),
    ).toEqual([]);
  });

  test('AC-4: a test commit changing control files and test files together gives no violation', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'test: reword',
        change('vitest.config.ts', 'M', 3, 3),
        change('src/a.test.ts', 'M', 3, 1),
      ),
    ]);
    expect(violations).toEqual([]);
  });
});

describe('checkTestControl: test-control lines in package.json', () => {
  test.each([
    ['adds the pass-with-no-tests flag', ['"e2e": "playwright test --pass-with-no-tests",'], []],
    ['adds passWithNoTests', ['"test": "vitest run --passWithNoTests"'], []],
    ['removes the test script', [], ['"test": "vitest run",']],
    ['edits a coverage script', ['"coverage": "echo skipped",'], ['"coverage": "vitest run",']],
  ])('AC-5: a feat commit that %s gives one test-lock violation for package.json', (_n, a, r) => {
    const violations = checkTestControl([
      commit(SHA_A, 'feat: change scripts', withLines('package.json', a, r)),
    ]);
    expect(files(violations)).toEqual(['package.json']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
  });

  test('AC-5: a package.json in a subdirectory is reported with its own path', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'fix: speed up',
        withLines('packages/schema/package.json', ['"test:unit": "echo skipped",']),
      ),
    ]);
    expect(files(violations)).toEqual(['packages/schema/package.json']);
  });

  test('AC-5: several test-control lines in one file give one violation', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'feat: rework scripts',
        withLines(
          'package.json',
          ['"test": "vitest run --passWithNoTests",', '"e2e": "playwright test",'],
          ['"test": "vitest run",', '"coverage:ci": "vitest run --coverage",'],
        ),
      ),
    ]);
    expect(files(violations)).toEqual(['package.json']);
  });

  test('AC-5: the message names the short sha, the subject and test-control', () => {
    const subject = 'feat: tolerate empty suites';
    const [violation] = checkTestControl([
      commit(SHA_C, subject, withLines('package.json', ['"test": "vitest run --passWithNoTests"'])),
    ]);
    expect(violation).toBeDefined();
    expect(violation?.message).toContain(short(SHA_C));
    expect(violation?.message).toContain(subject);
    expect(violation?.message).toContain('test-control');
  });

  test('AC-5: dependency, version and other script lines give none', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'chore(deps): bump vitest',
        withLines(
          'package.json',
          ['"vitest": "^5.0.4",', '"lint": "eslint --max-warnings 0 .",', '"version": "1.2.0",'],
          ['"vitest": "^5.0.3",', '"lint": "eslint .",', '"version": "1.1.0",'],
        ),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-5: a package.json change without lines gives none', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'feat: change scripts', change('package.json', 'M', 3, 3)),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-5: a package.json change with empty lines gives none', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'feat: nothing', withLines('package.json', [], [])),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-5: a test commit with test-control lines gives none', () => {
    const violations = checkTestControl([
      commit(
        SHA_A,
        'test(guardrails): wire the new runner',
        withLines(
          'package.json',
          ['"test": "vitest run --passWithNoTests",'],
          ['"test": "vitest run",'],
        ),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-5: test-control lines outside a package.json are not line-checked', () => {
    const violations = checkTestControl([
      commit(SHA_A, 'feat: add y', withLines('src/a.ts', ['"test": "not a script",'])),
    ]);
    expect(violations).toEqual([]);
  });
});

describe('checkTestLock: spec 004 behaviour is unchanged', () => {
  test('AC-6: a non-test commit editing a test file is still flagged, naming the sha and subject', () => {
    const subject = 'fix: loosen the assertion';
    const violations = checkTestLock([commit(SHA_A, subject, change('src/a.test.ts', 'M', 1, 1))]);
    expect(files(violations)).toEqual(['src/a.test.ts']);
    expect(ruleIds(violations)).toEqual(['test-lock']);
    expect(violations[0]?.message).toContain(short(SHA_A));
    expect(violations[0]?.message).toContain(subject);
    expect(violations[0]?.message).not.toContain('test-control');
  });

  test('AC-6: a test commit that only adds lines to a test file still passes', () => {
    expect(
      checkTestLock([commit(SHA_A, 'test: one more case', change('src/a.test.ts', 'M', 8, 0))]),
    ).toEqual([]);
  });

  test('AC-6: a test commit that removes a line from a test file is still flagged', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'test: trim', change('src/a.test.ts', 'M', 0, 1)),
    ]);
    expect(files(violations)).toEqual(['src/a.test.ts']);
  });

  test('AC-6: vitest.config.ts is still not a test path', () => {
    expect(isTestPath('vitest.config.ts')).toBe(false);
    expect(isTestPath('src/__mocks__/fs.ts')).toBe(false);
    expect(isTestPath('vitest.setup.ts')).toBe(false);
  });

  test('AC-6: a feat commit deleting vitest.config.ts gives no checkTestLock violation', () => {
    expect(
      checkTestLock([commit(SHA_A, 'feat: drop config', change('vitest.config.ts', 'D', 0, 3))]),
    ).toEqual([]);
  });

  test.each([
    change('vitest.setup.ts', 'D', 0, 7),
    change('playwright.config.ts', 'M', 2, 2),
    change('src/__mocks__/fs.ts', 'A', 5, 0),
    change('tests/setup.ts', 'M', 1, 1),
    change('vitest.config.mts', 'R', 0, 0, 'vitest.config.ts'),
  ])('AC-6: checkTestLock ignores the test-control file $path', (c) => {
    expect(checkTestLock([commit(SHA_A, 'fix: tweak', c)])).toEqual([]);
  });

  test('AC-6: a feat commit adding --pass-with-no-tests to package.json gives no checkTestLock violation', () => {
    const violations = checkTestLock([
      commit(
        SHA_A,
        'feat: tolerate empty suites',
        withLines(
          'package.json',
          ['"e2e": "playwright test --pass-with-no-tests",'],
          ['"e2e": "playwright test",'],
        ),
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test('AC-6: a test file that is also a test-control path is still reported once by checkTestLock', () => {
    const violations = checkTestLock([
      commit(SHA_A, 'fix: tweak', change('e2e/auth.setup.ts', 'M', 1, 1)),
    ]);
    expect(files(violations)).toEqual(['e2e/auth.setup.ts']);
    expect(violations[0]?.message).not.toContain('test-control');
  });

  test('AC-6: explicit single-parent commits behave like commits without parents', () => {
    const plain = commit(SHA_A, 'fix: loosen', change('src/a.test.ts', 'M', 1, 1));
    expect(checkTestLock([{ ...plain, parents: 1 }])).toEqual(checkTestLock([plain]));
  });
});

describe('checkNoMerges', () => {
  test('AC-7: gives one no-merges violation per merge commit, naming the short sha and subject', () => {
    const violations = checkNoMerges([
      { sha: SHA_A, subject: 'feat: add y', parents: 1 },
      { sha: SHA_B, subject: "Merge branch 'main' into feature", parents: 2 },
      { sha: SHA_C, subject: 'fix: z', parents: 1 },
      { sha: SHA_D, subject: 'Merge octopus', parents: 3 },
    ]);
    expect(violations.map((violation) => violation.file)).toEqual([short(SHA_B), short(SHA_D)]);
    expect(ruleIds(violations)).toEqual(['no-merges']);
    expect(violations[0]?.message).toContain("Merge branch 'main' into feature");
    expect(violations[1]?.message).toContain('Merge octopus');
  });

  test('AC-7: the file is the 7-character short sha', () => {
    const [violation] = checkNoMerges([{ sha: SHA_A, subject: 'Merge x', parents: 2 }]);
    expect(violation?.file).toBe(short(SHA_A));
    expect(violation?.file).toHaveLength(7);
  });

  test('AC-7: the message tells to rebase instead of merging', () => {
    const [violation] = checkNoMerges([{ sha: SHA_A, subject: 'Merge x', parents: 2 }]);
    expect(violation).toBeDefined();
    expect(violation?.message).toMatch(/rebase/i);
  });

  test('AC-7: single-parent commits give none', () => {
    expect(
      checkNoMerges([
        { sha: SHA_A, subject: 'feat: add y', parents: 1 },
        { sha: SHA_B, subject: 'Merge-looking subject', parents: 1 },
      ]),
    ).toEqual([]);
  });

  test('AC-7: an empty list gives none', () => {
    expect(checkNoMerges([])).toEqual([]);
  });
});
