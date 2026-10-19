// The numbers of the progress view and of the Progress card (spec 028). Stub.
import type { LeitnerSummary } from '@field-guide/quiz-core';
import type { DomainId, Progress, Question, TaskId } from '@field-guide/schema';

export interface OverallView {
  questions: number;
  seen: number;
  answered: number;
  correct: number;
  /** `Math.round(100 * raw)`, or `null` while nothing was answered. */
  percent: number | null;
  /** Questions due for another try now. */
  due: number;
}

export interface AttemptRow {
  submittedAt: number;
  mode: 'exam' | 'practice';
  correct: number;
  total: number;
  /** The estimated score of a mock exam; `null` for a practice set. */
  estimated: number | null;
  /** `estimated >= 720`; `null` for a practice set. */
  passed: boolean | null;
}

/** A domain or a task of the "By domain" and "By task" sections. */
export interface CoverageRow<Id> {
  id: Id;
  title: string;
  questions: number;
  seen: number;
  answered: number;
  correct: number;
  raw: number | null;
  percent: number | null;
  weak: number;
  /** True exactly when `raw !== null && raw < 0.72`. */
  needsWork: boolean;
}

export interface DashboardView {
  overall: OverallView;
  attempts: { total: number; exam: number; practice: number };
  /** The last 20 attempts, newest first (ties: the later record first). */
  recent: AttemptRow[];
  /** The estimated scores of the last 20 mock exams, oldest first. */
  examScores: { submittedAt: number; estimated: number }[];
  domains: CoverageRow<DomainId>[];
  tasks: CoverageRow<TaskId>[];
  leitner: LeitnerSummary;
}

export const dashboardView: (
  bank: readonly Question[],
  progress: Progress,
  now: number,
) => DashboardView = () => {
  throw new Error('not implemented');
};
