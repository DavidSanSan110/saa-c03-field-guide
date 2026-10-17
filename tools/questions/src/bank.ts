// Question bank logic: reads the draft and public question folders (as in-memory file maps),
// allocates ids and plans promotions. No file system access: tools/questions/src/cli.ts does the I/O.
import { validateQuestion } from '@field-guide/schema';
import type { Question, TaskId } from '@field-guide/schema';
import { parse } from 'yaml';

/** Relative POSIX path ("/" separators, no leading "./") → file text. */
export type FileMap = Record<string, string>;

export interface Problem {
  file: string;
  message: string;
}

export interface BankEntry {
  path: string;
  slug: string;
  question: Question;
  text: string;
}

export interface BankResult {
  entries: BankEntry[];
  problems: Problem[];
}

export interface PromoteMove {
  id: string;
  from: string;
  to: string;
}

export interface PromotePlan {
  moves: PromoteMove[];
  skipped: Problem[];
  errors: Problem[];
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SIDECAR_SUFFIX = '.check.yaml';
const MAX_NUMBER = 9999;

/** Code-unit order, the same on every machine (unlike localeCompare). */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isYamlFile(path: string): boolean {
  return path.endsWith('.yaml') || path.endsWith('.yml');
}

function isSidecar(path: string): boolean {
  return path.endsWith(SIDECAR_SUFFIX);
}

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parseYaml(text: string): Parsed {
  try {
    return { ok: true, value: parse(text) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function questionPath(question: Pick<Question, 'domain' | 'task'>, slug: string): string {
  return `d${question.domain}/${question.task}/${slug}.yaml`;
}

export function sidecarPath(path: string): string {
  return `${path.slice(0, -'.yaml'.length)}${SIDECAR_SUFFIX}`;
}

/** Reads one question file; the problems come back in the order they are found. */
function readFile(
  path: string,
  text: string,
  publicOnly: boolean,
): { entry: BankEntry } | { problems: Problem[] } {
  const fail = (message: string): { problems: Problem[] } => ({
    problems: [{ file: path, message }],
  });
  if (path.endsWith('.yml')) return fail('use the .yaml extension, not .yml');

  const slug = path.slice(path.lastIndexOf('/') + 1, -'.yaml'.length);
  if (!SLUG_PATTERN.test(slug)) return fail(`the file name "${slug}" is not a lowercase slug`);

  const parsed = parseYaml(text);
  if (!parsed.ok) return fail(`invalid YAML: ${parsed.message}`);
  if (!isMapping(parsed.value)) return fail('the YAML top level must be a mapping');

  const result = validateQuestion(parsed.value, { publicOnly });
  if (!result.ok) return { problems: result.errors.map((message) => ({ file: path, message })) };

  const expected = questionPath(result.question, slug);
  if (path !== expected) return fail(`wrong location, expected ${expected}`);
  return { entry: { path, slug, question: result.question, text } };
}

export function readBank(files: FileMap, opts: { publicOnly: boolean }): BankResult {
  const entries: BankEntry[] = [];
  const problems: Problem[] = [];
  const firstById = new Map<string, string>();

  const paths = Object.keys(files)
    .filter((path) => isYamlFile(path) && !isSidecar(path) && !path.startsWith('rejected/'))
    .sort(compare);
  for (const path of paths) {
    const result = readFile(path, files[path] ?? '', opts.publicOnly);
    if ('problems' in result) {
      problems.push(...result.problems);
      continue;
    }
    const { id } = result.entry.question;
    const first = firstById.get(id);
    if (first === undefined) {
      firstById.set(id, path);
      entries.push(result.entry);
    } else {
      problems.push({ file: path, message: `id ${id} is already used by ${first}` });
    }
  }
  return { entries, problems };
}

export function collectIds(files: FileMap): string[] {
  const ids: string[] = [];
  for (const path of Object.keys(files).sort(compare)) {
    if (!isYamlFile(path) || isSidecar(path)) continue;
    const parsed = parseYaml(files[path] ?? '');
    if (parsed.ok && isMapping(parsed.value) && typeof parsed.value.id === 'string') {
      ids.push(parsed.value.id);
    }
  }
  return ids;
}

export function nextId(task: TaskId, ids: Iterable<string>): string {
  const prefix = `d${task.slice(0, 1)}-${task}-`;
  let highest = 0;
  for (const id of ids) {
    const number = id.startsWith(prefix) ? id.slice(prefix.length) : '';
    if (/^\d{4}$/.test(number)) highest = Math.max(highest, Number(number));
  }
  if (highest >= MAX_NUMBER) throw new Error(`task ${task} has no free question id left`);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

/**
 * One problem, on the draft's file, for each draft whose id is already used in the bank; the bank
 * file is named with `bankPrefix` (the bank folder and a slash) in front of its path.
 */
export function findIdCollisions(
  drafts: BankEntry[],
  bank: BankEntry[],
  bankPrefix = '',
): Problem[] {
  const bankById = new Map(bank.map((entry) => [entry.question.id, entry.path]));
  const problems: Problem[] = [];
  for (const draft of drafts) {
    const bankPath = bankById.get(draft.question.id);
    if (bankPath !== undefined) {
      problems.push({
        file: draft.path,
        message: `id ${draft.question.id} is already used in the bank by ${bankPrefix}${bankPath}`,
      });
    }
  }
  return problems;
}

export function planPromote(
  drafts: BankEntry[],
  bank: BankEntry[],
  opts?: { ids?: string[]; bankPrefix?: string },
): PromotePlan {
  const requested = opts?.ids === undefined ? undefined : new Set(opts.ids);
  const skipped: Problem[] = [];
  const errors: Problem[] = [];
  const moves: PromoteMove[] = [];

  const idClashes = new Map(
    findIdCollisions(drafts, bank, opts?.bankPrefix).map((p) => [p.file, p.message]),
  );
  const bankPaths = new Set(bank.map((entry) => entry.path));

  for (const id of requested ?? []) {
    if (!drafts.some((draft) => draft.question.id === id)) {
      errors.push({ file: id, message: `no draft has the id ${id}` });
    }
  }

  const selected = drafts.filter((draft) => requested?.has(draft.question.id) ?? true);
  for (const draft of selected) {
    const { id, status } = draft.question;
    const clash = idClashes.get(draft.path);
    if (status !== 'reviewed') {
      const problem = { file: draft.path, message: `status is ${status}, not reviewed` };
      (requested === undefined ? skipped : errors).push(problem);
    } else if (clash !== undefined) {
      errors.push({ file: draft.path, message: clash });
    } else if (bankPaths.has(draft.path)) {
      errors.push({
        file: draft.path,
        message: `the bank already has a question at ${draft.path}`,
      });
    } else {
      moves.push({ id, from: draft.path, to: draft.path });
    }
  }

  moves.sort((a, b) => compare(a.id, b.id));
  return { moves: errors.length > 0 ? [] : moves, skipped, errors };
}
