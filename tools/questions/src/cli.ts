// Questions CLI: argument parsing, file I/O, the fetch and exit codes only; the logic is in bank.ts,
// dedupe.ts, sidecar.ts, brief.ts and verify.ts.
import {
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isTaskId, validateQuestion } from '@field-guide/schema';
import type { Question, TaskId } from '@field-guide/schema';
import { parse } from 'yaml';
import {
  collectIds,
  findIdCollisions,
  nextId,
  planPromote,
  readBank,
  sidecarPath,
} from './bank.ts';
import type { BankResult, FileMap, Problem, PromoteMove } from './bank.ts';
import { feedingSections, nextIds, notesStatus, parseSectionMap, renderBrief } from './brief.ts';
import type { BriefInput } from './brief.ts';
import { findSimilar, roundScore, similarByDraft, withDedupe } from './dedupe.ts';
import { withSidecarKey } from './sidecar.ts';
import {
  isFinalDocsUrl,
  judge,
  pageToCheck,
  parseResults,
  questionDigest,
  quoteCheckOf,
  renderBlind,
} from './verify.ts';
import type { VerifierResult } from './verify.ts';

const USAGE = `Usage:
  questions check [options]                      read both folders and print every problem
  questions next-id <task> [options]             print the next free question id of a task
  questions promote [--dry-run] [<id>...] [options]
                                                 move reviewed drafts into the public bank
  questions dedupe [--threshold <t>] [--write] [options]
                                                 flag drafts that nearly repeat another question;
                                                 --write records it in each draft's check file
  questions brief <task> [--count <n>] [--notes <dir>] [--map <file>] [--studied-only]
                                                 print the brief of the question writer for a task
                                                 (studied and AI-draft sections; --studied-only
                                                 leaves the AI-draft ones out)
  questions blind [--pending] [<file>...]        print drafts without their key, for the verifier
  questions verdict <results.yaml> [--write] [--no-fetch]
                                                 compare the verifier's answers and quotes with the
                                                 keys; --write records it in each draft's check file

Options (every command):
  --drafts <dir>   drafts folder (default private/questions-drafts)
  --bank <dir>     public bank folder (default questions)`;

const DEFAULT_DRAFTS = 'private/questions-drafts';
const DEFAULT_BANK = 'questions';
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_NOTES = 'private/notes-import';
const DEFAULT_COUNT = 10;
const MAX_COUNT = 50;
const FETCH_TIMEOUT_MS = 20_000;
const COMMANDS = ['check', 'next-id', 'promote', 'dedupe', 'brief', 'blind', 'verdict'];

class UsageError extends Error {}

interface Options {
  command: string;
  drafts: string;
  bank: string;
  dryRun: boolean;
  write: boolean;
  threshold: number;
  count: number;
  notes: string;
  map: string | undefined;
  pending: boolean;
  noFetch: boolean;
  studiedOnly: boolean;
  positionals: string[];
}

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command ?? '')) throw new UsageError();
  const options: Options = {
    command: command as string,
    drafts: DEFAULT_DRAFTS,
    bank: DEFAULT_BANK,
    dryRun: false,
    write: false,
    threshold: DEFAULT_THRESHOLD,
    count: DEFAULT_COUNT,
    notes: DEFAULT_NOTES,
    map: undefined,
    pending: false,
    noFetch: false,
    studiedOnly: false,
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
    } else if (arg === '--write' && (command === 'dedupe' || command === 'verdict')) {
      options.write = true;
    } else if (arg === '--no-fetch' && command === 'verdict') {
      options.noFetch = true;
    } else if (arg === '--pending' && command === 'blind') {
      options.pending = true;
    } else if (arg === '--studied-only' && command === 'brief') {
      options.studiedOnly = true;
    } else if (arg === '--count' && command === 'brief') {
      options.count = parseCount(rest[++i]);
    } else if ((arg === '--notes' || arg === '--map') && command === 'brief') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError();
      if (arg === '--notes') options.notes = value;
      else options.map = value;
    } else if (arg === '--threshold' && command === 'dedupe') {
      options.threshold = parseThreshold(rest[++i]);
    } else if (arg.startsWith('-')) {
      throw new UsageError();
    } else {
      options.positionals.push(arg);
    }
  }
  const expected = ['next-id', 'brief', 'verdict'].includes(command as string)
    ? 1
    : ['promote', 'blind'].includes(command as string)
      ? undefined
      : 0;
  if (expected !== undefined && options.positionals.length !== expected) throw new UsageError();
  if (command === 'brief' && !isTaskId(options.positionals[0])) throw new UsageError();
  if (command === 'blind' && !options.pending && options.positionals.length === 0) {
    throw new UsageError();
  }
  return options;
}

/** A plain integer from 1 to 50. */
function parseCount(value: string | undefined): number {
  const count = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(count >= 1 && count <= MAX_COUNT)) throw new UsageError();
  return count;
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

  for (const { a, b, bFolder, score: value } of pairs) {
    const other = under(bFolder === 'drafts' ? options.drafts : options.bank, b.path);
    console.log(
      `${roundScore(value).toFixed(2)} ${a.question.id} ${under(options.drafts, a.path)} ~ ${b.question.id} ${other}`,
    );
  }
  const n = drafts.entries.length;
  const compared = n * bank.entries.length + (n * (n - 1)) / 2;
  console.log(
    `pairs: ${pairs.length} flagged of ${compared} compared (threshold ${String(options.threshold)})`,
  );

  const failure = writeSidecars(sidecars, options.drafts);
  if (failure !== undefined) {
    console.error(`questions: ${failure}; no sidecar was changed`);
    return 1;
  }
  return pairs.length > 0 ? 1 : 0;
}

/**
 * Writes each sidecar to a temporary file next to it and renames it into place. On a failure it
 * puts back the old bytes of the sidecars already replaced, deletes the ones it created and the
 * temporary files, and returns a message naming the failing sidecar; else undefined.
 */
function writeSidecars(sidecars: Map<string, string>, folder: string): string | undefined {
  const done: { file: string; old: Buffer | undefined }[] = [];
  let file = '';
  let temp = '';
  try {
    for (const [path, text] of sidecars) {
      file = under(folder, path);
      temp = `${file}.${String(process.pid)}.tmp`;
      const old = readOld(file);
      writeFileSync(temp, text);
      renameSync(temp, file);
      done.push({ file, old });
    }
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    rmSync(temp, { force: true });
    for (const { file: written, old } of done.reverse()) {
      if (old === undefined) rmSync(written, { force: true });
      else writeFileSync(written, old);
    }
    return `could not write ${file} (${code})`;
  }
}

/** The bytes of a file, or undefined when there is none. */
function readOld(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Both folders for allocating ids. Ids behind a link are unknown, so allocating without them could
 * hand out a used id: the links are printed and nothing is returned.
 */
function readIdFolders(options: Options): { draftFolder: Folder; bankFolder: Folder } | undefined {
  const draftFolder = readFolder(options.drafts);
  const bankFolder = readFolder(options.bank);
  const links = [
    ...draftFolder.links.map(({ file, message }) => `${options.drafts}/${file}: ${message}`),
    ...bankFolder.links.map(({ file, message }) => `${options.bank}/${file}: ${message}`),
  ];
  for (const link of links) console.error(link);
  return links.length > 0 ? undefined : { draftFolder, bankFolder };
}

function runNextId(options: Options): number {
  const task = options.positionals[0];
  if (!isTaskId(task)) throw new UsageError();
  const folders = readIdFolders(options);
  if (folders === undefined) return 1;
  const { draftFolder, bankFolder } = folders;
  console.log(nextId(task, [...collectIds(draftFolder.files), ...collectIds(bankFolder.files)]));
  return 0;
}

/** The text of a file; undefined when there is no such file (or it is a folder). */
function readTextIfFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The notes of the studied and AI-draft sections that feed the task, in feed order (AI-draft ones
 * left out with `--studied-only`), or undefined (with the reason on stderr) when the map or the
 * notes folder cannot be used.
 */
function readFeedingNotes(options: Options, task: TaskId): BriefInput['notes'] | undefined {
  if (!existsSync(options.notes)) {
    console.error(`no notes folder at ${options.notes}`);
    return undefined;
  }
  const mapFile = options.map ?? under(options.notes, 'sections.yaml');
  const mapText = readTextIfFile(mapFile);
  if (mapText === undefined) {
    console.error(`no section map at ${mapFile}`);
    return undefined;
  }
  const { map, problems } = parseSectionMap(mapText);
  if (map === undefined) {
    for (const problem of problems) console.error(`${mapFile}: ${problem}`);
    return undefined;
  }
  const included: BriefInput['notes'] = [];
  for (const folder of feedingSections(map, task)) {
    const text = readTextIfFile(under(under(options.notes, folder), 'notes.md'));
    if (text === undefined) {
      console.error(`skipped ${folder}: no notes.md`);
      continue;
    }
    const status = notesStatus(text);
    if (status === 'studied') {
      included.push({ folder, text });
    } else if (status === 'not-finished') {
      console.error(`skipped ${folder}: not finished`);
    } else if (options.studiedOnly) {
      console.error(`skipped ${folder}: AI draft (--studied-only)`);
    } else {
      console.error(`included ${folder}: AI draft`);
      included.push({ folder, text, aiDraft: true });
    }
  }
  return included;
}

type Where = 'bank' | 'draft' | 'rejected';

/** The questions of the task in a folder, as brief lines. */
function existingOf(
  files: FileMap,
  where: Where,
  task: TaskId,
): { id: string; where: Where; stem: string }[] {
  return readBank(files, { publicOnly: where === 'bank' })
    .entries.filter((entry) => entry.question.task === task)
    .map(({ question }) => ({ id: question.id, where, stem: question.stem }));
}

function runBrief(options: Options): number {
  const task = options.positionals[0];
  if (!isTaskId(task)) throw new UsageError();
  const notes = readFeedingNotes(options, task);
  if (notes === undefined) return 1;
  if (notes.length === 0) {
    console.error(`no finished section feeds task ${task} (studied gate)`);
    return 1;
  }
  const folders = readIdFolders(options);
  if (folders === undefined) return 1;
  const { draftFolder, bankFolder } = folders;

  const ids = nextIds(
    task,
    [...collectIds(draftFolder.files), ...collectIds(bankFolder.files)],
    options.count,
  );
  // Rejected drafts live below rejected/; readBank skips that prefix, so read them on their own.
  const rejected: FileMap = {};
  for (const [path, text] of Object.entries(draftFolder.files)) {
    if (path.startsWith('rejected/')) rejected[path.slice('rejected/'.length)] = text;
  }
  const existing = [
    ...existingOf(bankFolder.files, 'bank', task),
    ...existingOf(draftFolder.files, 'draft', task),
    ...existingOf(rejected, 'rejected', task),
  ];
  process.stdout.write(renderBrief({ task, ids, draftsDir: options.drafts, existing, notes }));
  return 0;
}

/** A question file given to `blind`: the question, or the problems of the file. */
function readQuestionFile(path: string): { question: Question } | { problems: string[] } {
  const text = readTextIfFile(path);
  if (text === undefined) return { problems: [`${path}: cannot read this file`] };
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return { problems: [`${path}: invalid YAML: ${error instanceof Error ? error.message : ''}`] };
  }
  const result = validateQuestion(data);
  return result.ok
    ? { question: result.question }
    : { problems: result.errors.map((message) => `${path}: ${message}`) };
}

/** True when the sidecar holds a verification of the question as it is now. */
function isVerified(sidecar: string | undefined, question: Question): boolean {
  if (sidecar === undefined) return false;
  try {
    const data = parse(sidecar) as { verification?: { digest?: unknown } } | null;
    return data?.verification?.digest === questionDigest(question);
  } catch {
    return false;
  }
}

function runBlind(options: Options): number {
  const questions = new Map<string, Question>();
  const problems: string[] = [];
  for (const path of options.positionals) {
    const result = readQuestionFile(path);
    if ('question' in result) questions.set(resolve(path), result.question);
    else problems.push(...result.problems);
  }
  if (options.pending) {
    const folder = readFolder(options.drafts);
    const { entries, problems: invalid } = readBank(folder.files, { publicOnly: false });
    for (const { file, message } of [...invalid, ...folder.links]) {
      console.error(`${options.drafts}/${file}: ${message}`);
    }
    for (const { path, question } of entries) {
      if (!isVerified(folder.files[sidecarPath(path)], question)) {
        questions.set(resolve(under(options.drafts, path)), question);
      }
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  if (questions.size === 0) {
    console.error('nothing pending');
    return 0;
  }
  const blocks = [...questions.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(renderBlind);
  process.stdout.write(`${blocks.join('\n\n---\n\n')}\n`);
  return 0;
}

/** The HTML of a page, or undefined when it cannot be fetched (network error, non-2xx status). */
async function fetchPage(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Only a page that ends on the docs site counts, whatever the redirects were.
    return response.ok && isFinalDocsUrl(response.url) ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

interface Checked {
  question: Question;
  path: string;
  result: VerifierResult;
}

async function runVerdict(options: Options): Promise<number> {
  const file = options.positionals[0] as string;
  const text = readTextIfFile(file);
  if (text === undefined) {
    console.error(`${file}: cannot read the results file`);
    return 1;
  }
  const { draftFiles, drafts, problems: folderProblems } = readFolders(options);
  const parsed = parseResults(text);
  const problems = [...folderProblems, ...parsed.problems.map((problem) => `${file}: ${problem}`)];
  const checked: Checked[] = [];
  for (const result of parsed.results) {
    const draft = drafts.entries.find((entry) => entry.question.id === result.id);
    const keys = draft?.question.options.map((option) => option.key) ?? [];
    const unknown = result.answer.find((key) => !keys.includes(key.toUpperCase()));
    if (draft === undefined) {
      problems.push(`${file}: ${result.id} is not a draft (bank and rejected ones don't count)`);
    } else if (unknown !== undefined) {
      problems.push(`${file}: ${result.id}: "${unknown}" is not an option key of this question`);
    } else {
      checked.push({ question: draft.question, path: draft.path, result });
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  checked.sort((a, b) => (a.question.id < b.question.id ? -1 : 1));

  let pages: Map<string, string | undefined> | undefined;
  if (!options.noFetch) {
    const urls = new Set(checked.flatMap(({ result }) => pageToCheck(result) ?? []));
    const fetched = await Promise.all([...urls].map(async (url) => [url, await fetchPage(url)]));
    pages = new Map(fetched as [string, string | undefined][]);
  }
  const verifier = parsed.verifier as string;
  const verdicts = checked.map(({ question, path, result }) => ({
    path,
    id: question.id,
    verification: judge(question, result, verifier, quoteCheckOf(result, pages)),
  }));

  // Check every existing sidecar before writing any (all or nothing).
  const sidecars = new Map<string, string>();
  const bad: string[] = [];
  if (options.write) {
    for (const { path, verification } of verdicts) {
      const target = sidecarPath(path);
      try {
        sidecars.set(target, withSidecarKey(draftFiles[target], 'verification', verification));
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

  const counts = { verified: 0, mismatch: 0, unsupported: 0 };
  for (const { path, id, verification } of verdicts) {
    counts[verification.result]++;
    console.log(`${verification.result} ${id} ${under(options.drafts, path)}`);
    for (const reason of verification.reasons) console.log(`  - ${reason}`);
  }
  console.log(
    `verified: ${String(counts.verified)}, mismatch: ${String(counts.mismatch)}, unsupported: ${String(counts.unsupported)}`,
  );

  const failure = writeSidecars(sidecars, options.drafts);
  if (failure !== undefined) {
    console.error(`questions: ${failure}; no sidecar was changed`);
    return 1;
  }
  return counts.mismatch + counts.unsupported > 0 ? 1 : 0;
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
export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === 'check') return runCheck(options);
    if (options.command === 'dedupe') return runDedupe(options);
    if (options.command === 'next-id') return runNextId(options);
    if (options.command === 'brief') return runBrief(options);
    if (options.command === 'blind') return runBlind(options);
    if (options.command === 'verdict') return await runVerdict(options);
    return runPromote(options);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(USAGE);
      return 2;
    }
    console.error(`questions: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
