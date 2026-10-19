// Spec 028 (AC-5, AC-6): what the Practice card offers, set sizes and pool labels.
import { emptyProgress, leitnerSummary, listServices, practicePool } from '@field-guide/quiz-core';
import { domains, tasks } from '@field-guide/schema';
import type { DomainId, Progress, Question, QuestionStats, TaskId } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { makeQuestion } from '../../../../packages/quiz-core/src/__mocks__/questions.ts';
import { SET_SIZES, poolLabel, practiceChoices, setSize } from './setup.ts';

const NOW = 5_000_000_000;
const DAY = 86_400_000;

/** Computes on first use, so a throwing implementation fails the tests, not the collection. */
function lazy<T>(make: () => T): () => T {
  let value: { made: T } | undefined;
  return () => {
    value ??= { made: make() };
    return value.made;
  };
}

function q(id: string, services: string[], status: Question['status'] = 'reviewed'): Question {
  const domain = Number(id.charAt(1)) as DomainId;
  const task = id.slice(3, 6) as TaskId;
  return { ...makeQuestion({ id, domain, task, status }), services };
}

/**
 * Domain 1: tasks 1.1 (2 reviewed + 1 draft), 1.3 (1 reviewed + 1 verified). Domain 2: task 2.1 (1).
 * Domain 3: task 3.5 (1). Domain 4: only a draft, so no reviewed question. Most tasks have none.
 */
const bank = lazy((): Question[] => [
  q('d1-1.1-0001', ['s3', 'kms']),
  q('d1-1.1-0002', ['s3']),
  q('d1-1.1-0003', ['s3', 'only-in-a-draft'], 'draft'),
  q('d1-1.3-0004', ['kms']),
  q('d1-1.3-0005', ['kms', 'only-verified'], 'verified'),
  q('d2-2.1-0006', ['sqs']),
  q('d3-3.5-0007', ['ec2', 'sqs']),
  q('d4-4.1-0008', ['s3'], 'draft'),
]);

function stats(overrides: Partial<QuestionStats>): QuestionStats {
  return {
    answered: 1,
    correct: 0,
    lastAnsweredAt: NOW - DAY,
    box: 1,
    dueAt: NOW - 1,
    ...overrides,
  };
}

function progressWith(questions: Record<string, QuestionStats>): Progress {
  return { ...emptyProgress(), questions };
}

describe('practiceChoices', () => {
  test('AC-5: domains lists the four domains in order with their catalog titles', () => {
    const { domains: listed } = practiceChoices(bank(), emptyProgress(), NOW);

    expect(listed.map(({ id, title }) => ({ id, title }))).toEqual(
      domains.map(({ id, title }) => ({ id, title })),
    );
  });

  test('AC-5: the count of every domain equals the size of its practice pool', () => {
    const { domains: listed } = practiceChoices(bank(), emptyProgress(), NOW);

    expect(listed.map(({ count }) => count)).toEqual([3, 1, 1, 0]);
    for (const { id, count } of listed) {
      const pool = practicePool(bank(), emptyProgress(), { kind: 'domain', domain: id });
      expect(count, `domain ${String(id)}`).toBe(pool.length);
    }
  });

  test('AC-5: tasks lists the 14 tasks in catalog order with their titles', () => {
    const { tasks: listed } = practiceChoices(bank(), emptyProgress(), NOW);

    expect(listed).toHaveLength(14);
    expect(listed.map(({ id, title }) => ({ id, title }))).toEqual(
      tasks.map(({ id, title }) => ({ id, title })),
    );
  });

  test('AC-5: the count of every task equals the size of its practice pool', () => {
    const { tasks: listed } = practiceChoices(bank(), emptyProgress(), NOW);

    for (const { id, count } of listed) {
      const pool = practicePool(bank(), emptyProgress(), { kind: 'task', task: id });
      expect(count, `task ${id}`).toBe(pool.length);
    }
  });

  test('AC-5: tasks with no question are kept with count 0', () => {
    const { tasks: listed } = practiceChoices(bank(), emptyProgress(), NOW);
    const counts = Object.fromEntries(listed.map(({ id, count }) => [id, count]));

    expect(counts['1.2']).toBe(0);
    expect(counts['4.1']).toBe(0);
    expect(listed.filter(({ count }) => count === 0)).toHaveLength(10);
    expect(counts['1.1']).toBe(2);
    expect(counts['1.3']).toBe(1);
    expect(counts['2.1']).toBe(1);
    expect(counts['3.5']).toBe(1);
  });

  test('AC-5: questions that are not reviewed are not counted', () => {
    const choices = practiceChoices(bank(), emptyProgress(), NOW);

    // 1.1 holds two reviewed and one draft; 1.3 one reviewed and one verified; 4.1 only a draft.
    expect(choices.domains.find(({ id }) => id === 1)?.count).toBe(3);
    expect(choices.tasks.find(({ id }) => id === '4.1')?.count).toBe(0);
    expect(choices.domains.find(({ id }) => id === 4)?.count).toBe(0);
  });

  test('AC-5: services are those of listServices, with the same counts, and ignore drafts', () => {
    const { services } = practiceChoices(bank(), emptyProgress(), NOW);

    expect(services).toEqual(listServices(bank()));
    expect(services).toEqual([
      { service: 'ec2', count: 1 },
      { service: 'kms', count: 2 },
      { service: 's3', count: 2 },
      { service: 'sqs', count: 2 },
    ]);
  });

  test('AC-5: the count of every service equals the size of its practice pool', () => {
    const { services } = practiceChoices(bank(), emptyProgress(), NOW);

    for (const { service, count } of services) {
      const pool = practicePool(bank(), emptyProgress(), { kind: 'service', service });
      expect(count, service).toBe(pool.length);
    }
  });

  test('AC-5: weak is all zero and null on fresh progress', () => {
    expect(practiceChoices(bank(), emptyProgress(), NOW).weak).toEqual({
      due: 0,
      inBoxes: 0,
      nextDueAt: null,
    });
  });

  test('AC-5: weak counts the due questions, those in boxes 1 to 5 and the next due time', () => {
    const progress = progressWith({
      'd1-1.1-0001': stats({ box: 1, dueAt: NOW - 10 }),
      'd1-1.1-0002': stats({ box: 3, dueAt: NOW + 3 * DAY }),
      'd2-2.1-0006': stats({ box: 2, dueAt: NOW + DAY }),
      'd3-3.5-0007': stats({ box: 0, dueAt: null, correct: 1 }),
    });

    expect(practiceChoices(bank(), progress, NOW).weak).toEqual({
      due: 1,
      inBoxes: 3,
      nextDueAt: NOW + DAY,
    });
  });

  test('AC-5: weak matches leitnerSummary, and inBoxes is the sum of boxes 1 to 5', () => {
    const progress = progressWith({
      'd1-1.1-0001': stats({ box: 5, dueAt: NOW + 14 * DAY }),
      'd1-1.1-0002': stats({ box: 4, dueAt: NOW - 1 }),
      'd1-1.3-0004': stats({ box: 1, dueAt: NOW }),
      'd2-2.1-0006': stats({ box: 1, dueAt: NOW + 5 }),
    });
    const summary = leitnerSummary(bank(), progress, NOW);

    const { weak } = practiceChoices(bank(), progress, NOW);

    expect(weak.due).toBe(summary.due);
    expect(weak.nextDueAt).toBe(summary.nextDueAt);
    expect(weak.inBoxes).toBe(Object.values(summary.boxes).reduce((sum, n) => sum + n, 0));
    expect(weak.inBoxes).toBe(4);
  });

  test('AC-5: the weak count follows the time given', () => {
    const progress = progressWith({ 'd1-1.1-0001': stats({ box: 2, dueAt: NOW + DAY }) });

    expect(practiceChoices(bank(), progress, NOW).weak.due).toBe(0);
    expect(practiceChoices(bank(), progress, NOW + DAY).weak.due).toBe(1);
  });

  test('AC-5: stats of a question that is not reviewed or not in the bank are ignored', () => {
    const progress = progressWith({
      'd1-1.1-0003': stats({ box: 1 }), // a draft
      'd9-9.9-9999': stats({ box: 1 }), // not in the bank
    });

    expect(practiceChoices(bank(), progress, NOW).weak).toEqual({
      due: 0,
      inBoxes: 0,
      nextDueAt: null,
    });
  });

  test('AC-5: an empty bank gives zero counts, no services and 4 domains and 14 tasks', () => {
    const choices = practiceChoices([], emptyProgress(), NOW);

    expect(choices.domains).toHaveLength(4);
    expect(choices.tasks).toHaveLength(14);
    expect(choices.services).toEqual([]);
    expect([...choices.domains, ...choices.tasks].every(({ count }) => count === 0)).toBe(true);
  });
});

describe('setSize and SET_SIZES', () => {
  test('AC-6: the sizes offered next to "All" are 10, 20 and 30', () => {
    expect([...SET_SIZES]).toEqual([10, 20, 30]);
  });

  test('AC-6: setSize(10, 56) is 10', () => {
    expect(setSize(10, 56)).toBe(10);
  });

  test('AC-6: setSize(30, 7) is 7: a small pool gives a smaller set', () => {
    expect(setSize(30, 7)).toBe(7);
  });

  test('AC-6: setSize("all", 56) is 56', () => {
    expect(setSize('all', 56)).toBe(56);
  });

  test('AC-6: setSize(10, 0) is 0', () => {
    expect(setSize(10, 0)).toBe(0);
  });

  test('AC-6: setSize("all", 0) is 0', () => {
    expect(setSize('all', 0)).toBe(0);
  });

  test('AC-6: a pool exactly as big as the choice gives the choice', () => {
    expect(setSize(20, 20)).toBe(20);
    expect(setSize(10, 1)).toBe(1);
  });
});

describe('poolLabel', () => {
  test('AC-6: a domain is "Domain d: <title>"', () => {
    expect(poolLabel({ kind: 'domain', domain: 2 })).toBe(
      'Domain 2: Design Resilient Architectures',
    );
  });

  test('AC-6: every domain uses its catalog title', () => {
    for (const { id, title } of domains) {
      expect(poolLabel({ kind: 'domain', domain: id })).toBe(`Domain ${String(id)}: ${title}`);
    }
  });

  test('AC-6: a task is "Task <id>: <title>" with its catalog title', () => {
    expect(poolLabel({ kind: 'task', task: '1.3' })).toBe(
      'Task 1.3: Determine appropriate data security controls',
    );
    for (const { id, title } of tasks) {
      expect(poolLabel({ kind: 'task', task: id })).toBe(`Task ${id}: ${title}`);
    }
  });

  test('AC-6: a service is "Service: <service>"', () => {
    expect(poolLabel({ kind: 'service', service: 's3' })).toBe('Service: s3');
  });

  test('AC-6: weak spots are "Weak spots", whatever the time', () => {
    expect(poolLabel({ kind: 'weak', now: 1 })).toBe('Weak spots');
    expect(poolLabel({ kind: 'weak', now: NOW })).toBe('Weak spots');
  });
});
