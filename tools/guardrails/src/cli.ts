// Guardrails CLI: argument parsing, git calls, I/O and exit codes only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkCommitMessage,
  checkContent,
  checkPath,
  checkPushRefs,
  checkQuestionFile,
  isQuestionFile,
} from './rules.ts';
import type { Violation } from './rules.ts';
import {
  checkCommits,
  checkNoMerges,
  checkTestControl,
  checkTestLock,
  isPackageJson,
} from './test-lock.ts';
import type { CommitChange, CommitInfo } from './test-lock.ts';

const USAGE = `Usage:
  guardrails paths [--staged | --all | <files...>]
  guardrails commit-msg <file>
  guardrails pre-push   (reads git pre-push lines on stdin)
  guardrails test-lock --base <ref> [--head <ref>]
  guardrails no-merges --base <ref> [--head <ref>]
  guardrails commits --base <ref> [--head <ref>]`;

/** `git commit -v` appends the diff below this line; it is not part of the message. */
const SCISSORS_LINE = '# ------------------------ >8 ------------------------';

class UsageError extends Error {}

/** A file to check: how it is reported, and how to read its bytes (undefined if unreadable). */
interface Target {
  name: string;
  read: () => Buffer | undefined;
}

let repoRoot: string | undefined;

/** The repository top level: index paths are relative to it, whatever the working directory. */
function topLevel(): string {
  repoRoot ??= execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  return repoRoot;
}

/** Runs git from the repository top level. */
function git(args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: topLevel(),
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitList(args: string[]): string[] {
  return git(args).toString('utf8').split('\0').filter(Boolean);
}

/** `path` is read as given; `name` is how it is reported. */
function fromDisk(name: string, path = name): Target {
  return {
    name,
    read: () => {
      try {
        return readFileSync(path);
      } catch {
        return undefined; // deleted, or not a regular file
      }
    },
  };
}

/**
 * Only regular files have content to check: not gitlinks (160000) or symlinks (120000).
 * An unknown mode counts as regular, so a lookup miss reads the content instead of skipping it.
 */
function isRegular(mode: string | undefined): boolean {
  return mode !== '160000' && mode !== '120000';
}

/** Index entries as `path -> mode` (`git ls-files -s -z` prints `<mode> <sha> <stage>\t<path>`). */
function indexModes(): Map<string, string> {
  const modes = new Map<string, string>();
  for (const entry of gitList(['ls-files', '-s', '-z', '--full-name'])) {
    const tab = entry.indexOf('\t');
    modes.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(' ')));
  }
  return modes;
}

function fromIndex(name: string, mode: string | undefined): Target {
  return { name, read: () => (isRegular(mode) ? git(['show', `:0:${name}`]) : undefined) };
}

function pathTargets(args: string[]): Target[] {
  const [first] = args;
  if (args.length === 1 && first === '--staged') {
    const modes = indexModes();
    // Everything but deletions, so type changes are checked too.
    return gitList(['diff', '--cached', '--name-only', '--diff-filter=d', '-z']).map((name) =>
      fromIndex(name, modes.get(name)),
    );
  }
  if (args.length === 1 && first === '--all') {
    return [...indexModes()].map(([name, mode]) =>
      isRegular(mode) ? fromDisk(name, join(topLevel(), name)) : { name, read: () => undefined },
    );
  }
  if (args.length === 0 || args.some((arg) => arg.startsWith('--'))) throw new UsageError();
  return args.map((arg) => fromDisk(arg));
}

function checkTarget({ name, read }: Target): Violation[] {
  const violations = checkPath(name);
  const content = read();
  if (content === undefined) return violations;
  const text = content.toString('utf8');
  violations.push(...checkContent(name, text));
  if (isQuestionFile(name) && !content.includes(0)) {
    violations.push(...checkQuestionFile(name, text));
  }
  return violations;
}

/** Parses `--base <ref> [--head <ref>]`; the head defaults to HEAD. */
function parseRange(args: string[]): string {
  let base: string | undefined;
  let head = 'HEAD';
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('-')) throw new UsageError();
    if (args[i] === '--base') base = value;
    else if (args[i] === '--head') head = value;
    else throw new UsageError();
  }
  if (base === undefined) throw new UsageError();
  return `${base}..${head}`;
}

/** The non-merge commits of a range, oldest first. */
function rangeShas(range: string): string[] {
  return git(['rev-list', '--no-merges', '--reverse', range, '--'])
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
}

/** The merge commits of a range with their subject and parent count. */
function mergeCommits(range: string): { sha: string; subject: string; parents: number }[] {
  const lines = git(['rev-list', '--merges', '--parents', '--reverse', range, '--'])
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  return lines.map((line) => {
    const [sha = '', ...parents] = line.split(' ');
    return {
      sha,
      subject: git(['log', '-1', '--format=%s', sha]).toString('utf8').trim(),
      parents: parents.length,
    };
  });
}

/** Parses `git show --name-status -z`: `<status>\0<path>\0`, or `<status>\0<old>\0<new>\0` for R/C. */
function parseNameStatus(tokens: string[]): Omit<CommitChange, 'added' | 'removed'>[] {
  const entries: Omit<CommitChange, 'added' | 'removed'>[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = (tokens[i] ?? '').charAt(0) as CommitChange['status'];
    if (status === 'R' || status === 'C') {
      entries.push({ status, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 3;
    } else {
      entries.push({ status, path: tokens[i + 1] ?? '' });
      i += 2;
    }
  }
  return entries;
}

/** Parses `git show --numstat -z`: `<added>\t<removed>\t<path>\0`, or `...\t\0<old>\0<new>\0` for R/C. */
function parseNumstat(tokens: string[]): { added: number; removed: number }[] {
  const entries: { added: number; removed: number }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const [added = '', removed = '', ...path] = (tokens[i] ?? '').split('\t');
    // Binary files report "-": their lines cannot be compared, so they count as fully changed.
    entries.push({
      added: added === '-' ? 1 : Number(added),
      removed: removed === '-' ? 1 : Number(removed),
    });
    if (path.join('\t') === '') i += 2;
  }
  return entries;
}

/** The added and removed lines of one file in one commit (`git show -U0`), without the +/- prefix. */
function fileLines(sha: string, path: string): NonNullable<CommitChange['lines']> {
  const diff = git([
    '--literal-pathspecs',
    'show',
    '--format=',
    '-U0',
    '--no-color',
    sha,
    '--',
    path,
  ]).toString('utf8');
  const lines: NonNullable<CommitChange['lines']> = { added: [], removed: [] };
  let inHunk = false; // the +++/--- headers come before the first hunk, so they are skipped
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) lines.added.push(line.slice(1));
    else if (inHunk && line.startsWith('-')) lines.removed.push(line.slice(1));
  }
  return lines;
}

function commitInfo(sha: string): CommitInfo {
  const show = (flag: string): string[] => gitList(['show', '--format=', flag, '-M', '-z', sha]);
  const numstat = parseNumstat(show('--numstat'));
  const changes = parseNameStatus(show('--name-status')).map((entry, index) => {
    const counts = numstat[index] ?? { added: 0, removed: 0 };
    // A new file has nothing to remove (a binary one reports "-" for both counts).
    const change = {
      ...entry,
      added: counts.added,
      removed: entry.status === 'A' ? 0 : counts.removed,
    };
    // Counts cannot tell which package.json lines changed, so the test-control check needs them.
    return isPackageJson(entry.path) ? { ...change, lines: fileLines(sha, entry.path) } : change;
  });
  const subject = git(['log', '-1', '--format=%s', sha]).toString('utf8').trim();
  return { sha, subject, changes };
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return ''; // no stdin attached
  }
}

function commandViolations(command: string, args: string[]): Violation[] {
  switch (command) {
    case 'paths':
      return pathTargets(args).flatMap(checkTarget);
    case 'commit-msg': {
      const [file] = args;
      if (args.length !== 1 || file === undefined) throw new UsageError();
      let message: string;
      try {
        message = readFileSync(file, 'utf8');
      } catch {
        throw new UsageError();
      }
      const lines = message.split(/\r?\n/);
      const scissors = lines.indexOf(SCISSORS_LINE);
      const body = scissors === -1 ? lines : lines.slice(0, scissors);
      return checkCommitMessage(body.filter((line) => !line.startsWith('#')).join('\n'));
    }
    case 'pre-push':
      if (args.length > 0) throw new UsageError();
      return checkPushRefs(readStdin());
    case 'test-lock': {
      const commits = rangeShas(parseRange(args)).map(commitInfo);
      return [...checkTestLock(commits), ...checkTestControl(commits)];
    }
    case 'no-merges':
      return checkNoMerges(mergeCommits(parseRange(args)));
    case 'commits':
      return checkCommits(
        rangeShas(parseRange(args)).map((sha) => ({
          sha,
          message: git(['log', '-1', '--format=%B', sha]).toString('utf8'),
        })),
      );
    default:
      throw new UsageError();
  }
}

/** Runs one CLI command and resolves to the process exit code (0 ok, 1 violations, 2 usage). */
export function main(argv: string[]): Promise<number> {
  const [command = '', ...args] = argv;
  let violations: Violation[];
  try {
    violations = commandViolations(command, args);
  } catch (error) {
    console.error(error instanceof UsageError ? USAGE : String(error));
    return Promise.resolve(2);
  }

  for (const { file, rule, message } of violations) {
    console.log(`✖ ${file} [${rule}] ${message}`);
  }
  if (violations.length > 0) {
    console.log(`guardrails: ${violations.length} violation(s) found by ${command}`);
    return Promise.resolve(1);
  }
  console.log(`✔ guardrails: ${command} ok`);
  return Promise.resolve(0);
}

process.exitCode = await main(process.argv.slice(2));
