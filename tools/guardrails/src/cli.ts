// Guardrails CLI (private spec 003): argument parsing, git calls, I/O and exit codes only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

class UsageError extends Error {}

/** A file to check: how it is reported, and how to read its bytes (undefined if unreadable). */
interface Target {
  name: string;
  read: () => Buffer | undefined;
}

function git(args: string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitList(args: string[]): string[] {
  return git(args).toString('utf8').split('\0').filter(Boolean);
}

function fromDisk(name: string): Target {
  return {
    name,
    read: () => {
      try {
        return readFileSync(name);
      } catch {
        return undefined; // deleted, or not a regular file
      }
    },
  };
}

function fromIndex(name: string): Target {
  return { name, read: () => git(['show', `:0:${name}`]) };
}

function pathTargets(args: string[]): Target[] {
  const [first] = args;
  if (args.length === 1 && first === '--staged') {
    return gitList(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).map(fromIndex);
  }
  if (args.length === 1 && first === '--all') {
    return gitList(['ls-files', '-z']).map(fromDisk);
  }
  if (args.length === 0 || args.some((arg) => arg.startsWith('--'))) throw new UsageError();
  return args.map(fromDisk);
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
      const lines = message.split(/\r?\n/).filter((line) => !line.startsWith('#'));
      return checkCommitMessage(lines.join('\n'));
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
