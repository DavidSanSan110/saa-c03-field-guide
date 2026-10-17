import { savedSessionSchema } from '@field-guide/schema';
import type { Question, SavedSession } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { deepFreeze, makeBank, makeQuestion } from './__mocks__/questions.ts';
import {
  answerItem,
  makeDescendingQuestions,
  makeExam,
  playActions,
} from './__mocks__/sessions.ts';
import type { Exam } from './build.ts';
import { restoreSession, saveSession } from './saved.ts';
import { sessionReducer, startSession } from './session.ts';
import type { Session } from './session.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture: no element at index ${String(index)}`);
  return item;
}

/**
 * 6 questions whose ids sort in the REVERSE of the item order (domains 4, 4, 3, 2, 2, 1):
 * single, multiple (B, E), single, multiple (A, D), single, multiple (B, E). The exam shows the
 * first four items with a shuffled option order.
 */
function fixtureExam(): { questions: Question[]; exam: Exam } {
  const questions = makeDescendingQuestions(6);
  const exam = makeExam(
    questions,
    {
      0: ['D', 'C', 'B', 'A'],
      1: ['E', 'D', 'C', 'B', 'A'],
      2: ['B', 'A', 'D', 'C'],
      3: ['C', 'A', 'E', 'B', 'D'],
    },
    { seed: 31_337 },
  );
  return { questions, exam };
}

const goTo = (index: number, now = 1_000) => ({ type: 'goTo', index, now }) as const;
const flag = (flagged: boolean, now = 1_000) => ({ type: 'flag', flagged, now }) as const;
const reveal = (now = 1_000) => ({ type: 'reveal', now }) as const;
const tick = (now: number) => ({ type: 'tick', now }) as const;
const submit = (now: number) => ({ type: 'submit', now }) as const;

/** Active exam session on item 4: items 0 and 1 answered, item 2 flagged. Started at 1,000. */
function activeExam(exam: Exam = fixtureExam().exam): Session {
  let session = startSession(exam, { mode: 'exam', now: 1_000 });
  session = answerItem(session, 0, ['A'], 1_100);
  session = answerItem(session, 1, ['B', 'E'], 1_200);
  session = playActions(session, goTo(2, 1_300), flag(true, 1_300), goTo(4, 1_400));
  return session;
}

/** Active practice session on item 3: item 0 answered and revealed, item 1 revealed, item 3 flagged. */
function activePractice(exam: Exam = fixtureExam().exam): Session {
  let session = startSession(exam, { mode: 'practice', now: 2_000 });
  session = answerItem(session, 0, ['A'], 2_100);
  session = playActions(session, reveal(2_150), goTo(1, 2_200), reveal(2_250));
  session = answerItem(session, 2, ['A'], 2_300);
  return playActions(session, goTo(3, 2_400), flag(true, 2_400));
}

function submittedManually(exam: Exam = fixtureExam().exam): Session {
  return sessionReducer(activeExam(exam), submit(60_000));
}

function timedOut(exam: Exam = fixtureExam().exam): Session {
  let session = startSession(exam, { mode: 'exam', now: 1_000, durationMs: 600_000 });
  session = answerItem(session, 0, ['A'], 1_100);
  return sessionReducer(session, tick(700_000));
}

/**
 * The saved copy written by hand, so that the restore tests do not depend on `saveSession`.
 * Plain data with fresh arrays and objects.
 */
function handSaved(session: Session): SavedSession {
  const { exam } = session;
  return {
    version: 1,
    mode: session.mode,
    startedAt: session.startedAt,
    deadline: session.deadline,
    current: session.current,
    exam: {
      seed: exam.seed,
      size: exam.size,
      complete: exam.complete,
      byDomain: structuredClone(exam.byDomain),
      items: exam.items.map((item) => ({
        id: item.question.id,
        optionOrder: [...item.optionOrder],
      })),
    },
    answers: Object.fromEntries(
      Object.entries(session.answers).map(([id, keys]) => [id, [...keys]]),
    ),
    flagged: [...session.flagged],
    revealed: [...session.revealed],
    status: session.status,
    submittedAt: session.submittedAt,
    submitReason: session.submitReason,
  };
}

function idAt(session: Session, index: number): string {
  return at(session.exam.items, index).question.id;
}

function jsonRoundTrip(saved: SavedSession): unknown {
  return JSON.parse(JSON.stringify(saved));
}

function restored(data: unknown, bank: readonly Question[]): Session {
  const result = restoreSession(data, bank);
  if (!result.ok) throw new Error(`expected a restored session, got ${result.reason}`);
  return result.session;
}

function failure(data: unknown, bank: readonly Question[]) {
  const result = restoreSession(data, bank);
  if (result.ok) throw new Error('expected a failure');
  return result;
}

const sessionCases: readonly [string, (exam: Exam) => Session][] = [
  ['an active exam session', (exam) => activeExam(exam)],
  ['an active practice session with reveals', (exam) => activePractice(exam)],
  ['a manually submitted session', (exam) => submittedManually(exam)],
  ['a timed-out session', (exam) => timedOut(exam)],
];

// ---------------------------------------------------------------------------------------------
// saveSession
// ---------------------------------------------------------------------------------------------

describe('saveSession', () => {
  test('AC-29: an active exam session is saved as the schema-valid data of its fields', () => {
    const session = activeExam();
    const saved = saveSession(session);
    expect(savedSessionSchema.safeParse(saved).success).toBe(true);
    expect(saved.version).toBe(1);
    expect(saved).toStrictEqual({
      version: 1,
      mode: 'exam',
      startedAt: 1_000,
      deadline: 7_801_000,
      current: 4,
      exam: {
        seed: 31_337,
        size: 6,
        complete: true,
        byDomain: session.exam.byDomain,
        items: session.exam.items.map((item) => ({
          id: item.question.id,
          optionOrder: item.optionOrder,
        })),
      },
      answers: { [idAt(session, 0)]: ['A'], [idAt(session, 1)]: ['B', 'E'] },
      flagged: [idAt(session, 2)],
      revealed: [],
      status: 'active',
      submittedAt: null,
      submitReason: null,
    });
  });

  test('AC-29: the items are { id, optionOrder } in item order, with no question objects', () => {
    const session = activeExam();
    const saved = saveSession(session);
    expect(saved.exam.items.map((item) => item.id)).toEqual(
      session.exam.items.map((item) => item.question.id),
    );
    for (const item of saved.exam.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'optionOrder']);
    }
    expect(at(saved.exam.items, 0).optionOrder).toEqual(['D', 'C', 'B', 'A']);
    expect(JSON.stringify(saved)).not.toContain('stem');
    expect(JSON.stringify(saved)).not.toContain('Explanation for option');
  });

  test('AC-29: the saved data deep-equals its own JSON round trip', () => {
    const saved = saveSession(activeExam());
    expect(JSON.parse(JSON.stringify(saved))).toStrictEqual(saved);
  });

  test('AC-29: saveSession does not change a deep-frozen session', () => {
    const session = deepFreeze(activeExam());
    const snapshot = structuredClone(session);
    const saved = saveSession(session);
    expect(session).toEqual(snapshot);
    expect(savedSessionSchema.safeParse(saved).success).toBe(true);
  });

  test.each(sessionCases)('AC-29: %s is saved as data that passes the schema', (_name, make) => {
    expect(savedSessionSchema.safeParse(saveSession(make(fixtureExam().exam))).success).toBe(true);
  });

  test('AC-29: a submitted session keeps its status, time and reason', () => {
    const manual = saveSession(submittedManually());
    expect(manual).toMatchObject({
      status: 'submitted',
      submittedAt: 60_000,
      submitReason: 'manual',
    });
    const timeout = saveSession(timedOut());
    expect(timeout).toMatchObject({
      status: 'submitted',
      submittedAt: 601_000,
      submitReason: 'timeout',
      deadline: 601_000,
    });
  });

  test('AC-29: a practice session keeps its reveals and has no deadline', () => {
    const session = activePractice();
    const saved = saveSession(session);
    expect(saved.mode).toBe('practice');
    expect(saved.deadline).toBeNull();
    expect(saved.revealed).toEqual([idAt(session, 0), idAt(session, 1)]);
    expect(saved.flagged).toEqual([idAt(session, 3)]);
    expect(saved.current).toBe(3);
  });

  test('AC-29: the saved copy does not share its arrays with the session', () => {
    const session = activeExam();
    const saved = saveSession(session);
    saved.flagged.push('d1-1.1-0001');
    saved.exam.items.pop();
    expect(session.flagged).toHaveLength(1);
    expect(session.exam.items).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------
// restoreSession: the round trip
// ---------------------------------------------------------------------------------------------

describe('restoreSession: round trip', () => {
  test.each(sessionCases)('AC-30: %s survives save, JSON and restore', (_name, make) => {
    const { questions, exam } = fixtureExam();
    const own = make(exam);
    const result = restoreSession(jsonRoundTrip(saveSession(own)), questions);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session).toEqual(own);
  });

  test.each(sessionCases)('AC-30: %s works with the bank in a different order', (_name, make) => {
    const { questions, exam } = fixtureExam();
    const own = make(exam);
    const extra = makeBank({ 1: 2, 3: 2 });
    const shuffled = [
      at(extra, 0),
      ...[...questions].reverse(),
      at(extra, 3),
      at(extra, 1),
      at(extra, 2),
    ];
    const result = restoreSession(jsonRoundTrip(saveSession(own)), shuffled);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session).toEqual(own);
  });

  test('AC-30: the restored items hold the bank question objects, not the originals', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const bankCopy = structuredClone(questions).reverse();
    const session = restored(jsonRoundTrip(saveSession(own)), bankCopy);
    expect(session).toEqual(own);
    session.exam.items.forEach((item, index) => {
      const fromBank = bankCopy.find((question) => question.id === idAt(own, index));
      expect(item.question).toBe(fromBank);
      expect(item.question).not.toBe(at(own.exam.items, index).question);
    });
  });

  test('AC-30: the restored items keep their saved option order', () => {
    const { questions, exam } = fixtureExam();
    const session = restored(jsonRoundTrip(saveSession(activeExam(exam))), questions);
    expect(at(session.exam.items, 0).optionOrder).toEqual(['D', 'C', 'B', 'A']);
    expect(at(session.exam.items, 3).optionOrder).toEqual(['C', 'A', 'E', 'B', 'D']);
  });

  test('AC-30: a hand-written saved copy restores to the same session', () => {
    const { questions, exam } = fixtureExam();
    for (const make of [activeExam, activePractice, submittedManually, timedOut]) {
      const own = make(exam);
      expect(restored(jsonRoundTrip(handSaved(own)), questions)).toEqual(own);
    }
  });

  test('AC-30: extra reviewed questions in the bank do not change the restored exam', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const bank = [...makeBank({ 1: 3, 2: 3, 3: 3, 4: 3 }), ...questions];
    expect(restored(handSaved(own), bank)).toEqual(own);
  });
});

// ---------------------------------------------------------------------------------------------
// restoreSession: the session keeps working
// ---------------------------------------------------------------------------------------------

describe('restoreSession: a restored session keeps working', () => {
  test('AC-31: the same actions give deep-equal results on the original and the restored session', () => {
    const { questions, exam } = fixtureExam();
    const original = activeExam(exam);
    const copy = restored(handSaved(original), questions);
    const actions = [
      goTo(5, 3_000),
      { type: 'answer', selected: ['E', 'B'], now: 3_000 },
      flag(true, 3_100),
      goTo(0, 3_200),
      { type: 'answer', selected: ['C'], now: 3_300 },
      flag(false, 3_350),
      goTo(2, 3_400),
      flag(false, 3_450),
      submit(50_000),
    ] as const;
    let left = original;
    let right = copy;
    for (const action of actions) {
      left = sessionReducer(left, action);
      right = sessionReducer(right, action);
      expect(right).toEqual(left);
    }
    expect(right.status).toBe('submitted');
    expect(right.submittedAt).toBe(50_000);
  });

  test('AC-31: a restored practice session still reveals and locks answers like the original', () => {
    const { questions, exam } = fixtureExam();
    const original = activePractice(exam);
    const copy = restored(handSaved(original), questions);
    const actions = [
      goTo(0, 5_000),
      { type: 'answer', selected: ['B'], now: 5_000 },
      goTo(2, 5_100),
      reveal(5_100),
      { type: 'answer', selected: ['C'], now: 5_200 },
      submit(9_000),
    ] as const;
    expect(playActions(copy, ...actions)).toEqual(playActions(original, ...actions));
    // Item 0 was revealed before the save: its answer is locked.
    const onItem0 = playActions(copy, goTo(0, 5_000));
    expect(sessionReducer(onItem0, { type: 'answer', selected: ['B'], now: 5_000 })).toBe(onItem0);
  });

  test('AC-31: a submitted session restores as submitted and ignores answers', () => {
    const { questions, exam } = fixtureExam();
    const copy = restored(handSaved(submittedManually(exam)), questions);
    expect(sessionReducer(copy, { type: 'answer', selected: ['A'], now: 70_000 })).toBe(copy);
    expect(sessionReducer(copy, goTo(1, 70_000)).current).toBe(1);
  });

  test('AC-31: an exam saved at 1,000 and restored times out at its deadline on a tick', () => {
    const { questions, exam } = fixtureExam();
    const saved = handSaved(answerItem(startSession(exam, { mode: 'exam', now: 1_000 }), 0, ['A']));
    const copy = restored(jsonRoundTrip(saved), questions);
    expect(copy.status).toBe('active');
    expect(copy.deadline).toBe(7_801_000);
    const ended = sessionReducer(copy, tick(7_801_000));
    expect(ended.status).toBe('submitted');
    expect(ended.submitReason).toBe('timeout');
    expect(ended.submittedAt).toBe(7_801_000);
  });

  test('AC-31: restoring does not look at the clock: a late tick is capped at the deadline', () => {
    const { questions, exam } = fixtureExam();
    const saved = handSaved(startSession(exam, { mode: 'exam', now: 1_000 }));
    const copy = restored(saved, questions);
    expect(copy.status).toBe('active');
    const ended = sessionReducer(copy, tick(99_000_000));
    expect(ended).toMatchObject({
      status: 'submitted',
      submitReason: 'timeout',
      submittedAt: 7_801_000,
    });
  });

  test('AC-31: an answer after the deadline is not applied to a restored session', () => {
    const { questions, exam } = fixtureExam();
    const copy = restored(handSaved(startSession(exam, { mode: 'exam', now: 1_000 })), questions);
    const ended = sessionReducer(copy, { type: 'answer', selected: ['A'], now: 8_000_000 });
    expect(ended.submitReason).toBe('timeout');
    expect(ended.answers).toEqual({});
  });

  test('AC-31: a tick before the deadline changes nothing on a restored session', () => {
    const { questions, exam } = fixtureExam();
    const copy = restored(handSaved(activeExam(exam)), questions);
    expect(sessionReducer(copy, tick(7_800_999))).toBe(copy);
  });
});

// ---------------------------------------------------------------------------------------------
// restoreSession: bad data
// ---------------------------------------------------------------------------------------------

describe('restoreSession: version and invalid data', () => {
  test('AC-32: a saved copy with version 2 gives reason "version"', () => {
    const { questions, exam } = fixtureExam();
    const newer = { ...handSaved(activeExam(exam)), version: 2 };
    const result = failure(newer, questions);
    expect(result.reason).toBe('version');
  });

  test('AC-32: a bare object with version 2 gives reason "version"', () => {
    expect(failure({ version: 2 }, fixtureExam().questions).reason).toBe('version');
  });

  test.each([
    ['null', null],
    ['a string', 'text'],
    ['an empty object', {}],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', []],
    ['an object with only version 1', { version: 1 }],
  ])('AC-32: %s gives reason "invalid" with errors', (_name, data) => {
    const result = failure(data, fixtureExam().questions);
    expect(result.reason).toBe('invalid');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test.each([
    ['equal to items.length', 6],
    ['negative', -1],
    ['fractional', 1.5],
  ])('AC-32: a copy with current %s gives reason "invalid" with errors', (_name, current) => {
    const { questions, exam } = fixtureExam();
    const result = failure({ ...handSaved(activeExam(exam)), current }, questions);
    expect(result.reason).toBe('invalid');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('AC-32: a copy with an unknown key gives reason "invalid"', () => {
    const { questions, exam } = fixtureExam();
    expect(failure({ ...handSaved(activeExam(exam)), extra: 1 }, questions).reason).toBe('invalid');
  });

  test('AC-32: restoreSession never throws for bad data', () => {
    const { questions } = fixtureExam();
    const cyclic: Record<string, unknown> = { version: 1 };
    cyclic['self'] = cyclic;
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      'text',
      [],
      {},
      Number.NaN,
      Symbol('s'),
      () => 1,
      cyclic,
      { version: 1, mode: 'exam', exam: null },
      { version: 1, exam: { items: 'none' } },
    ];
    for (const input of inputs) {
      expect(() => restoreSession(input, questions)).not.toThrow();
      expect(restoreSession(input, questions).ok).toBe(false);
    }
  });

  test('AC-32: bad data with an empty bank does not throw either', () => {
    expect(failure(null, []).reason).toBe('invalid');
  });
});

describe('restoreSession: missing and changed questions', () => {
  test('AC-33: an item id that is not in the bank gives reason "missing" and names the id', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const bank = questions.filter((question) => question.id !== idAt(own, 2));
    const result = failure(handSaved(own), bank);
    expect(result.reason).toBe('missing');
    expect(result.errors.join('\n')).toContain(idAt(own, 2));
  });

  test('AC-33: two missing ids are both named', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const gone = [idAt(own, 0), idAt(own, 5)];
    const bank = questions.filter((question) => !gone.includes(question.id));
    const result = failure(handSaved(own), bank);
    expect(result.reason).toBe('missing');
    const text = result.errors.join('\n');
    for (const id of gone) expect(text).toContain(id);
  });

  test('AC-33: an item that is only a draft in the bank is missing', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const bank = questions.map((question) =>
      question.id === idAt(own, 1) ? { ...question, status: 'draft' as const } : question,
    );
    const result = failure(handSaved(own), bank);
    expect(result.reason).toBe('missing');
    expect(result.errors.join('\n')).toContain(idAt(own, 1));
  });

  test('AC-33: an item that is only verified in the bank is missing', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const bank = questions.map((question) =>
      question.id === idAt(own, 4) ? { ...question, status: 'verified' as const } : question,
    );
    expect(failure(handSaved(own), bank).reason).toBe('missing');
  });

  test('AC-33: an empty bank misses every item', () => {
    const own = activeExam();
    const result = failure(handSaved(own), []);
    expect(result.reason).toBe('missing');
    const text = result.errors.join('\n');
    for (const item of own.exam.items) expect(text).toContain(item.question.id);
  });

  test('AC-33: duplicate ids in the bank still throw an Error that names the id', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const bank = [...questions, { ...at(questions, 0) }];
    expect(() => restoreSession(handSaved(own), bank)).toThrow(Error);
    expect(() => restoreSession(handSaved(own), bank)).toThrow(idAt(own, 0));
  });
});

describe('restoreSession: changed questions', () => {
  function changed(mutate: (saved: SavedSession) => void) {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const saved = handSaved(own);
    mutate(saved);
    const result = failure(saved, questions);
    return { result, own };
  }

  test('AC-34: an optionOrder with a key the question does not have is "changed"', () => {
    const { result, own } = changed((saved) => {
      at(saved.exam.items, 0).optionOrder = ['D', 'C', 'B', 'Z'];
    });
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(idAt(own, 0));
  });

  test('AC-34: an optionOrder that misses one of the keys is "changed"', () => {
    const { result, own } = changed((saved) => {
      at(saved.exam.items, 0).optionOrder = ['D', 'C', 'B'];
    });
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(idAt(own, 0));
  });

  test('AC-34: an optionOrder with an extra key (a different length) is "changed"', () => {
    const { result, own } = changed((saved) => {
      at(saved.exam.items, 0).optionOrder = ['D', 'C', 'B', 'A', 'E'];
    });
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(idAt(own, 0));
  });

  test('AC-34: a stored answer that uses a key the question does not have is "changed"', () => {
    const { result, own } = changed((saved) => {
      saved.answers[at(saved.exam.items, 0).id] = ['Z'];
    });
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(idAt(own, 0));
  });

  test('AC-34: a stored answer with a key beyond the options of a 4-option question is "changed"', () => {
    const { result } = changed((saved) => {
      saved.answers[at(saved.exam.items, 0).id] = ['E'];
    });
    expect(result.reason).toBe('changed');
  });

  test('AC-34: a two-key answer on a single question is "changed"', () => {
    const { result, own } = changed((saved) => {
      saved.answers[at(saved.exam.items, 0).id] = ['A', 'B'];
    });
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(idAt(own, 0));
  });

  test('AC-34: a question that gained an option since the save is "changed"', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const id = idAt(own, 0);
    const grown = makeQuestion({
      id,
      domain: 4,
      task: '4.1',
      type: 'multiple',
      optionCount: 5,
      correct: ['B', 'E'],
    });
    const bank = questions.map((question) => (question.id === id ? grown : question));
    const result = failure(handSaved(own), bank);
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(id);
  });

  test('AC-34: a question that became single since the save, with a two-key answer, is "changed"', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const id = idAt(own, 1);
    // Item 1 holds ['B', 'E']; the new version of the question takes only one key.
    const narrowed = makeQuestion({
      id,
      domain: 4,
      task: '4.1',
      type: 'single',
      optionCount: 5,
      correct: ['A'],
    });
    const bank = questions.map((question) => (question.id === id ? narrowed : question));
    const result = failure(handSaved(own), bank);
    expect(result.reason).toBe('changed');
    expect(result.errors.join('\n')).toContain(id);
  });

  test('AC-34: a valid two-key answer on a multiple question is not "changed"', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    expect(restoreSession(handSaved(own), questions).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// restoreSession: normalised order
// ---------------------------------------------------------------------------------------------

describe('restoreSession: normalised order', () => {
  test('AC-35: answers given out of order come back in the original option order', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const saved = handSaved(own);
    saved.answers[idAt(own, 1)] = ['E', 'B'];
    const session = restored(saved, questions);
    expect(session.answers[idAt(own, 1)]).toEqual(['B', 'E']);
    expect(session.answers[idAt(own, 0)]).toEqual(['A']);
  });

  test('AC-35: a three-key answer in reverse order comes back in original order', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const saved = handSaved(own);
    saved.answers[idAt(own, 3)] = ['E', 'D', 'A'];
    const session = restored(saved, questions);
    expect(session.answers[idAt(own, 3)]).toEqual(['A', 'D', 'E']);
  });

  test('AC-35: the order of the answers follows the original option order, not the shown order', () => {
    // Item 1 is shown as E, D, C, B, A; the stored answer is still B, E (original order).
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const saved = handSaved(own);
    saved.answers[idAt(own, 1)] = ['B', 'E'];
    expect(restored(saved, questions).answers[idAt(own, 1)]).toEqual(['B', 'E']);
  });

  test('AC-35: flagged ids listed out of order come back in exam item order', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    // The ids sort in the reverse of the item order, so item order differs from id order.
    expect([idAt(own, 0), idAt(own, 2), idAt(own, 3)].sort()).toEqual([
      idAt(own, 3),
      idAt(own, 2),
      idAt(own, 0),
    ]);
    const saved = handSaved(own);
    saved.flagged = [idAt(own, 2), idAt(own, 3), idAt(own, 0)];
    expect(restored(saved, questions).flagged).toEqual([idAt(own, 0), idAt(own, 2), idAt(own, 3)]);
  });

  test('AC-35: revealed ids listed out of order come back in exam item order', () => {
    const { questions, exam } = fixtureExam();
    const own = activePractice(exam);
    const saved = handSaved(own);
    saved.revealed = [idAt(own, 1), idAt(own, 2), idAt(own, 0)];
    expect(restored(saved, questions).revealed).toEqual([idAt(own, 0), idAt(own, 1), idAt(own, 2)]);
  });

  test('AC-35: ids that are already in item order are kept in item order', () => {
    const { questions, exam } = fixtureExam();
    const own = activePractice(exam);
    const saved = handSaved(own);
    saved.flagged = [idAt(own, 0), idAt(own, 4), idAt(own, 5)];
    expect(restored(saved, questions).flagged).toEqual([idAt(own, 0), idAt(own, 4), idAt(own, 5)]);
  });
});

// ---------------------------------------------------------------------------------------------
// Review round 1 (gaps): AC-38
// ---------------------------------------------------------------------------------------------

describe('restoreSession: order of checks', () => {
  test('AC-38: a missing item and a changed item give reason "missing", naming the missing id', () => {
    const { questions, exam } = fixtureExam();
    const own = activeExam(exam);
    const saved = handSaved(own);
    // Item 0 changed (a key the question does not have); item 2 gone from the bank.
    at(saved.exam.items, 0).optionOrder = ['D', 'C', 'B', 'Z'];
    const bank = questions.filter((question) => question.id !== idAt(own, 2));
    // Each problem alone gives its own reason.
    expect(failure(handSaved(own), bank).reason).toBe('missing');
    const onlyChanged = handSaved(own);
    at(onlyChanged.exam.items, 0).optionOrder = ['D', 'C', 'B', 'Z'];
    expect(failure(onlyChanged, questions).reason).toBe('changed');

    const result = failure(saved, bank);
    expect(result.reason).toBe('missing');
    expect(result.errors.join('\n')).toContain(idAt(own, 2));
  });

  test('AC-38: an invalid copy is reported before missing questions', () => {
    const { exam } = fixtureExam();
    const broken = { ...handSaved(activeExam(exam)), current: 6 };
    expect(failure(broken, []).reason).toBe('invalid');
  });

  test('AC-38: a newer version is reported before missing questions', () => {
    const { exam } = fixtureExam();
    const newer = { ...handSaved(activeExam(exam)), version: 2 };
    expect(failure(newer, []).reason).toBe('version');
  });
});
