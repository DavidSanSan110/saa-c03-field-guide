// Question bank I/O: reads the draft and public question folders, allocates ids, plans promotions.
// Interface stubs only: the behaviour comes after the locked tests (spec 019).
import type { Question, TaskId } from '@field-guide/schema';

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

export function readBank(files: FileMap, opts: { publicOnly: boolean }): BankResult {
  void files;
  void opts;
  throw new Error('not implemented');
}

export function questionPath(question: Pick<Question, 'domain' | 'task'>, slug: string): string {
  void question;
  void slug;
  throw new Error('not implemented');
}

export function sidecarPath(path: string): string {
  void path;
  throw new Error('not implemented');
}

export function collectIds(files: FileMap): string[] {
  void files;
  throw new Error('not implemented');
}

export function nextId(task: TaskId, ids: Iterable<string>): string {
  void task;
  void ids;
  throw new Error('not implemented');
}

export function planPromote(
  drafts: BankEntry[],
  bank: BankEntry[],
  opts?: { ids?: string[] },
): PromotePlan {
  void drafts;
  void bank;
  void opts;
  throw new Error('not implemented');
}
