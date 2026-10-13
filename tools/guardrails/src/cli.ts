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

const USAGE = `Usage:
  guardrails paths [--staged | --all | <files...>]
  guardrails commit-msg <file>
  guardrails pre-push   (reads git pre-push lines on stdin)`;

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
