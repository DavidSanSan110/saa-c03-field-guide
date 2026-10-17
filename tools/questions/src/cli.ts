// Questions CLI: argument parsing, file I/O and exit codes only; the logic is in bank.ts.
import {
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
import type { BankResult, FileMap, Problem, PromoteMove } from './bank.ts';
import { findSimilar, similarByDraft, withDedupe } from './dedupe.ts';

const USAGE = `Usage:
  questions check [options]                      read both folders and print every problem
  questions next-id <task> [options]             print the next free question id of a task
  questions promote [--dry-run] [<id>...] [options]
                                                 move reviewed drafts into the public bank
  questions dedupe [--threshold <t>] [--write] [options]
                                                 flag drafts that nearly repeat another question;
                                                 --write records it in each draft's check file

Options (every command):
  --drafts <dir>   drafts folder (default private/questions-drafts)
  --bank <dir>     public bank folder (default questions)`;

const DEFAULT_DRAFTS = 'private/questions-drafts';
const DEFAULT_BANK = 'questions';
const DEFAULT_THRESHOLD = 0.5;

class UsageError extends Error {}

interface Options {
  command: string;
  drafts: string;
  bank: string;
  dryRun: boolean;
  write: boolean;
  threshold: number;
  positionals: string[];
}

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!['check', 'next-id', 'promote', 'dedupe'].includes(command ?? '')) throw new UsageError();
  const options: Options = {
    command: command as string,
    drafts: DEFAULT_DRAFTS,
    bank: DEFAULT_BANK,
    dryRun: false,
    write: false,
    threshold: DEFAULT_THRESHOLD,
    positionals: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--drafts' || arg === '--bank') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError();
      // No trailing separator, so that printed paths do not show `dir//d1/...`.
      const folder = value.replace(/[\\/]+$/, '') || value;
      if (arg === '--drafts') options.drafts = folder;
      else options.bank = folder;
    } else if (arg === '--dry-run' && command === 'promote') {
      options.dryRun = true;
    } else if (arg === '--write' && command === 'dedupe') {
      options.write = true;
    } else if (arg === '--threshold' && command === 'dedupe') {
      options.threshold = parseThreshold(rest[++i]);
    } else if (arg.startsWith('-')) {
      throw new UsageError();
    } else {
      options.positionals.push(arg);
    }
  }
  const expected = command === 'next-id' ? 1 : command === 'promote' ? undefined : 0;
  if (expected !== undefined && options.positionals.length !== expected) throw new UsageError();
  return options;
}

/** A plain decimal number in (0, 1]. */
function parseThreshold(value: string | undefined): number {
  const threshold = value !== undefined && /^(\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : NaN;
  if (!(threshold > 0 && threshold <= 1)) throw new UsageError();
  return threshold;
}

interface Folder {
  files: FileMap;
  /** Symbolic links and junctions: they are never followed, and each one is a problem. */
  links: Problem[];
}

/**
 * The YAML files under `dir` as `relative POSIX path -> text`; a missing folder is empty, with a
 * notice. Links are listed in `links` instead of being followed.
 */
function readFolder(dir: string): Folder {
  const folder: Folder = { files: {}, links: [] };
  if (!existsSync(dir)) {
    console.error(`no folder at ${dir}, treated as empty`);
    return folder;
  }
  const walk = (relative: string): void => {
    for (const entry of readdirSync(under(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        folder.links.push({ file: path, message: 'symbolic links are not followed' });
      } else if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && /\.ya?ml$/.test(path)) {
        folder.files[path] = readFileSync(under(dir, path), 'utf8');
      }
    }
  };
  walk('');
  return folder;
}

/** The path of a file below `dir`, as printed and as opened. */
function under(dir: string, path: string): string {
  return `${dir}/${path}`;
}

interface Folders {
  /** The YAML files of the drafts folder, sidecars included. */
  draftFiles: FileMap;
  drafts: BankResult;
  bank: BankResult;
  /** Every problem of both folders, printed with its folder, in the order drafts, bank, ids. */
  problems: string[];
}

function readFolders(options: Options): Folders {
  const draftFolder = readFolder(options.drafts);
  const bankFolder = readFolder(options.bank);
  const drafts = readBank(draftFolder.files, { publicOnly: false });
  const bank = readBank(bankFolder.files, { publicOnly: true });
  const label = (dir: string) => (problem: Problem) => `${dir}/${problem.file}: ${problem.message}`;
  const problems = [
    ...[...drafts.problems, ...draftFolder.links].map(label(options.drafts)),
    ...[...bank.problems, ...bankFolder.links].map(label(options.bank)),
    ...findIdCollisions(drafts.entries, bank.entries, `${options.bank}/`).map(
      label(options.drafts),
    ),
  ];
  return { draftFiles: draftFolder.files, drafts, bank, problems };
}

function runCheck(options: Options): number {
  const { drafts, bank, problems } = readFolders(options);
  for (const problem of problems) console.error(problem);
  console.log(
    `drafts: ${drafts.entries.length}, bank questions: ${bank.entries.length}, problems: ${problems.length}`,
  );
  return problems.length > 0 ? 1 : 0;
}

function runDedupe(options: Options): number {
  const { draftFiles, drafts, bank, problems } = readFolders(options);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  const pairs = findSimilar(drafts.entries, bank.entries, options.threshold);

  // Check every existing sidecar before writing any (all or nothing).
  const sidecars = new Map<string, string>();
  const bad: string[] = [];
  if (options.write) {
    const similar = similarByDraft(drafts.entries, pairs);
    for (const { path } of drafts.entries) {
      const target = sidecarPath(path);
      try {
        sidecars.set(
          target,
          withDedupe(draftFiles[target], options.threshold, similar.get(path) ?? []),
        );
      } catch (error) {
        bad.push(
          `${under(options.drafts, target)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (bad.length > 0) {
    for (const line of bad) console.error(line);
    return 1;
  }

  const score = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);
  for (const { a, b, bFolder, score: value } of pairs) {
    const other = under(bFolder === 'drafts' ? options.drafts : options.bank, b.path);
    console.log(
      `${score(value)} ${a.question.id} ${under(options.drafts, a.path)} ~ ${b.question.id} ${other}`,
    );
  }
  const n = drafts.entries.length;
  const compared = n * bank.entries.length + (n * (n - 1)) / 2;
  console.log(
    `pairs: ${pairs.length} flagged of ${compared} compared (threshold ${options.threshold.toFixed(2)})`,
  );

  for (const [target, text] of sidecars) writeFileSync(under(options.drafts, target), text);
  return pairs.length > 0 ? 1 : 0;
}

function runNextId(options: Options): number {
  const task = options.positionals[0];
  if (!isTaskId(task)) throw new UsageError();
  const draftFolder = readFolder(options.drafts);
  const bankFolder = readFolder(options.bank);
  // Ids behind a link are unknown, so allocating without them could hand out a used id.
  const links = [
    ...draftFolder.links.map(({ file, message }) => `${options.drafts}/${file}: ${message}`),
    ...bankFolder.links.map(({ file, message }) => `${options.bank}/${file}: ${message}`),
  ];
  if (links.length > 0) {
    for (const link of links) console.error(link);
    return 1;
  }
  console.log(nextId(task, [...collectIds(draftFolder.files), ...collectIds(bankFolder.files)]));
  return 0;
}

function runPromote(options: Options): number {
  const { drafts, bank, problems } = readFolders(options);
  const bankPrefix = `${options.bank}/`;
  const planOptions = options.positionals.length > 0 ? { ids: options.positionals } : {};
  const plan =
    problems.length > 0
      ? undefined
      : planPromote(drafts.entries, bank.entries, { ...planOptions, bankPrefix });

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
  const printMoves = (verb: string): void => {
    for (const { id, from, to } of plan.moves) {
      console.log(`${verb} ${id}: ${under(options.drafts, from)} -> ${under(options.bank, to)}`);
    }
  };
  if (options.dryRun) {
    printMoves('would move');
    console.log('dry run: nothing was written or deleted');
    return 0;
  }

  // Copy every file first and delete afterwards, so a failed copy leaves the drafts untouched.
  const copied = copyAll(plan.moves, options);
  if (copied !== undefined) {
    console.error(`questions: ${copied}; the drafts were left as they were`);
    return 1;
  }
  const left = deleteDrafts(plan.moves, options);
  printMoves('moved');
  if (left.length > 0) {
    // The bank copies are complete; only the deletion of the drafts is left to do by hand.
    console.error(`questions: could not delete these drafts (the bank already has their copies):`);
    for (const line of left) console.error(`  ${line}`);
    return 1;
  }
  console.log(`Review the new files, then commit ${options.bank}/ yourself (git is not run here).`);
  return 0;
}

/**
 * Copies each draft into the bank without overwriting anything. On a failure it removes what it
 * made (the copies and the folders it created) and returns the error message; else undefined.
 */
function copyAll(moves: PromoteMove[], options: Options): string | undefined {
  const copies: string[] = [];
  const createdFolders: string[] = [];
  let writing: string | undefined;
  try {
    for (const { from, to } of moves) {
      const target = under(options.bank, to);
      const created = mkdirSync(dirname(target), { recursive: true });
      if (created !== undefined) createdFolders.push(created);
      // Only a target that is ours to clean up: Windows reports a clash as EPERM, not EEXIST.
      writing = lstatSync(target, { throwIfNoEntry: false }) === undefined ? target : undefined;
      copyFileSync(under(options.drafts, from), target, constants.COPYFILE_EXCL);
      copies.push(target);
      writing = undefined;
    }
    return undefined;
  } catch (error) {
    // A failed copy may leave a part-written target (never one that was already there).
    if (writing !== undefined) rmSync(writing, { force: true });
    for (const copy of copies) rmSync(copy, { force: true });
    for (const folder of createdFolders) rmSync(folder, { recursive: true, force: true });
    return error instanceof Error ? error.message : String(error);
  }
}

/** Deletes the promoted drafts and their sidecars; returns one line per file that was left. */
function deleteDrafts(moves: PromoteMove[], options: Options): string[] {
  const left: string[] = [];
  for (const { from } of moves) {
    for (const path of [from, sidecarPath(from)]) {
      try {
        rmSync(under(options.drafts, path), { force: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        left.push(`${under(options.drafts, path)}: ${reason}`);
      }
    }
  }
  return left;
}

/** Runs the CLI and resolves to the process exit code (0 ok, 1 problems, 2 usage error). */
export function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === 'check') return Promise.resolve(runCheck(options));
    if (options.command === 'dedupe') return Promise.resolve(runDedupe(options));
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
