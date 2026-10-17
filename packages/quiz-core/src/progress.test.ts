import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ATTEMPTS, progressSchema, tasks } from '@field-guide/schema';
import type { AttemptRecord, Progress, QuestionStats } from '@field-guide/schema';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  correctKeys,
  deepFreeze,
  makeBank,
  makeQuestion,
  wrongKeys,
} from './__mocks__/questions.ts';
import {
  answerItem,
  makeDescendingQuestions,
  makeExam,
  playActions,
} from './__mocks__/sessions.ts';
import * as quizCore from './index.ts';
import type {
  CoverageBucket,
  LeitnerSummary,
  PoolFilter,
  ProgressResult,
  ProgressSummary,
  RestoreResult,
} from './index.ts';
import { listServices, practicePool } from './pools.ts';
import {
  LEITNER_INTERVALS_MS,
  emptyProgress,
  leitnerSummary,
  parseProgress,
  progressSummary,
  recordSession,
  updateStats,
} from './progress.ts';
import { sessionReducer, sessionScore, startSession } from './session.ts';
import type { Session, SessionMode } from './session.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const DOMAIN_IDS = [1, 2, 3, 4] as const;

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture: no element at index ${String(index)}`);
  return item;
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

/** Valid stats in `box` (`dueAt` is forced to null in box 0). */
function stat(
  box: QuestionStats['box'],
  dueAt: number | null,
  extra: Partial<QuestionStats> = {},
): QuestionStats {
  return {
    answered: 2,
    correct: 1,
    lastAnsweredAt: 0,
    box,
    dueAt: box === 0 ? null : dueAt,
    ...extra,
  };
}

// The progress fixture of AC-1: 2 attempt records and 3 question stats (boxes 0, 1 and 5).
const attemptExam: AttemptRecord = {
  mode: 'exam',
  seed: 123_456,
  size: 65,
  startedAt: 1_700_000_000_000,
  submittedAt: 1_700_000_060_000,
  submitReason: 'manual',
  total: 10,
  answered: 8,
  correct: 6,
  estimated: 640,
  byDomain: {
    1: { total: 4, answered: 3, correct: 3 },
    2: { total: 3, answered: 3, correct: 2 },
    3: { total: 2, answered: 1, correct: 1 },
    4: { total: 1, answered: 1, correct: 0 },
  },
};

const attemptPractice: AttemptRecord = {
  mode: 'practice',
  seed: 0,
  size: 5,
  startedAt: 1_700_100_000_000,
  submittedAt: 1_700_100_030_000,
  submitReason: 'timeout',
  total: 5,
  answered: 5,
  correct: 5,
  estimated: 1000,
  byDomain: {
    1: { total: 5, answered: 5, correct: 5 },
    2: { total: 0, answered: 0, correct: 0 },
    3: { total: 0, answered: 0, correct: 0 },
    4: { total: 0, answered: 0, correct: 0 },
  },
};

const fixtureProgress: Progress = {
  version: 1,
  attempts: [attemptExam, attemptPractice],
  questions: {
    'd1-1.3-0007': {
      answered: 3,
      correct: 3,
      lastAnsweredAt: 1_700_000_060_000,
      box: 0,
      dueAt: null,
    },
    'd2-2.1-0002': {
      answered: 2,
      correct: 0,
      lastAnsweredAt: 1_700_000_060_000,
      box: 1,
      dueAt: 1_700_000_060_000,
    },
    'd3-3.4-0120': {
      answered: 7,
      correct: 5,
      lastAnsweredAt: 1_700_100_030_000,
      box: 5,
      dueAt: 1_701_309_630_000,
    },
  },
};

const NO_PROGRESS: Progress = { version: 1, attempts: [], questions: {} };

interface BuildOptions {
  mode?: SessionMode;
  seed?: number;
  startedAt?: number;
  submitAt?: number;
}

/**
 * A submitted 5-question session on a short exam (size 65 requested, 5 items) whose ids sort in
 * the reverse of the item order (domains 4, 4, 3, 2, 1). Items 0, 1 and 4 are answered right,
 * item 2 wrong, item 3 left unanswered; submitted by hand at `submitAt`.
 */
function buildSession(options: BuildOptions = {}): Session {
  const { mode = 'exam', seed = 424_242, startedAt = 1_000, submitAt = 60_000 } = options;
  const questions = makeDescendingQuestions(5);
  const exam = makeExam(questions, {}, { seed, size: 65 });
  let session = startSession(exam, { mode, now: startedAt });
  const right = (index: number) => correctKeys(at(questions, index));
  session = answerItem(session, 0, right(0), startedAt + 1);
  session = answerItem(session, 1, right(1), startedAt + 2);
  session = answerItem(session, 2, [at(wrongKeys(at(questions, 2)), 0)], startedAt + 3);
  session = answerItem(session, 4, right(4), startedAt + 4);
  return sessionReducer(session, { type: 'submit', now: submitAt });
}

function idOf(session: Session, index: number): string {
  return at(session.exam.items, index).question.id;
}

function statsOf(progress: Progress, id: string): QuestionStats | undefined {
  return Object.hasOwn(progress.questions, id) ? progress.questions[id] : undefined;
}

function lastAttempt(progress: Progress): AttemptRecord {
  return at(progress.attempts, progress.attempts.length - 1);
}

// ---------------------------------------------------------------------------------------------
// emptyProgress and parseProgress
// ---------------------------------------------------------------------------------------------

describe('emptyProgress', () => {
  test('AC-5: emptyProgress is a version 1 progress with no attempts and no stats', () => {
    expect(emptyProgress()).toEqual({ version: 1, attempts: [], questions: {} });
  });

  test('AC-5: emptyProgress passes progressSchema', () => {
    expect(progressSchema.safeParse(emptyProgress()).success).toBe(true);
  });

  test('AC-5: two calls give different objects, with no shared arrays or records', () => {
    const first = emptyProgress();
    const second = emptyProgress();
    expect(first).not.toBe(second);
    expect(first.attempts).not.toBe(second.attempts);
    expect(first.questions).not.toBe(second.questions);
  });
});

describe('parseProgress', () => {
  test('AC-6: the AC-1 fixture parses to a progress deep-equal to the input', () => {
    const result = parseProgress(fixtureProgress);
    expect(result).toEqual({ ok: true, progress: fixtureProgress });
  });

  test('AC-6: the same fixture parses after a JSON round trip', () => {
    const stored: unknown = JSON.parse(JSON.stringify(fixtureProgress));
    expect(parseProgress(stored)).toEqual({ ok: true, progress: fixtureProgress });
  });

  test('AC-6: an empty progress parses', () => {
    expect(parseProgress(NO_PROGRESS)).toEqual({ ok: true, progress: NO_PROGRESS });
  });

  test.each([
    ['version 2', { version: 2, attempts: [], questions: {} }],
    ['version "1"', { version: '1' }],
    ['version 2 with garbage', { version: 2, other: 'newer format' }],
    ['version 0', { version: 0, attempts: [], questions: {} }],
  ])('AC-6: %s gives reason "version"', (_name, data) => {
    const result = parseProgress(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('version');
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['42', 42],
    ['a string', 'text'],
    ['an array', []],
    ['an object with only version 1', { version: 1 }],
    ['version 1 with an unknown key', { version: 1, attempts: [], questions: {}, extra: 1 }],
  ])('AC-6: %s gives reason "invalid" with errors', (_name, data) => {
    const result = parseProgress(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test('AC-6: errors are "path: message" strings that name the failing field', () => {
    const result = parseProgress({ version: 1 });
    if (result.ok) throw new Error('expected a failure');
    for (const error of result.errors) expect(error).toMatch(/^.+: .+$/);
    expect(result.errors.some((error) => error.startsWith('attempts: '))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('questions: '))).toBe(true);
  });

  test('AC-6: parseProgress never throws, whatever the input', () => {
    const cyclic: Record<string, unknown> = { version: 1 };
    cyclic['self'] = cyclic;
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      Number.NaN,
      Symbol('s'),
      () => 1,
      cyclic,
      { version: 1, attempts: 'many', questions: [] },
      { version: 1, attempts: [null], questions: {} },
    ];
    for (const input of inputs) {
      expect(() => parseProgress(input)).not.toThrow();
      expect(typeof parseProgress(input).ok).toBe('boolean');
    }
  });

  test('AC-6: a parsed progress passes progressSchema', () => {
    const result = parseProgress(fixtureProgress);
    if (!result.ok) throw new Error('expected success');
    expect(progressSchema.safeParse(result.progress).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Leitner boxes: updateStats
// ---------------------------------------------------------------------------------------------

describe('updateStats', () => {
  test('AC-7: LEITNER_INTERVALS_MS is 0, 1, 3, 7 and 14 days', () => {
    expect(LEITNER_INTERVALS_MS).toEqual([0, 86_400_000, 259_200_000, 604_800_000, 1_209_600_000]);
  });

  test('AC-7: a first wrong answer goes to box 1, due at once', () => {
    expect(updateStats(undefined, false, 1_000)).toEqual({
      answered: 1,
      correct: 0,
      lastAnsweredAt: 1_000,
      box: 1,
      dueAt: 1_000,
    });
  });

  test('AC-7: a first right answer stays in box 0, not under review', () => {
    expect(updateStats(undefined, true, 1_000)).toEqual({
      answered: 1,
      correct: 1,
      lastAnsweredAt: 1_000,
      box: 0,
      dueAt: null,
    });
  });

  const T = 1_000_000;
  const before = (box: QuestionStats['box']): QuestionStats => ({
    answered: 4,
    correct: 2,
    lastAnsweredAt: 100,
    box,
    dueAt: box === 0 ? null : 100,
  });

  test.each([
    [1, 2, 86_400_000],
    [2, 3, 259_200_000],
    [3, 4, 604_800_000],
    [4, 5, 1_209_600_000],
  ] as const)('AC-8: right in box %i gives box %i due %i ms later', (from, to, wait) => {
    expect(updateStats(before(from), true, T)).toEqual({
      answered: 5,
      correct: 3,
      lastAnsweredAt: T,
      box: to,
      dueAt: T + wait,
    });
  });

  test('AC-8: right in box 5 graduates to box 0 with a null dueAt', () => {
    expect(updateStats(before(5), true, T)).toEqual({
      answered: 5,
      correct: 3,
      lastAnsweredAt: T,
      box: 0,
      dueAt: null,
    });
  });

  test('AC-8: right in box 0 stays in box 0', () => {
    expect(updateStats(before(0), true, T)).toEqual({
      answered: 5,
      correct: 3,
      lastAnsweredAt: T,
      box: 0,
      dueAt: null,
    });
  });

  test.each([0, 1, 2, 3, 4, 5] as const)('AC-8: wrong in box %i goes to box 1 due at t', (from) => {
    expect(updateStats(before(from), false, T)).toEqual({
      answered: 5,
      correct: 2,
      lastAnsweredAt: T,
      box: 1,
      dueAt: T,
    });
  });

  test('AC-8: one wrong then five right climbs 1, 2, 3, 4, 5, 0 and the counts add up', () => {
    let stats = updateStats(undefined, false, 10);
    const boxes: number[] = [stats.box];
    for (let step = 1; step <= 5; step += 1) {
      stats = updateStats(stats, true, 10 + step * 1_000);
      boxes.push(stats.box);
    }
    expect(boxes).toEqual([1, 2, 3, 4, 5, 0]);
    expect(stats).toEqual({
      answered: 6,
      correct: 5,
      lastAnsweredAt: 5_010,
      box: 0,
      dueAt: null,
    });
  });

  test('AC-8: a wrong answer in the middle of the climb sends the question back to box 1', () => {
    let stats = updateStats(undefined, false, 0);
    stats = updateStats(stats, true, 1);
    stats = updateStats(stats, true, 2);
    expect(stats.box).toBe(3);
    stats = updateStats(stats, false, 3);
    expect(stats).toEqual({ answered: 4, correct: 2, lastAnsweredAt: 3, box: 1, dueAt: 3 });
  });

  test('AC-8: any answer moves the box, due or not (no "too early" rule)', () => {
    // Box 3 is due 7 days after the last answer; answering 1 ms later still moves it.
    const stats: QuestionStats = {
      answered: 3,
      correct: 2,
      lastAnsweredAt: 1_000,
      box: 3,
      dueAt: 1_000 + 604_800_000,
    };
    expect(updateStats(stats, true, 1_001).box).toBe(4);
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '1000' as unknown as number],
  ])('AC-9: at = %s throws RangeError', (_name, value) => {
    expect(() => updateStats(undefined, true, value)).toThrow(RangeError);
    expect(() => updateStats(undefined, false, value)).toThrow(RangeError);
    expect(() => updateStats(before(2), true, value)).toThrow(RangeError);
  });

  test('AC-9: updateStats leaves a frozen stats untouched and returns a new object', () => {
    const frozen = deepFreeze(before(2));
    const snapshot = structuredClone(frozen);
    const result = updateStats(frozen, true, T);
    expect(result).not.toBe(frozen);
    expect(frozen).toEqual(snapshot);
    expect(result.box).toBe(3);
  });

  test('AC-9: a wrong answer on a frozen stats also returns a new object', () => {
    const frozen = deepFreeze(before(1));
    const result = updateStats(frozen, false, T);
    expect(result).not.toBe(frozen);
    expect(frozen).toEqual(before(1));
  });

  test('AC-9: a time of 0 and a negative time are valid', () => {
    expect(updateStats(undefined, false, 0).dueAt).toBe(0);
    expect(updateStats(undefined, false, -5).dueAt).toBe(-5);
  });
});

// ---------------------------------------------------------------------------------------------
// recordSession
// ---------------------------------------------------------------------------------------------

describe('recordSession: the attempt record', () => {
  test('AC-10: an active exam session throws RangeError', () => {
    const active = answerItem(
      startSession(makeExam(makeDescendingQuestions(3)), { mode: 'exam', now: 0 }),
      0,
      ['A'],
    );
    expect(active.status).toBe('active');
    expect(() => recordSession(NO_PROGRESS, active)).toThrow(RangeError);
  });

  test('AC-10: an active practice session throws RangeError, and a fresh one too', () => {
    const fresh = startSession(makeExam(makeDescendingQuestions(3)), { mode: 'practice', now: 0 });
    expect(() => recordSession(NO_PROGRESS, fresh)).toThrow(RangeError);
  });

  test('AC-11: a submitted exam session appends one record with its summary', () => {
    const session = buildSession();
    const result = recordSession(NO_PROGRESS, session);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toEqual({
      mode: 'exam',
      seed: 424_242,
      size: 65,
      startedAt: 1_000,
      submittedAt: 60_000,
      submitReason: 'manual',
      total: 5,
      answered: 4,
      correct: 3,
      estimated: 640,
      byDomain: {
        1: { total: 1, answered: 1, correct: 1 },
        2: { total: 1, answered: 0, correct: 0 },
        3: { total: 1, answered: 1, correct: 0 },
        4: { total: 2, answered: 2, correct: 2 },
      },
    });
  });

  test('AC-11: estimated and the per-domain tallies equal those of sessionScore', () => {
    const session = buildSession();
    const score = must(sessionScore(session));
    const record = lastAttempt(recordSession(NO_PROGRESS, session));
    expect(record.estimated).toBe(score.estimated);
    expect(record.total).toBe(score.total);
    expect(record.answered).toBe(score.answered);
    expect(record.correct).toBe(score.correct);
    for (const domain of DOMAIN_IDS) {
      const bucket = score.byDomain[domain];
      expect(record.byDomain[domain]).toEqual({
        total: bucket.total,
        answered: bucket.answered,
        correct: bucket.correct,
      });
    }
  });

  test('AC-11: the record keeps the requested size, not the number of items', () => {
    const session = buildSession();
    expect(session.exam.items).toHaveLength(5);
    expect(lastAttempt(recordSession(NO_PROGRESS, session)).size).toBe(65);
  });

  test('AC-11: the tallies hold only total, answered and correct (the schema is strict)', () => {
    const record = lastAttempt(recordSession(NO_PROGRESS, buildSession()));
    for (const domain of DOMAIN_IDS) {
      expect(Object.keys(record.byDomain[domain]).sort()).toEqual(['answered', 'correct', 'total']);
    }
    expect(Object.keys(record).sort()).toEqual(
      [
        'answered',
        'byDomain',
        'correct',
        'estimated',
        'mode',
        'seed',
        'size',
        'startedAt',
        'submitReason',
        'submittedAt',
        'total',
      ].sort(),
    );
  });

  test('AC-11: the result passes progressSchema', () => {
    const result = recordSession(fixtureProgress, buildSession());
    expect(progressSchema.safeParse(result).success).toBe(true);
  });

  test('AC-11: a practice session is recorded with mode "practice"', () => {
    const result = recordSession(NO_PROGRESS, buildSession({ mode: 'practice' }));
    expect(lastAttempt(result).mode).toBe('practice');
    expect(lastAttempt(result).submitReason).toBe('manual');
  });

  test('AC-12: a timed-out exam is recorded with its reason and the deadline as submittedAt', () => {
    const questions = makeDescendingQuestions(5);
    const exam = makeExam(questions, {}, { seed: 9, size: 5 });
    let session = startSession(exam, { mode: 'exam', now: 1_000, durationMs: 600_000 });
    session = answerItem(session, 0, correctKeys(at(questions, 0)), 2_000);
    session = answerItem(session, 1, ['A'], 3_000);
    session = sessionReducer(session, { type: 'tick', now: 700_000 });
    expect(session.submitReason).toBe('timeout');
    expect(session.submittedAt).toBe(601_000);

    const result = recordSession(NO_PROGRESS, session);
    expect(lastAttempt(result)).toMatchObject({
      submitReason: 'timeout',
      submittedAt: 601_000,
      startedAt: 1_000,
      answered: 2,
      correct: 1,
    });
    expect(statsOf(result, idOf(session, 0))).toEqual({
      answered: 1,
      correct: 1,
      lastAnsweredAt: 601_000,
      box: 0,
      dueAt: null,
    });
    expect(statsOf(result, idOf(session, 1))).toEqual({
      answered: 1,
      correct: 0,
      lastAnsweredAt: 601_000,
      box: 1,
      dueAt: 601_000,
    });
  });
});

describe('recordSession: question stats', () => {
  test('AC-12: right answers get box 0 stats graded at submittedAt', () => {
    const session = buildSession();
    const result = recordSession(NO_PROGRESS, session);
    for (const index of [0, 1, 4]) {
      expect(statsOf(result, idOf(session, index))).toEqual({
        answered: 1,
        correct: 1,
        box: 0,
        dueAt: null,
        lastAnsweredAt: 60_000,
      });
    }
  });

  test('AC-12: the wrong answer goes to box 1, due at submittedAt', () => {
    const session = buildSession();
    const result = recordSession(NO_PROGRESS, session);
    expect(statsOf(result, idOf(session, 2))).toEqual({
      answered: 1,
      correct: 0,
      lastAnsweredAt: 60_000,
      box: 1,
      dueAt: 60_000,
    });
  });

  test('AC-12: the unanswered question gets no stats entry', () => {
    const session = buildSession();
    const result = recordSession(NO_PROGRESS, session);
    expect(Object.hasOwn(result.questions, idOf(session, 3))).toBe(false);
    expect(Object.keys(result.questions).sort()).toEqual(
      [0, 1, 2, 4].map((index) => idOf(session, index)).sort(),
    );
  });

  test('AC-12: a session with no answer at all leaves the stats empty', () => {
    const questions = makeDescendingQuestions(3);
    const session = sessionReducer(startSession(makeExam(questions), { mode: 'exam', now: 0 }), {
      type: 'submit',
      now: 5_000,
    });
    const result = recordSession(NO_PROGRESS, session);
    expect(result.questions).toEqual({});
    expect(lastAttempt(result)).toMatchObject({
      total: 3,
      answered: 0,
      correct: 0,
      estimated: 100,
    });
  });

  test('AC-13: in practice mode a revealed question with no answer is graded as wrong', () => {
    const questions = makeDescendingQuestions(5);
    let session = startSession(makeExam(questions), { mode: 'practice', now: 1_000 });
    session = playActions(session, { type: 'reveal', now: 1_100 });
    session = sessionReducer(session, { type: 'submit', now: 9_000 });
    const result = recordSession(NO_PROGRESS, session);
    expect(statsOf(result, idOf(session, 0))).toEqual({
      answered: 1,
      correct: 0,
      lastAnsweredAt: 9_000,
      box: 1,
      dueAt: 9_000,
    });
  });

  test('AC-13: an answered then revealed question is graded on its answer', () => {
    const questions = makeDescendingQuestions(5);
    let session = startSession(makeExam(questions), { mode: 'practice', now: 1_000 });
    // Item 1 (multiple) answered right, item 2 (single) answered wrong; both then revealed.
    session = answerItem(session, 1, correctKeys(at(questions, 1)), 1_100);
    session = sessionReducer(session, { type: 'reveal', now: 1_200 });
    session = answerItem(session, 2, [at(wrongKeys(at(questions, 2)), 0)], 1_300);
    session = sessionReducer(session, { type: 'reveal', now: 1_400 });
    session = sessionReducer(session, { type: 'submit', now: 9_000 });
    const result = recordSession(NO_PROGRESS, session);
    expect(statsOf(result, idOf(session, 1))).toEqual({
      answered: 1,
      correct: 1,
      lastAnsweredAt: 9_000,
      box: 0,
      dueAt: null,
    });
    expect(statsOf(result, idOf(session, 2))).toEqual({
      answered: 1,
      correct: 0,
      lastAnsweredAt: 9_000,
      box: 1,
      dueAt: 9_000,
    });
  });

  test('AC-13: an unanswered, unrevealed question gets no stats (and a plain answer is graded)', () => {
    const questions = makeDescendingQuestions(5);
    let session = startSession(makeExam(questions), { mode: 'practice', now: 1_000 });
    session = answerItem(session, 4, correctKeys(at(questions, 4)), 1_100);
    session = sessionReducer(session, { type: 'submit', now: 9_000 });
    const result = recordSession(NO_PROGRESS, session);
    expect(Object.keys(result.questions)).toEqual([idOf(session, 4)]);
    expect(statsOf(result, idOf(session, 4))?.box).toBe(0);
  });

  test('AC-13: the record counts a revealed question without an answer as unanswered', () => {
    const questions = makeDescendingQuestions(4);
    let session = startSession(makeExam(questions), { mode: 'practice', now: 1_000 });
    session = sessionReducer(session, { type: 'reveal', now: 1_100 });
    session = answerItem(session, 1, correctKeys(at(questions, 1)), 1_200);
    session = sessionReducer(session, { type: 'submit', now: 9_000 });
    const score = must(sessionScore(session));
    const record = lastAttempt(recordSession(NO_PROGRESS, session));
    expect(record.answered).toBe(score.answered);
    expect(record.answered).toBe(1);
    expect(record.correct).toBe(1);
    expect(record.total).toBe(4);
  });

  test('AC-14: existing stats move with updateStats: box 2 right goes to box 3', () => {
    const session = buildSession();
    const id = idOf(session, 0);
    const progress: Progress = {
      version: 1,
      attempts: [],
      questions: {
        [id]: { answered: 3, correct: 1, lastAnsweredAt: 500, box: 2, dueAt: 500 + DAY },
      },
    };
    const result = recordSession(progress, session);
    expect(statsOf(result, id)).toEqual({
      answered: 4,
      correct: 2,
      lastAnsweredAt: 60_000,
      box: 3,
      dueAt: 60_000 + 3 * DAY,
    });
  });

  test('AC-14: existing stats in box 4 answered wrong go back to box 1', () => {
    const session = buildSession();
    const id = idOf(session, 2);
    const progress: Progress = {
      version: 1,
      attempts: [],
      questions: {
        [id]: { answered: 5, correct: 4, lastAnsweredAt: 500, box: 4, dueAt: 500 + 7 * DAY },
      },
    };
    const result = recordSession(progress, session);
    expect(statsOf(result, id)).toEqual({
      answered: 6,
      correct: 4,
      lastAnsweredAt: 60_000,
      box: 1,
      dueAt: 60_000,
    });
  });

  test('AC-14: stats of ids that are not in the session, or were skipped, are unchanged', () => {
    const session = buildSession();
    const skipped = idOf(session, 3);
    const outsider = 'd1-1.3-0007';
    const skippedStats = stat(3, 700_000, { answered: 6, correct: 4, lastAnsweredAt: 123 });
    const outsiderStats = stat(5, 9_000_000, { answered: 9, correct: 9, lastAnsweredAt: 456 });
    const progress: Progress = {
      version: 1,
      attempts: [],
      questions: { [skipped]: skippedStats, [outsider]: outsiderStats },
    };
    const result = recordSession(progress, session);
    expect(statsOf(result, skipped)).toEqual(skippedStats);
    expect(statsOf(result, outsider)).toEqual(outsiderStats);
    expect(Object.keys(result.questions)).toHaveLength(2 + 4);
  });

  test('AC-14: the new record is appended after the existing attempts', () => {
    const result = recordSession(fixtureProgress, buildSession());
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]).toEqual(attemptExam);
    expect(result.attempts[1]).toEqual(attemptPractice);
    expect(lastAttempt(result)).toMatchObject({ seed: 424_242, startedAt: 1_000 });
  });
});

describe('recordSession: idempotency, history limit and purity', () => {
  test('AC-15: recording the same session twice returns the same object the second time', () => {
    const session = buildSession();
    const first = recordSession(NO_PROGRESS, session);
    const second = recordSession(first, session);
    expect(second).toBe(first);
    expect(second.attempts).toHaveLength(1);
  });

  test('AC-15: an equal session built again is still recognised', () => {
    const first = recordSession(NO_PROGRESS, buildSession());
    expect(recordSession(first, buildSession())).toBe(first);
  });

  test('AC-15: the same mode, seed and startedAt is the same attempt, whatever else differs', () => {
    const first = recordSession(NO_PROGRESS, buildSession({ submitAt: 60_000 }));
    expect(recordSession(first, buildSession({ submitAt: 90_000 }))).toBe(first);
  });

  test('AC-15: two sessions with different startedAt give two records, in recording order', () => {
    const early = buildSession({ startedAt: 1_000 });
    const late = buildSession({ startedAt: 2_000, submitAt: 70_000 });
    const result = recordSession(recordSession(NO_PROGRESS, early), late);
    expect(result.attempts.map((attempt) => attempt.startedAt)).toEqual([1_000, 2_000]);
  });

  test('AC-15: the key is not the seed alone: same seed, different startedAt are two attempts', () => {
    const first = recordSession(NO_PROGRESS, buildSession({ seed: 7, startedAt: 1_000 }));
    const second = recordSession(first, buildSession({ seed: 7, startedAt: 5_000 }));
    expect(second).not.toBe(first);
    expect(second.attempts).toHaveLength(2);
  });

  test('AC-15: the key includes the seed: same startedAt, different seed are two attempts', () => {
    const first = recordSession(NO_PROGRESS, buildSession({ seed: 7 }));
    const second = recordSession(first, buildSession({ seed: 8 }));
    expect(second.attempts.map((attempt) => attempt.seed)).toEqual([7, 8]);
  });

  test('AC-15: the key includes the mode: same seed and startedAt, other mode, are two attempts', () => {
    const first = recordSession(NO_PROGRESS, buildSession({ mode: 'exam' }));
    const second = recordSession(first, buildSession({ mode: 'practice' }));
    expect(second.attempts.map((attempt) => attempt.mode)).toEqual(['exam', 'practice']);
  });

  const records = (count: number): AttemptRecord[] =>
    Array.from({ length: count }, (_, index) => ({ ...attemptPractice, startedAt: index }));

  test('AC-16: the history limit is 500', () => {
    expect(MAX_ATTEMPTS).toBe(500);
  });

  test('AC-16: with 500 records stored, one more keeps 500, drops the oldest and ends with the new', () => {
    const full: Progress = { version: 1, attempts: records(500), questions: {} };
    const result = recordSession(full, buildSession({ startedAt: 10_000_000 }));
    expect(result.attempts).toHaveLength(500);
    expect(result.attempts[0]).toEqual(at(full.attempts, 1));
    expect(result.attempts[498]).toEqual(at(full.attempts, 499));
    expect(lastAttempt(result)).toMatchObject({ startedAt: 10_000_000, seed: 424_242 });
    expect(result.attempts.some((attempt) => attempt.startedAt === 0)).toBe(false);
  });

  test('AC-16: with 499 records stored nothing is dropped', () => {
    const almost: Progress = { version: 1, attempts: records(499), questions: {} };
    const result = recordSession(almost, buildSession({ startedAt: 10_000_000 }));
    expect(result.attempts).toHaveLength(500);
    expect(result.attempts[0]).toEqual(at(almost.attempts, 0));
  });

  test('AC-16: question stats are kept when old records are dropped', () => {
    const outsider = 'd1-1.3-0007';
    const full: Progress = {
      version: 1,
      attempts: records(500),
      questions: { [outsider]: stat(2, 5_000) },
    };
    const result = recordSession(full, buildSession({ startedAt: 10_000_000 }));
    expect(statsOf(result, outsider)).toEqual(stat(2, 5_000));
    expect(Object.keys(result.questions)).toHaveLength(1 + 4);
  });

  test('AC-16: the result always passes progressSchema', () => {
    const full: Progress = { version: 1, attempts: records(500), questions: {} };
    const result = recordSession(full, buildSession({ startedAt: 10_000_000 }));
    expect(progressSchema.safeParse(result).success).toBe(true);
    const small = recordSession(NO_PROGRESS, buildSession({ mode: 'practice' }));
    expect(progressSchema.safeParse(small).success).toBe(true);
  });

  test('AC-17: recordSession does not change a deep-frozen progress and session', () => {
    const progress = deepFreeze(structuredClone(fixtureProgress));
    const session = deepFreeze(buildSession());
    const progressSnapshot = structuredClone(fixtureProgress);
    const sessionSnapshot = structuredClone(session);
    const result = recordSession(progress, session);
    expect(result).not.toBe(progress);
    expect(progress).toEqual(progressSnapshot);
    expect(session).toEqual(sessionSnapshot);
    expect(result.attempts).toHaveLength(3);
  });

  test('AC-17: recordSession is deterministic', () => {
    const session = buildSession();
    const first = recordSession(fixtureProgress, session);
    const second = recordSession(fixtureProgress, session);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  test('AC-17: a new progress does not share its arrays or stats with the old one', () => {
    const progress = structuredClone(fixtureProgress);
    const result = recordSession(progress, buildSession());
    expect(result.attempts).not.toBe(progress.attempts);
    expect(result.questions).not.toBe(progress.questions);
    expect(progress.attempts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// leitnerSummary
// ---------------------------------------------------------------------------------------------

/**
 * A bank of 6 reviewed questions (r0 to r5) and 1 draft, with stats: r0 box 0, r1 box 1 (due at
 * 5,000), r2 box 1 (20,000), r3 box 3 (50,000), r4 box 5 (90,000), r5 none; an id that is not in
 * the bank (box 1, 15,000) and the draft (box 1, 1,000).
 */
function leitnerFixture() {
  const bank = makeBank({ 1: 6, 2: 1 }, (domain) => (domain === 2 ? { status: 'draft' } : {}));
  const ids = bank.map((question) => question.id);
  const [r0, r1, r2, r3, r4, , draft] = ids;
  const outsider = 'd1-1.1-9999';
  const progress: Progress = {
    version: 1,
    attempts: [],
    questions: {
      [must(r0)]: stat(0, null),
      [must(r1)]: stat(1, 5_000),
      [must(r2)]: stat(1, 20_000),
      [must(r3)]: stat(3, 50_000),
      [must(r4)]: stat(5, 90_000),
      [outsider]: stat(1, 15_000),
      [must(draft)]: stat(1, 1_000),
    },
  };
  return { bank, progress };
}

describe('leitnerSummary', () => {
  test('AC-18: counts the reviewed bank questions per box, ignoring unknown ids and drafts', () => {
    const { bank, progress } = leitnerFixture();
    expect(leitnerSummary(bank, progress, 10_000).boxes).toEqual({ 1: 2, 2: 0, 3: 1, 4: 0, 5: 1 });
  });

  test('AC-18: one box-1 question is due and nextDueAt is the smallest future dueAt', () => {
    const { bank, progress } = leitnerFixture();
    // Due at 5,000 counts; the unknown id (15,000) and the draft (1,000) must not.
    expect(leitnerSummary(bank, progress, 10_000)).toEqual({
      boxes: { 1: 2, 2: 0, 3: 1, 4: 0, 5: 1 },
      due: 1,
      nextDueAt: 20_000,
    });
  });

  test('AC-18: a question due exactly at now counts as due and is not the next one', () => {
    const { bank, progress } = leitnerFixture();
    expect(leitnerSummary(bank, progress, 5_000)).toMatchObject({ due: 1, nextDueAt: 20_000 });
    expect(leitnerSummary(bank, progress, 20_000)).toMatchObject({ due: 2, nextDueAt: 50_000 });
  });

  test('AC-18: one millisecond before the dueAt the question is not due yet', () => {
    const { bank, progress } = leitnerFixture();
    expect(leitnerSummary(bank, progress, 4_999)).toMatchObject({ due: 0, nextDueAt: 5_000 });
  });

  test('AC-18: with every box due, nextDueAt is null', () => {
    const { bank, progress } = leitnerFixture();
    expect(leitnerSummary(bank, progress, 90_000)).toMatchObject({ due: 4, nextDueAt: null });
  });

  test('AC-18: with nothing boxed, due is 0 and nextDueAt is null', () => {
    const bank = makeBank({ 1: 3 });
    const [a, b] = bank;
    const progress: Progress = {
      version: 1,
      attempts: [],
      questions: { [must(a).id]: stat(0, null), [must(b).id]: stat(0, null) },
    };
    expect(leitnerSummary(bank, progress, 1_000)).toEqual({
      boxes: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      due: 0,
      nextDueAt: null,
    });
    expect(leitnerSummary(bank, NO_PROGRESS, 1_000)).toEqual({
      boxes: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      due: 0,
      nextDueAt: null,
    });
  });

  test('AC-18: an empty bank gives an empty summary', () => {
    expect(leitnerSummary([], fixtureProgress, 0)).toEqual({
      boxes: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      due: 0,
      nextDueAt: null,
    });
  });

  test('AC-18: a verified question of the bank is not counted either', () => {
    const reviewed = makeQuestion({ status: 'reviewed' });
    const verified = makeQuestion({ status: 'verified' });
    const progress: Progress = {
      version: 1,
      attempts: [],
      questions: { [reviewed.id]: stat(2, 100), [verified.id]: stat(2, 100) },
    };
    expect(leitnerSummary([reviewed, verified], progress, 100)).toMatchObject({
      boxes: { 2: 1 },
      due: 1,
    });
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('AC-18: now = %s throws RangeError', (_name, now) => {
    const { bank, progress } = leitnerFixture();
    expect(() => leitnerSummary(bank, progress, now)).toThrow(RangeError);
  });

  test('AC-18: leitnerSummary does not change a deep-frozen bank and progress', () => {
    const { bank, progress } = leitnerFixture();
    const snapshot = structuredClone(progress);
    expect(() => leitnerSummary(deepFreeze(bank), deepFreeze(progress), 10_000)).not.toThrow();
    expect(progress).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
// progressSummary
// ---------------------------------------------------------------------------------------------

function summaryFixture() {
  const a1 = makeQuestion({ task: '1.1' });
  const a2 = makeQuestion({ task: '1.1' });
  const b1 = makeQuestion({ task: '1.2' });
  const c1 = makeQuestion({ task: '2.1' });
  const c2 = makeQuestion({ task: '2.1' });
  const draft = makeQuestion({ task: '1.1', status: 'draft' });
  const bank = [c2, b1, a2, draft, c1, a1];
  const progress: Progress = {
    version: 1,
    attempts: [],
    questions: {
      [a1.id]: stat(0, null, { answered: 3, correct: 2 }),
      [b1.id]: stat(1, 100, { answered: 2, correct: 0 }),
      [c1.id]: stat(3, 100, { answered: 4, correct: 1 }),
      [draft.id]: stat(0, null, { answered: 5, correct: 5 }),
      'd4-4.4-9999': stat(1, 100, { answered: 9, correct: 9 }),
    },
  };
  return { bank, progress };
}

const zeroBucket: CoverageBucket = {
  questions: 0,
  seen: 0,
  answered: 0,
  correct: 0,
  raw: null,
  weak: 0,
};

describe('progressSummary', () => {
  test('AC-19: the overall bucket sums the reviewed bank questions', () => {
    const { bank, progress } = summaryFixture();
    expect(progressSummary(bank, progress).overall).toEqual({
      questions: 5,
      seen: 3,
      answered: 9,
      correct: 3,
      raw: 3 / 9,
      weak: 2,
    });
  });

  test('AC-19: each domain bucket has its own counts', () => {
    const { bank, progress } = summaryFixture();
    const { byDomain } = progressSummary(bank, progress);
    expect(byDomain[1]).toEqual({
      questions: 3,
      seen: 2,
      answered: 5,
      correct: 2,
      raw: 2 / 5,
      weak: 1,
    });
    expect(byDomain[2]).toEqual({
      questions: 2,
      seen: 1,
      answered: 4,
      correct: 1,
      raw: 1 / 4,
      weak: 1,
    });
  });

  test('AC-19: domains without questions have zeros and a null raw; keys are exactly 1 to 4', () => {
    const { bank, progress } = summaryFixture();
    const { byDomain } = progressSummary(bank, progress);
    expect(Object.keys(byDomain).sort()).toEqual(['1', '2', '3', '4']);
    expect(byDomain[3]).toEqual(zeroBucket);
    expect(byDomain[4]).toEqual(zeroBucket);
  });

  test('AC-19: each task bucket has its own counts, and a raw of 0 is not null', () => {
    const { bank, progress } = summaryFixture();
    const { byTask } = progressSummary(bank, progress);
    expect(byTask['1.1']).toEqual({
      questions: 2,
      seen: 1,
      answered: 3,
      correct: 2,
      raw: 2 / 3,
      weak: 0,
    });
    expect(byTask['1.2']).toEqual({
      questions: 1,
      seen: 1,
      answered: 2,
      correct: 0,
      raw: 0,
      weak: 1,
    });
    expect(byTask['2.1']).toEqual({
      questions: 2,
      seen: 1,
      answered: 4,
      correct: 1,
      raw: 1 / 4,
      weak: 1,
    });
  });

  test('AC-19: byTask has all 14 tasks, the ones without questions are zeros with a null raw', () => {
    const { bank, progress } = summaryFixture();
    const { byTask } = progressSummary(bank, progress);
    expect(Object.keys(byTask).sort()).toEqual(tasks.map((task) => task.id).sort());
    expect(Object.keys(byTask)).toHaveLength(14);
    for (const task of tasks) {
      if (!['1.1', '1.2', '2.1'].includes(task.id)) expect(byTask[task.id]).toEqual(zeroBucket);
    }
  });

  test('AC-19: stats of drafts and of ids outside the bank are ignored', () => {
    const { bank, progress } = summaryFixture();
    const summary = progressSummary(bank, progress);
    // The draft (5 answered) and the outsider (9 answered) would raise these numbers.
    expect(summary.overall.answered).toBe(9);
    expect(summary.byDomain[4].answered).toBe(0);
    expect(summary.byTask['4.4'].weak).toBe(0);
  });

  test('AC-19: an empty bank and no progress give all zeros', () => {
    const summary = progressSummary([], NO_PROGRESS);
    expect(summary.overall).toEqual(zeroBucket);
    for (const domain of DOMAIN_IDS) expect(summary.byDomain[domain]).toEqual(zeroBucket);
  });

  test('AC-19: questions without stats count in questions but not in seen', () => {
    const bank = makeBank({ 3: 4 });
    const summary = progressSummary(bank, NO_PROGRESS);
    expect(summary.byDomain[3]).toEqual({ ...zeroBucket, questions: 4 });
    expect(summary.overall).toEqual({ ...zeroBucket, questions: 4 });
  });

  test('AC-19: progressSummary does not change a deep-frozen bank and progress', () => {
    const { bank, progress } = summaryFixture();
    const snapshot = structuredClone(progress);
    expect(() => progressSummary(deepFreeze(bank), deepFreeze(progress))).not.toThrow();
    expect(progress).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
// Duplicate ids
// ---------------------------------------------------------------------------------------------

describe('duplicate ids in the bank', () => {
  const DUPLICATE = 'd1-1.1-0042';
  const bank = [
    makeQuestion({ id: 'd1-1.1-0041' }),
    makeQuestion({ id: DUPLICATE }),
    makeQuestion({ id: DUPLICATE }),
  ];
  const domainFilter: PoolFilter = { kind: 'domain', domain: 1 };

  test.each([
    ['leitnerSummary', () => leitnerSummary(bank, NO_PROGRESS, 0)],
    ['progressSummary', () => progressSummary(bank, NO_PROGRESS)],
    ['practicePool', () => practicePool(bank, NO_PROGRESS, domainFilter)],
    ['listServices', () => listServices(bank)],
  ])('AC-20: %s throws an Error that names the shared id', (_name, call) => {
    expect(call).toThrow(Error);
    expect(call).toThrow(DUPLICATE);
  });

  test('AC-20: a bank with distinct ids does not throw', () => {
    const distinct = [makeQuestion({ id: 'd1-1.1-0041' }), makeQuestion({ id: 'd1-1.1-0042' })];
    expect(() => leitnerSummary(distinct, NO_PROGRESS, 0)).not.toThrow();
    expect(() => progressSummary(distinct, NO_PROGRESS)).not.toThrow();
    expect(() => practicePool(distinct, NO_PROGRESS, domainFilter)).not.toThrow();
    expect(() => listServices(distinct)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------------------------

const srcDir = import.meta.dirname;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('package surface', () => {
  test('AC-36: the progress, pools and saved modules exist', () => {
    for (const name of ['progress.ts', 'pools.ts', 'saved.ts']) {
      expect(existsSync(join(srcDir, name)), name).toBe(true);
    }
  });

  test('AC-36: every function and constant of the interface is exported from the index', () => {
    expect(typeof quizCore.emptyProgress).toBe('function');
    expect(typeof quizCore.parseProgress).toBe('function');
    expect(typeof quizCore.updateStats).toBe('function');
    expect(typeof quizCore.recordSession).toBe('function');
    expect(typeof quizCore.leitnerSummary).toBe('function');
    expect(typeof quizCore.progressSummary).toBe('function');
    expect(typeof quizCore.practicePool).toBe('function');
    expect(typeof quizCore.listServices).toBe('function');
    expect(typeof quizCore.buildPracticeExam).toBe('function');
    expect(typeof quizCore.saveSession).toBe('function');
    expect(typeof quizCore.restoreSession).toBe('function');
    expect(Array.isArray(quizCore.LEITNER_INTERVALS_MS)).toBe(true);
    expect(quizCore.LEITNER_INTERVALS_MS).toEqual([0, DAY, 3 * DAY, 7 * DAY, 14 * DAY]);
  });

  test('AC-36: the functions exported from the index are the ones of their modules', () => {
    expect(quizCore.updateStats).toBe(updateStats);
    expect(quizCore.practicePool).toBe(practicePool);
  });

  test('AC-36: every type of the interface is exported from the index', () => {
    // Checked by the typecheck: the type imports at the top of this file fail to compile if
    // one is missing.
    expectTypeOf<ProgressResult>().toMatchTypeOf<{ ok: boolean }>();
    expectTypeOf<LeitnerSummary>().toHaveProperty('nextDueAt').toEqualTypeOf<number | null>();
    expectTypeOf<CoverageBucket>().toHaveProperty('raw').toEqualTypeOf<number | null>();
    expectTypeOf<ProgressSummary>().toHaveProperty('overall').toEqualTypeOf<CoverageBucket>();
    expectTypeOf<PoolFilter>().toMatchTypeOf<{ kind: string }>();
    expectTypeOf<RestoreResult>().toMatchTypeOf<{ ok: boolean }>();
    expect(true).toBe(true);
  });

  test('AC-36: the new modules import only @field-guide/schema and their own files', () => {
    for (const name of ['progress.ts', 'pools.ts', 'saved.ts']) {
      const code = withoutComments(readFileSync(join(srcDir, name), 'utf8'));
      const specifiers = [...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
      for (const specifier of specifiers) {
        const allowed = specifier === '@field-guide/schema' || specifier.startsWith('./');
        expect(allowed, `${name} imports "${specifier}"`).toBe(true);
      }
    }
  });

  test('AC-36: the new modules use no node: module, Math.random or clock', () => {
    for (const name of ['progress.ts', 'pools.ts', 'saved.ts']) {
      const code = withoutComments(readFileSync(join(srcDir, name), 'utf8'));
      expect(code, `${name} uses node:`).not.toMatch(/node:/);
      expect(code, `${name} uses Math.random`).not.toMatch(/Math\s*\.\s*random/);
      expect(code, `${name} uses the clock`).not.toMatch(/\bDate\b/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Review round 1 (gaps): AC-39
// ---------------------------------------------------------------------------------------------

describe('recordSession: the active check comes first', () => {
  test('AC-39: an active session throws RangeError even when its attempt is already recorded', () => {
    const recorded = recordSession(NO_PROGRESS, buildSession());
    // The same exam, mode, seed and startedAt as buildSession(), but still active.
    const exam = makeExam(makeDescendingQuestions(5), {}, { seed: 424_242, size: 65 });
    const active = startSession(exam, { mode: 'exam', now: 1_000 });
    expect(active.status).toBe('active');
    expect(
      recorded.attempts.some(
        (attempt) =>
          attempt.mode === active.mode &&
          attempt.seed === active.exam.seed &&
          attempt.startedAt === active.startedAt,
      ),
    ).toBe(true);
    expect(() => recordSession(recorded, active)).toThrow(RangeError);
  });

  test('AC-39: the same holds in practice mode', () => {
    const recorded = recordSession(NO_PROGRESS, buildSession({ mode: 'practice' }));
    const exam = makeExam(makeDescendingQuestions(5), {}, { seed: 424_242, size: 65 });
    const active = startSession(exam, { mode: 'practice', now: 1_000 });
    expect(() => recordSession(recorded, active)).toThrow(RangeError);
  });
});
