// Test-lock and commit checks for CI: pure functions over data that the CLI reads from git.
import { checkCommitMessage } from './rules.ts';
import type { Violation } from './rules.ts';

export interface CommitChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  oldPath?: string;
  added: number;
  removed: number;
  /** Diff lines without the +/- prefix; the CLI fills it for package.json files only. */
  lines?: { added: string[]; removed: string[] };
}

export interface CommitInfo {
  sha: string;
  subject: string;
  changes: CommitChange[];
  /** Number of parents; a missing value means 1. */
  parents?: number;
}

const TEST_FILE_NAME = /\.(test|spec)\.(ts|tsx|js|mjs)$|\.tftest\.hcl$/;
const TEST_COMMIT_SUBJECT = /^test(\([^()\s]*\))?!?: /;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** True for test files: unit and spec files, Terraform tests, `e2e/` and snapshot directories. */
export function isTestPath(path: string): boolean {
  const segments = path
    .replaceAll('\\', '/')
    .replace(/^(\.\/)+/, '')
    .toLowerCase()
    .split('/');
  const name = segments.pop() ?? '';
  return (
    TEST_FILE_NAME.test(name) ||
    segments.some(
      (segment) =>
        segment === 'e2e' || segment === '__snapshots__' || segment.endsWith('-snapshots'),
    )
  );
}

/** True when the subject is a conventional commit of type `test`. */
export function isTestCommit(subject: string): boolean {
  return TEST_COMMIT_SUBJECT.test(subject);
}

/** The test file a change touches (its new path, or the old one if it was moved away), if any. */
function touchedTestPath({ path, oldPath }: CommitChange): string | undefined {
  if (isTestPath(path)) return path;
  return oldPath !== undefined && isTestPath(oldPath) ? oldPath : undefined;
}

/** What a test commit may not do to a test file: delete, rename or retype it, or remove lines. */
function weakensTest(change: CommitChange): boolean {
  if (change.status === 'D' || change.status === 'T') return true;
  if (change.status === 'R' && change.oldPath !== undefined && isTestPath(change.oldPath)) {
    return true;
  }
  return change.removed > 0;
}

export function checkTestLock(commits: CommitInfo[]): Violation[] {
  const violations: Violation[] = [];
  for (const { sha, subject, changes } of commits) {
    const testCommit = isTestCommit(subject);
    const flagged = new Set<string>();
    for (const change of changes) {
      const file = touchedTestPath(change);
      if (file === undefined || flagged.has(file)) continue;
      if (testCommit && !weakensTest(change)) continue;
      flagged.add(file);
      violations.push({
        file,
        rule: 'test-lock',
        message: testCommit
          ? `commit ${shortSha(sha)} "${subject}" deletes, renames or removes lines from a test file`
          : `commit ${shortSha(sha)} "${subject}" is not a test commit but changes a test file`,
      });
    }
  }
  return violations;
}

const RUNNER_CONFIG_NAME =
  /^(vitest\.config|vitest\.workspace|vite\.config|playwright\.config)\.(js|mjs|cjs|ts|mts|cts)$|^stryker\.(conf|config)\.(json|js|mjs|cjs|ts|mts|cts)$/;
const SETUP_FILE_NAME =
  /^(.+\.setup|setuptests|setup-tests|test-setup|global-setup|global-teardown)\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const TEST_DIR_SETUP_NAME = /^setup\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const TEST_CONTROL_LINE =
  /pass-with-no-tests|passwithnotests|^\s*"(test|coverage|e2e)(:[^"]*)?"\s*:/i;

/** True for files that decide which tests run and how strictly (runner configs, setup files, mocks). */
export function isTestControlPath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').toLowerCase().split('/');
  const name = segments.pop() ?? '';
  const directory = segments.at(-1);
  return (
    RUNNER_CONFIG_NAME.test(name) ||
    SETUP_FILE_NAME.test(name) ||
    ((directory === 'test' || directory === 'tests') && TEST_DIR_SETUP_NAME.test(name)) ||
    segments.includes('__mocks__')
  );
}

/** True for a package.json diff line (prefix already stripped) that controls the test scripts. */
export function isTestControlLine(line: string): boolean {
  return TEST_CONTROL_LINE.test(line);
}

/** The file a change puts under test control: a test-control path, or a package.json with such lines. */
function touchedControlFile({ path, oldPath, lines }: CommitChange): string | undefined {
  if (isTestControlPath(path)) return path;
  if (oldPath !== undefined && isTestControlPath(oldPath)) return oldPath;
  const isPackageJson =
    path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() === 'package.json';
  const changed = [...(lines?.added ?? []), ...(lines?.removed ?? [])];
  return isPackageJson && changed.some(isTestControlLine) ? path : undefined;
}

/** Rules 3 and 4 of spec 005: non-test commits must not change test-control files or lines. */
export function checkTestControl(commits: CommitInfo[]): Violation[] {
  const violations: Violation[] = [];
  for (const { sha, subject, changes } of commits) {
    if (isTestCommit(subject)) continue;
    const flagged = new Set<string>();
    for (const change of changes) {
      const file = touchedControlFile(change);
      if (file === undefined || flagged.has(file)) continue;
      flagged.add(file);
      violations.push({
        file,
        rule: 'test-lock',
        message: `commit ${shortSha(sha)} "${subject}" is not a test commit but changes a test-control file or script`,
      });
    }
  }
  return violations;
}

/** One `no-merges` violation per commit with two or more parents. */
export function checkNoMerges(
  commits: { sha: string; subject: string; parents: number }[],
): Violation[] {
  return commits
    .filter(({ parents }) => parents >= 2)
    .map(({ sha, subject }) => ({
      file: shortSha(sha),
      rule: 'no-merges',
      message: `merge commit "${subject}": rebase on the base branch instead of merging it`,
    }));
}

export function checkCommits(commits: { sha: string; message: string }[]): Violation[] {
  return commits.flatMap(({ sha, message }) =>
    checkCommitMessage(message).map((violation) => ({ ...violation, file: shortSha(sha) })),
  );
}
