// The numbers of the results screen, derived from a submitted session (spec 027). Stub until implemented.
import type { DomainId, TaskId } from '@field-guide/schema';
import type { Session } from '@field-guide/quiz-core';

export type ItemStatus = 'correct' | 'incorrect' | 'unanswered';

/** One of the four "By domain" rows. */
export interface DomainRow {
  id: DomainId;
  /** The exam catalog title, e.g. "Design Secure Architectures". */
  title: string;
  /** Exam weight in percent: 30, 26, 24, 20. */
  weight: number;
  /** Questions of this domain in the exam answered correctly. */
  correct: number;
  /** Questions of this domain in the exam (0 when the bank had none). */
  total: number;
  /** `correct / total` (not rounded), or `null` when `total` is 0. */
  raw: number | null;
  /** True exactly when `raw < 0.72`: 0.72 itself is not "needs work", and `null` never is. */
  needsWork: boolean;
}

/** One row of the "Questions" list, in exam order. */
export interface ItemRow {
  /** 1-based position in the exam. */
  number: number;
  id: string;
  status: ItemStatus;
  flagged: boolean;
  domain: DomainId;
  task: TaskId;
  /** The full question stem (the screen cuts it to two lines with CSS). */
  stem: string;
  /** Letters (A, B, C… by display position in this attempt) of the selected options, sorted; [] if unanswered. */
  yourLetters: string[];
  /** Display letters of the correct options, sorted. */
  correctLetters: string[];
}

/** Every number the results screen shows. Built by `resultsView` from a submitted session. */
export interface ResultsView {
  /** `sessionScore(session).estimated`, 100 to 1000. */
  estimated: number;
  /** `estimated >= 720`. */
  passed: boolean;
  correct: number;
  total: number;
  /** `Math.round(100 * correct / total)`. */
  percent: number;
  /** Questions without an answer. */
  unanswered: number;
  /** Questions flagged for review. */
  flagged: number;
  /** `submittedAt - startedAt`. */
  timeUsedMs: number;
  /** `deadline - startedAt`. */
  timeLimitMs: number;
  /** True when the session ended because the deadline passed (`submitReason === 'timeout'`). */
  timedOut: boolean;
  /** Domains 1 to 4 in this order. */
  domains: DomainRow[];
  items: ItemRow[];
  /** Filter chip counts: All, Incorrect (incorrect + unanswered) and Flagged. */
  counts: { all: number; incorrect: number; flagged: number };
}

/** The results of a submitted exam-mode session. RangeError for an active session. */
export function resultsView(session: Session): ResultsView {
  void session;
  throw new Error('not implemented');
}
