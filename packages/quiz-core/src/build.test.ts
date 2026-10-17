import { domains } from '@field-guide/schema';
import type { DomainId, Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { deepFreeze, makeBank, makeQuestion } from './__mocks__/questions.ts';
import { EXAM_SIZE, buildExam, domainQuotas } from './build.ts';
import type { Exam } from './build.ts';

const DOMAIN_IDS = [1, 2, 3, 4] as const;

/** 30 reviewed questions in every domain. */
function fullBank(): Question[] {
  return makeBank({ 1: 30, 2: 30, 3: 30, 4: 30 });
}

function itemsPerDomain(exam: Exam): Record<DomainId, number> {
  const counts: Record<DomainId, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const item of exam.items) counts[item.question.domain] += 1;
  return counts;
}

function ids(exam: Exam): string[] {
  return exam.items.map((item) => item.question.id);
}

describe('domainQuotas', () => {
  test('AC-14: 65 questions split 19 / 17 / 16 / 13', () => {
    expect(domainQuotas(65)).toEqual({ 1: 19, 2: 17, 3: 16, 4: 13 });
  });

  test('AC-14: 20 questions split 6 / 5 / 5 / 4', () => {
    expect(domainQuotas(20)).toEqual({ 1: 6, 2: 5, 3: 5, 4: 4 });
  });

  test('AC-14: 10 questions split 3 / 3 / 2 / 2', () => {
    expect(domainQuotas(10)).toEqual({ 1: 3, 2: 3, 3: 2, 4: 2 });
  });

  test('AC-14: 1 question goes to domain 1', () => {
    expect(domainQuotas(1)).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0 });
  });

  test('AC-14: EXAM_SIZE is 65', () => {
    expect(EXAM_SIZE).toBe(65);
  });

  test('AC-15: ties go to the lower domain id (25 -> 8 / 6 / 6 / 5)', () => {
    expect(domainQuotas(25)).toEqual({ 1: 8, 2: 6, 3: 6, 4: 5 });
  });

  test('AC-16: for sizes 1 to 300 the quotas sum to the size', () => {
    for (let size = 1; size <= 300; size += 1) {
      const quotas = domainQuotas(size);
      const sum = DOMAIN_IDS.reduce((total, id) => total + quotas[id], 0);
      expect(sum, `size ${String(size)}`).toBe(size);
    }
  });

  test('AC-16: for sizes 1 to 300 each quota is the floor or the ceiling of size x weight / 100', () => {
    for (let size = 1; size <= 300; size += 1) {
      const quotas = domainQuotas(size);
      for (const domain of domains) {
        const exact = (size * domain.weight) / 100;
        const quota = quotas[domain.id];
        expect(quota, `size ${String(size)}, domain ${String(domain.id)}`).toBeGreaterThanOrEqual(
          Math.floor(exact),
        );
        expect(quota, `size ${String(size)}, domain ${String(domain.id)}`).toBeLessThanOrEqual(
          Math.ceil(exact),
        );
      }
    }
  });

  test.each([0, -1, 2.5, NaN, Infinity])('AC-17: size %s throws RangeError', (size) => {
    expect(() => domainQuotas(size)).toThrow(RangeError);
  });
});

describe('buildExam: size and quotas', () => {
  test('AC-18: 30 reviewed questions per domain give a complete 65-question exam', () => {
    const exam = buildExam(fullBank(), { seed: 1 });
    expect(exam.seed).toBe(1);
    expect(exam.size).toBe(65);
    expect(exam.items).toHaveLength(65);
    expect(exam.complete).toBe(true);
  });

  test('AC-18: the items are split 19 / 17 / 16 / 13 and match byDomain', () => {
    const exam = buildExam(fullBank(), { seed: 1 });
    expect(itemsPerDomain(exam)).toEqual({ 1: 19, 2: 17, 3: 16, 4: 13 });
    for (const id of DOMAIN_IDS) {
      expect(exam.byDomain[id].picked).toBe(itemsPerDomain(exam)[id]);
      expect(exam.byDomain[id].available).toBe(30);
      expect(exam.byDomain[id].short).toBe(0);
    }
    expect(exam.byDomain[1].quota).toBe(19);
    expect(exam.byDomain[2].quota).toBe(17);
    expect(exam.byDomain[3].quota).toBe(16);
    expect(exam.byDomain[4].quota).toBe(13);
  });

  test('AC-18: the quotas are the ones domainQuotas(65) gives', () => {
    const exam = buildExam(fullBank(), { seed: 1 });
    const quotas = domainQuotas(65);
    for (const id of DOMAIN_IDS) expect(exam.byDomain[id].quota).toBe(quotas[id]);
  });

  test('AC-18: no question appears twice', () => {
    const exam = buildExam(fullBank(), { seed: 1 });
    expect(new Set(ids(exam)).size).toBe(65);
  });

  test('AC-18: the default size is EXAM_SIZE', () => {
    expect(buildExam(fullBank(), { seed: 9 }).size).toBe(EXAM_SIZE);
  });

  test('AC-19: a domain with too few questions is short and never borrows from the others', () => {
    const bank = makeBank({ 1: 30, 2: 30, 3: 30, 4: 5 });
    const exam = buildExam(bank, { seed: 1 });
    expect(exam.items).toHaveLength(57);
    expect(exam.complete).toBe(false);
    expect(exam.size).toBe(65);
    expect(exam.byDomain[4]).toEqual({ quota: 13, available: 5, picked: 5, short: 8 });
    expect(itemsPerDomain(exam)).toEqual({ 1: 19, 2: 17, 3: 16, 4: 5 });
    for (const id of [1, 2, 3] as const) {
      expect(exam.byDomain[id].picked).toBe(exam.byDomain[id].quota);
      expect(exam.byDomain[id].short).toBe(0);
    }
  });

  test('AC-19: a short domain contributes all of its questions', () => {
    const bank = makeBank({ 1: 30, 2: 30, 3: 30, 4: 5 });
    const exam = buildExam(bank, { seed: 3 });
    const domain4 = new Set(bank.filter((q) => q.domain === 4).map((q) => q.id));
    const picked = ids(exam).filter((id) => domain4.has(id));
    expect(new Set(picked)).toEqual(domain4);
  });

  test('AC-20: draft and verified questions are never picked or counted as available', () => {
    const reviewed = makeBank({ 1: 30, 2: 30, 3: 30, 4: 5 });
    const others = makeBank({ 1: 10, 2: 10, 3: 10, 4: 10 }, (_domain, index) => ({
      status: index % 2 === 0 ? 'draft' : 'verified',
    }));
    const bank = [...others, ...reviewed];
    for (let seed = 0; seed < 20; seed += 1) {
      const exam = buildExam(bank, { seed });
      expect(exam.items).toHaveLength(57);
      for (const item of exam.items) expect(item.question.status).toBe('reviewed');
      expect(exam.byDomain[1].available).toBe(30);
      expect(exam.byDomain[4].available).toBe(5);
      expect(exam.byDomain[4].short).toBe(8);
    }
  });

  test('AC-20: a bank with no reviewed questions gives 0 items and every domain short', () => {
    const bank = makeBank({ 1: 10, 2: 10, 3: 10, 4: 10 }, (_domain, index) => ({
      status: index % 2 === 0 ? 'draft' : 'verified',
    }));
    const exam = buildExam(bank, { seed: 1 });
    expect(exam.items).toEqual([]);
    expect(exam.complete).toBe(false);
    expect(exam.byDomain).toEqual({
      1: { quota: 19, available: 0, picked: 0, short: 19 },
      2: { quota: 17, available: 0, picked: 0, short: 17 },
      3: { quota: 16, available: 0, picked: 0, short: 16 },
      4: { quota: 13, available: 0, picked: 0, short: 13 },
    });
  });

  test('AC-20: an empty bank gives 0 items and every domain short by its whole quota', () => {
    const exam = buildExam([], { seed: 1 });
    expect(exam.items).toEqual([]);
    expect(exam.complete).toBe(false);
    expect(exam.byDomain[3]).toEqual({ quota: 16, available: 0, picked: 0, short: 16 });
  });

  test('AC-25: size 20 gives 20 items split 6 / 5 / 5 / 4', () => {
    const exam = buildExam(fullBank(), { seed: 1, size: 20 });
    expect(exam.size).toBe(20);
    expect(exam.items).toHaveLength(20);
    expect(exam.complete).toBe(true);
    expect(itemsPerDomain(exam)).toEqual({ 1: 6, 2: 5, 3: 5, 4: 4 });
    expect(exam.byDomain[1].quota).toBe(6);
    expect(exam.byDomain[4].quota).toBe(4);
  });

  test('AC-25: a size larger than the bank can fill gives a short exam', () => {
    const bank = makeBank({ 1: 2, 2: 2, 3: 2, 4: 2 });
    const exam = buildExam(bank, { seed: 1, size: 20 });
    expect(exam.items).toHaveLength(8);
    expect(exam.complete).toBe(false);
    expect(exam.byDomain[1]).toEqual({ quota: 6, available: 2, picked: 2, short: 4 });
  });
});

describe('buildExam: reproducibility and randomness', () => {
  test('AC-21: the same bank and options give a deep-equal exam', () => {
    const bank = fullBank();
    expect(buildExam(bank, { seed: 5 })).toEqual(buildExam(bank, { seed: 5 }));
  });

  test('AC-21: the same bank in reverse order gives the same exam', () => {
    const bank = fullBank();
    const reversed = [...bank].reverse();
    expect(buildExam(reversed, { seed: 5 })).toEqual(buildExam(bank, { seed: 5 }));
  });

  test('AC-21: seeds 1 and 2 give a different item order', () => {
    const bank = fullBank();
    expect(ids(buildExam(bank, { seed: 1 }))).not.toEqual(ids(buildExam(bank, { seed: 2 })));
  });

  test('AC-22: domains are mixed, the first 19 items are not all from domain 1', () => {
    const exam = buildExam(fullBank(), { seed: 1 });
    const firstDomains = new Set(exam.items.slice(0, 19).map((item) => item.question.domain));
    expect(firstDomains.size).toBeGreaterThan(1);
  });

  test('AC-23: sampling within a domain is uniform (26 questions, seeds 0-199)', () => {
    const bank = makeBank({ 1: 30, 2: 30, 3: 30, 4: 26 });
    const domain4 = bank.filter((question) => question.domain === 4);
    expect(domain4).toHaveLength(26);
    const picks = new Map<string, number>();
    for (let seed = 0; seed < 200; seed += 1) {
      for (const id of ids(buildExam(bank, { seed }))) picks.set(id, (picks.get(id) ?? 0) + 1);
    }
    for (const question of domain4) {
      const count = picks.get(question.id) ?? 0;
      expect(count, question.id).toBeGreaterThanOrEqual(60);
      expect(count, question.id).toBeLessThanOrEqual(140);
    }
  });
});

describe('buildExam: option order', () => {
  /** A bank that mixes single (4 options) and multiple (5 and 6 options) questions. */
  function mixedBank(): Question[] {
    return makeBank({ 1: 30, 2: 30, 3: 30, 4: 30 }, (_domain, index) => {
      if (index % 3 === 0) return { type: 'multiple', optionCount: 6, correct: ['A', 'C', 'F'] };
      if (index % 3 === 1) return { type: 'multiple' };
      return { type: 'single' };
    });
  }

  test('AC-24: each optionOrder is a permutation of its question option keys', () => {
    const exam = buildExam(mixedBank(), { seed: 8 });
    expect(exam.items).toHaveLength(65);
    for (const item of exam.items) {
      const keys = item.question.options.map((option) => option.key).sort();
      expect([...item.optionOrder].sort(), item.question.id).toEqual(keys);
    }
  });

  test('AC-24: over seeds 0-399 each key of a 4-option question comes first 60 to 140 times', () => {
    const bank = makeBank({ 1: 19, 2: 17, 3: 16, 4: 13 }); // every question is in every exam
    const subject = bank[0];
    expect(subject?.options).toHaveLength(4);
    const firsts = new Map<string, number>();
    for (let seed = 0; seed < 400; seed += 1) {
      const item = buildExam(bank, { seed }).items.find((it) => it.question === subject);
      const first = item?.optionOrder[0] ?? 'missing';
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    expect([...firsts.keys()].sort()).toEqual(['A', 'B', 'C', 'D']);
    for (const count of firsts.values()) {
      expect(count).toBeGreaterThanOrEqual(60);
      expect(count).toBeLessThanOrEqual(140);
    }
  });

  test('AC-24: shuffleOptions defaults to true', () => {
    const bank = mixedBank();
    const byDefault = buildExam(bank, { seed: 8 });
    expect(byDefault).toEqual(buildExam(bank, { seed: 8, shuffleOptions: true }));
    const changed = byDefault.items.some(
      (item) =>
        item.optionOrder.join('') !== item.question.options.map((option) => option.key).join(''),
    );
    expect(changed).toBe(true);
  });

  test('AC-24: with shuffleOptions false every optionOrder is the original order', () => {
    const exam = buildExam(mixedBank(), { seed: 8, shuffleOptions: false });
    expect(exam.items).toHaveLength(65);
    for (const item of exam.items) {
      expect(item.optionOrder, item.question.id).toEqual(
        item.question.options.map((option) => option.key),
      );
    }
  });

  test('AC-24: shuffling the options does not change which questions are picked', () => {
    const bank = fullBank();
    const shuffled = buildExam(bank, { seed: 4, shuffleOptions: true });
    const original = buildExam(bank, { seed: 4, shuffleOptions: false });
    expect(new Set(ids(shuffled))).toEqual(new Set(ids(original)));
    expect(shuffled.byDomain).toEqual(original.byDomain);
  });
});

describe('buildExam: bad input', () => {
  test.each([-1, 1.5, 2 ** 32, NaN])('AC-26: seed %s throws RangeError', (seed) => {
    expect(() => buildExam(fullBank(), { seed })).toThrow(RangeError);
  });

  test.each([0, 2.5, -3, NaN])('AC-26: size %s throws RangeError', (size) => {
    expect(() => buildExam(fullBank(), { seed: 1, size })).toThrow(RangeError);
  });

  test.each([0, 2 ** 32 - 1])('AC-26: seed %s is accepted', (seed) => {
    expect(() => buildExam(fullBank(), { seed })).not.toThrow();
  });

  test('AC-26: bad options throw even when the bank is empty', () => {
    expect(() => buildExam([], { seed: -1 })).toThrow(RangeError);
    expect(() => buildExam([], { seed: 1, size: 0 })).toThrow(RangeError);
  });

  test('AC-26: two questions with the same id throw an Error naming the id', () => {
    const bank = [
      ...fullBank(),
      makeQuestion({ id: 'd2-2.1-7777', domain: 2, task: '2.1' }),
      makeQuestion({ id: 'd2-2.1-7777', domain: 2, task: '2.1' }),
    ];
    expect(() => buildExam(bank, { seed: 1 })).toThrow(Error);
    expect(() => buildExam(bank, { seed: 1 })).toThrow(/d2-2\.1-7777/);
  });

  test('AC-26: a duplicated id throws even when one of the two is not reviewed', () => {
    const bank = [
      ...fullBank(),
      makeQuestion({ id: 'd3-3.2-7778', domain: 3, task: '3.2' }),
      makeQuestion({ id: 'd3-3.2-7778', domain: 3, task: '3.2', status: 'draft' }),
    ];
    expect(() => buildExam(bank, { seed: 1 })).toThrow(/d3-3\.2-7778/);
  });
});

describe('buildExam: purity', () => {
  test('AC-27: a frozen bank of frozen questions works and is not changed', () => {
    const bank = fullBank();
    const before = structuredClone(bank);
    deepFreeze(bank);
    const exam = buildExam(bank, { seed: 6 });
    expect(exam.items).toHaveLength(65);
    expect(bank).toEqual(before);
  });

  test('AC-27: each item question is the same object as in the bank', () => {
    const bank = fullBank();
    const exam = buildExam(bank, { seed: 6 });
    for (const item of exam.items) {
      expect(bank.includes(item.question), item.question.id).toBe(true);
    }
  });

  test('AC-27: the bank array keeps its order', () => {
    const bank = fullBank();
    const order = bank.map((question) => question.id);
    buildExam(bank, { seed: 6 });
    expect(bank.map((question) => question.id)).toEqual(order);
  });
});

describe('review round 1: size limit regressions', () => {
  test('AC-33: domainQuotas(10_000) is 3000 / 2600 / 2400 / 2000', () => {
    expect(domainQuotas(10_000)).toEqual({ 1: 3000, 2: 2600, 3: 2400, 4: 2000 });
  });

  test.each([10_001, 2 ** 53])('AC-33: domainQuotas(%s) throws RangeError', (size) => {
    expect(() => domainQuotas(size)).toThrow(RangeError);
  });

  test('AC-33: buildExam with size 10_001 throws RangeError', () => {
    expect(() => buildExam(fullBank(), { seed: 1, size: 10_001 })).toThrow(RangeError);
  });
});
