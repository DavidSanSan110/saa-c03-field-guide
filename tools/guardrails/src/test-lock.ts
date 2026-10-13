// Test-lock and commit checks for CI.
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

export function isTestPath(path: string): boolean {
  void path;
  throw new Error('not implemented');
}

export function isTestCommit(subject: string): boolean {
  void subject;
  throw new Error('not implemented');
}

export function checkTestLock(commits: CommitInfo[]): Violation[] {
  void commits;
  throw new Error('not implemented');
}

export function checkCommits(commits: { sha: string; message: string }[]): Violation[] {
  void commits;
  throw new Error('not implemented');
}
