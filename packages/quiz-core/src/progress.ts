// Progress and Leitner boxes: attempt history and per-question stats (spec 018).
// Time is a number of milliseconds given by the caller; nothing here reads a clock.
import {
  MAX_ATTEMPTS,
  PROGRESS_VERSION,
  formatIssues,
  progressSchema,
  tasks,
} from '@field-guide/schema';
import type {
  AttemptRecord,
  DomainId,
  LeitnerBox,
  Progress,
  Question,
  QuestionStats,
  TaskId,
} from '@field-guide/schema';
import {
  assertFinite,
  assertUniqueIds,
  hasOtherVersion,
  perDomain,
  sortedReviewed,
  statsOf,
} from './internal.ts';
import { sessionScore } from './session.ts';
import type { Session } from './session.ts';

const DAY_MS = 86_400_000;

/** Waits for boxes 1 to 5, in milliseconds. */
export const LEITNER_INTERVALS_MS: readonly number[] = [0, 1, 3, 7, 14].map(
  (days) => days * DAY_MS,
);

/** A new, empty progress record. */
export function emptyProgress(): Progress {
  return { version: PROGRESS_VERSION, attempts: [], questions: {} };
}

export type ProgressResult =
  { ok: true; progress: Progress } | { ok: false; reason: 'version' | 'invalid'; errors: string[] };

/**
 * Validates stored data; never throws. `reason: 'version'` is data of another version (the app
 * must not overwrite it blindly), `'invalid'` anything else that fails the schema.
 */
export function parseProgress(data: unknown): ProgressResult {
  const result = progressSchema.safeParse(data);
  if (result.success) return { ok: true, progress: result.data };
  return {
    ok: false,
    reason: hasOtherVersion(data, PROGRESS_VERSION) ? 'version' : 'invalid',
    errors: formatIssues(result.error.issues),
  };
}

/** The box after a graded answer: a miss goes to box 1, a hit moves up and graduates from 5. */
function nextBox(box: LeitnerBox, correct: boolean): LeitnerBox {
  if (!correct) return 1;
  return box === 0 || box === 5 ? 0 : ((box + 1) as LeitnerBox);
}

/**
 * Grades one answer at time `at`: counts it and moves the Leitner box. Returns new stats.
 * RangeError when `at` is not finite.
 */
export function updateStats(
  stats: QuestionStats | undefined,
  correct: boolean,
  at: number,
): QuestionStats {
  assertFinite('at', at);
  const box = nextBox(stats?.box ?? 0, correct);
  return {
    answered: (stats?.answered ?? 0) + 1,
    correct: (stats?.correct ?? 0) + (correct ? 1 : 0),
    lastAnsweredAt: at,
    box,
    dueAt: box === 0 ? null : at + (LEITNER_INTERVALS_MS[box - 1] ?? 0),
  };
}

/**
 * Adds a submitted session: one attempt record plus updated stats for the questions it graded.
 * RangeError for an active session. Recording the same session again returns `progress` itself.
 */
export function recordSession(progress: Progress, session: Session): Progress {
  const score = sessionScore(session);
  const { submittedAt: at, submitReason } = session;
  if (score === null || score.estimated === null || at === null || submitReason === null) {
    throw new RangeError('only a submitted session can be recorded');
  }
  const { mode, exam, startedAt } = session;
  const seen = progress.attempts.some(
    (attempt) =>
      attempt.mode === mode && attempt.seed === exam.seed && attempt.startedAt === startedAt,
  );
  if (seen) return progress;

  const record: AttemptRecord = {
    mode,
    seed: exam.seed,
    size: exam.size,
    startedAt,
    submittedAt: at,
    submitReason,
    total: score.total,
    answered: score.answered,
    correct: score.correct,
    estimated: score.estimated,
    byDomain: perDomain((id) => {
      const { total, answered, correct } = score.byDomain[id];
      return { total, answered, correct };
    }),
  };

  // A revealed question without an answer is a give-up, so a miss; an unseen one is skipped.
  const questions = { ...progress.questions };
  for (const result of score.results) {
    const gaveUp = mode === 'practice' && session.revealed.includes(result.id);
    if (result.answered || gaveUp) {
      questions[result.id] = updateStats(statsOf(progress, result.id), result.correct, at);
    }
  }
  return { ...progress, attempts: [...progress.attempts, record].slice(-MAX_ATTEMPTS), questions };
}

type Box = 1 | 2 | 3 | 4 | 5;

export interface LeitnerSummary {
  boxes: Record<Box, number>;
  due: number;
  nextDueAt: number | null;
}

/** Counts the reviewed bank questions in each box 1 to 5, those due at `now`, and the next due time. */
export function leitnerSummary(
  bank: readonly Question[],
  progress: Progress,
  now: number,
): LeitnerSummary {
  assertFinite('now', now);
  assertUniqueIds(bank);
  const summary: LeitnerSummary = {
    boxes: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    due: 0,
    nextDueAt: null,
  };
  for (const { id } of sortedReviewed(bank)) {
    const stats = statsOf(progress, id);
    if (stats?.dueAt == null) continue;
    summary.boxes[stats.box as Box]++;
    if (stats.dueAt <= now) summary.due++;
    else summary.nextDueAt = Math.min(summary.nextDueAt ?? stats.dueAt, stats.dueAt);
  }
  return summary;
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

function toCoverage(questions: readonly Question[], progress: Progress): CoverageBucket {
  const all = questions.map(({ id }) => statsOf(progress, id));
  const seen = all.filter((stats) => stats !== undefined);
  const answered = seen.reduce((sum, stats) => sum + stats.answered, 0);
  const correct = seen.reduce((sum, stats) => sum + stats.correct, 0);
  return {
    questions: questions.length,
    seen: seen.length,
    answered,
    correct,
    raw: answered === 0 ? null : correct / answered,
    weak: seen.filter((stats) => stats.box > 0).length,
  };
}

/** Coverage and accuracy of the reviewed bank questions: overall, per domain and per task. */
export function progressSummary(bank: readonly Question[], progress: Progress): ProgressSummary {
  assertUniqueIds(bank);
  const reviewed = sortedReviewed(bank);
  return {
    overall: toCoverage(reviewed, progress),
    byDomain: perDomain((id) =>
      toCoverage(
        reviewed.filter((question) => question.domain === id),
        progress,
      ),
    ),
    byTask: Object.fromEntries(
      tasks.map(({ id }) => [
        id,
        toCoverage(
          reviewed.filter((question) => question.task === id),
          progress,
        ),
      ]),
    ) as Record<TaskId, CoverageBucket>,
  };
}
