// Questions CLI: argument parsing, file I/O and exit codes only; the logic is in bank.ts.
import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isTaskId } from '@field-guide/schema';
import {
  collectIds,
  findIdCollisions,
  nextId,
  planPromote,
  readBank,
  sidecarPath,
} from './bank.ts';
import type { BankResult, FileMap, Problem } from './bank.ts';

const USAGE = `Usage:
  questions check [options]                      read both folders and print every problem
  questions next-id <task> [options]             print the next free question id of a task
  questions promote [--dry-run] [<id>...] [options]
                                                 move reviewed drafts into the public bank

Options (every command):
  --drafts <dir>   drafts folder (default private/questions-drafts)
  --bank <dir>     public bank folder (default questions)`;

const DEFAULT_DRAFTS = 'private/questions-drafts';
const DEFAULT_BANK = 'questions';

class UsageError extends Error {}

interface Options {
  command: string;
  drafts: string;
  bank: string;
  dryRun: boolean;
  positionals: string[];
}

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command !== 'check' && command !== 'next-id' && command !== 'promote') throw new UsageError();
  const options: Options = {
    command,
    drafts: DEFAULT_DRAFTS,
    bank: DEFAULT_BANK,
    dryRun: false,
    positionals: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--drafts' || arg === '--bank') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError();
      if (arg === '--drafts') options.drafts = value;
      else options.bank = value;
    } else if (arg === '--dry-run' && command === 'promote') {
      options.dryRun = true;
    } else if (arg.startsWith('--')) {
      throw new UsageError();
    } else {
      options.positionals.push(arg);
    }
  }
  const expected = command === 'check' ? 0 : command === 'next-id' ? 1 : undefined;
  if (expected !== undefined && options.positionals.length !== expected) throw new UsageError();
  return options;
}

/** Every file under `dir` as `relative POSIX path -> text`; a missing folder is empty, with a notice. */
function readFolder(dir: string): FileMap {
  const files: FileMap = {};
  if (!existsSync(dir)) {
    console.error(`no folder at ${dir}, treated as empty`);
    return files;
  }
  const walk = (relative: string): void => {
    for (const entry of readdirSync(under(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[path] = readFileSync(under(dir, path), 'utf8');
    }
  };
  walk('');
  return files;
}

/** The path of a file below `dir`, as printed and as opened. */
function under(dir: string, path: string): string {
  return `${dir}/${path}`;
}

interface Folders {
  drafts: BankResult;
  bank: BankResult;
  /** Every problem of both folders, printed with its folder, in the order drafts, bank, ids. */
  problems: string[];
}

function readFolders(options: Options): Folders {
  const draftFiles = readFolder(options.drafts);
  const bankFiles = readFolder(options.bank);
  const drafts = readBank(draftFiles, { publicOnly: false });
  const bank = readBank(bankFiles, { publicOnly: true });
  const label = (dir: string) => (problem: Problem) => `${dir}/${problem.file}: ${problem.message}`;
  const problems = [
    ...drafts.problems.map(label(options.drafts)),
    ...bank.problems.map(label(options.bank)),
    ...findIdCollisions(drafts.entries, bank.entries).map(label(options.drafts)),
  ];
  return { drafts, bank, problems };
}

function runCheck(options: Options): number {
  const { drafts, bank, problems } = readFolders(options);
  for (const problem of problems) console.error(problem);
  console.log(
    `drafts: ${drafts.entries.length}, bank questions: ${bank.entries.length}, problems: ${problems.length}`,
  );
  return problems.length > 0 ? 1 : 0;
}

function runNextId(options: Options): number {
  const task = options.positionals[0];
  if (!isTaskId(task)) throw new UsageError();
  const draftFiles = readFolder(options.drafts);
  const bankFiles = readFolder(options.bank);
  console.log(nextId(task, [...collectIds(draftFiles), ...collectIds(bankFiles)]));
  return 0;
}

function runPromote(options: Options): number {
  const { drafts, bank, problems } = readFolders(options);
  const only = options.positionals.length > 0 ? { ids: options.positionals } : {};
  const plan = problems.length > 0 ? undefined : planPromote(drafts.entries, bank.entries, only);

  const errors = [
    ...problems,
    ...(plan?.errors ?? []).map(({ file, message }) =>
      drafts.entries.some((entry) => entry.path === file)
        ? `${options.drafts}/${file}: ${message}`
        : `${file}: ${message}`,
    ),
  ];
  if (plan === undefined || errors.length > 0) {
    for (const error of errors) console.error(error);
    return 1;
  }
  if (plan.moves.length === 0) {
    console.log('nothing to promote');
    return 0;
  }

  for (const { file, message } of plan.skipped) {
    console.log(`skipped ${options.drafts}/${file}: ${message}`);
  }
  const verb = options.dryRun ? 'would move' : 'moved';
  for (const { id, from, to } of plan.moves) {
    console.log(`${verb} ${id}: ${under(options.drafts, from)} -> ${under(options.bank, to)}`);
  }
  if (options.dryRun) {
    console.log('dry run: nothing was written or deleted');
    return 0;
  }

  // Copy every file first and delete afterwards, so a failed copy leaves the drafts untouched.
  for (const { from, to } of plan.moves) {
    const target = under(options.bank, to);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(under(options.drafts, from), target, constants.COPYFILE_EXCL);
  }
  for (const { from } of plan.moves) {
    rmSync(under(options.drafts, from));
    rmSync(under(options.drafts, sidecarPath(from)), { force: true });
  }
  console.log(`Review the new files, then commit ${options.bank}/ yourself (git is not run here).`);
  return 0;
}

/** Runs the CLI and resolves to the process exit code (0 ok, 1 problems, 2 usage error). */
export function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === 'check') return Promise.resolve(runCheck(options));
    if (options.command === 'next-id') return Promise.resolve(runNextId(options));
    return Promise.resolve(runPromote(options));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(USAGE);
      return Promise.resolve(2);
    }
    console.error(`questions: ${error instanceof Error ? error.message : String(error)}`);
    return Promise.resolve(1);
  }
}

process.exitCode = await main(process.argv.slice(2));
