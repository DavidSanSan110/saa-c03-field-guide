// Attempt scoring: raw score per domain and task, plus an estimate on the 100-1000 scale (spec 016).
import { tasks } from '@field-guide/schema';
import type { DomainId, Question, TaskId } from '@field-guide/schema';
import { gradeQuestion } from './grade.ts';
import { assertUniqueIds, perDomain } from './internal.ts';

export const PASS_MARK = 720;

/** `Math.round(100 + 900 * raw)`. `raw` in [0, 1], else RangeError. */
export function estimateScore(raw: number): number {
  if (!(raw >= 0 && raw <= 1)) throw new RangeError(`raw must be between 0 and 1, got ${raw}`);
  return Math.round(100 + 900 * raw);
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

function gradeResult(question: Question, answers: Answers): QuestionResult {
  const selected = answers[question.id] ?? [];
  return {
    id: question.id,
    domain: question.domain,
    task: question.task,
    answered: selected.length > 0,
    correct: gradeQuestion(question, selected),
  };
}

function toBucket(results: readonly QuestionResult[]): ScoreBucket {
  const total = results.length;
  const correct = results.filter((result) => result.correct).length;
  return {
    total,
    answered: results.filter((result) => result.answered).length,
    correct,
    raw: total === 0 ? null : correct / total,
  };
}

export function scoreAttempt(questions: readonly Question[], answers: Answers): AttemptScore {
  assertUniqueIds(questions);
  const results = questions.map((question) => gradeResult(question, answers));
  const overall = toBucket(results);
  const estimated = overall.raw === null ? null : estimateScore(overall.raw);
  return {
    ...overall,
    estimated,
    passed: estimated !== null && estimated >= PASS_MARK,
    byDomain: perDomain((id) => toBucket(results.filter((result) => result.domain === id))),
    byTask: Object.fromEntries(
      tasks.map(({ id }) => [id, toBucket(results.filter((result) => result.task === id))]),
    ) as Record<TaskId, ScoreBucket>,
    results,
  };
}
