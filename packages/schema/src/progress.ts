// Progress and saved-session schemas: what the practice-test app keeps between visits (spec 018).
import { z } from 'zod';

import type { DomainId } from './exam.ts';
import { questionIdSchema } from './question-id.ts';

export const PROGRESS_VERSION = 1;
export const SAVED_SESSION_VERSION = 1;
export const MAX_ATTEMPTS = 500;

/** 0 = not under review. */
export type LeitnerBox = 0 | 1 | 2 | 3 | 4 | 5;

export interface QuestionStats {
  answered: number;
  correct: number;
  lastAnsweredAt: number;
  box: LeitnerBox;
  dueAt: number | null;
}

export interface DomainTally {
  total: number;
  answered: number;
  correct: number;
}

export interface AttemptRecord {
  mode: 'exam' | 'practice';
  seed: number;
  size: number;
  startedAt: number;
  submittedAt: number;
  submitReason: 'manual' | 'timeout';
  total: number;
  answered: number;
  correct: number;
  estimated: number;
  byDomain: Record<DomainId, DomainTally>;
}

export interface Progress {
  version: 1;
  attempts: AttemptRecord[];
  questions: Record<string, QuestionStats>;
}

export interface SavedItem {
  id: string;
  optionOrder: string[];
}

export interface SavedSession {
  version: 1;
  mode: 'exam' | 'practice';
  startedAt: number;
  deadline: number | null;
  current: number;
  exam: {
    seed: number;
    size: number;
    complete: boolean;
    byDomain: Record<DomainId, { quota: number; available: number; picked: number; short: number }>;
    items: SavedItem[];
  };
  answers: Record<string, string[]>;
  flagged: string[];
  revealed: string[];
  status: 'active' | 'submitted';
  submittedAt: number | null;
  submitReason: 'manual' | 'timeout' | null;
}

type Ctx = z.RefinementCtx;

function fail(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

const count = z.int().min(0);
const time = z.number();
const mode = z.enum(['exam', 'practice']);
const submitReason = z.enum(['manual', 'timeout']);
const seed = z
  .int()
  .min(0)
  .max(2 ** 32 - 1);
const box = z.literal([0, 1, 2, 3, 4, 5]);

const statsSchema = z
  .strictObject({
    answered: z.int().min(1),
    correct: count,
    lastAnsweredAt: time,
    box,
    dueAt: time.nullable(),
  })
  .superRefine((stats, ctx) => {
    if (stats.correct > stats.answered) fail(ctx, ['correct'], 'must not exceed answered');
    if ((stats.box === 0) !== (stats.dueAt === null)) {
      fail(ctx, ['dueAt'], 'must be null exactly when box is 0');
    }
  });

/**
 * The question stats by id. zod drops an own `__proto__` key from a record, so it is rejected
 * before the record is parsed.
 */
const questionsSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, '__proto__')) {
      fail(ctx, ['__proto__'], 'is not a question id');
    }
  })
  .pipe(z.record(questionIdSchema, statsSchema));

function isOrdered(tally: DomainTally): boolean {
  return tally.correct <= tally.answered && tally.answered <= tally.total;
}

const tallySchema = z
  .strictObject({ total: count, answered: count, correct: count })
  .refine(isOrdered, { message: 'must have correct <= answered <= total' });

function checkAttempt(record: AttemptRecord, ctx: Ctx): void {
  if (!isOrdered(record)) fail(ctx, [], 'must have correct <= answered <= total');
  const tallies = Object.values(record.byDomain);
  for (const key of ['total', 'answered', 'correct'] as const) {
    const sum = tallies.reduce((acc, tally) => acc + tally[key], 0);
    if (sum !== record[key]) fail(ctx, ['byDomain'], `${key} must add up to ${record[key]}`);
  }
}

const attemptSchema = z
  .strictObject({
    mode,
    seed,
    size: z.int().min(1).max(10_000),
    startedAt: time,
    submittedAt: time,
    submitReason,
    total: z.int().min(1),
    answered: count,
    correct: count,
    estimated: z.int().min(100).max(1000),
    byDomain: z.strictObject({ 1: tallySchema, 2: tallySchema, 3: tallySchema, 4: tallySchema }),
  })
  .superRefine(checkAttempt);

export const progressSchema: z.ZodType<Progress> = z.strictObject({
  version: z.literal(PROGRESS_VERSION),
  attempts: z.array(attemptSchema).max(MAX_ATTEMPTS),
  questions: questionsSchema,
});

function checkUnique(values: string[], ctx: Ctx): void {
  if (new Set(values).size !== values.length) fail(ctx, [], 'must not repeat a value');
}

const uniqueStrings = z.array(z.string().min(1)).superRefine(checkUnique);
const uniqueIds = z.array(questionIdSchema).superRefine(checkUnique);
const planSchema = z.strictObject({ quota: count, available: count, picked: count, short: count });

function checkNamesItems(ids: Set<string>, names: string[], key: string, ctx: Ctx): void {
  for (const name of names) {
    if (!ids.has(name)) fail(ctx, [key, name], 'must name an item of the exam');
  }
}

function checkSaved(saved: SavedSession, ctx: Ctx): void {
  const { items, size, complete } = saved.exam;
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) fail(ctx, ['exam', 'items'], 'ids must be unique');
  if (saved.current >= items.length) fail(ctx, ['current'], 'must be an index into items');
  if (complete !== (items.length === size)) {
    fail(ctx, ['exam', 'complete'], 'must be true exactly when items.length equals size');
  }
  checkNamesItems(ids, Object.keys(saved.answers), 'answers', ctx);
  checkNamesItems(ids, saved.flagged, 'flagged', ctx);
  checkNamesItems(ids, saved.revealed, 'revealed', ctx);
  if ((saved.mode === 'practice') !== (saved.deadline === null)) {
    fail(ctx, ['deadline'], 'must be null exactly in practice mode');
  }
  if (saved.mode === 'exam' && saved.revealed.length > 0) {
    fail(ctx, ['revealed'], 'must be empty in exam mode');
  }
  const active = saved.status === 'active';
  if ((saved.submittedAt === null) !== active) {
    fail(ctx, ['submittedAt'], 'must be null exactly when the session is active');
  }
  if ((saved.submitReason === null) !== active) {
    fail(ctx, ['submitReason'], 'must be null exactly when the session is active');
  }
}

export const savedSessionSchema: z.ZodType<SavedSession> = z
  .strictObject({
    version: z.literal(SAVED_SESSION_VERSION),
    mode,
    startedAt: time,
    deadline: time.nullable(),
    current: count,
    exam: z.strictObject({
      seed,
      size: count,
      complete: z.boolean(),
      byDomain: z.strictObject({ 1: planSchema, 2: planSchema, 3: planSchema, 4: planSchema }),
      items: z.array(z.strictObject({ id: questionIdSchema, optionOrder: uniqueStrings })).min(1),
    }),
    answers: z.record(z.string(), uniqueStrings.min(1)),
    flagged: uniqueIds,
    revealed: uniqueIds,
    status: z.enum(['active', 'submitted']),
    submittedAt: time.nullable(),
    submitReason: submitReason.nullable(),
  })
  .superRefine(checkSaved);
