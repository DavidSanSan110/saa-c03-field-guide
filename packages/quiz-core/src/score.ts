// Attempt scoring (interface stub: implementation pending, spec 016).
import type { DomainId, Question, TaskId } from '@field-guide/schema';

export const PASS_MARK = 720;

/** `Math.round(100 + 900 * raw)`. `raw` in [0, 1], else RangeError. */
export function estimateScore(raw: number): number {
  void raw;
  throw new Error('not implemented');
}

/** Question id to the option keys selected (original keys). */
export type Answers = Readonly<Record<string, readonly string[]>>;

export interface ScoreBucket {
  total: number;
  answered: number;
  correct: number;
  raw: number | null;
}

export interface QuestionResult {
  id: string;
  domain: DomainId;
  task: TaskId;
  answered: boolean;
  correct: boolean;
}

export interface AttemptScore extends ScoreBucket {
  estimated: number | null;
  passed: boolean;
  byDomain: Record<DomainId, ScoreBucket>;
  byTask: Record<TaskId, ScoreBucket>;
  results: QuestionResult[];
}

export function scoreAttempt(questions: readonly Question[], answers: Answers): AttemptScore {
  void questions;
  void answers;
  throw new Error('not implemented');
}
