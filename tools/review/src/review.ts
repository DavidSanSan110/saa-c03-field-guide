// Pure logic of the review tool (spec 023). Interface stub: the implementer fills it in.
import type { BankEntry, FileMap, Problem } from '@field-guide/questions/bank';
import type { Question } from '@field-guide/schema';

/** Marks the parameters as used while this module is a stub. */
function notImplemented(...args: unknown[]): never {
  void args;
  throw new Error('not implemented');
}

export function questionDigest(q: Pick<Question, 'type' | 'stem' | 'options'>): string {
  return notImplemented(q);
}

export type VerificationState = 'verified' | 'changed' | 'flagged' | 'none';

export function verificationState(q: Question, sidecar: unknown): VerificationState {
  return notImplemented(q, sidecar);
}

export function buildQueue(files: FileMap): {
  items: BankEntry[];
  waiting: number;
  problems: Problem[];
} {
  return notImplemented(files);
}

export function isCorrect(q: Question, answer: string[]): boolean {
  return notImplemented(q, answer);
}

/** Throws when the text is not safe to rewrite. */
export function approvedText(text: string, by: { reviewer: string; verifier?: string }): string {
  return notImplemented(text, by);
}

export function checkEdit(
  old: Question,
  text: string,
): { ok: true; question: Question } | { ok: false; errors: string[] } {
  return notImplemented(old, text);
}
