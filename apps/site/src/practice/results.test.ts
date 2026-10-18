import { sessionReducer, sessionScore, startSession } from '@field-guide/quiz-core';
import type { Exam, ExamItem, Session } from '@field-guide/quiz-core';
import { domains } from '@field-guide/schema';
import type { DomainId, Question, TaskId } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { resultsView } from './results.ts';

/** Computes on first use, so a throwing implementation fails the tests, not the collection. */
function lazy<T>(make: () => T): () => T {
  let value: { made: T } | undefined;
  return () => {
    value ??= { made: make() };
    return value.made;
  };
}

const START = 1_000_000;
const MINUTE = 60_000;

const TASK_OF: Record<DomainId, TaskId> = { 1: '1.1', 2: '2.1', 3: '3.1', 4: '4.1' };

interface Spec {
  id: string;
  domain: DomainId;
  type?: 'single' | 'multiple';
  /** Original keys marked correct. */
  correct: string[];
  /** Number of options (default 4 for single, 5 for multiple). */
  optionCount?: number;
}

function question(spec: Spec): Question {
  const type = spec.type ?? 'single';
  const count = spec.optionCount ?? (type === 'single' ? 4 : 5);
  return {
    id: spec.id,
    domain: spec.domain,
    task: TASK_OF[spec.domain],
    services: [],
    difficulty: 'medium',
    type,
    stem: `Stem of ${spec.id}`,
    options: Array.from({ length: count }, (_, index) => {
      const key = String.fromCharCode(65 + index);
      return { key, text: `Option ${key}`, correct: spec.correct.includes(key), why: 'Because.' };
    }),
    references: ['https://docs.aws.amazon.com/'],
    status: 'reviewed',
    provenance: { generated_by: 'fixture', verified_by: 'fixture', reviewed_by: 'fixture' },
  };
}

/** A hand-made exam: items in the order given, with the option order given. */
function examOf(items: ExamItem[]): Exam {
  const byDomain = Object.fromEntries(
    domains.map(({ id }) => {
      const n = items.filter((item) => item.question.domain === id).length;
      return [id, { quota: n, available: n, picked: n, short: 0 }];
    }),
  ) as Exam['byDomain'];
  return { seed: 7, size: items.length, items, complete: true, byDomain };
}

function startedOn(items: ExamItem[], durationMs = items.length * 2 * MINUTE): Session {
  return startSession(examOf(items), { mode: 'exam', now: START, durationMs });
}

function answer(session: Session, id: string, keys: string[], now = START + 1): Session {
  const index = session.exam.items.findIndex((item) => item.question.id === id);
  const there = sessionReducer(session, { type: 'goTo', index, now });
  return sessionReducer(there, { type: 'answer', selected: keys, now });
}

function flag(session: Session, id: string, now = START + 1): Session {
  const index = session.exam.items.findIndex((item) => item.question.id === id);
  const there = sessionReducer(session, { type: 'goTo', index, now });
  return sessionReducer(there, { type: 'flag', flagged: true, now });
}

function submit(session: Session, now: number): Session {
  return sessionReducer(session, { type: 'submit', now });
}

/** Five questions with a different option order each, one of every kind of outcome. */
function smallSession(): Session {
  const items: ExamItem[] = [
    // single, answered right: shown D (key B is in 4th place)
    {
      question: question({ id: 'd1-1.1-0001', domain: 1, correct: ['B'] }),
      optionOrder: ['C', 'A', 'D', 'B'],
    },
    // single, answered wrong
    {
      question: question({ id: 'd2-2.1-0002', domain: 2, correct: ['A'] }),
      optionOrder: ['D', 'C', 'B', 'A'],
    },
    // multiple, answered wrong (one right key, one wrong)
    {
      question: question({ id: 'd3-3.1-0003', domain: 3, type: 'multiple', correct: ['B', 'E'] }),
      optionOrder: ['E', 'D', 'C', 'B', 'A'],
    },
    // single, not answered
    {
      question: question({ id: 'd1-1.1-0004', domain: 1, correct: ['C'] }),
      optionOrder: ['B', 'C', 'A', 'D'],
    },
    // multiple, answered right
    {
      question: question({ id: 'd2-2.1-0005', domain: 2, type: 'multiple', correct: ['A', 'C'] }),
      optionOrder: ['C', 'E', 'A', 'B', 'D'],
    },
  ];
  let session = startedOn(items);
  session = answer(session, 'd1-1.1-0001', ['B']);
  session = answer(session, 'd2-2.1-0002', ['C']);
  session = answer(session, 'd3-3.1-0003', ['A', 'B']);
  session = answer(session, 'd2-2.1-0005', ['A', 'C']);
  session = flag(session, 'd1-1.1-0001');
  session = flag(session, 'd1-1.1-0004');
  return submit(session, START + 5 * MINUTE);
}

/**
 * `perDomain[d] = [total, correct]` single-answer questions: the first `correct` of each domain are
 * answered right, the others wrong. Submitted 10 minutes after the start.
 */
function bulkSession(perDomain: Record<DomainId, [number, number]>): Session {
  const items: ExamItem[] = [];
  const rightIds: string[] = [];
  const wrongIds: string[] = [];
  let counter = 0;
  for (const { id: domain } of domains) {
    const [total, correct] = perDomain[domain];
    for (let i = 0; i < total; i += 1) {
      counter += 1;
      const id = `d${String(domain)}-${TASK_OF[domain]}-${String(counter).padStart(4, '0')}`;
      items.push({
        question: question({ id, domain, correct: ['A'] }),
        optionOrder: ['A', 'B', 'C', 'D'],
      });
      (i < correct ? rightIds : wrongIds).push(id);
    }
  }
  let session = startedOn(items);
  for (const id of rightIds) session = answer(session, id, ['A']);
  for (const id of wrongIds) session = answer(session, id, ['B']);
  return submit(session, START + 10 * MINUTE);
}

describe('resultsView: summary numbers', () => {
  test('AC-4: the score, the verdict and the counts come from the session score', () => {
    const session = bulkSession({ 1: [25, 18], 2: [25, 17], 3: [32, 23], 4: [0, 0] });
    const score = sessionScore(session);
    const view = resultsView(session);

    expect(score?.estimated).toBe(737);
    expect(view.estimated).toBe(737);
    expect(view.passed).toBe(true);
    expect(view.correct).toBe(58);
    expect(view.total).toBe(82);
  });

  test('AC-4: percent is the correct share rounded to a whole number', () => {
    // 58 of 82 is 70.7 %
    expect(
      resultsView(bulkSession({ 1: [25, 18], 2: [25, 17], 3: [32, 23], 4: [0, 0] })).percent,
    ).toBe(71);
    // 2 of 3 is 66.7 %
    expect(resultsView(bulkSession({ 1: [3, 2], 2: [0, 0], 3: [0, 0], 4: [0, 0] })).percent).toBe(
      67,
    );
  });

  test('AC-4: 720 passes (31 of 45 is exactly 720) and 700 fails (30 of 45)', () => {
    const pass = resultsView(bulkSession({ 1: [45, 31], 2: [0, 0], 3: [0, 0], 4: [0, 0] }));
    const fail = resultsView(bulkSession({ 1: [45, 30], 2: [0, 0], 3: [0, 0], 4: [0, 0] }));

    expect(pass.estimated).toBe(720);
    expect(pass.passed).toBe(true);
    expect(fail.estimated).toBe(700);
    expect(fail.passed).toBe(false);
  });

  test('AC-4: flagged and unanswered counts', () => {
    const view = resultsView(smallSession());

    expect(view.flagged).toBe(2);
    expect(view.unanswered).toBe(1);
    expect(view.total).toBe(5);
    expect(view.correct).toBe(2);
  });

  test('AC-4: time used is submit time minus start, against the full limit', () => {
    const view = resultsView(smallSession());

    expect(view.timeUsedMs).toBe(5 * MINUTE);
    expect(view.timeLimitMs).toBe(10 * MINUTE);
    expect(view.timedOut).toBe(false);
  });

  test('AC-4: a session ended by the deadline reports the whole limit as used and timedOut', () => {
    const items: ExamItem[] = [
      {
        question: question({ id: 'd1-1.1-0001', domain: 1, correct: ['A'] }),
        optionOrder: ['A', 'B', 'C', 'D'],
      },
      {
        question: question({ id: 'd2-2.1-0002', domain: 2, correct: ['A'] }),
        optionOrder: ['A', 'B', 'C', 'D'],
      },
    ];
    const started = startedOn(items);
    const answered = answer(started, 'd1-1.1-0001', ['A']);
    const deadline = START + 4 * MINUTE;
    const ended = sessionReducer(answered, { type: 'tick', now: deadline + 5_000 });
    const view = resultsView(ended);

    expect(view.timedOut).toBe(true);
    expect(view.timeUsedMs).toBe(4 * MINUTE);
    expect(view.timeLimitMs).toBe(4 * MINUTE);
    expect(view.correct).toBe(1);
    expect(view.unanswered).toBe(1);
  });

  test('AC-4: an active session has no results (RangeError)', () => {
    const items: ExamItem[] = [
      {
        question: question({ id: 'd1-1.1-0001', domain: 1, correct: ['A'] }),
        optionOrder: ['A', 'B', 'C', 'D'],
      },
    ];

    expect(() => resultsView(startedOn(items))).toThrow(RangeError);
  });
});

describe('resultsView: domain rows', () => {
  const view = lazy(() =>
    resultsView(bulkSession({ 1: [25, 18], 2: [25, 17], 3: [32, 23], 4: [0, 0] })),
  );

  test('AC-4: four rows in domain order with the exam weights 30, 26, 24, 20', () => {
    expect(view().domains.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(view().domains.map((row) => row.weight)).toEqual([30, 26, 24, 20]);
    expect(view().domains.map((row) => row.title)).toEqual(domains.map((domain) => domain.title));
  });

  test('AC-4: each row holds correct, total and raw', () => {
    expect(view().domains.map(({ correct, total }) => [correct, total])).toEqual([
      [18, 25],
      [17, 25],
      [23, 32],
      [0, 0],
    ]);
    expect(view().domains[0]?.raw).toBe(18 / 25);
    expect(view().domains[1]?.raw).toBe(17 / 25);
    expect(view().domains[2]?.raw).toBe(23 / 32);
  });

  test('AC-4: raw 0.72 exactly (18 of 25) is not "needs work"', () => {
    expect(view().domains[0]?.raw).toBe(0.72);
    expect(view().domains[0]?.needsWork).toBe(false);
  });

  test('AC-4: raw below 0.72 (17 of 25 = 0.68) needs work', () => {
    expect(view().domains[1]?.needsWork).toBe(true);
  });

  test('AC-4: 23 of 32 (0.71875, shown as 72 %) still needs work: the cut-off uses the raw value', () => {
    expect(view().domains[2]?.raw).toBeLessThan(0.72);
    expect(Math.round((view().domains[2]?.raw ?? 0) * 100)).toBe(72);
    expect(view().domains[2]?.needsWork).toBe(true);
  });

  test('AC-4: a domain without questions has raw null and no needs-work flag', () => {
    expect(view().domains[3]?.total).toBe(0);
    expect(view().domains[3]?.raw).toBeNull();
    expect(view().domains[3]?.needsWork).toBe(false);
  });

  test('AC-4: a domain answered above 0.72 does not need work', () => {
    const above = resultsView(bulkSession({ 1: [26, 19], 2: [0, 0], 3: [0, 0], 4: [0, 0] }));

    expect(above.domains[0]?.raw).toBeCloseTo(0.7308, 3);
    expect(above.domains[0]?.needsWork).toBe(false);
  });

  test('AC-4: a domain with questions but no correct answer has raw 0 and needs work', () => {
    const none = resultsView(bulkSession({ 1: [0, 0], 2: [0, 0], 3: [4, 0], 4: [0, 0] }));

    expect(none.domains[2]?.raw).toBe(0);
    expect(none.domains[2]?.needsWork).toBe(true);
  });
});

describe('resultsView: item rows', () => {
  const view = lazy(() => resultsView(smallSession()));

  test('AC-4: one row per question in exam order, numbered from 1, with domain, task and stem', () => {
    expect(view().items.map((row) => [row.number, row.id])).toEqual([
      [1, 'd1-1.1-0001'],
      [2, 'd2-2.1-0002'],
      [3, 'd3-3.1-0003'],
      [4, 'd1-1.1-0004'],
      [5, 'd2-2.1-0005'],
    ]);
    expect(view().items[2]?.domain).toBe(3);
    expect(view().items[2]?.task).toBe('3.1');
    expect(view().items[2]?.stem).toBe('Stem of d3-3.1-0003');
  });

  test('AC-4: status is correct, incorrect or unanswered', () => {
    expect(view().items.map((row) => row.status)).toEqual([
      'correct',
      'incorrect',
      'incorrect',
      'unanswered',
      'correct',
    ]);
  });

  test('AC-4: the flag of each row', () => {
    expect(view().items.map((row) => row.flagged)).toEqual([true, false, false, true, false]);
  });

  test('AC-4: "your answer" letters are display positions, not keys (single, right)', () => {
    // key B is in 4th place of [C, A, D, B]
    expect(view().items[0]?.yourLetters).toEqual(['D']);
  });

  test('AC-4: wrong single answer shows your and the correct display letters', () => {
    // order [D, C, B, A]: picked C is 2nd (B), correct A is 4th (D)
    expect(view().items[1]?.yourLetters).toEqual(['B']);
    expect(view().items[1]?.correctLetters).toEqual(['D']);
  });

  test('AC-4: wrong multiple answer shows sorted display letters', () => {
    // order [E, D, C, B, A]: picked A, B are 5th and 4th -> D, E; correct B, E are 4th and 1st -> A, D
    expect(view().items[2]?.yourLetters).toEqual(['D', 'E']);
    expect(view().items[2]?.correctLetters).toEqual(['A', 'D']);
  });

  test('AC-4: an unanswered question has no letters of yours but still has the correct ones', () => {
    // order [B, C, A, D]: correct C is 2nd
    expect(view().items[3]?.yourLetters).toEqual([]);
    expect(view().items[3]?.correctLetters).toEqual(['B']);
  });

  test('AC-4: a right multiple answer has the same letters on both sides', () => {
    // order [C, E, A, B, D]: A and C are 3rd and 1st
    expect(view().items[4]?.yourLetters).toEqual(['A', 'C']);
    expect(view().items[4]?.correctLetters).toEqual(['A', 'C']);
  });
});

describe('resultsView: filter counts', () => {
  test('AC-4: All, Incorrect (incorrect + unanswered) and Flagged', () => {
    const view = resultsView(smallSession());

    expect(view.counts).toEqual({ all: 5, incorrect: 3, flagged: 2 });
  });

  test('AC-4: with every answer right and nothing flagged only All is non-zero', () => {
    const view = resultsView(bulkSession({ 1: [3, 3], 2: [2, 2], 3: [0, 0], 4: [0, 0] }));

    expect(view.counts).toEqual({ all: 5, incorrect: 0, flagged: 0 });
  });

  test('AC-4: counts agree with the item rows', () => {
    const view = resultsView(smallSession());

    expect(view.items.filter((row) => row.status !== 'correct')).toHaveLength(
      view.counts.incorrect,
    );
    expect(view.items.filter((row) => row.flagged)).toHaveLength(view.counts.flagged);
  });
});
