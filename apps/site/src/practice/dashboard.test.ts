// Spec 028 (AC-7): the numbers of the progress view and of the Progress card.
import { emptyProgress, leitnerSummary, progressSummary } from '@field-guide/quiz-core';
import { domains, tasks } from '@field-guide/schema';
import type {
  AttemptRecord,
  DomainId,
  Progress,
  Question,
  QuestionStats,
  TaskId,
} from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { makeQuestion } from '../../../../packages/quiz-core/src/__mocks__/questions.ts';
import { dashboardView } from './dashboard.ts';

const NOW = 9_000_000_000;
const DAY = 86_400_000;

/** Computes on first use, so a throwing implementation fails the tests, not the collection. */
function lazy<T>(make: () => T): () => T {
  let value: { made: T } | undefined;
  return () => {
    value ??= { made: make() };
    return value.made;
  };
}

function q(id: string, status: Question['status'] = 'reviewed'): Question {
  const domain = Number(id.charAt(1)) as DomainId;
  const task = id.slice(3, 6) as TaskId;
  return makeQuestion({ id, domain, task, status });
}

/** Five reviewed questions in tasks 1.1 (two), 1.3, 2.1 and 3.5, and a draft that never counts. */
const bank = lazy((): Question[] => [
  q('d1-1.1-0001'),
  q('d1-1.1-0002'),
  q('d1-1.3-0003'),
  q('d2-2.1-0004'),
  q('d3-3.5-0005'),
  q('d1-1.1-0006', 'draft'),
]);

function stats(
  answered: number,
  correct: number,
  overrides: Partial<QuestionStats> = {},
): QuestionStats {
  return { answered, correct, lastAnsweredAt: NOW - DAY, box: 0, dueAt: null, ...overrides };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const tally = { total: 0, answered: 0, correct: 0 };
  return {
    mode: 'exam',
    seed: 1,
    size: 10,
    startedAt: 0,
    submittedAt: 1_000,
    submitReason: 'manual',
    total: 10,
    answered: 10,
    correct: 5,
    estimated: 500,
    byDomain: { 1: tally, 2: tally, 3: tally, 4: tally },
    ...overrides,
  };
}

function progressOf(
  attempts: AttemptRecord[],
  questions: Record<string, QuestionStats> = {},
): Progress {
  return { ...emptyProgress(), attempts, questions };
}

describe('dashboardView on empty progress', () => {
  test('AC-7: with an empty bank and no attempts every count is 0, percent is null and lists are empty', () => {
    const view = dashboardView([], emptyProgress(), NOW);

    expect(view.overall).toEqual({
      questions: 0,
      seen: 0,
      answered: 0,
      correct: 0,
      percent: null,
      due: 0,
    });
    expect(view.attempts).toEqual({ total: 0, exam: 0, practice: 0 });
    expect(view.recent).toEqual([]);
    expect(view.examScores).toEqual([]);
    expect(view.domains).toHaveLength(4);
    expect(view.tasks).toHaveLength(14);
    expect(view.leitner).toEqual({
      boxes: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      due: 0,
      nextDueAt: null,
    });
  });

  test('AC-7: with a bank and no attempts, only the question counts are above 0', () => {
    const view = dashboardView(bank(), emptyProgress(), NOW);

    expect(view.overall).toEqual({
      questions: 5,
      seen: 0,
      answered: 0,
      correct: 0,
      percent: null,
      due: 0,
    });
    expect(view.attempts).toEqual({ total: 0, exam: 0, practice: 0 });
    expect(view.recent).toEqual([]);
    expect(view.examScores).toEqual([]);
    for (const row of [...view.domains, ...view.tasks]) {
      expect(row, String(row.id)).toMatchObject({
        seen: 0,
        answered: 0,
        correct: 0,
        raw: null,
        percent: null,
        weak: 0,
        needsWork: false,
      });
    }
  });

  test('AC-7: the domain rows are the four domains in order, the task rows the 14 tasks in catalog order', () => {
    const view = dashboardView(bank(), emptyProgress(), NOW);

    expect(view.domains.map(({ id, title }) => ({ id, title }))).toEqual(
      domains.map(({ id, title }) => ({ id, title })),
    );
    expect(view.tasks.map(({ id, title }) => ({ id, title }))).toEqual(
      tasks.map(({ id, title }) => ({ id, title })),
    );
  });

  test('AC-7: the question counts of the rows count reviewed questions only', () => {
    const view = dashboardView(bank(), emptyProgress(), NOW);

    expect(view.domains.map((row) => row.questions)).toEqual([3, 1, 1, 0]);
    expect(Object.fromEntries(view.tasks.map((row) => [row.id, row.questions]))).toMatchObject({
      '1.1': 2,
      '1.2': 0,
      '1.3': 1,
      '2.1': 1,
      '3.5': 1,
    });
  });
});

describe('dashboardView overall', () => {
  const progress = () =>
    progressOf([attempt()], {
      'd1-1.1-0001': stats(1, 1),
      'd1-1.1-0002': stats(2, 1, { box: 1, dueAt: NOW - 5 }),
      'd2-2.1-0004': stats(0, 0, { box: 3, dueAt: NOW + 3 * DAY }),
    });

  test('AC-7: seen, answered and correct come from progressSummary', () => {
    const { overall } = dashboardView(bank(), progress(), NOW);

    expect(overall).toMatchObject({ questions: 5, seen: 3, answered: 3, correct: 2 });
  });

  test('AC-7: percent rounds: 2 correct of 3 answered is 67', () => {
    expect(dashboardView(bank(), progress(), NOW).overall.percent).toBe(67);
  });

  test('AC-7: percent rounds half up: 1 correct of 8 answered is 13', () => {
    const view = dashboardView(
      bank(),
      progressOf([attempt()], { 'd1-1.1-0001': stats(8, 1) }),
      NOW,
    );

    expect(view.overall.percent).toBe(13);
  });

  test('AC-7: percent is 0 when everything answered was wrong, and null only when nothing was answered', () => {
    const wrong = dashboardView(
      bank(),
      progressOf([attempt()], { 'd1-1.1-0001': stats(2, 0) }),
      NOW,
    );

    expect(wrong.overall.percent).toBe(0);
    expect(wrong.overall.answered).toBe(2);
  });

  test('AC-7: due is the number of questions due now, as leitnerSummary counts them', () => {
    const view = dashboardView(bank(), progress(), NOW);

    expect(view.overall.due).toBe(1);
    expect(view.leitner).toEqual(leitnerSummary(bank(), progress(), NOW));
  });

  test('AC-7: due follows the time given', () => {
    expect(dashboardView(bank(), progress(), NOW + 3 * DAY).overall.due).toBe(2);
  });

  test('AC-7: attempts counts all, mock exams and practice sets', () => {
    const attempts = [
      attempt({ mode: 'exam', submittedAt: 1 }),
      attempt({ mode: 'practice', submittedAt: 2 }),
      attempt({ mode: 'exam', submittedAt: 3 }),
      attempt({ mode: 'practice', submittedAt: 4 }),
      attempt({ mode: 'exam', submittedAt: 5 }),
    ];

    expect(dashboardView(bank(), progressOf(attempts), NOW).attempts).toEqual({
      total: 5,
      exam: 3,
      practice: 2,
    });
  });
});

describe('dashboardView recent attempts', () => {
  test('AC-7: recent is newest first', () => {
    const attempts = [1, 2, 3].map((n) => attempt({ submittedAt: n * 1_000, correct: n }));

    const { recent } = dashboardView(bank(), progressOf(attempts), NOW);

    expect(recent.map((row) => row.submittedAt)).toEqual([3_000, 2_000, 1_000]);
  });

  test('AC-7: recent sorts by submittedAt, and for equal times the later record comes first', () => {
    const attempts = [
      attempt({ submittedAt: 100, correct: 1 }),
      attempt({ submittedAt: 300, correct: 2 }),
      attempt({ submittedAt: 200, correct: 3 }),
      attempt({ submittedAt: 300, correct: 4 }),
    ];

    const { recent } = dashboardView(bank(), progressOf(attempts), NOW);

    expect(recent.map((row) => row.correct)).toEqual([4, 2, 3, 1]);
  });

  test('AC-7: with 25 attempts recent holds the last 20, newest first', () => {
    const attempts = Array.from({ length: 25 }, (_, index) =>
      attempt({ submittedAt: (index + 1) * 1_000, correct: index }),
    );

    const { recent, attempts: counts } = dashboardView(bank(), progressOf(attempts), NOW);

    expect(counts.total).toBe(25);
    expect(recent).toHaveLength(20);
    expect(recent[0]?.submittedAt).toBe(25_000);
    expect(recent[19]?.submittedAt).toBe(6_000);
  });

  test('AC-7: an exam row has its estimated score and passed', () => {
    const view = dashboardView(
      bank(),
      progressOf([
        attempt({ mode: 'exam', submittedAt: 7, correct: 40, total: 65, estimated: 810 }),
      ]),
      NOW,
    );

    expect(view.recent).toEqual([
      { submittedAt: 7, mode: 'exam', correct: 40, total: 65, estimated: 810, passed: true },
    ]);
  });

  test('AC-7: passed is true from 720 and false at 719', () => {
    const view = dashboardView(
      bank(),
      progressOf([
        attempt({ submittedAt: 1, estimated: 719 }),
        attempt({ submittedAt: 2, estimated: 720 }),
      ]),
      NOW,
    );

    expect(view.recent.map((row) => row.passed)).toEqual([true, false]);
  });

  test('AC-7: a practice row has estimated and passed null', () => {
    const view = dashboardView(
      bank(),
      progressOf([
        attempt({ mode: 'practice', submittedAt: 7, correct: 3, total: 10, estimated: 340 }),
      ]),
      NOW,
    );

    expect(view.recent).toEqual([
      { submittedAt: 7, mode: 'practice', correct: 3, total: 10, estimated: null, passed: null },
    ]);
  });
});

describe('dashboardView exam scores', () => {
  test('AC-7: examScores holds the exam attempts only, oldest first', () => {
    const attempts = [
      attempt({ mode: 'exam', submittedAt: 1_000, estimated: 400 }),
      attempt({ mode: 'practice', submittedAt: 2_000, estimated: 999 }),
      attempt({ mode: 'exam', submittedAt: 3_000, estimated: 650 }),
      attempt({ mode: 'practice', submittedAt: 4_000, estimated: 998 }),
      attempt({ mode: 'exam', submittedAt: 5_000, estimated: 780 }),
    ];

    const { examScores } = dashboardView(bank(), progressOf(attempts), NOW);

    expect(examScores).toEqual([
      { submittedAt: 1_000, estimated: 400 },
      { submittedAt: 3_000, estimated: 650 },
      { submittedAt: 5_000, estimated: 780 },
    ]);
  });

  test('AC-7: examScores is capped at the last 20 exam attempts, oldest first', () => {
    const attempts: AttemptRecord[] = [];
    for (let index = 0; index < 22; index += 1) {
      attempts.push(
        attempt({ mode: 'exam', submittedAt: 1_000 + index * 100, estimated: 100 + index }),
      );
      if (index % 7 === 0) {
        attempts.push(attempt({ mode: 'practice', submittedAt: 1_050 + index * 100 }));
      }
    }

    const { examScores } = dashboardView(bank(), progressOf(attempts), NOW);

    expect(examScores).toHaveLength(20);
    expect(examScores[0]).toEqual({ submittedAt: 1_200, estimated: 102 });
    expect(examScores[19]).toEqual({ submittedAt: 3_100, estimated: 121 });
    expect(examScores.map((row) => row.estimated)).toEqual(
      Array.from({ length: 20 }, (_, index) => 102 + index),
    );
  });

  test('AC-7: with only practice attempts examScores is empty', () => {
    const view = dashboardView(
      bank(),
      progressOf([attempt({ mode: 'practice', submittedAt: 1 })]),
      NOW,
    );

    expect(view.examScores).toEqual([]);
    expect(view.recent).toHaveLength(1);
  });
});

describe('dashboardView domains and tasks', () => {
  const progress = () =>
    progressOf([attempt()], {
      'd1-1.1-0001': stats(1, 1),
      'd1-1.1-0002': stats(2, 1, { box: 1, dueAt: NOW - 5 }),
      'd1-1.3-0003': stats(1, 0, { box: 2, dueAt: NOW + DAY }),
      'd2-2.1-0004': stats(4, 3),
    });

  test('AC-7: every domain row has the fields of progressSummary, a rounded percent and needsWork', () => {
    const summary = progressSummary(bank(), progress());

    const { domains: rows } = dashboardView(bank(), progress(), NOW);

    expect(rows).toEqual(
      domains.map(({ id, title }) => {
        const bucket = summary.byDomain[id];
        return {
          id,
          title,
          questions: bucket.questions,
          seen: bucket.seen,
          answered: bucket.answered,
          correct: bucket.correct,
          raw: bucket.raw,
          percent: bucket.raw === null ? null : Math.round(100 * bucket.raw),
          weak: bucket.weak,
          needsWork: bucket.raw !== null && bucket.raw < 0.72,
        };
      }),
    );
  });

  test('AC-7: every task row has the fields of progressSummary, a rounded percent and needsWork', () => {
    const summary = progressSummary(bank(), progress());

    const { tasks: rows } = dashboardView(bank(), progress(), NOW);

    expect(rows).toEqual(
      tasks.map(({ id, title }) => {
        const bucket = summary.byTask[id];
        return {
          id,
          title,
          questions: bucket.questions,
          seen: bucket.seen,
          answered: bucket.answered,
          correct: bucket.correct,
          raw: bucket.raw,
          percent: bucket.raw === null ? null : Math.round(100 * bucket.raw),
          weak: bucket.weak,
          needsWork: bucket.raw !== null && bucket.raw < 0.72,
        };
      }),
    );
  });

  test('AC-7: a domain row counts seen questions, answers and the questions in weak spots', () => {
    const row = dashboardView(bank(), progress(), NOW).domains[0];

    // Domain 1: 3 reviewed questions, 3 seen; answers 1 + 2 + 1, right 1 + 1 + 0; two in boxes.
    expect(row).toMatchObject({
      id: 1,
      questions: 3,
      seen: 3,
      answered: 4,
      correct: 2,
      raw: 0.5,
      percent: 50,
      weak: 2,
      needsWork: true,
    });
  });

  test('AC-7: percent rounds in the rows too: 2 correct of 3 answered is 67', () => {
    const rows = dashboardView(
      bank(),
      progressOf([attempt()], { 'd2-2.1-0004': stats(3, 2) }),
      NOW,
    );

    expect(rows.domains[1]?.percent).toBe(67);
    expect(rows.tasks.find((row) => row.id === '2.1')?.percent).toBe(67);
  });

  test('AC-7: needsWork is false at raw exactly 0.72 and true just below', () => {
    const view = dashboardView(
      bank(),
      progressOf([attempt()], {
        'd2-2.1-0004': stats(25, 18), // 0.72 exactly
        'd3-3.5-0005': stats(1000, 719), // 0.719
      }),
      NOW,
    );

    expect(view.domains[1]).toMatchObject({ raw: 0.72, needsWork: false });
    expect(view.tasks.find((row) => row.id === '2.1')).toMatchObject({
      raw: 0.72,
      needsWork: false,
    });
    expect(view.domains[2]).toMatchObject({ raw: 0.719, needsWork: true });
    expect(view.tasks.find((row) => row.id === '3.5')).toMatchObject({
      raw: 0.719,
      needsWork: true,
    });
  });

  test('AC-7: needsWork is false when nothing was answered and when everything was right', () => {
    const view = dashboardView(
      bank(),
      progressOf([attempt()], { 'd2-2.1-0004': stats(4, 4) }),
      NOW,
    );

    expect(view.domains[0]).toMatchObject({ raw: null, needsWork: false });
    expect(view.domains[1]).toMatchObject({ raw: 1, percent: 100, needsWork: false });
  });

  test('AC-7: leitner is the leitnerSummary of the bank, the progress and now', () => {
    const view = dashboardView(bank(), progress(), NOW);

    expect(view.leitner).toEqual(leitnerSummary(bank(), progress(), NOW));
    expect(view.leitner.boxes[1]).toBe(1);
    expect(view.leitner.boxes[2]).toBe(1);
    expect(view.leitner.due).toBe(1);
    expect(view.leitner.nextDueAt).toBe(NOW + DAY);
  });
});
