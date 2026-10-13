// Test-lock and commit checks for CI: pure functions over data that the CLI reads from git.
import { checkCommitMessage } from './rules.ts';
import type { Violation } from './rules.ts';

export interface CommitChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  oldPath?: string;
  added: number;
  removed: number;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  changes: CommitChange[];
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

export function checkCommits(commits: { sha: string; message: string }[]): Violation[] {
  return commits.flatMap(({ sha, message }) =>
    checkCommitMessage(message).map((violation) => ({ ...violation, file: shortSha(sha) })),
  );
}
