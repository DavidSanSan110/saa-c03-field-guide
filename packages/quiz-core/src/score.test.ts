import { tasks } from '@field-guide/schema';
import type { Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import {
  correctKeys,
  deepFreeze,
  makeBank,
  makeQuestion,
  wrongKeys,
} from './__mocks__/questions.ts';
import { PASS_MARK, estimateScore, scoreAttempt } from './score.ts';
import type { Answers } from './score.ts';

function right(question: Question): string[] {
  return correctKeys(question);
}

function wrong(question: Question): string[] {
  return wrongKeys(question).slice(0, 1);
}

/** Answers where the first `correct` questions are right, the next `wrongCount` wrong, rest empty. */
function attempt(
  questions: readonly Question[],
  correct: number,
  wrongCount: number,
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  questions.forEach((question, index) => {
    if (index < correct) answers[question.id] = right(question);
    else if (index < correct + wrongCount) answers[question.id] = wrong(question);
  });
  return answers;
}

describe('estimateScore', () => {
  test.each([
    [0, 100],
    [1, 1000],
    [0.72, 748],
    [0.5, 550],
    [45 / 65, 723],
    [44 / 65, 709],
  ])('AC-8: estimateScore(%s) is %s', (raw, expected) => {
    expect(estimateScore(raw)).toBe(expected);
  });

  test.each([-0.01, 1.01, NaN])('AC-8: estimateScore(%s) throws RangeError', (raw) => {
    expect(() => estimateScore(raw)).toThrow(RangeError);
  });

  test('AC-8: PASS_MARK is 720', () => {
    expect(PASS_MARK).toBe(720);
  });
});

describe('scoreAttempt: whole attempt', () => {
  const questions = makeBank({ 1: 4, 2: 3, 3: 2, 4: 1 });

  test('AC-9: 7 correct, 1 wrong and 2 unanswered', () => {
    const score = scoreAttempt(questions, attempt(questions, 7, 1));
    expect(score.total).toBe(10);
    expect(score.answered).toBe(8);
    expect(score.correct).toBe(7);
    expect(score.raw).toBeCloseTo(0.7, 10);
    expect(score.estimated).toBe(730);
    expect(score.passed).toBe(true);
  });

  test('AC-9: with 6 correct the estimate is 640 and the attempt is not passed', () => {
    const score = scoreAttempt(questions, attempt(questions, 6, 2));
    expect(score.correct).toBe(6);
    expect(score.raw).toBeCloseTo(0.6, 10);
    expect(score.estimated).toBe(640);
    expect(score.passed).toBe(false);
  });

  test('AC-9: passed is true exactly at the pass mark and not below it', () => {
    // 45/65 -> 723 (pass), 44/65 -> 709 (fail)
    const exam = makeBank({ 1: 20, 2: 17, 3: 16, 4: 12 });
    expect(exam).toHaveLength(65);
    const pass = scoreAttempt(exam, attempt(exam, 45, 20));
    expect(pass.estimated).toBe(723);
    expect(pass.passed).toBe(true);
    const fail = scoreAttempt(exam, attempt(exam, 44, 21));
    expect(fail.estimated).toBe(709);
    expect(fail.passed).toBe(false);
  });

  test('AC-9: a short exam is scored over the questions it has', () => {
    const short = makeBank({ 1: 3, 2: 2 });
    const score = scoreAttempt(short, attempt(short, 5, 0));
    expect(score.total).toBe(5);
    expect(score.raw).toBe(1);
    expect(score.estimated).toBe(1000);
    expect(score.passed).toBe(true);
  });

  test('AC-9: all unanswered gives raw 0, estimate 100 and not passed', () => {
    const score = scoreAttempt(questions, {});
    expect(score.total).toBe(10);
    expect(score.answered).toBe(0);
    expect(score.correct).toBe(0);
    expect(score.raw).toBe(0);
    expect(score.estimated).toBe(100);
    expect(score.passed).toBe(false);
  });

  test('AC-12: no questions gives total 0, raw null, estimated null and not passed', () => {
    const score = scoreAttempt([], {});
    expect(score.total).toBe(0);
    expect(score.answered).toBe(0);
    expect(score.correct).toBe(0);
    expect(score.raw).toBeNull();
    expect(score.estimated).toBeNull();
    expect(score.passed).toBe(false);
    expect(score.results).toEqual([]);
  });

  test('AC-12: no questions still has all 4 domains and all 14 tasks, empty', () => {
    const score = scoreAttempt([], {});
    const empty = { total: 0, answered: 0, correct: 0, raw: null };
    expect(Object.keys(score.byDomain)).toHaveLength(4);
    expect(Object.keys(score.byTask)).toHaveLength(14);
    expect(score.byDomain[1]).toEqual(empty);
    expect(score.byTask['3.5']).toEqual(empty);
  });
});

describe('scoreAttempt: buckets per domain and task', () => {
  // Domain 1: tasks 1.1 (x3) and 1.2 (x2). Domain 2: task 2.1 (x2). Domain 3: task 3.2 (x1).
  const q = [
    makeQuestion({ domain: 1, task: '1.1' }),
    makeQuestion({ domain: 1, task: '1.1' }),
    makeQuestion({ domain: 1, task: '1.1' }),
    makeQuestion({ domain: 1, task: '1.2' }),
    makeQuestion({ domain: 1, task: '1.2' }),
    makeQuestion({ domain: 2, task: '2.1' }),
    makeQuestion({ domain: 2, task: '2.1' }),
    makeQuestion({ domain: 3, task: '3.2', type: 'multiple' }),
  ] as const;
  const answers: Answers = {
    [q[0].id]: right(q[0]),
    [q[1].id]: wrong(q[1]),
    // q[2]: unanswered
    [q[3].id]: right(q[3]),
    [q[4].id]: right(q[4]),
    [q[5].id]: wrong(q[5]),
    [q[6].id]: [],
    [q[7].id]: right(q[7]),
  };

  test('AC-10: byDomain has the keys 1 to 4 and byTask has the 14 task ids', () => {
    const score = scoreAttempt(q, answers);
    expect(Object.keys(score.byDomain).sort()).toEqual(['1', '2', '3', '4']);
    expect(Object.keys(score.byTask).sort()).toEqual(tasks.map((task) => task.id).sort());
  });

  test('AC-10: each domain holds the counts of its own questions', () => {
    const { byDomain } = scoreAttempt(q, answers);
    expect(byDomain[1]).toEqual({ total: 5, answered: 4, correct: 3, raw: 0.6 });
    expect(byDomain[2]).toEqual({ total: 2, answered: 1, correct: 0, raw: 0 });
    expect(byDomain[3]).toEqual({ total: 1, answered: 1, correct: 1, raw: 1 });
  });

  test('AC-10: a domain with no questions has total 0 and raw null', () => {
    const { byDomain } = scoreAttempt(q, answers);
    expect(byDomain[4]).toEqual({ total: 0, answered: 0, correct: 0, raw: null });
  });

  test('AC-10: each task holds the counts of its own questions', () => {
    const { byTask } = scoreAttempt(q, answers);
    expect(byTask['1.1'].total).toBe(3);
    expect(byTask['1.1'].answered).toBe(2);
    expect(byTask['1.1'].correct).toBe(1);
    expect(byTask['1.1'].raw).toBeCloseTo(1 / 3, 10);
    expect(byTask['1.2']).toEqual({ total: 2, answered: 2, correct: 2, raw: 1 });
    expect(byTask['2.1']).toEqual({ total: 2, answered: 1, correct: 0, raw: 0 });
    expect(byTask['3.2']).toEqual({ total: 1, answered: 1, correct: 1, raw: 1 });
  });

  test('AC-10: every task with no questions has total 0 and raw null', () => {
    const { byTask } = scoreAttempt(q, answers);
    const used = new Set(['1.1', '1.2', '2.1', '3.2']);
    for (const task of tasks.filter((candidate) => !used.has(candidate.id))) {
      expect(byTask[task.id], task.id).toEqual({ total: 0, answered: 0, correct: 0, raw: null });
    }
  });

  test('AC-10: the whole-attempt bucket adds up the questions', () => {
    const score = scoreAttempt(q, answers);
    expect(score.total).toBe(8);
    expect(score.answered).toBe(6);
    expect(score.correct).toBe(4);
    expect(score.raw).toBe(0.5);
    expect(score.estimated).toBe(550);
    expect(score.passed).toBe(false);
  });
});

describe('scoreAttempt: results and answers', () => {
  const questions = [
    makeQuestion({ domain: 2, task: '2.2' }),
    makeQuestion({ domain: 1, task: '1.3', type: 'multiple' }),
    makeQuestion({ domain: 4, task: '4.4' }),
    makeQuestion({ domain: 3, task: '3.1' }),
  ] as const;
  const [first, second, third, fourth] = questions;

  test('AC-11: results has one entry per question, in input order, with all its fields', () => {
    const score = scoreAttempt(questions, {
      [first.id]: right(first),
      [second.id]: wrong(second),
      [fourth.id]: [],
    });
    expect(score.results).toEqual([
      { id: first.id, domain: 2, task: '2.2', answered: true, correct: true },
      { id: second.id, domain: 1, task: '1.3', answered: true, correct: false },
      { id: third.id, domain: 4, task: '4.4', answered: false, correct: false },
      { id: fourth.id, domain: 3, task: '3.1', answered: false, correct: false },
    ]);
  });

  test('AC-11: an answer that is an empty array counts as unanswered', () => {
    const score = scoreAttempt([first], { [first.id]: [] });
    expect(score.answered).toBe(0);
    expect(score.results[0]).toMatchObject({ answered: false, correct: false });
  });

  test('AC-11: an answer with only unknown option keys is answered and wrong', () => {
    const score = scoreAttempt([first], { [first.id]: ['Z'] });
    expect(score.answered).toBe(1);
    expect(score.correct).toBe(0);
    expect(score.results[0]).toMatchObject({ answered: true, correct: false });
  });

  test('AC-11: answers for ids that are not in the questions change nothing', () => {
    const base = { [first.id]: right(first), [second.id]: wrong(second) };
    const withStrangers = { ...base, 'd1-1.1-9999': ['A'], 'not-a-question': ['B', 'C'] };
    expect(scoreAttempt(questions, withStrangers)).toEqual(scoreAttempt(questions, base));
  });

  test('AC-9: a multiple question counts as correct only with the exact set', () => {
    const partial = scoreAttempt([second], { [second.id]: [right(second)[0] ?? 'B'] });
    expect(partial.correct).toBe(0);
    expect(partial.answered).toBe(1);
    const full = scoreAttempt([second], { [second.id]: [...right(second)].reverse() });
    expect(full.correct).toBe(1);
  });
});

describe('scoreAttempt: duplicates and purity', () => {
  test('AC-13: two questions with the same id throw an Error naming the id', () => {
    const a = makeQuestion({ id: 'd1-1.1-0123' });
    const b = makeQuestion({ id: 'd1-1.1-0123' });
    expect(() => scoreAttempt([a, b], {})).toThrow(Error);
    expect(() => scoreAttempt([a, b], {})).toThrow(/d1-1\.1-0123/);
  });

  test('AC-13: frozen inputs work and are not changed', () => {
    const questions = makeBank({ 1: 2, 2: 2, 3: 1, 4: 1 });
    const answers: Answers = {
      [questions[0]?.id ?? '']: ['A'],
      [questions[1]?.id ?? '']: [],
      unknown: ['A'],
    };
    const questionsBefore = structuredClone(questions);
    const answersBefore = structuredClone(answers);
    deepFreeze(questions);
    deepFreeze(answers);

    const score = scoreAttempt(questions, answers);

    expect(score.total).toBe(6);
    expect(questions).toEqual(questionsBefore);
    expect(answers).toEqual(answersBefore);
  });
});

describe('review round 1: scoring regressions', () => {
  test('AC-31: 31 correct of 45 gives estimated 720 and passed', () => {
    const questions = makeBank({ 1: 15, 2: 12, 3: 10, 4: 8 });
    expect(questions).toHaveLength(45);
    const score = scoreAttempt(questions, attempt(questions, 31, 14));
    expect(score.correct).toBe(31);
    expect(score.estimated).toBe(720);
    expect(score.passed).toBe(true);
  });

  test('AC-31: 42 correct of 61 (unrounded 719.67) gives estimated 720 and passed', () => {
    const questions = makeBank({ 1: 20, 2: 16, 3: 14, 4: 11 });
    expect(questions).toHaveLength(61);
    const score = scoreAttempt(questions, attempt(questions, 42, 19));
    expect(score.correct).toBe(42);
    expect(score.estimated).toBe(720);
    expect(score.passed).toBe(true);
  });

  test('AC-32: an inherited answer does not count, the question is unanswered and wrong', () => {
    const question = makeQuestion({ type: 'single', correct: ['C'] });
    const answers = Object.create({ [question.id]: ['C'] }) as Answers;
    const score = scoreAttempt([question], answers);
    expect(score.answered).toBe(0);
    expect(score.correct).toBe(0);
    expect(score.results[0]).toMatchObject({ id: question.id, answered: false, correct: false });
  });

  test('AC-32: an own answer on the same kind of object still counts', () => {
    const question = makeQuestion({ type: 'single', correct: ['C'] });
    const answers = Object.assign(Object.create({}) as object, { [question.id]: ['C'] }) as Answers;
    const score = scoreAttempt([question], answers);
    expect(score.answered).toBe(1);
    expect(score.correct).toBe(1);
  });
});
