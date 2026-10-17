import type { DomainId, Progress, Question, QuestionStats, TaskId } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { deepFreeze, makeBank, makeQuestion } from './__mocks__/questions.ts';
import type { QuestionSpec } from './__mocks__/questions.ts';
import { buildPracticeExam, listServices, practicePool } from './pools.ts';
import type { PoolFilter } from './pools.ts';
import { startSession } from './session.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------

const DOMAIN_IDS = [1, 2, 3, 4] as const;
const NO_PROGRESS: Progress = { version: 1, attempts: [], questions: {} };

/**
 * A question with explicit services (the factory always names ec2). The domain and the task come
 * from the id (`d<domain>-<task>-<4 digits>`), as the question schema requires.
 */
function q(spec: QuestionSpec & { id: string }, services: string[]): Question {
  const [prefix, task] = spec.id.split('-');
  const domain = Number(prefix?.slice(1)) as DomainId;
  return { ...makeQuestion({ domain, task: task as TaskId, ...spec }), services };
}

function idsOf(questions: readonly Question[]): string[] {
  return questions.map((question) => question.id);
}

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

/** The bank, with its ids in DESCENDING order (reverse of the order a sorted pool must have). */
function descending(questions: readonly Question[]): Question[] {
  return [...questions].sort((a, b) => (a.id < b.id ? 1 : -1));
}

/**
 * Nine questions: reviewed ones in all four domains, plus a draft and a verified one that match
 * the same domain, task and service as reviewed ones.
 */
function catalogBank(): Question[] {
  return descending([
    q({ id: 'd1-1.1-0001' }, ['s3']),
    q({ id: 'd1-1.1-0002' }, ['s3', 'kms']),
    q({ id: 'd1-1.2-0003' }, ['kms']),
    q({ id: 'd2-2.1-0004' }, ['s3']),
    q({ id: 'd2-2.2-0005' }, ['ec2']),
    q({ id: 'd1-1.1-0006', status: 'draft' }, ['s3']),
    q({ id: 'd1-1.1-0007', status: 'verified' }, ['s3']),
    q({ id: 'd3-3.1-0008' }, ['s3', 'ec2']),
    q({ id: 'd4-4.1-0009' }, ['s3-glacier']),
  ]);
}

// ---------------------------------------------------------------------------------------------
// practicePool
// ---------------------------------------------------------------------------------------------

describe('practicePool: domain, task and service', () => {
  test.each([
    [1, ['d1-1.1-0001', 'd1-1.1-0002', 'd1-1.2-0003']],
    [2, ['d2-2.1-0004', 'd2-2.2-0005']],
    [3, ['d3-3.1-0008']],
    [4, ['d4-4.1-0009']],
  ] as const)('AC-21: domain %i gives its reviewed questions sorted by id', (domain, expected) => {
    const bank = catalogBank();
    // The bank is in descending order: a pool in bank order would be reversed.
    expect(idsOf(bank)).toEqual([...idsOf(bank)].sort().reverse());
    expect(idsOf(practicePool(bank, NO_PROGRESS, { kind: 'domain', domain }))).toEqual(expected);
  });

  test.each([
    ['1.1', ['d1-1.1-0001', 'd1-1.1-0002']],
    ['1.2', ['d1-1.2-0003']],
    ['2.1', ['d2-2.1-0004']],
    ['3.1', ['d3-3.1-0008']],
    ['3.2', []],
  ] as const)('AC-21: task %s gives its reviewed questions sorted by id', (task, expected) => {
    expect(idsOf(practicePool(catalogBank(), NO_PROGRESS, { kind: 'task', task }))).toEqual(
      expected,
    );
  });

  test.each([
    ['s3', ['d1-1.1-0001', 'd1-1.1-0002', 'd2-2.1-0004', 'd3-3.1-0008']],
    ['kms', ['d1-1.1-0002', 'd1-1.2-0003']],
    ['ec2', ['d2-2.2-0005', 'd3-3.1-0008']],
    ['s3-glacier', ['d4-4.1-0009']],
  ] as const)(
    'AC-21: service %s gives the reviewed questions that name it, sorted by id',
    (service, expected) => {
      expect(idsOf(practicePool(catalogBank(), NO_PROGRESS, { kind: 'service', service }))).toEqual(
        expected,
      );
    },
  );

  test('AC-21: a service named by no question gives an empty pool', () => {
    expect(practicePool(catalogBank(), NO_PROGRESS, { kind: 'service', service: 'iam' })).toEqual(
      [],
    );
  });

  test('AC-21: draft and verified questions are never returned', () => {
    const bank = catalogBank();
    const filters: PoolFilter[] = [
      { kind: 'domain', domain: 1 },
      { kind: 'task', task: '1.1' },
      { kind: 'service', service: 's3' },
    ];
    for (const filter of filters) {
      const pool = practicePool(bank, NO_PROGRESS, filter);
      expect(pool.every((question) => question.status === 'reviewed')).toBe(true);
      expect(idsOf(pool)).not.toContain('d1-1.1-0006');
      expect(idsOf(pool)).not.toContain('d1-1.1-0007');
    }
  });

  test('AC-21: the pool holds the bank question objects and the bank is not reordered', () => {
    const bank = catalogBank();
    const order = idsOf(bank);
    const pool = practicePool(bank, NO_PROGRESS, { kind: 'domain', domain: 1 });
    for (const question of pool) expect(bank).toContain(question);
    expect(pool[0]).toBe(bank.find((question) => question.id === 'd1-1.1-0001'));
    expect(idsOf(bank)).toEqual(order);
  });

  test('AC-21: an ascending bank and a descending bank give the same pool', () => {
    const bank = catalogBank();
    const filter: PoolFilter = { kind: 'service', service: 's3' };
    const forward = practicePool([...bank].reverse(), NO_PROGRESS, filter);
    expect(idsOf(practicePool(bank, NO_PROGRESS, filter))).toEqual(idsOf(forward));
  });

  test('AC-21: an empty bank gives an empty pool for every kind', () => {
    expect(practicePool([], NO_PROGRESS, { kind: 'domain', domain: 1 })).toEqual([]);
    expect(practicePool([], NO_PROGRESS, { kind: 'task', task: '1.1' })).toEqual([]);
    expect(practicePool([], NO_PROGRESS, { kind: 'service', service: 's3' })).toEqual([]);
    expect(practicePool([], NO_PROGRESS, { kind: 'weak', now: 0 })).toEqual([]);
  });

  test('AC-21: practicePool does not change a deep-frozen bank', () => {
    const bank = deepFreeze(catalogBank());
    expect(() => practicePool(bank, NO_PROGRESS, { kind: 'service', service: 's3' })).not.toThrow();
  });
});

describe('practicePool: weak spots', () => {
  /**
   * D (0002) box 5 due 50, A (0005) box 1 due 100, B (0003) box 2 due 101, C (0004) box 0,
   * E (0006) no stats, a draft (0007) and a verified question (0008) in boxes 1 and 3 due at 0,
   * and an id that is not in the bank. The stats list A before D on purpose.
   */
  function weakFixture() {
    const bank = descending([
      makeQuestion({ id: 'd1-1.1-0002' }),
      makeQuestion({ id: 'd1-1.1-0003' }),
      makeQuestion({ id: 'd1-1.1-0004' }),
      makeQuestion({ id: 'd1-1.1-0005' }),
      makeQuestion({ id: 'd1-1.1-0006' }),
      makeQuestion({ id: 'd1-1.1-0007', status: 'draft' }),
      makeQuestion({ id: 'd1-1.1-0008', status: 'verified' }),
    ]);
    const progress: Progress = {
      version: 1,
      attempts: [],
      questions: {
        'd1-1.1-0005': stat(1, 100),
        'd1-1.1-0002': stat(5, 50),
        'd1-1.1-0003': stat(2, 101),
        'd1-1.1-0004': stat(0, null),
        'd1-1.1-0007': stat(1, 0),
        'd1-1.1-0008': stat(3, 0),
        'd1-1.1-0099': stat(1, 0),
      },
    };
    return { bank, progress };
  }

  const weak = (now: number): PoolFilter => ({ kind: 'weak', now });

  test('AC-22: the pool holds the due boxed questions, sorted by id', () => {
    const { bank, progress } = weakFixture();
    expect(idsOf(practicePool(bank, progress, weak(100)))).toEqual(['d1-1.1-0002', 'd1-1.1-0005']);
  });

  test('AC-22: a question is in the pool at now = dueAt and not at dueAt - 1', () => {
    const { bank, progress } = weakFixture();
    expect(idsOf(practicePool(bank, progress, weak(100)))).toContain('d1-1.1-0005');
    expect(idsOf(practicePool(bank, progress, weak(99)))).not.toContain('d1-1.1-0005');
    expect(idsOf(practicePool(bank, progress, weak(99)))).toEqual(['d1-1.1-0002']);
  });

  test('AC-22: a question due later joins the pool once its time comes', () => {
    const { bank, progress } = weakFixture();
    expect(idsOf(practicePool(bank, progress, weak(101)))).toEqual([
      'd1-1.1-0002',
      'd1-1.1-0003',
      'd1-1.1-0005',
    ]);
  });

  test('AC-22: nothing is due before the first dueAt', () => {
    const { bank, progress } = weakFixture();
    expect(practicePool(bank, progress, weak(49))).toEqual([]);
  });

  test('AC-22: box 0, no stats, drafts, verified questions and unknown ids are never in the pool', () => {
    const { bank, progress } = weakFixture();
    const pool = idsOf(practicePool(bank, progress, weak(1_000_000)));
    expect(pool).toEqual(['d1-1.1-0002', 'd1-1.1-0003', 'd1-1.1-0005']);
    expect(pool).not.toContain('d1-1.1-0004');
    expect(pool).not.toContain('d1-1.1-0006');
    expect(pool).not.toContain('d1-1.1-0007');
    expect(pool).not.toContain('d1-1.1-0008');
    expect(pool).not.toContain('d1-1.1-0099');
  });

  test('AC-22: every box from 1 to 5 counts, box 0 does not', () => {
    const bank = descending([0, 1, 2, 3, 4, 5].map((n) => makeQuestion({ id: `d1-1.1-000${n}` })));
    const questions: Record<string, QuestionStats> = {};
    for (const n of [0, 1, 2, 3, 4, 5] as const) questions[`d1-1.1-000${n}`] = stat(n, 0);
    const pool = practicePool(bank, { version: 1, attempts: [], questions }, weak(0));
    expect(idsOf(pool)).toEqual([
      'd1-1.1-0001',
      'd1-1.1-0002',
      'd1-1.1-0003',
      'd1-1.1-0004',
      'd1-1.1-0005',
    ]);
  });

  test('AC-22: the pool holds the bank question objects', () => {
    const { bank, progress } = weakFixture();
    for (const question of practicePool(bank, progress, weak(100))) {
      expect(bank).toContain(question);
    }
  });

  test('AC-22: a progress with no stats gives an empty weak pool', () => {
    expect(practicePool(weakFixture().bank, NO_PROGRESS, weak(1_000_000))).toEqual([]);
  });
});

describe('practicePool: invalid filters', () => {
  const bank = catalogBank();

  test.each([
    ['domain 5', { kind: 'domain', domain: 5 }],
    ['domain 0', { kind: 'domain', domain: 0 }],
    ['task "5.1"', { kind: 'task', task: '5.1' }],
    ['task "1.4"', { kind: 'task', task: '1.4' }],
    ['an empty service', { kind: 'service', service: '' }],
    ['now NaN', { kind: 'weak', now: Number.NaN }],
    ['now Infinity', { kind: 'weak', now: Number.POSITIVE_INFINITY }],
    ['now -Infinity', { kind: 'weak', now: Number.NEGATIVE_INFINITY }],
  ])('AC-23: %s throws RangeError', (_name, filter) => {
    expect(() => practicePool(bank, NO_PROGRESS, filter as unknown as PoolFilter)).toThrow(
      RangeError,
    );
  });

  test('AC-23: an invalid filter throws even when the bank is empty', () => {
    expect(() => practicePool([], NO_PROGRESS, { kind: 'domain', domain: 5 as DomainId })).toThrow(
      RangeError,
    );
    expect(() => practicePool([], NO_PROGRESS, { kind: 'weak', now: Number.NaN })).toThrow(
      RangeError,
    );
  });

  test('AC-23: valid filters at the edges do not throw', () => {
    expect(() => practicePool(bank, NO_PROGRESS, { kind: 'domain', domain: 4 })).not.toThrow();
    expect(() => practicePool(bank, NO_PROGRESS, { kind: 'task', task: '4.4' })).not.toThrow();
    expect(() => practicePool(bank, NO_PROGRESS, { kind: 'weak', now: 0 })).not.toThrow();
    expect(() => practicePool(bank, NO_PROGRESS, { kind: 'weak', now: -5 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// listServices
// ---------------------------------------------------------------------------------------------

describe('listServices', () => {
  test('AC-24: counts the reviewed questions per service, sorted by service name', () => {
    const bank = descending([
      q({ id: 'd1-1.1-0001' }, ['s3', 'kms']),
      q({ id: 'd1-1.1-0002' }, ['s3', 'kms']),
      q({ id: 'd1-1.2-0003' }, ['s3']),
      q({ id: 'd2-2.1-0004' }, ['ec2']),
      q({ id: 'd2-2.1-0005', status: 'draft' }, ['iam']),
    ]);
    expect(listServices(bank)).toEqual([
      { service: 'ec2', count: 1 },
      { service: 'kms', count: 2 },
      { service: 's3', count: 3 },
    ]);
  });

  test('AC-24: a service named only by a draft or a verified question is not listed', () => {
    const bank = [
      q({ id: 'd1-1.1-0001' }, ['s3']),
      q({ id: 'd1-1.1-0002', status: 'draft' }, ['iam']),
      q({ id: 'd1-1.1-0003', status: 'verified' }, ['sqs', 's3']),
    ];
    expect(listServices(bank)).toEqual([{ service: 's3', count: 1 }]);
  });

  test('AC-24: the order is by name, not by count', () => {
    // a has 1 question, m has 3, z has 2: by name a, m, z; by count (either way) it would differ.
    const bank = [
      q({ id: 'd1-1.1-0001' }, ['m', 'a']),
      q({ id: 'd1-1.1-0002' }, ['z', 'm']),
      q({ id: 'd1-1.1-0003' }, ['m', 'z']),
    ];
    expect(listServices(bank)).toEqual([
      { service: 'a', count: 1 },
      { service: 'm', count: 3 },
      { service: 'z', count: 2 },
    ]);
  });

  test('AC-24: a service that is the prefix of another is a separate entry', () => {
    const bank = [q({ id: 'd1-1.1-0001' }, ['s3']), q({ id: 'd1-1.1-0002' }, ['s3-glacier'])];
    expect(listServices(bank)).toEqual([
      { service: 's3', count: 1 },
      { service: 's3-glacier', count: 1 },
    ]);
  });

  test('AC-24: an empty bank gives an empty list', () => {
    expect(listServices([])).toEqual([]);
  });

  test('AC-24: listServices does not change a deep-frozen bank', () => {
    const bank = deepFreeze(catalogBank());
    expect(() => listServices(bank)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// buildPracticeExam
// ---------------------------------------------------------------------------------------------

/** 12 reviewed questions: 4 / 3 / 3 / 2 in domains 1 to 4. */
function pool12(): Question[] {
  return makeBank({ 1: 4, 2: 3, 3: 3, 4: 2 });
}

function domainCount(questions: readonly Question[], domain: DomainId): number {
  return questions.filter((question) => question.domain === domain).length;
}

describe('buildPracticeExam: size and plan', () => {
  test('AC-25: size 5 from a pool of 12 gives 5 distinct questions of the pool', () => {
    const pool = pool12();
    const exam = buildPracticeExam(pool, { seed: 1, size: 5 });
    expect(exam.items).toHaveLength(5);
    expect(exam.size).toBe(5);
    expect(exam.seed).toBe(1);
    expect(exam.complete).toBe(true);
    expect(new Set(idsOf(exam.items.map((item) => item.question))).size).toBe(5);
    for (const item of exam.items) expect(pool).toContain(item.question);
  });

  test('AC-25: per domain, picked is the item count, quota equals picked, available the pool count', () => {
    const pool = pool12();
    const exam = buildPracticeExam(pool, { seed: 1, size: 5 });
    const items = exam.items.map((item) => item.question);
    for (const domain of DOMAIN_IDS) {
      const picked = domainCount(items, domain);
      expect(exam.byDomain[domain]).toEqual({
        quota: picked,
        available: domainCount(pool, domain),
        picked,
        short: 0,
      });
    }
    expect(Object.keys(exam.byDomain).sort()).toEqual(['1', '2', '3', '4']);
  });

  test('AC-25: a size above the pool gives every question and complete false', () => {
    const pool = pool12();
    const exam = buildPracticeExam(pool, { seed: 1, size: 20 });
    expect(exam.items).toHaveLength(12);
    expect(exam.size).toBe(20);
    expect(exam.complete).toBe(false);
    expect(idsOf(exam.items.map((item) => item.question)).sort()).toEqual(idsOf(pool).sort());
  });

  test('AC-25: with size 20, picked equals available, quota equals picked and short is 0', () => {
    const pool = pool12();
    const exam = buildPracticeExam(pool, { seed: 1, size: 20 });
    for (const domain of DOMAIN_IDS) {
      const count = domainCount(pool, domain);
      expect(exam.byDomain[domain]).toEqual({
        quota: count,
        available: count,
        picked: count,
        short: 0,
      });
    }
  });

  test('AC-25: a size equal to the pool is complete', () => {
    const exam = buildPracticeExam(pool12(), { seed: 3, size: 12 });
    expect(exam.items).toHaveLength(12);
    expect(exam.complete).toBe(true);
  });

  test('AC-25: size 1 gives one item', () => {
    const exam = buildPracticeExam(pool12(), { seed: 3, size: 1 });
    expect(exam.items).toHaveLength(1);
    expect(exam.complete).toBe(true);
  });

  test('AC-25: the picks are not tied to the domain weights (a one-domain pool fills the size)', () => {
    const pool = makeBank({ 4: 10 });
    const exam = buildPracticeExam(pool, { seed: 5, size: 8 });
    expect(exam.items).toHaveLength(8);
    expect(exam.complete).toBe(true);
    expect(exam.byDomain[4]).toEqual({ quota: 8, available: 10, picked: 8, short: 0 });
    expect(exam.byDomain[1]).toEqual({ quota: 0, available: 0, picked: 0, short: 0 });
  });
});

describe('buildPracticeExam: determinism and drafts', () => {
  test('AC-26: the same pool and options give a deep-equal exam', () => {
    const pool = pool12();
    const first = buildPracticeExam(pool, { seed: 7, size: 8 });
    const second = buildPracticeExam(pool, { seed: 7, size: 8 });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  test('AC-26: the same pool reversed, or rotated, gives the same exam', () => {
    const pool = pool12();
    const exam = buildPracticeExam(pool, { seed: 7, size: 8 });
    const reversed = buildPracticeExam([...pool].reverse(), { seed: 7, size: 8 });
    const rotated = buildPracticeExam([...pool.slice(5), ...pool.slice(0, 5)], {
      seed: 7,
      size: 8,
    });
    expect(reversed).toEqual(exam);
    expect(rotated).toEqual(exam);
    expect(idsOf(reversed.items.map((item) => item.question))).toEqual(
      idsOf(exam.items.map((item) => item.question)),
    );
  });

  test('AC-26: seeds 1 and 2 give a different item order', () => {
    const pool = pool12();
    const one = idsOf(buildPracticeExam(pool, { seed: 1, size: 12 }).items.map((i) => i.question));
    const two = idsOf(buildPracticeExam(pool, { seed: 2, size: 12 }).items.map((i) => i.question));
    expect(two).not.toEqual(one);
    expect([...two].sort()).toEqual([...one].sort());
  });

  test('AC-26: draft and verified questions in the pool are never picked or counted', () => {
    const reviewed = makeBank({ 1: 3, 2: 3 });
    const others = [
      ...makeBank({ 1: 3, 3: 2 }, () => ({ status: 'draft' })),
      ...makeBank({ 2: 2 }, () => ({ status: 'verified' })),
    ];
    const pool = [...others, ...reviewed];
    for (const seed of [0, 1, 2, 3]) {
      const exam = buildPracticeExam(pool, { seed, size: 20 });
      expect(exam.items).toHaveLength(6);
      expect(exam.complete).toBe(false);
      expect(exam.items.every((item) => item.question.status === 'reviewed')).toBe(true);
      expect(exam.byDomain[1].available).toBe(3);
      expect(exam.byDomain[2].available).toBe(3);
      expect(exam.byDomain[3]).toEqual({ quota: 0, available: 0, picked: 0, short: 0 });
    }
  });

  test('AC-26: a pool without reviewed questions gives an empty exam', () => {
    const exam = buildPracticeExam(
      makeBank({ 1: 3 }, () => ({ status: 'draft' })),
      {
        seed: 1,
        size: 3,
      },
    );
    expect(exam.items).toHaveLength(0);
    expect(exam.complete).toBe(false);
  });

  test('AC-26: startSession accepts the result in both modes', () => {
    const exam = buildPracticeExam(pool12(), { seed: 11, size: 6 });
    for (const mode of ['exam', 'practice'] as const) {
      const session = startSession(exam, { mode, now: 1_000 });
      expect(session.exam).toBe(exam);
      expect(session.status).toBe('active');
      expect(session.deadline === null).toBe(mode === 'practice');
    }
  });
});

describe('buildPracticeExam: sampling and options', () => {
  test('AC-27: sampling is uniform: 3 of 10 over seeds 0-999, each question 210 to 390 times', () => {
    const pool = makeBank({ 1: 10 });
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 1_000; seed += 1) {
      for (const item of buildPracticeExam(pool, { seed, size: 3 }).items) {
        counts.set(item.question.id, (counts.get(item.question.id) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(10);
    for (const question of pool) {
      const count = counts.get(question.id) ?? 0;
      expect(count, question.id).toBeGreaterThanOrEqual(210);
      expect(count, question.id).toBeLessThanOrEqual(390);
    }
  });

  test('AC-27: the items come in random order, not sorted by id', () => {
    const pool = makeBank({ 1: 10 });
    const orders = new Set<string>();
    let sorted = 0;
    for (let seed = 0; seed < 50; seed += 1) {
      const ids = idsOf(buildPracticeExam(pool, { seed, size: 10 }).items.map((i) => i.question));
      orders.add(ids.join());
      if (ids.join() === [...ids].sort().join()) sorted += 1;
    }
    expect(orders.size).toBeGreaterThan(40);
    expect(sorted).toBeLessThanOrEqual(1);
  });

  test('AC-27: every optionOrder is a permutation of its question keys', () => {
    const pool = makeBank({ 1: 4, 2: 4 }, (_domain, index) => ({
      type: index % 2 === 0 ? 'single' : 'multiple',
    }));
    for (let seed = 0; seed < 30; seed += 1) {
      for (const item of buildPracticeExam(pool, { seed, size: 8 }).items) {
        const keys = item.question.options.map((option) => option.key);
        expect([...item.optionOrder].sort()).toEqual(keys);
      }
    }
  });

  test('AC-27: options are shuffled by default (not always the original order)', () => {
    const pool = makeBank({ 1: 5 });
    let shuffled = 0;
    for (let seed = 0; seed < 30; seed += 1) {
      for (const item of buildPracticeExam(pool, { seed, size: 5 }).items) {
        const keys = item.question.options.map((option) => option.key);
        if (item.optionOrder.join() !== keys.join()) shuffled += 1;
      }
    }
    expect(shuffled).toBeGreaterThan(100);
  });

  test('AC-27: shuffleOptions defaults to true', () => {
    const pool = pool12();
    expect(buildPracticeExam(pool, { seed: 4, size: 6 })).toEqual(
      buildPracticeExam(pool, { seed: 4, size: 6, shuffleOptions: true }),
    );
  });

  test('AC-27: shuffleOptions false keeps the original option order', () => {
    const pool = pool12();
    for (let seed = 0; seed < 10; seed += 1) {
      for (const item of buildPracticeExam(pool, { seed, size: 12, shuffleOptions: false }).items) {
        expect(item.optionOrder).toEqual(item.question.options.map((option) => option.key));
      }
    }
  });
});

describe('buildPracticeExam: invalid input and purity', () => {
  const pool = pool12();

  test.each([
    ['seed -1', { seed: -1, size: 5 }],
    ['seed 1.5', { seed: 1.5, size: 5 }],
    ['seed 2 ** 32', { seed: 2 ** 32, size: 5 }],
    ['seed NaN', { seed: Number.NaN, size: 5 }],
    ['size 0', { seed: 1, size: 0 }],
    ['size 2.5', { seed: 1, size: 2.5 }],
    ['size 10,001', { seed: 1, size: 10_001 }],
    ['size NaN', { seed: 1, size: Number.NaN }],
    ['size -3', { seed: 1, size: -3 }],
  ])('AC-28: %s throws RangeError', (_name, options) => {
    expect(() => buildPracticeExam(pool, options)).toThrow(RangeError);
  });

  test('AC-28: bad options throw RangeError even for an empty pool', () => {
    expect(() => buildPracticeExam([], { seed: -1, size: 5 })).toThrow(RangeError);
    expect(() => buildPracticeExam([], { seed: 1, size: 0 })).toThrow(RangeError);
  });

  test('AC-28: the edge values seed 0, seed 2 ** 32 - 1, size 1 and size 10,000 are valid', () => {
    expect(() => buildPracticeExam(pool, { seed: 0, size: 1 })).not.toThrow();
    expect(() => buildPracticeExam(pool, { seed: 2 ** 32 - 1, size: 10_000 })).not.toThrow();
    expect(buildPracticeExam(pool, { seed: 0, size: 10_000 }).items).toHaveLength(12);
  });

  test('AC-28: two questions with the same id throw an Error that names the id', () => {
    const duplicated = [
      makeQuestion({ id: 'd1-1.1-0042' }),
      makeQuestion({ id: 'd2-2.1-0043' }),
      makeQuestion({ id: 'd1-1.1-0042' }),
    ];
    expect(() => buildPracticeExam(duplicated, { seed: 1, size: 2 })).toThrow(Error);
    expect(() => buildPracticeExam(duplicated, { seed: 1, size: 2 })).toThrow('d1-1.1-0042');
  });

  test('AC-28: a frozen pool of frozen questions works and stays as it was', () => {
    const frozen = deepFreeze(makeBank({ 1: 3, 2: 3 }));
    const snapshot = structuredClone(frozen);
    const exam = buildPracticeExam(frozen, { seed: 9, size: 4 });
    expect(exam.items).toHaveLength(4);
    expect(frozen).toEqual(snapshot);
  });

  test('AC-28: each item question is the pool object, not a copy', () => {
    const exam = buildPracticeExam(pool, { seed: 2, size: 12 });
    for (const item of exam.items) {
      expect(pool.some((question) => question === item.question)).toBe(true);
    }
  });

  test('AC-28: the pool order is not changed', () => {
    const own = pool12();
    const order = idsOf(own);
    buildPracticeExam(own, { seed: 5, size: 6 });
    expect(idsOf(own)).toEqual(order);
  });

  test('AC-28: an empty pool gives 0 items, complete false and zeros per domain', () => {
    expect(buildPracticeExam([], { seed: 4, size: 5 })).toEqual({
      seed: 4,
      size: 5,
      items: [],
      complete: false,
      byDomain: {
        1: { quota: 0, available: 0, picked: 0, short: 0 },
        2: { quota: 0, available: 0, picked: 0, short: 0 },
        3: { quota: 0, available: 0, picked: 0, short: 0 },
        4: { quota: 0, available: 0, picked: 0, short: 0 },
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Review round 1 (gaps): AC-40
// ---------------------------------------------------------------------------------------------

describe('buildPracticeExam: tighter sampling bound', () => {
  test('AC-40: 3 of 10 over seeds 0-999, each question is picked 255 to 345 times', () => {
    const pool = makeBank({ 1: 10 });
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 1_000; seed += 1) {
      for (const item of buildPracticeExam(pool, { seed, size: 3 }).items) {
        counts.set(item.question.id, (counts.get(item.question.id) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(10);
    for (const question of pool) {
      const count = counts.get(question.id) ?? 0;
      expect(count, question.id).toBeGreaterThanOrEqual(255);
      expect(count, question.id).toBeLessThanOrEqual(345);
    }
  });
});
