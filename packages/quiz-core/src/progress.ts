// Progress and Leitner boxes: attempt history and per-question stats (spec 018).
// Interface stub: the functions throw until they are implemented.
import type { DomainId, Progress, Question, QuestionStats, TaskId } from '@field-guide/schema';
import type { Session } from './session.ts';

/** Waits for boxes 1 to 5, in milliseconds. */
export const LEITNER_INTERVALS_MS: readonly number[] = [];

export function emptyProgress(): Progress {
  throw new Error('not implemented');
}

export type ProgressResult =
  { ok: true; progress: Progress } | { ok: false; reason: 'version' | 'invalid'; errors: string[] };

export function parseProgress(data: unknown): ProgressResult {
  void data;
  throw new Error('not implemented');
}

export function updateStats(
  stats: QuestionStats | undefined,
  correct: boolean,
  at: number,
): QuestionStats {
  void [stats, correct, at];
  throw new Error('not implemented');
}

export function recordSession(progress: Progress, session: Session): Progress {
  void [progress, session];
  throw new Error('not implemented');
}

export interface LeitnerSummary {
  boxes: Record<1 | 2 | 3 | 4 | 5, number>;
  due: number;
  nextDueAt: number | null;
}

export function leitnerSummary(
  bank: readonly Question[],
  progress: Progress,
  now: number,
): LeitnerSummary {
  void [bank, progress, now];
  throw new Error('not implemented');
}

export interface CoverageBucket {
  questions: number;
  seen: number;
  answered: number;
  correct: number;
  raw: number | null;
  weak: number;
}

export interface ProgressSummary {
  overall: CoverageBucket;
  byDomain: Record<DomainId, CoverageBucket>;
  byTask: Record<TaskId, CoverageBucket>;
}

export function progressSummary(bank: readonly Question[], progress: Progress): ProgressSummary {
  void [bank, progress];
  throw new Error('not implemented');
}
