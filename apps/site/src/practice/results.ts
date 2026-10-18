// The numbers of the results screen, derived from a submitted session (spec 027).
import { sessionScore } from '@field-guide/quiz-core';
import type { QuestionResult, Session } from '@field-guide/quiz-core';
import { domains } from '@field-guide/schema';
import type { DomainId, TaskId } from '@field-guide/schema';
import { displayLetters } from './format.ts';

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
  const score = sessionScore(session);
  const { submittedAt, deadline, startedAt } = session;
  if (score === null || score.estimated === null || submittedAt === null) {
    throw new RangeError('only a submitted session has results');
  }
  const items = session.exam.items.map(({ question, optionOrder }, index): ItemRow => {
    const result = score.results[index] as QuestionResult;
    const selected = session.answers[question.id] ?? [];
    const correctKeys = question.options.filter((option) => option.correct).map((o) => o.key);
    return {
      number: index + 1,
      id: question.id,
      status: !result.answered ? 'unanswered' : result.correct ? 'correct' : 'incorrect',
      flagged: session.flagged.includes(question.id),
      domain: question.domain,
      task: question.task,
      stem: question.stem,
      yourLetters: displayLetters(optionOrder, selected),
      correctLetters: displayLetters(optionOrder, correctKeys),
    };
  });
  return {
    estimated: score.estimated,
    passed: score.passed,
    correct: score.correct,
    total: score.total,
    percent: Math.round((100 * score.correct) / score.total),
    unanswered: score.total - score.answered,
    flagged: session.flagged.length,
    timeUsedMs: submittedAt - startedAt,
    timeLimitMs: (deadline ?? submittedAt) - startedAt,
    timedOut: session.submitReason === 'timeout',
    domains: domains.map(({ id, title, weight }) => {
      const { correct, total, raw } = score.byDomain[id];
      return { id, title, weight, correct, total, raw, needsWork: raw !== null && raw < 0.72 };
    }),
    items,
    counts: {
      all: items.length,
      incorrect: items.filter((row) => row.status !== 'correct').length,
      flagged: items.filter((row) => row.flagged).length,
    },
  };
}
