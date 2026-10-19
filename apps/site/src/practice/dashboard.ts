// The numbers of the progress view and of the Progress card (spec 028).
import { PASS_MARK, leitnerSummary, progressSummary } from '@field-guide/quiz-core';
import type { CoverageBucket, LeitnerSummary } from '@field-guide/quiz-core';
import { domains, tasks } from '@field-guide/schema';
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

const LAST = 20;

const percentOf = (raw: number | null): number | null =>
  raw === null ? null : Math.round(100 * raw);

function coverageRow<Id>(id: Id, title: string, bucket: CoverageBucket): CoverageRow<Id> {
  const { raw, ...counts } = bucket;
  return {
    id,
    title,
    ...counts,
    raw,
    percent: percentOf(raw),
    needsWork: raw !== null && raw < 0.72,
  };
}

export function dashboardView(
  bank: readonly Question[],
  progress: Progress,
  now: number,
): DashboardView {
  const summary = progressSummary(bank, progress);
  const leitner = leitnerSummary(bank, progress, now);
  const { attempts } = progress;
  const exams = attempts.filter((attempt) => attempt.mode === 'exam');
  return {
    overall: {
      questions: summary.overall.questions,
      seen: summary.overall.seen,
      answered: summary.overall.answered,
      correct: summary.overall.correct,
      percent: percentOf(summary.overall.raw),
      due: leitner.due,
    },
    attempts: {
      total: attempts.length,
      exam: exams.length,
      practice: attempts.length - exams.length,
    },
    recent: attempts
      .map((attempt, position) => ({ attempt, position }))
      .sort((a, b) => b.attempt.submittedAt - a.attempt.submittedAt || b.position - a.position)
      .slice(0, LAST)
      .map(({ attempt }): AttemptRow => {
        const isExam = attempt.mode === 'exam';
        return {
          submittedAt: attempt.submittedAt,
          mode: attempt.mode,
          correct: attempt.correct,
          total: attempt.total,
          estimated: isExam ? attempt.estimated : null,
          passed: isExam ? attempt.estimated >= PASS_MARK : null,
        };
      }),
    examScores: exams
      .map((attempt, position) => ({ attempt, position }))
      .sort((a, b) => a.attempt.submittedAt - b.attempt.submittedAt || a.position - b.position)
      .slice(-LAST)
      .map(({ attempt }) => ({ submittedAt: attempt.submittedAt, estimated: attempt.estimated })),
    domains: domains.map(({ id, title }) => coverageRow(id, title, summary.byDomain[id])),
    tasks: tasks.map(({ id, title }) => coverageRow(id, title, summary.byTask[id])),
    leitner,
  };
}
