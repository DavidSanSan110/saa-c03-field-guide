// Spec 028 (AC-4): what the review screen and the explanation block show for one question.
import { sessionReducer, startSession } from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import type { Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import {
  answerItem,
  makeDescendingQuestions,
  makeExam,
  playActions,
} from '../../../../packages/quiz-core/src/__mocks__/sessions.ts';
import { resultsView } from './results.ts';
import { questionReview } from './review.ts';

const START = 1_000_000;
const REFERENCES = [
  'https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html',
  'https://aws.amazon.com/blogs/security/example/',
];

/** Computes on first use, so a throwing implementation fails the tests, not the collection. */
function lazy<T>(make: () => T): () => T {
  let value: { made: T } | undefined;
  return () => {
    value ??= { made: make() };
    return value.made;
  };
}

/**
 * Four questions in this exam order (descending ids): 0 single (correct A), 1 multiple (B, E),
 * 2 single (correct C), 3 multiple (A, D). Question 1 has a cue; every question has two references.
 */
const questions = lazy((): Question[] =>
  makeDescendingQuestions(4).map((question, index) => ({
    ...question,
    references: REFERENCES,
    ...(index === 1 ? { cue: 'A "stateless" tier hints at an Auto Scaling group.' } : {}),
  })),
);

/** A different option order for every question, so display letters differ from the keys. */
const ORDERS: Record<number, string[]> = {
  0: ['C', 'A', 'D', 'B'],
  1: ['E', 'D', 'C', 'B', 'A'],
  2: ['D', 'C', 'B', 'A'],
  3: ['B', 'A', 'E', 'D', 'C'],
};

function startedExam(mode: 'exam' | 'practice'): Session {
  return startSession(makeExam(questions(), ORDERS), { mode, now: START, durationMs: 600_000 });
}

/** Answers: 0 right (A), 1 wrong (B and D), 2 none, 3 right (A and D); then submitted. */
const submittedExam = lazy((): Session => {
  let session = startedExam('exam');
  session = answerItem(session, 0, ['A']);
  session = answerItem(session, 1, ['B', 'D']);
  session = answerItem(session, 3, ['A', 'D']);
  return playActions(session, { type: 'submit', now: START + 60_000 });
});

describe('questionReview of a submitted exam', () => {
  test('AC-4: it gives the 1-based number, the total and the facts of the question', () => {
    const review = questionReview(submittedExam(), 1);
    const question = questions()[1] as Question;

    expect(review).toMatchObject({
      number: 2,
      total: 4,
      id: question.id,
      domain: question.domain,
      task: question.task,
      type: 'multiple',
      need: 2,
      stem: question.stem,
    });
  });

  test('AC-4: a single-answer question needs one option', () => {
    const review = questionReview(submittedExam(), 0);

    expect(review.type).toBe('single');
    expect(review.need).toBe(1);
  });

  test('AC-4: the options follow optionOrder, lettered A, B, C… by display position', () => {
    const review = questionReview(submittedExam(), 0);

    expect(review.options.map((option) => option.key)).toEqual(ORDERS[0]);
    expect(review.options.map((option) => option.letter)).toEqual(['A', 'B', 'C', 'D']);
  });

  test('AC-4: each option carries its text and why from the question', () => {
    const question = questions()[1] as Question;
    const review = questionReview(submittedExam(), 1);

    for (const option of review.options) {
      const source = question.options.find((candidate) => candidate.key === option.key);
      expect(option.text).toBe(source?.text);
      expect(option.why).toBe(source?.why);
    }
  });

  test('AC-4: correct and selected are set as in the question and the answers', () => {
    // Question 1: correct B and E, the visitor chose B and D, displayed as E D C B A.
    const review = questionReview(submittedExam(), 1);

    expect(
      review.options.map(({ letter, key, correct, selected }) => ({
        letter,
        key,
        correct,
        selected,
      })),
    ).toEqual([
      { letter: 'A', key: 'E', correct: true, selected: false },
      { letter: 'B', key: 'D', correct: false, selected: true },
      { letter: 'C', key: 'C', correct: false, selected: false },
      { letter: 'D', key: 'B', correct: true, selected: true },
      { letter: 'E', key: 'A', correct: false, selected: false },
    ]);
  });

  test('AC-4: an option has exactly the fields letter, key, text, why, correct and selected', () => {
    const [first] = questionReview(submittedExam(), 0).options;

    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['correct', 'key', 'letter', 'selected', 'text', 'why'].sort(),
    );
  });

  test('AC-4: status is correct, incorrect or unanswered as resultsView says for every question', () => {
    const session = submittedExam();
    const expected = resultsView(session).items.map((item) => item.status);

    expect(expected).toEqual(['correct', 'incorrect', 'unanswered', 'correct']);
    expect(questions().map((_, index) => questionReview(session, index).status)).toEqual(expected);
  });

  test('AC-4: an unanswered question has no selected option', () => {
    const review = questionReview(submittedExam(), 2);

    expect(review.status).toBe('unanswered');
    expect(review.options.some((option) => option.selected)).toBe(false);
    expect(review.options.filter((option) => option.correct).map((option) => option.key)).toEqual([
      'C',
    ]);
  });

  test('AC-4: cue is null when the question has none and the text when it has one', () => {
    const session = submittedExam();

    expect(questionReview(session, 0).cue).toBeNull();
    expect(questionReview(session, 1).cue).toBe(
      'A "stateless" tier hints at an Auto Scaling group.',
    );
  });

  test('AC-4: references are those of the question, in order', () => {
    expect(questionReview(submittedExam(), 0).references).toEqual(REFERENCES);
  });

  test('AC-4: it does not depend on the current question of the session', () => {
    const session = playActions(submittedExam(), { type: 'goTo', index: 3, now: START + 70_000 });

    expect(questionReview(session, 0)).toEqual(questionReview(submittedExam(), 0));
  });
});

describe('questionReview where the key is hidden', () => {
  test('AC-4: it throws a RangeError for every question of an active exam', () => {
    const session = answerItem(startedExam('exam'), 0, ['A']);

    for (const index of [0, 1, 2, 3]) {
      expect(() => questionReview(session, index), `index ${String(index)}`).toThrow(RangeError);
    }
  });

  test('AC-4: it throws a RangeError for an index outside the exam', () => {
    expect(() => questionReview(submittedExam(), 4)).toThrow(RangeError);
    expect(() => questionReview(submittedExam(), -1)).toThrow(RangeError);
  });
});

describe('questionReview of a practice session', () => {
  test('AC-4: a revealed question can be reviewed, with the answer given', () => {
    let session = answerItem(startedExam('practice'), 0, ['A']);
    session = playActions(session, { type: 'reveal', now: START + 10 });

    const review = questionReview(session, 0);

    expect(review.status).toBe('correct');
    expect(review.options.filter((option) => option.selected).map((option) => option.key)).toEqual([
      'A',
    ]);
    expect(review.options.filter((option) => option.correct).map((option) => option.key)).toEqual([
      'A',
    ]);
  });

  test('AC-4: a wrong answer that was revealed is incorrect', () => {
    let session = answerItem(startedExam('practice'), 2, ['A']);
    session = playActions(session, { type: 'reveal', now: START + 10 });

    expect(questionReview(session, 2).status).toBe('incorrect');
  });

  test('AC-4: a question revealed with no selection is unanswered', () => {
    const session = playActions(
      startedExam('practice'),
      { type: 'goTo', index: 2, now: START + 5 },
      { type: 'reveal', now: START + 10 },
    );

    const review = questionReview(session, 2);

    expect(review.status).toBe('unanswered');
    expect(review.options.some((option) => option.selected)).toBe(false);
  });

  test('AC-4: a question that is not revealed yet throws a RangeError, even when answered', () => {
    const answered = answerItem(startedExam('practice'), 0, ['A']);

    expect(() => questionReview(answered, 0)).toThrow(RangeError);
    expect(() => questionReview(answered, 1)).toThrow(RangeError);
  });

  test('AC-4: only the revealed questions can be reviewed while the set is active', () => {
    let session = playActions(startedExam('practice'), { type: 'reveal', now: START + 1 });
    session = playActions(session, { type: 'goTo', index: 1, now: START + 2 });

    expect(() => questionReview(session, 0)).not.toThrow();
    expect(() => questionReview(session, 1)).toThrow(RangeError);
  });

  test('AC-4: after the set is submitted every question can be reviewed', () => {
    const answered = answerItem(startedExam('practice'), 0, ['A']);
    const session = sessionReducer(answered, { type: 'submit', now: START + 100 });

    expect(questions().map((_, index) => questionReview(session, index).number)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(questionReview(session, 3).status).toBe('unanswered');
  });
});
