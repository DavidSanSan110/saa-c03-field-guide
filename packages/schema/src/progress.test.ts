import { describe, expect, test } from 'vitest';
import * as schemaIndex from './index.ts';
import {
  MAX_ATTEMPTS,
  PROGRESS_VERSION,
  SAVED_SESSION_VERSION,
  progressSchema,
  savedSessionSchema,
} from './progress.ts';

// ---------------------------------------------------------------------------------------------
// Hand-written fixtures (the schema package does not depend on quiz-core) and helpers
// ---------------------------------------------------------------------------------------------

type Path = (string | number)[];

/** A deep copy of `base` with the value at `path` replaced. */
function withValue(base: unknown, path: Path, value: unknown): unknown {
  const copy = structuredClone(base);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('fixture: empty path');
  node[last] = value;
  return copy;
}

/** A deep copy of `base` without the key at `path`. */
function withoutKey(base: unknown, path: Path): unknown {
  const copy = structuredClone(base);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('fixture: empty path');
  Reflect.deleteProperty(node, last);
  return copy;
}

function accepts(schema: { safeParse: (data: unknown) => { success: boolean } }, data: unknown) {
  return schema.safeParse(data).success;
}

type Case = [name: string, key: string, value: unknown];

/** One case per value that is not a finite number, for the time field `key`. */
function notFiniteCases(key: string): Case[] {
  return [
    [`${key} NaN`, key, Number.NaN],
    [`${key} Infinity`, key, Number.POSITIVE_INFINITY],
    [`${key} -Infinity`, key, Number.NEGATIVE_INFINITY],
  ];
}

// Two attempt records. Per-domain tallies add up to the record: 4+3+2+1 = 10 questions,
// 3+3+1+1 = 8 answered, 3+2+1+0 = 6 correct; and 5+0+0+0 = 5, 5, 5.
const attemptExam = {
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

const attemptPractice = {
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

const validProgress = {
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

const validStats = validProgress.questions['d2-2.1-0002'];

// Saved sessions. Three items from domains 1, 2 and 3 (the quotas of a 3-question exam).
const savedByDomain = {
  1: { quota: 1, available: 4, picked: 1, short: 0 },
  2: { quota: 1, available: 4, picked: 1, short: 0 },
  3: { quota: 1, available: 4, picked: 1, short: 0 },
  4: { quota: 0, available: 4, picked: 0, short: 0 },
};

const savedItems = [
  { id: 'd1-1.1-0001', optionOrder: ['B', 'A', 'D', 'C'] },
  { id: 'd2-2.1-0002', optionOrder: ['E', 'D', 'C', 'B', 'A'] },
  { id: 'd3-3.1-0003', optionOrder: ['A', 'B', 'C', 'D'] },
];

const savedExamSession = {
  version: 1,
  mode: 'exam',
  startedAt: 1_000,
  deadline: 7_801_000,
  current: 1,
  exam: { seed: 7, size: 3, complete: true, byDomain: savedByDomain, items: savedItems },
  answers: { 'd1-1.1-0001': ['B'], 'd2-2.1-0002': ['A', 'C'] },
  flagged: ['d2-2.1-0002'],
  revealed: [],
  status: 'active',
  submittedAt: null,
  submitReason: null,
};

const savedPracticeSession = {
  version: 1,
  mode: 'practice',
  startedAt: 2_000,
  deadline: null,
  current: 2,
  exam: {
    seed: 4_294_967_295,
    size: 3,
    complete: true,
    byDomain: savedByDomain,
    items: savedItems,
  },
  answers: { 'd1-1.1-0001': ['B'] },
  flagged: ['d3-3.1-0003', 'd1-1.1-0001'],
  revealed: ['d1-1.1-0001', 'd2-2.1-0002'],
  status: 'submitted',
  submittedAt: 90_000,
  submitReason: 'manual',
};

// ---------------------------------------------------------------------------------------------
// AC-1
// ---------------------------------------------------------------------------------------------

describe('constants and exports', () => {
  test('AC-1: PROGRESS_VERSION and SAVED_SESSION_VERSION are 1 and MAX_ATTEMPTS is 500', () => {
    expect(PROGRESS_VERSION).toBe(1);
    expect(SAVED_SESSION_VERSION).toBe(1);
    expect(MAX_ATTEMPTS).toBe(500);
  });

  test('AC-1: the schemas and the constants are importable from the schema index', () => {
    expect(schemaIndex.progressSchema).toBe(progressSchema);
    expect(schemaIndex.savedSessionSchema).toBe(savedSessionSchema);
    expect(schemaIndex.PROGRESS_VERSION).toBe(1);
    expect(schemaIndex.SAVED_SESSION_VERSION).toBe(1);
    expect(schemaIndex.MAX_ATTEMPTS).toBe(500);
  });

  test('AC-1: progressSchema accepts an empty progress', () => {
    expect(progressSchema.safeParse({ version: 1, attempts: [], questions: {} }).success).toBe(
      true,
    );
  });

  test('AC-1: progressSchema accepts 2 attempt records and 3 question stats (boxes 0, 1 and 5)', () => {
    const result = progressSchema.safeParse(validProgress);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validProgress);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-2
// ---------------------------------------------------------------------------------------------

describe('progressSchema: top level and question stats', () => {
  test('AC-2: version 2 and the string "1" are rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, ['version'], 2))).toBe(false);
    expect(accepts(progressSchema, withValue(validProgress, ['version'], '1'))).toBe(false);
  });

  test('AC-2: a missing version is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withoutKey(validProgress, ['version']))).toBe(false);
  });

  test('AC-2: an unknown top-level key is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, { ...validProgress, extra: true })).toBe(false);
  });

  test('AC-2: 500 attempt records are accepted and 501 are rejected', () => {
    const attempts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...attemptExam, startedAt: index }));
    expect(accepts(progressSchema, { ...validProgress, attempts: attempts(500) })).toBe(true);
    expect(accepts(progressSchema, { ...validProgress, attempts: attempts(501) })).toBe(false);
  });

  test.each([['q1'], ['__proto__'], ['d5-1.1-0001'], ['d1-1.1-007'], ['']])(
    'AC-2: a questions key %j is rejected',
    (key) => {
      expect(accepts(progressSchema, validProgress)).toBe(true);
      // JSON.parse makes "__proto__" an own property, as stored data would have it.
      const questions: unknown = JSON.parse(
        `{${JSON.stringify(key)}: ${JSON.stringify(validStats)}}`,
      );
      expect(Object.keys(questions as object)).toEqual([key]);
      expect(accepts(progressSchema, { ...validProgress, questions })).toBe(false);
    },
  );

  test('AC-2: a question stats entry that is not an object is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(
      accepts(progressSchema, { ...validProgress, questions: { 'd1-1.1-0001': 'stats' } }),
    ).toBe(false);
  });

  const statsPath = ['questions', 'd2-2.1-0002'];

  const badStats: Case[] = [
    ['answered 0', 'answered', 0],
    ['answered 1.5', 'answered', 1.5],
    ['answered NaN', 'answered', Number.NaN],
    ['correct above answered', 'correct', 3],
    ['negative correct', 'correct', -1],
    ['fractional correct', 'correct', 0.5],
    ['box 6', 'box', 6],
    ['box 1.5', 'box', 1.5],
    ['box -1', 'box', -1],
    ['box "1"', 'box', '1'],
    ['dueAt a string', 'dueAt', '1000'],
    ...notFiniteCases('lastAnsweredAt'),
    ...notFiniteCases('dueAt'),
  ];

  test.each(badStats)('AC-2: stats with %s are rejected', (_name, key, value) => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, [...statsPath, key], value))).toBe(
      false,
    );
  });

  test('AC-2: box 0 with a number dueAt is rejected', () => {
    const box0 = withValue(validProgress, ['questions', 'd1-1.3-0007', 'dueAt'], 5_000);
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, box0)).toBe(false);
  });

  test('AC-2: box 2 with a null dueAt is rejected', () => {
    const base = withValue(validProgress, [...statsPath, 'box'], 2);
    expect(accepts(progressSchema, base)).toBe(true);
    expect(accepts(progressSchema, withValue(base, [...statsPath, 'dueAt'], null))).toBe(false);
  });

  test('AC-2: a box 1 stats entry with a null dueAt is rejected too', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, [...statsPath, 'dueAt'], null))).toBe(
      false,
    );
  });

  test('AC-2: stats with correct equal to answered, and every box 0 to 5, are accepted', () => {
    for (const box of [0, 1, 2, 3, 4, 5]) {
      const stats = {
        answered: 2,
        correct: 2,
        lastAnsweredAt: 10,
        box,
        dueAt: box === 0 ? null : 10,
      };
      expect(
        accepts(progressSchema, { ...validProgress, questions: { 'd1-1.1-0001': stats } }),
      ).toBe(true);
    }
  });

  test('AC-2: an unknown key and a missing key in the stats are rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, [...statsPath, 'extra'], 1))).toBe(
      false,
    );
    expect(
      accepts(progressSchema, withoutKey(validProgress, [...statsPath, 'lastAnsweredAt'])),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-3
// ---------------------------------------------------------------------------------------------

describe('progressSchema: attempt records', () => {
  const at = (key: string): Path => ['attempts', 0, key];
  const domainAt = (domain: number, key: string): Path => ['attempts', 0, 'byDomain', domain, key];

  const badRecords: Case[] = [
    ['seed -1', 'seed', -1],
    ['seed 2 ** 32', 'seed', 2 ** 32],
    ['seed 1.5', 'seed', 1.5],
    ['seed NaN', 'seed', Number.NaN],
    ['size 0', 'size', 0],
    ['size 10,001', 'size', 10_001],
    ['size 2.5', 'size', 2.5],
    ['total 0', 'total', 0],
    ['answered above total', 'answered', 11],
    ['correct above answered', 'correct', 9],
    ['estimated 99', 'estimated', 99],
    ['estimated 1001', 'estimated', 1001],
    ['estimated 700.5', 'estimated', 700.5],
    ['mode "study"', 'mode', 'study'],
    ['submitReason null', 'submitReason', null],
    ['submitReason "auto"', 'submitReason', 'auto'],
    ...notFiniteCases('startedAt'),
    ...notFiniteCases('submittedAt'),
  ];

  test.each(badRecords)('AC-3: an attempt record with %s is rejected', (_name, key, value) => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, at(key), value))).toBe(false);
  });

  test.each([
    ['seed 0', 'seed', 0],
    ['seed 2 ** 32 - 1', 'seed', 2 ** 32 - 1],
    ['size 1', 'size', 1],
    ['size 10,000', 'size', 10_000],
    ['estimated 100', 'estimated', 100],
    ['estimated 1000', 'estimated', 1000],
  ] as const)('AC-3: an attempt record with %s is accepted', (_name, key, value) => {
    expect(accepts(progressSchema, withValue(validProgress, at(key), value))).toBe(true);
  });

  test('AC-3: a record that answered every question and got them all right is accepted', () => {
    // attemptPractice: total = answered = correct = 5.
    expect(accepts(progressSchema, { ...validProgress, attempts: [attemptPractice] })).toBe(true);
  });

  test('AC-3: a record with an unknown key is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, at('extra'), 1))).toBe(false);
  });

  test('AC-3: a byDomain missing domain 4 is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    // Attempt 1 has nothing in domain 4, so the totals still add up without it.
    const withoutFour = withoutKey(validProgress, ['attempts', 1, 'byDomain', 4]);
    expect(accepts(progressSchema, withoutFour)).toBe(false);
  });

  test('AC-3: a byDomain with a key 5 is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    const withFive = withValue(validProgress, ['attempts', 0, 'byDomain', 5], {
      total: 0,
      answered: 0,
      correct: 0,
    });
    expect(accepts(progressSchema, withFive)).toBe(false);
  });

  test('AC-3: byDomain totals that do not add up to total are rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, domainAt(1, 'total'), 5))).toBe(false);
    expect(accepts(progressSchema, withValue(validProgress, domainAt(1, 'total'), 3))).toBe(false);
  });

  test('AC-3: byDomain answered that does not add up to answered is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, domainAt(2, 'answered'), 2))).toBe(
      false,
    );
  });

  test('AC-3: byDomain correct that does not add up to correct is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, domainAt(4, 'correct'), 1))).toBe(
      false,
    );
  });

  test('AC-3: a domain tally with answered above total, or correct above answered, is rejected', () => {
    // Domain 4 is {1, 1, 0}. The record's own sums are raised so that only the tally is wrong.
    expect(accepts(progressSchema, validProgress)).toBe(true);
    const tooManyAnswered = withValue(
      withValue(validProgress, domainAt(4, 'answered'), 2),
      at('answered'),
      9,
    );
    expect(accepts(progressSchema, tooManyAnswered)).toBe(false);
    const tooManyCorrect = withValue(
      withValue(validProgress, domainAt(4, 'correct'), 2),
      at('correct'),
      8,
    );
    expect(accepts(progressSchema, tooManyCorrect)).toBe(false);
  });

  test('AC-3: a domain tally with a fractional count is rejected', () => {
    expect(accepts(progressSchema, validProgress)).toBe(true);
    expect(accepts(progressSchema, withValue(validProgress, domainAt(1, 'total'), 4.5))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// AC-4
// ---------------------------------------------------------------------------------------------

describe('savedSessionSchema', () => {
  test('AC-4: a valid active exam-mode session is accepted', () => {
    const result = savedSessionSchema.safeParse(savedExamSession);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(savedExamSession);
  });

  test('AC-4: a submitted practice-mode session with reveals is accepted', () => {
    const result = savedSessionSchema.safeParse(savedPracticeSession);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(savedPracticeSession);
  });

  test('AC-4: a submitted exam-mode session (timeout) is accepted', () => {
    const timedOut = withValue(
      withValue(withValue(savedExamSession, ['status'], 'submitted'), ['submittedAt'], 7_801_000),
      ['submitReason'],
      'timeout',
    );
    expect(accepts(savedSessionSchema, timedOut)).toBe(true);
  });

  test.each([
    ['version 2', ['version'], 2],
    ['version "1"', ['version'], '1'],
    ['current equal to items.length', ['current'], 3],
    ['current -1', ['current'], -1],
    ['current 1.5', ['current'], 1.5],
    ['complete true with fewer items than size', ['exam', 'size'], 5],
    ['complete false with items.length equal to size', ['exam', 'complete'], false],
    ['an answer for an id not in items', ['answers', 'd4-4.1-0009'], ['A']],
    ['an empty answer', ['answers', 'd1-1.1-0001'], []],
    ['an answer with a repeated key', ['answers', 'd1-1.1-0001'], ['A', 'A']],
    ['a flagged id not in items', ['flagged'], ['d4-4.1-0009']],
    ['a repeated flagged id', ['flagged'], ['d2-2.1-0002', 'd2-2.1-0002']],
    ['exam mode with a null deadline', ['deadline'], null],
    ['exam mode with a non-empty revealed', ['revealed'], ['d1-1.1-0001']],
    ['an active status with a submittedAt', ['submittedAt'], 5_000],
    ['an active status with a submitReason', ['submitReason'], 'manual'],
    ['a startedAt of NaN', ['startedAt'], Number.NaN],
    ['a deadline of Infinity', ['deadline'], Number.POSITIVE_INFINITY],
    ['an unknown key', ['extra'], true],
  ] as const)('AC-4: a saved session with %s is rejected', (_name, path, value) => {
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    expect(accepts(savedSessionSchema, withValue(savedExamSession, [...path], value))).toBe(false);
  });

  test('AC-4: a saved session without items is rejected', () => {
    // Consistent otherwise: nothing refers to an item and complete is false (0 of 3).
    const noItems = {
      ...savedExamSession,
      current: 0,
      exam: { ...savedExamSession.exam, complete: false, items: [] },
      answers: {},
      flagged: [],
    };
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    expect(accepts(savedSessionSchema, noItems)).toBe(false);
  });

  test('AC-4: two items with the same id are rejected', () => {
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    // The answers and the flag only name items 0 and 1, so they stay valid.
    expect(
      accepts(
        savedSessionSchema,
        withValue(savedExamSession, ['exam', 'items', 2, 'id'], 'd1-1.1-0001'),
      ),
    ).toBe(false);
  });

  test('AC-4: an item id that does not match the question id pattern is rejected', () => {
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    const renamed = withValue(savedExamSession, ['exam', 'items', 2, 'id'], 'q3');
    expect(accepts(savedSessionSchema, renamed)).toBe(false);
  });

  test('AC-4: an optionOrder with a repeated key or an empty key is rejected', () => {
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    const repeated = withValue(
      savedExamSession,
      ['exam', 'items', 0, 'optionOrder'],
      ['A', 'A', 'B', 'C'],
    );
    const empty = withValue(
      savedExamSession,
      ['exam', 'items', 0, 'optionOrder'],
      ['A', '', 'B', 'C'],
    );
    expect(accepts(savedSessionSchema, repeated)).toBe(false);
    expect(accepts(savedSessionSchema, empty)).toBe(false);
  });

  test('AC-4: a revealed id that is not in items, or revealed twice, is rejected', () => {
    expect(accepts(savedSessionSchema, savedPracticeSession)).toBe(true);
    expect(
      accepts(savedSessionSchema, withValue(savedPracticeSession, ['revealed'], ['d4-4.1-0009'])),
    ).toBe(false);
    expect(
      accepts(
        savedSessionSchema,
        withValue(savedPracticeSession, ['revealed'], ['d1-1.1-0001', 'd1-1.1-0001']),
      ),
    ).toBe(false);
  });

  test('AC-4: practice mode with a number deadline is rejected', () => {
    expect(accepts(savedSessionSchema, savedPracticeSession)).toBe(true);
    expect(accepts(savedSessionSchema, withValue(savedPracticeSession, ['deadline'], 9_000))).toBe(
      false,
    );
  });

  test('AC-4: status submitted with a null submitReason is rejected', () => {
    expect(accepts(savedSessionSchema, savedPracticeSession)).toBe(true);
    expect(
      accepts(savedSessionSchema, withValue(savedPracticeSession, ['submitReason'], null)),
    ).toBe(false);
  });

  test('AC-4: status submitted with a null submittedAt is rejected', () => {
    expect(accepts(savedSessionSchema, savedPracticeSession)).toBe(true);
    expect(
      accepts(savedSessionSchema, withValue(savedPracticeSession, ['submittedAt'], null)),
    ).toBe(false);
  });

  test('AC-4: a submitReason that is neither manual nor timeout is rejected', () => {
    expect(accepts(savedSessionSchema, savedPracticeSession)).toBe(true);
    expect(
      accepts(savedSessionSchema, withValue(savedPracticeSession, ['submitReason'], 'auto')),
    ).toBe(false);
  });

  test('AC-4: a mode that is neither exam nor practice is rejected', () => {
    expect(accepts(savedSessionSchema, savedPracticeSession)).toBe(true);
    expect(accepts(savedSessionSchema, withValue(savedPracticeSession, ['mode'], 'study'))).toBe(
      false,
    );
  });

  test('AC-4: an unknown key inside exam is rejected', () => {
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    expect(accepts(savedSessionSchema, withValue(savedExamSession, ['exam', 'extra'], 1))).toBe(
      false,
    );
  });

  test('AC-4: an unknown key inside an item is rejected', () => {
    expect(accepts(savedSessionSchema, savedExamSession)).toBe(true);
    expect(
      accepts(
        savedSessionSchema,
        withValue(savedExamSession, ['exam', 'items', 0, 'question'], {}),
      ),
    ).toBe(false);
  });
});
