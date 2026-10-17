import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tasksByDomain } from '@field-guide/schema';
import type { DomainId, Question } from '@field-guide/schema';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  correctKeys,
  deepFreeze,
  makeBank,
  makeQuestion,
  wrongKeys,
} from './__mocks__/questions.ts';
import { buildExam } from './build.ts';
import type { Exam } from './build.ts';
import * as quizCore from './index.ts';
import { scoreAttempt } from './score.ts';
import type { Answers, AttemptScore } from './score.ts';
import {
  EXAM_DURATION_MS,
  feedback,
  remainingMs,
  reviewList,
  sessionReducer,
  sessionScore,
  startSession,
} from './session.ts';
import type { ItemFeedback, ReviewEntry, Session, SessionAction, SessionMode } from './session.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------

const DEADLINE = 7_800_000;
const DOMAIN_IDS = [1, 2, 3, 4] as const;

/** Asserts that an array element exists (the tsconfig has noUncheckedIndexedAccess). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture: no element at index ${String(index)}`);
  return item;
}

/**
 * `count` questions with the ids `q0`, `q1`... Even indexes are `single` questions with 4 options,
 * odd indexes are `multiple` questions with 5 options. The correct keys differ from item to item.
 */
function questionsOf(count: number): Question[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `q${String(index)}`;
    const domain = DOMAIN_IDS[index % 4] as DomainId;
    const task = at(tasksByDomain(domain), 0).id;
    if (index % 2 === 0) {
      const correct = at(['A', 'C', 'B', 'D'], (index / 2) % 4);
      return makeQuestion({ id, domain, task, type: 'single', correct: [correct] });
    }
    const correct = index % 4 === 1 ? ['B', 'E'] : ['A', 'D'];
    return makeQuestion({ id, domain, task, type: 'multiple', correct });
  });
}

/** An `Exam` built by hand from questions: a known layout, original option order by default. */
function examOf(questions: readonly Question[], optionOrders: Record<number, string[]> = {}): Exam {
  const byDomain = {} as Exam['byDomain'];
  for (const domain of DOMAIN_IDS) {
    const count = questions.filter((question) => question.domain === domain).length;
    byDomain[domain] = { quota: count, available: count, picked: count, short: 0 };
  }
  return {
    seed: 1,
    size: questions.length,
    items: questions.map((question, index) => ({
      question,
      optionOrder: optionOrders[index] ?? question.options.map((option) => option.key),
    })),
    complete: true,
    byDomain,
  };
}

function exam6(): Exam {
  return examOf(questionsOf(6));
}

function ids(exam: Exam): string[] {
  return exam.items.map((item) => item.question.id);
}

function idAt(exam: Exam, index: number): string {
  return at(exam.items, index).question.id;
}

/** The correct original keys of item `index`. */
function rightKeys(exam: Exam, index: number): string[] {
  return correctKeys(at(exam.items, index).question);
}

/** One original key that is a wrong answer for item `index` (a wrong single key). */
function wrongKey(exam: Exam, index: number): string {
  return at(wrongKeys(at(exam.items, index).question), 0);
}

// Action builders. The default `now` (1,000) is before the deadline of a session started at 0.
const answer = (selected: readonly string[], now = 1_000): SessionAction => ({
  type: 'answer',
  selected,
  now,
});
const flag = (flagged: boolean, now = 1_000): SessionAction => ({ type: 'flag', flagged, now });
const goTo = (index: number, now = 1_000): SessionAction => ({ type: 'goTo', index, now });
const reveal = (now = 1_000): SessionAction => ({ type: 'reveal', now });
const submit = (now = 1_000): SessionAction => ({ type: 'submit', now });
const tick = (now = 1_000): SessionAction => ({ type: 'tick', now });

/** Applies the actions one after the other. */
function play(session: Session, ...actions: SessionAction[]): Session {
  return actions.reduce((state, action) => sessionReducer(state, action), session);
}

function startExam(exam: Exam = exam6(), now = 0): Session {
  return startSession(exam, { mode: 'exam', now });
}

function startPractice(exam: Exam = exam6(), now = 0): Session {
  return startSession(exam, { mode: 'practice', now });
}

/** Moves to item `index` and sets its answer. The session ends up on that item. */
function answerItem(
  session: Session,
  index: number,
  selected: readonly string[],
  now = 1_000,
): Session {
  return play(session, goTo(index, now), answer(selected, now));
}

/** A manually submitted session, at `now`. */
function submitted(session: Session, now = 60_000): Session {
  return sessionReducer(session, submit(now));
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error('expected a value, got null');
  return value;
}

const notAFiniteNumber: readonly [string, number][] = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a string', '1000' as unknown as number],
];

// ---------------------------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------------------------

describe('startSession', () => {
  test('AC-1: EXAM_DURATION_MS is 7,800,000 (130 minutes)', () => {
    expect(EXAM_DURATION_MS).toBe(7_800_000);
  });

  test('AC-1: an exam-mode session starts active on item 0 with nothing answered', () => {
    const exam = exam6();
    const session = startSession(exam, { mode: 'exam', now: 1_000 });
    expect(session.exam).toBe(exam);
    expect(session).toEqual({
      mode: 'exam',
      exam,
      startedAt: 1_000,
      deadline: 7_801_000,
      current: 0,
      answers: {},
      flagged: [],
      revealed: [],
      status: 'active',
      submittedAt: null,
      submitReason: null,
    });
  });

  test('AC-1: the default duration is EXAM_DURATION_MS, added to the start time', () => {
    expect(startExam(exam6(), 0).deadline).toBe(EXAM_DURATION_MS);
    expect(startExam(exam6(), 123_456).deadline).toBe(123_456 + EXAM_DURATION_MS);
  });

  test('AC-2: durationMs sets the deadline to now + durationMs', () => {
    const session = startSession(exam6(), { mode: 'exam', now: 5_000, durationMs: 600_000 });
    expect(session.deadline).toBe(605_000);
    expect(session.startedAt).toBe(5_000);
  });

  test('AC-2: the shortest duration, 1 ms, is valid', () => {
    expect(startSession(exam6(), { mode: 'exam', now: 10, durationMs: 1 }).deadline).toBe(11);
  });

  test('AC-2: practice mode has no deadline, with or without durationMs', () => {
    expect(startSession(exam6(), { mode: 'practice', now: 5_000 }).deadline).toBeNull();
    expect(
      startSession(exam6(), { mode: 'practice', now: 5_000, durationMs: 600_000 }).deadline,
    ).toBeNull();
  });

  test('AC-2: a practice session starts active on item 0, like an exam one', () => {
    const exam = exam6();
    expect(startPractice(exam, 2_000)).toEqual({
      mode: 'practice',
      exam,
      startedAt: 2_000,
      deadline: null,
      current: 0,
      answers: {},
      flagged: [],
      revealed: [],
      status: 'active',
      submittedAt: null,
      submitReason: null,
    });
  });

  test.each(notAFiniteNumber)('AC-3: startSession throws RangeError for now = %s', (_name, now) => {
    expect(() => startSession(exam6(), { mode: 'exam', now })).toThrow(RangeError);
    expect(() => startSession(exam6(), { mode: 'practice', now })).toThrow(RangeError);
  });

  test.each([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '600000' as unknown as number],
  ] as const)('AC-3: startSession throws RangeError for durationMs = %s', (_name, durationMs) => {
    expect(() => startSession(exam6(), { mode: 'exam', now: 0, durationMs })).toThrow(RangeError);
  });

  test('AC-3: startSession throws RangeError for an exam with no items, in both modes', () => {
    const empty = examOf([]);
    expect(() => startSession(empty, { mode: 'exam', now: 0 })).toThrow(RangeError);
    expect(() => startSession(empty, { mode: 'practice', now: 0 })).toThrow(RangeError);
  });

  test('AC-3: a bank with no reviewed questions builds an exam that cannot start (spec 016 AC-20)', () => {
    const drafts = makeBank({ 1: 3, 2: 3 }, () => ({ status: 'draft' }));
    const exam = buildExam(drafts, { seed: 1 });
    expect(exam.items).toHaveLength(0);
    expect(() => startSession(exam, { mode: 'exam', now: 0 })).toThrow(RangeError);
  });

  test('AC-3: startSession does not change the exam (a deep-frozen exam works)', () => {
    const exam = deepFreeze(exam6());
    const snapshot = structuredClone(exam);
    const session = startSession(exam, { mode: 'exam', now: 0 });
    expect(session.exam).toBe(exam);
    expect(exam).toEqual(snapshot);
  });

  test('AC-3: a time of 0 is a valid start, and so is a negative one', () => {
    expect(startExam(exam6(), 0).startedAt).toBe(0);
    expect(startExam(exam6(), -500).deadline).toBe(EXAM_DURATION_MS - 500);
  });
});

// ---------------------------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------------------------

describe('answer', () => {
  test('AC-4: answering a single question twice keeps the last selection', () => {
    const exam = exam6();
    const session = play(startExam(exam), answer(['B']), answer(['C']));
    expect(session.answers[idAt(exam, 0)]).toEqual(['C']);
  });

  test('AC-4: the answer is stored under the current question id only', () => {
    const exam = exam6();
    const session = answerItem(startExam(exam), 2, ['B']);
    expect(session.answers).toEqual({ [idAt(exam, 2)]: ['B'] });
    expect(Object.keys(session.answers)).toEqual(['q2']);
  });

  test('AC-4: answers to different questions are all kept', () => {
    const exam = exam6();
    let session = answerItem(startExam(exam), 0, ['A']);
    session = answerItem(session, 2, ['C']);
    expect(session.answers).toEqual({ q0: ['A'], q2: ['C'] });
  });

  test('AC-4: answering leaves the position, flags and status alone', () => {
    const before = play(startExam(), goTo(1), flag(true));
    const after = sessionReducer(before, answer(['A']));
    expect(after).toEqual({ ...before, answers: { q1: ['A'] } });
  });

  test('AC-5: a multiple answer is deduplicated and stored in the original option order', () => {
    const exam = exam6();
    const session = answerItem(startExam(exam), 1, ['E', 'B', 'E']);
    expect(session.answers[idAt(exam, 1)]).toEqual(['B', 'E']);
  });

  test('AC-5: equal selections in any order give equal stored arrays', () => {
    const base = startExam();
    const first = answerItem(base, 1, ['E', 'C', 'A']);
    const second = answerItem(base, 1, ['A', 'E', 'C']);
    expect(first.answers['q1']).toEqual(['A', 'C', 'E']);
    expect(second.answers).toEqual(first.answers);
  });

  test('AC-5: the stored order is the original order, not the displayed order', () => {
    const questions = questionsOf(6);
    const exam = examOf(questions, { 1: ['E', 'D', 'C', 'B', 'A'] });
    const session = answerItem(startExam(exam), 1, ['E', 'B']);
    expect(session.answers['q1']).toEqual(['B', 'E']);
  });

  test('AC-5: a repeated key on a single question counts once, so it is not "more than one key"', () => {
    const session = answerItem(startExam(), 0, ['B', 'B']);
    expect(session.answers['q0']).toEqual(['B']);
  });

  test('AC-6: an empty selection removes the question from answers', () => {
    const exam = exam6();
    const answered = answerItem(startExam(exam), 0, ['B']);
    const cleared = sessionReducer(answered, answer([]));
    expect(Object.hasOwn(cleared.answers, idAt(exam, 0))).toBe(false);
    expect(cleared.answers).toEqual({});
  });

  test('AC-6: clearing one answer keeps the others', () => {
    let session = answerItem(startExam(), 0, ['B']);
    session = answerItem(session, 2, ['C']);
    session = play(session, answer([]));
    expect(session.answers).toEqual({ q0: ['B'] });
  });

  test('AC-6: a cleared question is listed as unanswered again by reviewList', () => {
    const answered = answerItem(startExam(), 0, ['B']);
    expect(reviewList(answered).map((entry) => entry.index)).not.toContain(0);
    const cleared = sessionReducer(answered, answer([]));
    expect(reviewList(cleared).find((entry) => entry.index === 0)).toEqual({
      index: 0,
      id: 'q0',
      answered: false,
      flagged: false,
    });
  });

  test.each([['Z'], ['a'], ['']])(
    'AC-7: a key that is not an option (%j) throws RangeError',
    (key) => {
      const session = startExam();
      expect(() => sessionReducer(session, answer([key]))).toThrow(RangeError);
    },
  );

  test('AC-7: a key from a longer question is not an option of a 4-option question', () => {
    // Item 0 has the options A-D; E exists only on the 5-option items.
    expect(() => sessionReducer(startExam(), answer(['E']))).toThrow(RangeError);
    expect(() => sessionReducer(play(startExam(), goTo(1)), answer(['E']))).not.toThrow();
  });

  test('AC-7: one wrong key among valid keys throws on a multiple question', () => {
    const session = play(startExam(), goTo(1));
    expect(() => sessionReducer(session, answer(['B', 'Z']))).toThrow(RangeError);
    expect(() => sessionReducer(session, answer(['Z', 'B']))).toThrow(RangeError);
  });

  test('AC-7: two different keys on a single question throw RangeError', () => {
    expect(() => sessionReducer(startExam(), answer(['A', 'B']))).toThrow(RangeError);
  });

  test('AC-7: an invalid answer is rejected, it does not partly apply', () => {
    const session = answerItem(startExam(), 0, ['B']);
    const snapshot = structuredClone(session);
    expect(() => sessionReducer(session, answer(['A', 'B']))).toThrow(RangeError);
    expect(session).toEqual(snapshot);
  });

  test('AC-8: answers use original keys, whatever the option order (hand-built order)', () => {
    // Item 0 is a single question whose correct original key is A, shown last.
    const exam = examOf(questionsOf(6), { 0: ['D', 'C', 'B', 'A'] });
    const right = submitted(answerItem(startExam(exam), 0, ['A']));
    expect(must(feedback(right, 0)).correct).toBe(true);
    expect(must(sessionScore(right)).correct).toBe(1);

    // The first displayed option (D) is a different original key and is wrong.
    const wrong = submitted(answerItem(startExam(exam), 0, ['D']));
    expect(must(feedback(wrong, 0)).correct).toBe(false);
    expect(must(sessionScore(wrong)).correct).toBe(0);
  });

  test('AC-8: with buildExam shuffling on, the correct original keys score every item', () => {
    const bank = makeBank({ 1: 6, 2: 6, 3: 6, 4: 6 });
    const exam = buildExam(bank, { seed: 7, size: 20, shuffleOptions: true });
    // Precondition: the options really are shuffled for part of the items.
    const reordered = exam.items.filter(
      (item) => item.optionOrder.join('') !== item.question.options.map((o) => o.key).join(''),
    );
    expect(reordered.length).toBeGreaterThan(0);

    let session = startExam(exam);
    exam.items.forEach((item, index) => {
      session = answerItem(session, index, correctKeys(item.question));
    });
    session = submitted(session);
    for (let index = 0; index < exam.items.length; index += 1) {
      expect(must(feedback(session, index)).correct, `item ${String(index)}`).toBe(true);
    }
    expect(must(sessionScore(session)).correct).toBe(exam.items.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Flagging and moving
// ---------------------------------------------------------------------------------------------

describe('flag and goTo', () => {
  test('AC-9: flag true adds the current id, flag false removes it', () => {
    const exam = exam6();
    const flaggedSession = sessionReducer(startExam(exam), flag(true));
    expect(flaggedSession.flagged).toEqual([idAt(exam, 0)]);
    const cleared = sessionReducer(flaggedSession, flag(false));
    expect(cleared.flagged).toEqual([]);
  });

  test('AC-9: flagged ids stay in exam item order (flag item 5, then item 2)', () => {
    const exam = exam6();
    const session = play(startExam(exam), goTo(5), flag(true), goTo(2), flag(true));
    expect(session.flagged).toEqual([idAt(exam, 2), idAt(exam, 5)]);
  });

  test('AC-9: the order holds after an unflag and a re-flag', () => {
    const exam = exam6();
    const session = play(
      startExam(exam),
      goTo(4),
      flag(true),
      goTo(1),
      flag(true),
      goTo(3),
      flag(true),
      goTo(1),
      flag(false),
      flag(true),
    );
    expect(session.flagged).toEqual(['q1', 'q3', 'q4']);
  });

  test('AC-9: flagging an unanswered question works and does not create an answer', () => {
    const session = sessionReducer(startExam(), flag(true));
    expect(session.flagged).toEqual(['q0']);
    expect(session.answers).toEqual({});
  });

  test('AC-9: flag works in practice mode too', () => {
    const session = sessionReducer(startPractice(), flag(true));
    expect(session.flagged).toEqual(['q0']);
  });

  test('AC-9: flag acts on the current question and leaves the answers alone', () => {
    const session = play(startExam(), answer(['A']), goTo(3), flag(true));
    expect(session.flagged).toEqual(['q3']);
    expect(session.answers).toEqual({ q0: ['A'] });
    expect(session.current).toBe(3);
  });

  test('AC-9: flag to the value the question already has returns the same object', () => {
    const unflagged = startExam();
    expect(sessionReducer(unflagged, flag(false))).toBe(unflagged);
    const flaggedSession = sessionReducer(unflagged, flag(true));
    expect(sessionReducer(flaggedSession, flag(true))).toBe(flaggedSession);
  });

  test('AC-10: goTo 3 sets current to 3', () => {
    expect(sessionReducer(startExam(), goTo(3)).current).toBe(3);
  });

  test('AC-10: answer and flag act on the question of the item moved to', () => {
    const exam = exam6();
    const session = play(startExam(exam), goTo(3), answer(['A', 'D']), flag(true));
    expect(session.answers).toEqual({ [idAt(exam, 3)]: ['A', 'D'] });
    expect(session.flagged).toEqual([idAt(exam, 3)]);
  });

  test('AC-10: the first and the last index are valid', () => {
    const last = exam6().items.length - 1;
    expect(sessionReducer(startExam(), goTo(last)).current).toBe(last);
    expect(play(startExam(), goTo(last), goTo(0)).current).toBe(0);
  });

  test('AC-10: goTo changes only the position', () => {
    const before = play(startExam(), answer(['B']), flag(true));
    const after = sessionReducer(before, goTo(4));
    expect(after).toEqual({ ...before, current: 4 });
  });

  test('AC-10: goTo throws RangeError for -1, items.length, 1.5 and NaN', () => {
    const session = startExam();
    const length = session.exam.items.length;
    for (const index of [-1, length, 1.5, Number.NaN]) {
      expect(() => sessionReducer(session, goTo(index)), `index ${String(index)}`).toThrow(
        RangeError,
      );
    }
  });

  test('AC-10: goTo throws RangeError for Infinity and a non-number index', () => {
    const session = startExam();
    expect(() => sessionReducer(session, goTo(Number.POSITIVE_INFINITY))).toThrow(RangeError);
    expect(() => sessionReducer(session, goTo('2' as unknown as number))).toThrow(RangeError);
  });

  test('AC-10: goTo with an index out of range throws on a submitted session too', () => {
    const session = submitted(startExam());
    expect(() => sessionReducer(session, goTo(-1))).toThrow(RangeError);
    expect(() => sessionReducer(session, goTo(session.exam.items.length))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Deadline and submission
// ---------------------------------------------------------------------------------------------

describe('deadline and submission', () => {
  test('AC-11: a tick one millisecond before the deadline returns the same object', () => {
    const session = startExam(exam6(), 0);
    expect(sessionReducer(session, tick(DEADLINE - 1))).toBe(session);
  });

  test('AC-11: ticks well before the deadline return the same object', () => {
    const session = play(startExam(), answer(['A']));
    expect(sessionReducer(session, tick(0))).toBe(session);
    expect(sessionReducer(session, tick(3_600_000))).toBe(session);
  });

  test('AC-11: remainingMs is 1 one millisecond before the deadline', () => {
    expect(remainingMs(startExam(exam6(), 0), DEADLINE - 1)).toBe(1);
  });

  test('AC-12: a tick at exactly the deadline submits the session with timeout', () => {
    const session = startExam(exam6(), 0);
    const timedOut = sessionReducer(session, tick(DEADLINE));
    expect(timedOut.status).toBe('submitted');
    expect(timedOut.submitReason).toBe('timeout');
    expect(timedOut.submittedAt).toBe(7_800_000);
  });

  test('AC-12: a tick long after the deadline gives submittedAt = deadline, not now', () => {
    const timedOut = sessionReducer(startExam(exam6(), 0), tick(9_000_000));
    expect(timedOut.status).toBe('submitted');
    expect(timedOut.submitReason).toBe('timeout');
    expect(timedOut.submittedAt).toBe(7_800_000);
  });

  test('AC-12: the deadline depends on the start time and on durationMs', () => {
    const session = startSession(exam6(), { mode: 'exam', now: 1_000, durationMs: 600_000 });
    expect(sessionReducer(session, tick(601_000 - 1))).toBe(session);
    const timedOut = sessionReducer(session, tick(800_000));
    expect(timedOut.submittedAt).toBe(601_000);
    expect(timedOut.submitReason).toBe('timeout');
  });

  test('AC-12: a timeout keeps what was answered, flagged and the position', () => {
    const before = play(startExam(), answer(['B']), flag(true), goTo(2));
    const timedOut = sessionReducer(before, tick(DEADLINE));
    expect(timedOut).toEqual({
      ...before,
      status: 'submitted',
      submittedAt: DEADLINE,
      submitReason: 'timeout',
    });
    expect(must(sessionScore(timedOut)).answered).toBe(1);
  });

  const lateActions: [string, (now: number) => SessionAction][] = [
    ['answer', (now) => answer(['A'], now)],
    ['flag', (now) => flag(true, now)],
    ['goTo', (now) => goTo(3, now)],
    ['reveal', (now) => reveal(now)],
    ['submit', (now) => submit(now)],
    ['tick', (now) => tick(now)],
  ];

  const lateTimes = [DEADLINE, DEADLINE + 1, 9_000_000];
  const lateCases = lateActions.flatMap(([name, make]) =>
    lateTimes.map((now) => [name, now, make] as const),
  );

  test.each(lateCases)(
    'AC-13: a %s at now = %i times the session out and changes nothing else',
    (_name, now, make) => {
      // Item 1 shown, item 0 answered, nothing flagged or revealed.
      const before = play(startExam(exam6(), 0), answer(['B']), goTo(1));
      const after = sessionReducer(before, make(now));
      expect(after).toEqual({
        ...before,
        status: 'submitted',
        submittedAt: DEADLINE,
        submitReason: 'timeout',
      });
    },
  );

  test('AC-13: an answer at the deadline is not applied (answers unchanged, timeout)', () => {
    const before = answerItem(startExam(), 0, ['B']);
    const after = sessionReducer(before, answer(['C'], DEADLINE));
    expect(after.answers).toEqual({ q0: ['B'] });
    expect(after.submitReason).toBe('timeout');
    expect(after.status).toBe('submitted');
    expect(must(sessionScore(after)).answered).toBe(1);
  });

  test('AC-13: an answer one millisecond before the deadline is applied', () => {
    const after = sessionReducer(startExam(), answer(['C'], DEADLINE - 1));
    expect(after.answers).toEqual({ q0: ['C'] });
    expect(after.status).toBe('active');
  });

  test('AC-13: a submit at or after the deadline is a timeout, not a manual submit', () => {
    const atDeadline = sessionReducer(startExam(), submit(DEADLINE));
    expect(atDeadline.submitReason).toBe('timeout');
    const later = sessionReducer(startExam(), submit(DEADLINE + 5_000));
    expect(later.submitReason).toBe('timeout');
    expect(later.submittedAt).toBe(DEADLINE);
    const before = sessionReducer(startExam(), submit(DEADLINE - 1));
    expect(before.submitReason).toBe('manual');
    expect(before.submittedAt).toBe(DEADLINE - 1);
  });

  test('AC-13: an answer after the deadline is dropped when nothing was answered before', () => {
    const after = sessionReducer(startExam(), answer(['A'], DEADLINE + 1));
    expect(after.answers).toEqual({});
    expect(after.submitReason).toBe('timeout');
  });

  test('AC-14: submit at 60,000 submits manually', () => {
    const session = sessionReducer(startExam(), submit(60_000));
    expect(session.status).toBe('submitted');
    expect(session.submittedAt).toBe(60_000);
    expect(session.submitReason).toBe('manual');
  });

  test('AC-14: submit works with every question unanswered', () => {
    const before = startExam();
    const after = sessionReducer(before, submit(60_000));
    expect(after).toEqual({
      ...before,
      status: 'submitted',
      submittedAt: 60_000,
      submitReason: 'manual',
    });
    expect(must(sessionScore(after)).answered).toBe(0);
  });

  test('AC-14: submit keeps the answers, flags and position', () => {
    const before = play(startExam(), answer(['A']), flag(true), goTo(3));
    const after = sessionReducer(before, submit(60_000));
    expect(after).toEqual({
      ...before,
      status: 'submitted',
      submittedAt: 60_000,
      submitReason: 'manual',
    });
  });

  test('AC-15: after a manual submit, answer, flag, reveal, submit and tick return the same object', () => {
    const done = submitted(play(startExam(), answer(['A'])));
    for (const now of [60_000, 60_001, DEADLINE - 1, DEADLINE, 9_000_000]) {
      expect(sessionReducer(done, answer(['B'], now)), `answer at ${String(now)}`).toBe(done);
      expect(sessionReducer(done, flag(true, now)), `flag at ${String(now)}`).toBe(done);
      expect(sessionReducer(done, flag(false, now)), `unflag at ${String(now)}`).toBe(done);
      expect(sessionReducer(done, reveal(now)), `reveal at ${String(now)}`).toBe(done);
      expect(sessionReducer(done, submit(now)), `submit at ${String(now)}`).toBe(done);
      expect(sessionReducer(done, tick(now)), `tick at ${String(now)}`).toBe(done);
    }
  });

  test('AC-15: after a timeout, every action but goTo returns the same object', () => {
    const done = sessionReducer(play(startExam(), answer(['A'])), tick(DEADLINE));
    for (const action of [
      answer(['B'], 1),
      flag(true, 1),
      reveal(1),
      submit(1),
      tick(1),
      tick(DEADLINE + 9),
    ]) {
      expect(sessionReducer(done, action), action.type).toBe(done);
    }
  });

  test('AC-15: after a submit in practice mode, reveal returns the same object', () => {
    const done = submitted(startPractice());
    expect(sessionReducer(done, reveal(70_000))).toBe(done);
    expect(sessionReducer(done, answer(['A'], 70_000))).toBe(done);
  });

  test('AC-15: goTo still moves current after submission, and nothing else changes', () => {
    const done = submitted(play(startExam(), answer(['A']), flag(true)));
    const moved = sessionReducer(done, goTo(4, 70_000));
    expect(moved.current).toBe(4);
    expect(moved).toEqual({ ...done, current: 4 });
    expect(sessionReducer(moved, goTo(0, DEADLINE + 1)).current).toBe(0);
  });

  test('AC-15: goTo still works after a timeout, even with a now past the deadline', () => {
    const done = sessionReducer(startExam(), tick(DEADLINE));
    const moved = sessionReducer(done, goTo(2, 9_000_000));
    expect(moved).toEqual({ ...done, current: 2 });
  });

  test('AC-16: practice mode has no deadline: a tick at 10^12 returns the same object', () => {
    const session = startPractice();
    expect(sessionReducer(session, tick(10 ** 12))).toBe(session);
  });

  test('AC-16: practice mode: remainingMs is null, active or submitted', () => {
    const session = startPractice();
    expect(remainingMs(session, 0)).toBeNull();
    expect(remainingMs(session, 10 ** 12)).toBeNull();
    expect(remainingMs(submitted(session), 70_000)).toBeNull();
  });

  test('AC-16: practice mode: submit is manual and submittedAt is now', () => {
    const session = sessionReducer(startPractice(), submit(10 ** 12));
    expect(session.status).toBe('submitted');
    expect(session.submitReason).toBe('manual');
    expect(session.submittedAt).toBe(10 ** 12);
  });

  test('AC-16: practice mode: answers are still applied far past any 130 minutes', () => {
    const session = sessionReducer(startPractice(), answer(['B'], 10 ** 12));
    expect(session.answers).toEqual({ q0: ['B'] });
    expect(session.status).toBe('active');
  });

  test('AC-17: remainingMs counts down from 7,800,000 and never goes below 0', () => {
    const session = startExam(exam6(), 0);
    expect(remainingMs(session, 0)).toBe(7_800_000);
    expect(remainingMs(session, DEADLINE - 1)).toBe(1);
    expect(remainingMs(session, DEADLINE)).toBe(0);
    expect(remainingMs(session, DEADLINE + 1)).toBe(0);
    expect(remainingMs(session, 9_000_000)).toBe(0);
  });

  test('AC-17: remainingMs follows the start time and durationMs', () => {
    const session = startSession(exam6(), { mode: 'exam', now: 1_000, durationMs: 600_000 });
    expect(remainingMs(session, 1_000)).toBe(600_000);
    expect(remainingMs(session, 301_000)).toBe(300_000);
  });

  test('AC-17: remainingMs does not submit or change the session', () => {
    const session = startExam();
    const snapshot = structuredClone(session);
    remainingMs(session, 9_000_000);
    expect(session).toEqual(snapshot);
    expect(session.status).toBe('active');
  });

  test('AC-17: after a manual submit at 60,000, remainingMs is frozen at 7,740,000', () => {
    const done = submitted(startExam(exam6(), 0), 60_000);
    for (const now of [0, 59_999, 60_000, 60_001, 3_000_000, DEADLINE, 10 ** 12]) {
      expect(remainingMs(done, now), `now ${String(now)}`).toBe(7_740_000);
    }
  });

  test('AC-17: after a timeout, remainingMs is 0 whatever now is', () => {
    const done = sessionReducer(startExam(exam6(), 0), tick(9_000_000));
    for (const now of [0, DEADLINE - 1, DEADLINE, 9_000_000]) {
      expect(remainingMs(done, now), `now ${String(now)}`).toBe(0);
    }
  });

  test('AC-17: after a manual submit, the frozen value is measured from the deadline, not the start', () => {
    const session = startSession(exam6(), { mode: 'exam', now: 5_000, durationMs: 600_000 });
    const done = sessionReducer(session, submit(105_000));
    expect(remainingMs(done, 999_999)).toBe(500_000);
  });

  describe('AC-18: a now that is not a finite number throws RangeError', () => {
    const makers: [string, (now: number) => SessionAction][] = [
      ['answer', (now) => answer(['A'], now)],
      ['flag', (now) => flag(true, now)],
      ['flag (no change)', (now) => flag(false, now)],
      ['goTo', (now) => goTo(1, now)],
      ['goTo (same index)', (now) => goTo(0, now)],
      ['reveal', (now) => reveal(now)],
      ['submit', (now) => submit(now)],
      ['tick', (now) => tick(now)],
    ];
    const states: [string, () => Session][] = [
      ['an active exam session', () => startExam()],
      ['an active practice session', () => startPractice()],
      ['a manually submitted session', () => submitted(startExam())],
      ['a timed-out session', () => sessionReducer(startExam(), tick(DEADLINE))],
      ['a submitted practice session', () => submitted(startPractice())],
    ];

    test.each(states)('AC-18: every action throws on %s', (_state, make) => {
      const session = make();
      for (const [valueName, now] of notAFiniteNumber) {
        for (const [actionName, build] of makers) {
          expect(
            () => sessionReducer(session, build(now)),
            `${actionName} with now = ${valueName}`,
          ).toThrow(RangeError);
        }
      }
    });

    test.each(states)('AC-18: remainingMs throws on %s', (_state, make) => {
      const session = make();
      for (const [valueName, now] of notAFiniteNumber) {
        expect(() => remainingMs(session, now), `now = ${valueName}`).toThrow(RangeError);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Practice reveal
// ---------------------------------------------------------------------------------------------

describe('practice reveal', () => {
  test('AC-19: reveal adds the current id to revealed', () => {
    const session = sessionReducer(startPractice(), reveal());
    expect(session.revealed).toEqual(['q0']);
  });

  test('AC-19: revealed ids stay in exam item order', () => {
    const session = play(startPractice(), goTo(3), reveal(), goTo(1), reveal(), goTo(5), reveal());
    expect(session.revealed).toEqual(['q1', 'q3', 'q5']);
  });

  test('AC-19: feedback of a revealed single question gives the key and whether the answer is right', () => {
    const exam = exam6();
    const right = play(startPractice(exam), answer(rightKeys(exam, 0)), reveal());
    expect(feedback(right, 0)).toEqual({ correct: true, correctKeys: rightKeys(exam, 0) });
    const wrong = play(startPractice(exam), answer([wrongKey(exam, 0)]), reveal());
    expect(feedback(wrong, 0)).toEqual({ correct: false, correctKeys: rightKeys(exam, 0) });
  });

  test('AC-19: feedback of a multiple question lists the correct keys in original option order', () => {
    // q1 is multiple with the correct keys B and E; the options are shown in reverse.
    const exam = examOf(questionsOf(6), { 1: ['E', 'D', 'C', 'B', 'A'] });
    const session = play(startPractice(exam), goTo(1), answer(['E', 'B']), reveal());
    expect(feedback(session, 1)).toEqual({ correct: true, correctKeys: ['B', 'E'] });
  });

  test('AC-19: feedback is by exact set: a partial multiple answer is not correct', () => {
    const session = play(startPractice(), goTo(1), answer(['B']), reveal());
    expect(feedback(session, 1)).toEqual({ correct: false, correctKeys: ['B', 'E'] });
  });

  test('AC-19: feedback for an index that was not revealed is null while active', () => {
    const session = play(startPractice(), answer(['A']), reveal());
    expect(feedback(session, 0)).not.toBeNull();
    for (let index = 1; index < session.exam.items.length; index += 1) {
      expect(feedback(session, index), `item ${String(index)}`).toBeNull();
    }
  });

  test('AC-19: feedback is null before anything is revealed, even for an answered question', () => {
    const session = play(startPractice(), answer(['A']));
    expect(feedback(session, 0)).toBeNull();
  });

  test('AC-19: reveal changes only the revealed list', () => {
    const before = play(startPractice(), answer(['A']), flag(true), goTo(2));
    const after = sessionReducer(before, reveal());
    expect(after).toEqual({ ...before, revealed: ['q2'] });
  });

  test('AC-19: revealing the same question again returns the same object', () => {
    const session = sessionReducer(startPractice(), reveal());
    expect(sessionReducer(session, reveal())).toBe(session);
  });

  test('AC-20: after reveal, answer on that question returns the same object', () => {
    const revealedSession = play(startPractice(), answer(['B']), reveal());
    expect(sessionReducer(revealedSession, answer(['C']))).toBe(revealedSession);
    expect(sessionReducer(revealedSession, answer([]))).toBe(revealedSession);
    expect(revealedSession.answers).toEqual({ q0: ['B'] });
  });

  test('AC-20: answer on another question still works after a reveal', () => {
    const session = play(startPractice(), answer(['B']), reveal(), goTo(2), answer(['C']));
    expect(session.answers).toEqual({ q0: ['B'], q2: ['C'] });
  });

  test('AC-20: the lock follows the question: going back to it keeps it locked', () => {
    const session = play(startPractice(), reveal(), goTo(1), goTo(0));
    expect(sessionReducer(session, answer(['A']))).toBe(session);
  });

  test('AC-20: flag still works on a revealed question', () => {
    const session = play(startPractice(), reveal(), flag(true));
    expect(session.flagged).toEqual(['q0']);
  });

  test('AC-20: revealing an unanswered question works and counts as wrong', () => {
    const session = sessionReducer(startPractice(), reveal());
    expect(session.answers).toEqual({});
    expect(must(feedback(session, 0)).correct).toBe(false);
    expect(must(feedback(session, 0)).correctKeys).toEqual(['A']);
  });

  test('AC-20: a revealed but unanswered question stays in reviewList as unanswered', () => {
    const session = sessionReducer(startPractice(), reveal());
    expect(reviewList(session)).toContainEqual({
      index: 0,
      id: 'q0',
      answered: false,
      flagged: false,
    });
  });

  test('AC-21: exam mode: reveal returns the same object', () => {
    const session = play(startExam(), answer(['A']));
    expect(sessionReducer(session, reveal())).toBe(session);
    expect(session.revealed).toEqual([]);
  });

  test('AC-21: exam mode: feedback is null for every index while active, even if answered', () => {
    let session = startExam();
    session.exam.items.forEach((item, index) => {
      session = answerItem(session, index, correctKeys(item.question));
    });
    session = play(session, reveal());
    for (let index = 0; index < session.exam.items.length; index += 1) {
      expect(feedback(session, index), `item ${String(index)}`).toBeNull();
    }
  });

  test.each<SessionMode>(['exam', 'practice'])(
    'AC-21: %s mode: after a manual submit, feedback is non-null for every index',
    (mode) => {
      const exam = exam6();
      const base = startSession(exam, { mode, now: 0 });
      const done = submitted(answerItem(base, 0, rightKeys(exam, 0)));
      for (let index = 0; index < exam.items.length; index += 1) {
        const item = must(feedback(done, index));
        expect(item.correctKeys, `item ${String(index)}`).toEqual(rightKeys(exam, index));
      }
      expect(must(feedback(done, 0)).correct).toBe(true);
    },
  );

  test('AC-21: after submission, an unanswered question has correct = false', () => {
    const done = submitted(startExam());
    expect(must(feedback(done, 2))).toEqual({ correct: false, correctKeys: ['C'] });
  });

  test('AC-21: after a timeout, feedback is non-null for every index', () => {
    const done = sessionReducer(startExam(), tick(DEADLINE));
    for (let index = 0; index < done.exam.items.length; index += 1) {
      expect(feedback(done, index), `item ${String(index)}`).not.toBeNull();
    }
  });

  test('AC-21: after submission, a wrong answer is false and a right one is true', () => {
    const exam = exam6();
    let session = answerItem(startExam(exam), 0, [wrongKey(exam, 0)]);
    session = answerItem(session, 2, rightKeys(exam, 2));
    const done = submitted(session);
    expect(must(feedback(done, 0)).correct).toBe(false);
    expect(must(feedback(done, 2)).correct).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

describe('reviewList', () => {
  /** Items 0, 1, 4 answered; items 1 and 3 flagged; items 2 and 3 unanswered. */
  function reviewSession(): Session {
    let session = startExam(examOf(questionsOf(5)));
    session = answerItem(session, 0, ['A']);
    session = answerItem(session, 1, ['B']);
    session = play(session, flag(true));
    session = play(session, goTo(3), flag(true));
    session = answerItem(session, 4, ['B']);
    return session;
  }

  test('AC-22: it lists the flagged or unanswered questions in item order', () => {
    expect(reviewList(reviewSession())).toEqual([
      { index: 1, id: 'q1', answered: true, flagged: true },
      { index: 2, id: 'q2', answered: false, flagged: false },
      { index: 3, id: 'q3', answered: false, flagged: true },
    ]);
  });

  test('AC-22: answered and unflagged questions are left out', () => {
    const indexes = reviewList(reviewSession()).map((entry) => entry.index);
    expect(indexes).not.toContain(0);
    expect(indexes).not.toContain(4);
  });

  test('AC-22: with everything answered and nothing flagged, the list is empty', () => {
    let session = startExam(examOf(questionsOf(5)));
    for (let index = 0; index < 5; index += 1) {
      session = answerItem(session, index, rightKeys(session.exam, index));
    }
    expect(reviewList(session)).toEqual([]);
  });

  test('AC-22: a fresh session lists every question as unanswered and unflagged', () => {
    const list: ReviewEntry[] = reviewList(startExam(examOf(questionsOf(3))));
    expect(list).toEqual([
      { index: 0, id: 'q0', answered: false, flagged: false },
      { index: 1, id: 'q1', answered: false, flagged: false },
      { index: 2, id: 'q2', answered: false, flagged: false },
    ]);
  });

  test('AC-22: the order is the item order, not the order of flagging', () => {
    const session = play(
      startExam(examOf(questionsOf(3))),
      goTo(2),
      flag(true),
      answer(['A']),
      goTo(0),
      answer(['A']),
      goTo(1),
      answer(['A']),
      flag(true),
    );
    expect(reviewList(session).map((entry) => entry.index)).toEqual([1, 2]);
  });

  test('AC-22: a question flagged and then unflagged but answered is not listed', () => {
    const session = play(startExam(examOf(questionsOf(1))), answer(['A']), flag(true), flag(false));
    expect(reviewList(session)).toEqual([]);
  });
});

describe('sessionScore', () => {
  test('AC-23: it is null while the session is active, in both modes', () => {
    const exam = exam6();
    expect(sessionScore(startExam(exam))).toBeNull();
    expect(sessionScore(play(startExam(exam), answer(['A'])))).toBeNull();
    expect(sessionScore(startPractice(exam))).toBeNull();
    expect(sessionScore(play(startPractice(exam), answer(['A']), reveal()))).toBeNull();
  });

  /** 5 items: 0, 1 and 2 correct, item 3 wrong, item 4 unanswered. */
  function fiveItemAttempt(): Session {
    const exam = examOf(questionsOf(5));
    let session = startExam(exam);
    session = answerItem(session, 0, rightKeys(exam, 0));
    session = answerItem(session, 1, rightKeys(exam, 1));
    session = answerItem(session, 2, rightKeys(exam, 2));
    session = answerItem(session, 3, ['A', 'B']);
    return submitted(session);
  }

  test('AC-23: 3 correct, 1 wrong and 1 unanswered give correct 3, answered 4, total 5', () => {
    const score = must(sessionScore(fiveItemAttempt()));
    expect(score.correct).toBe(3);
    expect(score.answered).toBe(4);
    expect(score.total).toBe(5);
  });

  test('AC-23: it deep-equals scoreAttempt over the exam questions and the session answers', () => {
    const session = fiveItemAttempt();
    const expected: AttemptScore = scoreAttempt(
      session.exam.items.map((item) => item.question),
      session.answers,
    );
    expect(sessionScore(session)).toEqual(expected);
  });

  test('AC-23: the score is available after a timeout, over the answers given before it', () => {
    const exam = exam6();
    const session = sessionReducer(
      answerItem(startExam(exam), 0, rightKeys(exam, 0)),
      tick(DEADLINE),
    );
    const score = must(sessionScore(session));
    expect(score.total).toBe(6);
    expect(score.correct).toBe(1);
  });

  test('AC-23: the score is available after a practice submit', () => {
    const exam = exam6();
    const session = submitted(answerItem(startPractice(exam), 0, rightKeys(exam, 0)));
    expect(must(sessionScore(session)).correct).toBe(1);
  });

  test('AC-23: a short exam is scored over its own items', () => {
    const bank = makeBank({ 1: 30, 2: 30, 3: 30, 4: 5 });
    const exam = buildExam(bank, { seed: 4 });
    expect(exam.items).toHaveLength(57);
    let session = startExam(exam);
    for (const index of [0, 10, 20, 56]) {
      session = answerItem(session, index, rightKeys(exam, index));
    }
    session = submitted(play(session, answer([])));
    const score = must(sessionScore(session));
    expect(score.total).toBe(57);
    expect(score.results.map((result) => result.id)).toEqual(ids(exam));
    expect(score).toEqual(
      scoreAttempt(
        exam.items.map((item) => item.question),
        session.answers,
      ),
    );
  });
});

describe('feedback index', () => {
  test('AC-24: feedback throws RangeError for -1, items.length and 1.5', () => {
    const session = startPractice();
    const length = session.exam.items.length;
    for (const index of [-1, length, 1.5]) {
      expect(() => feedback(session, index), `index ${String(index)}`).toThrow(RangeError);
    }
  });

  test('AC-24: feedback throws RangeError for NaN and Infinity', () => {
    const session = startPractice();
    expect(() => feedback(session, Number.NaN)).toThrow(RangeError);
    expect(() => feedback(session, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test('AC-24: a bad index throws also on a submitted session, and in exam mode', () => {
    const done = submitted(startExam());
    const length = done.exam.items.length;
    expect(() => feedback(done, -1)).toThrow(RangeError);
    expect(() => feedback(done, length)).toThrow(RangeError);
    expect(() => feedback(startExam(), length)).toThrow(RangeError);
  });

  test('AC-24: the first and the last index are valid', () => {
    const done = submitted(startExam());
    const last = done.exam.items.length - 1;
    expect(feedback(done, 0)).not.toBeNull();
    expect(feedback(done, last)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------------------------

describe('purity', () => {
  interface Step {
    action: SessionAction;
    /** The action changes the session, so the reducer returns a new object. */
    changes: boolean;
  }

  /**
   * Runs the steps on deep-frozen sessions (a mutation throws). Each step is checked for the same
   * object (no change) or a new one, and in the end every earlier session still equals its
   * snapshot.
   */
  function runFrozen(start: Session, steps: readonly Step[]): Session {
    const history: { session: Session; snapshot: Session }[] = [];
    let state = start;
    for (const { action, changes } of steps) {
      deepFreeze(state);
      const snapshot = structuredClone(state);
      history.push({ session: state, snapshot });
      const next = sessionReducer(state, action);
      expect(state, `${action.type} must not change its input`).toEqual(snapshot);
      if (changes) {
        expect(next, `${action.type} must return a new object`).not.toBe(state);
        expect(next, `${action.type} must change something`).not.toEqual(state);
      } else {
        expect(next, `${action.type} changes nothing: same object`).toBe(state);
      }
      state = next;
    }
    for (const { session, snapshot } of history) expect(session).toEqual(snapshot);
    return state;
  }

  test('AC-25: a practice sequence on deep-frozen sessions: no mutation, same object for no-ops', () => {
    const steps: Step[] = [
      { action: answer(['B']), changes: true },
      { action: flag(true), changes: true },
      { action: flag(true), changes: false },
      { action: reveal(), changes: true },
      { action: reveal(), changes: false },
      { action: answer(['C']), changes: false },
      { action: answer([]), changes: false },
      { action: goTo(1), changes: true },
      { action: goTo(1), changes: false },
      { action: answer(['E', 'B', 'E']), changes: true },
      { action: answer([]), changes: true },
      { action: flag(false), changes: false },
      { action: tick(10 ** 12), changes: false },
      { action: goTo(3), changes: true },
      { action: reveal(), changes: true },
      { action: submit(5_000), changes: true },
      { action: answer(['A']), changes: false },
      { action: flag(true), changes: false },
      { action: reveal(), changes: false },
      { action: submit(6_000), changes: false },
      { action: tick(7_000), changes: false },
      { action: goTo(3), changes: false },
      { action: goTo(5), changes: true },
    ];
    const end = runFrozen(startPractice(), steps);
    expect(end.status).toBe('submitted');
    expect(end.current).toBe(5);
  });

  test('AC-25: an exam sequence on deep-frozen sessions: no mutation, same object for no-ops', () => {
    const steps: Step[] = [
      { action: tick(1_000), changes: false },
      { action: reveal(2_000), changes: false },
      { action: answer(['B'], 3_000), changes: true },
      { action: flag(false, 4_000), changes: false },
      { action: flag(true, 5_000), changes: true },
      { action: goTo(2, 6_000), changes: true },
      { action: goTo(2, 7_000), changes: false },
      { action: answer(['C'], 8_000), changes: true },
      { action: tick(DEADLINE - 1), changes: false },
      { action: submit(DEADLINE - 1), changes: true },
      { action: answer(['A'], DEADLINE - 1), changes: false },
      { action: goTo(0, DEADLINE + 5), changes: true },
    ];
    const end = runFrozen(startExam(), steps);
    expect(end.submitReason).toBe('manual');
    expect(end.answers).toEqual({ q0: ['B'], q2: ['C'] });
  });

  test('AC-25: a timeout is a change: a new object, with the input untouched', () => {
    const steps: Step[] = [
      { action: answer(['B'], 1_000), changes: true },
      { action: tick(DEADLINE), changes: true },
      { action: tick(DEADLINE + 1), changes: false },
    ];
    const end = runFrozen(startExam(), steps);
    expect(end.submitReason).toBe('timeout');
  });

  test('AC-25: every action that fails the deadline check changes the session (new object)', () => {
    const before = deepFreeze(startExam());
    const actions = [
      answer(['A'], DEADLINE),
      flag(true, DEADLINE),
      goTo(1, DEADLINE),
      reveal(DEADLINE),
      submit(DEADLINE),
      tick(DEADLINE),
    ];
    for (const action of actions) {
      const after = sessionReducer(before, action);
      expect(after, action.type).not.toBe(before);
      expect(after.status, action.type).toBe('submitted');
      expect(before.status, action.type).toBe('active');
    }
  });

  test('AC-25: the selection array passed to answer is not changed, even a frozen unsorted one', () => {
    const selected = Object.freeze(['E', 'B', 'E']);
    const session = answerItem(startExam(), 1, selected);
    expect(selected).toEqual(['E', 'B', 'E']);
    expect(session.answers['q1']).toEqual(['B', 'E']);
  });

  test('AC-25: the session does not keep a reference to the caller selection array', () => {
    const selected = ['B'];
    const session = answerItem(startExam(), 1, selected);
    selected.push('E');
    expect(session.answers['q1']).toEqual(['B']);
  });

  test('AC-25: a session given earlier is not affected by later actions', () => {
    const first = answerItem(startExam(), 0, ['B']);
    const snapshot = structuredClone(first);
    const later = play(first, flag(true), goTo(2), answer(['C']), submit(5_000));
    expect(first).toEqual(snapshot);
    expect(later.answers).toEqual({ q0: ['B'], q2: ['C'] });
  });

  test('AC-25: the selectors do not change the session either', () => {
    const exam = exam6();
    const done = deepFreeze(
      submitted(play(startPractice(exam), answer(['A']), reveal(), flag(true))),
    );
    const snapshot = structuredClone(done);
    remainingMs(done, 1);
    reviewList(done);
    feedback(done, 0);
    sessionScore(done);
    expect(done).toEqual(snapshot);
  });

  /** A recorded attempt: the action list that is replayed in AC-26. */
  function recorded(exam: Exam): SessionAction[] {
    // Valid whatever the item types: the correct keys, or one wrong key.
    const pick = (index: number): string[] => rightKeys(exam, index);
    return [
      goTo(0, 100),
      answer(pick(0), 200),
      flag(true, 300),
      goTo(3, 400),
      answer(pick(3), 500),
      goTo(7, 600),
      answer([wrongKey(exam, 7)], 700),
      flag(true, 800),
      goTo(2, 900),
      tick(1_000),
      answer(pick(2), 1_100),
      answer([], 1_200),
      submit(60_000),
      goTo(1, 70_000),
    ];
  }

  function replay(exam: Exam): Session {
    return play(startExam(exam, 50), ...recorded(exam));
  }

  test('AC-26: the same exam, options and action list always give deep-equal sessions', () => {
    // One bank and one exam: the fixture ids change on every makeBank call.
    const bank = makeBank({ 1: 8, 2: 8, 3: 8, 4: 8 });
    const exam = buildExam(bank, { seed: 11, size: 12 });
    const first = replay(exam);
    const second = replay(exam);
    expect(second).toEqual(first);
    expect(first.status).toBe('submitted');
    expect(first.submitReason).toBe('manual');
    expect(Object.keys(first.answers).length).toBeGreaterThan(0);
    expect(first.flagged.length).toBeGreaterThan(0);
  });

  test('AC-26: replaying the actions on one exam, step by step, rebuilds every intermediate session', () => {
    const exam = exam6();
    const run = (): Session[] => {
      const states: Session[] = [startPractice(exam, 10)];
      for (const action of [
        answer(['A']),
        flag(true),
        reveal(),
        goTo(2),
        answer(['B']),
        submit(9),
      ]) {
        states.push(sessionReducer(at(states, states.length - 1), action));
      }
      return states;
    };
    expect(run()).toEqual(run());
  });

  test('AC-26: a different action list gives a different session', () => {
    const exam = exam6();
    const one = play(startExam(exam), answer(['A']));
    const other = play(startExam(exam), answer(['B']));
    expect(one).not.toEqual(other);
  });
});

// ---------------------------------------------------------------------------------------------
// Package surface
// ---------------------------------------------------------------------------------------------

describe('package surface', () => {
  test('AC-27: src/session.ts exists', () => {
    expect(existsSync(join(import.meta.dirname, 'session.ts'))).toBe(true);
  });

  test('AC-27: every function and constant of the session interface is exported from the index', () => {
    expect(typeof quizCore.startSession).toBe('function');
    expect(typeof quizCore.sessionReducer).toBe('function');
    expect(typeof quizCore.remainingMs).toBe('function');
    expect(typeof quizCore.reviewList).toBe('function');
    expect(typeof quizCore.feedback).toBe('function');
    expect(typeof quizCore.sessionScore).toBe('function');
    expect(quizCore.EXAM_DURATION_MS).toBe(7_800_000);
  });

  test('AC-27: the index exports the same functions as session.ts', () => {
    expect(quizCore.startSession).toBe(startSession);
    expect(quizCore.sessionReducer).toBe(sessionReducer);
    expect(quizCore.remainingMs).toBe(remainingMs);
    expect(quizCore.reviewList).toBe(reviewList);
    expect(quizCore.feedback).toBe(feedback);
    expect(quizCore.sessionScore).toBe(sessionScore);
  });

  test('AC-27: every type of the session interface is exported from the index', () => {
    // Checked by the typecheck: these imports fail to compile if a type is missing.
    expectTypeOf<quizCore.SessionMode>().toEqualTypeOf<'exam' | 'practice'>();
    expectTypeOf<quizCore.Session>().toHaveProperty('deadline').toEqualTypeOf<number | null>();
    expectTypeOf<quizCore.Session>().toHaveProperty('exam').toEqualTypeOf<Exam>();
    expectTypeOf<quizCore.Session>().toHaveProperty('answers').toEqualTypeOf<Answers>();
    expectTypeOf<quizCore.Session>().toHaveProperty('flagged').toEqualTypeOf<string[]>();
    expectTypeOf<quizCore.Session>().toHaveProperty('revealed').toEqualTypeOf<string[]>();
    expectTypeOf<quizCore.Session>()
      .toHaveProperty('status')
      .toEqualTypeOf<'active' | 'submitted'>();
    expectTypeOf<quizCore.Session>().toHaveProperty('submittedAt').toEqualTypeOf<number | null>();
    expectTypeOf<quizCore.Session>()
      .toHaveProperty('submitReason')
      .toEqualTypeOf<'manual' | 'timeout' | null>();
    expectTypeOf<quizCore.SessionAction['type']>().toEqualTypeOf<
      'answer' | 'flag' | 'goTo' | 'reveal' | 'submit' | 'tick'
    >();
    expectTypeOf<quizCore.ReviewEntry>().toEqualTypeOf<ReviewEntry>();
    expectTypeOf<quizCore.ItemFeedback>().toEqualTypeOf<ItemFeedback>();
    expectTypeOf<ItemFeedback>().toHaveProperty('correctKeys').toEqualTypeOf<string[]>();
    expectTypeOf(quizCore.remainingMs).returns.toEqualTypeOf<number | null>();
    expectTypeOf(quizCore.feedback).returns.toEqualTypeOf<ItemFeedback | null>();
    expectTypeOf(quizCore.sessionScore).returns.toEqualTypeOf<AttemptScore | null>();
    expectTypeOf(quizCore.reviewList).returns.toEqualTypeOf<ReviewEntry[]>();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Review round 1 (test gaps)
// ---------------------------------------------------------------------------------------------

describe('review round 1', () => {
  /** Item ids that sort in the reverse of item order: q9, q8... (items 0, 1, 2... of `count`). */
  function reverseIdExam(count: number): Exam {
    return examOf(
      Array.from({ length: count }, (_, index) =>
        makeQuestion({ id: `q${String(9 - index)}`, type: 'single', correct: ['A'] }),
      ),
    );
  }

  test('AC-28: flagged follows exam item order, not id order (q9, q5, q1)', () => {
    const exam = examOf(
      ['q9', 'q5', 'q1'].map((id) => makeQuestion({ id, type: 'single', correct: ['A'] })),
    );
    const session = play(startExam(exam), goTo(2), flag(true), goTo(0), flag(true));
    expect(session.flagged).toEqual(['q9', 'q1']);
  });

  test('AC-28: revealed follows exam item order, not id order (q9, q5, q1)', () => {
    const exam = examOf(
      ['q9', 'q5', 'q1'].map((id) => makeQuestion({ id, type: 'single', correct: ['A'] })),
    );
    const session = play(startPractice(exam), goTo(2), reveal(), goTo(0), reveal());
    expect(session.revealed).toEqual(['q9', 'q1']);
  });

  test('AC-28: with 6 reverse-sorted ids, flags set in a scrambled order stay in item order', () => {
    const exam = reverseIdExam(6);
    expect(ids(exam)).toEqual(['q9', 'q8', 'q7', 'q6', 'q5', 'q4']);
    const session = play(
      startExam(exam),
      goTo(4),
      flag(true),
      goTo(1),
      flag(true),
      goTo(5),
      flag(true),
      goTo(0),
      flag(true),
    );
    expect(session.flagged).toEqual(['q9', 'q8', 'q5', 'q4']);
  });

  test('AC-28: with 6 reverse-sorted ids, reveals in a scrambled order stay in item order', () => {
    const session = play(
      startPractice(reverseIdExam(6)),
      goTo(5),
      reveal(),
      goTo(3),
      reveal(),
      goTo(1),
      reveal(),
    );
    expect(session.revealed).toEqual(['q8', 'q6', 'q4']);
  });

  test('AC-28: reviewList follows item order too, with reverse-sorted ids', () => {
    const session = play(startExam(reverseIdExam(3)), goTo(2), flag(true));
    expect(reviewList(session).map((entry) => entry.id)).toEqual(['q9', 'q8', 'q7']);
  });

  /** Item 1 is a multiple question; `['B', 'E']` is stored on it. */
  function withStoredAnswer(mode: SessionMode): Session {
    return answerItem(startSession(exam6(), { mode, now: 0 }), 1, ['B', 'E']);
  }

  test.each<SessionMode>(['exam', 'practice'])(
    'AC-29: %s mode: the selection already stored, in another order, returns the same object',
    (mode) => {
      const session = withStoredAnswer(mode);
      expect(sessionReducer(session, answer(['E', 'B']))).toBe(session);
    },
  );

  test('AC-29: the selection already stored, with duplicates, returns the same object', () => {
    const session = withStoredAnswer('exam');
    expect(sessionReducer(session, answer(['B', 'E', 'B']))).toBe(session);
  });

  test('AC-29: the selection already stored, as it is, returns the same object', () => {
    const session = withStoredAnswer('exam');
    expect(sessionReducer(session, answer(['B', 'E']))).toBe(session);
  });

  test('AC-29: the same single selection answered again returns the same object', () => {
    const session = answerItem(startExam(), 0, ['B']);
    expect(sessionReducer(session, answer(['B']))).toBe(session);
  });

  test.each<SessionMode>(['exam', 'practice'])(
    'AC-29: %s mode: answer [] on an unanswered question returns the same object',
    (mode) => {
      const fresh = startSession(exam6(), { mode, now: 0 });
      expect(sessionReducer(fresh, answer([]))).toBe(fresh);
      const elsewhere = answerItem(fresh, 2, ['C']);
      const onUnanswered = sessionReducer(elsewhere, goTo(3));
      expect(sessionReducer(onUnanswered, answer([]))).toBe(onUnanswered);
    },
  );

  test('AC-29: a different selection still gives a new object, and a clear on an answer too', () => {
    const session = withStoredAnswer('exam');
    const narrower = sessionReducer(session, answer(['B']));
    expect(narrower).not.toBe(session);
    expect(narrower.answers['q1']).toEqual(['B']);
    const wider = sessionReducer(session, answer(['B', 'C', 'E']));
    expect(wider).not.toBe(session);
    expect(wider.answers['q1']).toEqual(['B', 'C', 'E']);
    const cleared = sessionReducer(session, answer([]));
    expect(cleared).not.toBe(session);
    expect(cleared.answers).toEqual({});
  });

  test('AC-30: practice mode with durationMs 0 throws RangeError', () => {
    expect(() => startSession(exam6(), { mode: 'practice', now: 0, durationMs: 0 })).toThrow(
      RangeError,
    );
  });

  test.each([
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '600000' as unknown as number],
  ] as const)(
    'AC-30: practice mode with durationMs = %s throws RangeError',
    (_name, durationMs) => {
      expect(() => startSession(exam6(), { mode: 'practice', now: 0, durationMs })).toThrow(
        RangeError,
      );
    },
  );

  test('AC-30: practice mode with a valid durationMs gives a null deadline', () => {
    const session = startSession(exam6(), { mode: 'practice', now: 0, durationMs: 600_000 });
    expect(session.deadline).toBeNull();
    expect(session.status).toBe('active');
  });
});
