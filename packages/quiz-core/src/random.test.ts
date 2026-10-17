import { describe, expect, test } from 'vitest';
import { createRng, shuffle } from './random.ts';
import type { Rng } from './random.ts';

function take(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng());
}

describe('createRng', () => {
  test('AC-1: the same seed gives the same first 1,000 values', () => {
    expect(take(createRng(12345), 1000)).toEqual(take(createRng(12345), 1000));
  });

  test('AC-1: the same seed gives the same sequence for generators used in turn', () => {
    const first = createRng(99);
    const second = createRng(99);
    for (let i = 0; i < 50; i += 1) expect(first()).toBe(second());
  });

  test('AC-1: seeds 1 and 2 give different first 10 values', () => {
    expect(take(createRng(1), 10)).not.toEqual(take(createRng(2), 10));
  });

  test('AC-2: every value is a number >= 0 and < 1', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng();
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('AC-2: 10,000 values from seed 42 fill each tenth of [0, 1) 800 to 1,200 times', () => {
    const counts = new Array<number>(10).fill(0);
    for (const value of take(createRng(42), 10_000)) {
      const tenth = Math.floor(value * 10);
      counts[tenth] = (counts[tenth] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(800);
      expect(count).toBeLessThanOrEqual(1200);
    }
  });

  test.each([-1, 1.5, 2 ** 32, NaN, Infinity])('AC-3: seed %s throws RangeError', (seed) => {
    expect(() => createRng(seed)).toThrow(RangeError);
  });

  test.each([0, 2 ** 32 - 1])('AC-3: seed %s is accepted', (seed) => {
    expect(() => createRng(seed)).not.toThrow();
    const value = createRng(seed)();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});

describe('shuffle', () => {
  test('AC-4: returns a new array with the same elements and leaves the input unchanged', () => {
    const input = [5, 3, 8, 1, 9, 2, 7];
    const copy = [...input];
    const result = shuffle(input, createRng(3));
    expect(result).not.toBe(input);
    expect([...result].sort((a, b) => a - b)).toEqual([...copy].sort((a, b) => a - b));
    expect(input).toEqual(copy);
  });

  test('AC-4: keeps duplicate elements as they are (a permutation, not a set)', () => {
    const result = shuffle(['a', 'b', 'a', 'a', 'c'], createRng(4));
    expect([...result].sort()).toEqual(['a', 'a', 'a', 'b', 'c']);
  });

  test('AC-4: works on a frozen input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6]);
    const result = shuffle(input, createRng(11));
    expect([...result].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('AC-4: an empty array gives a new empty array', () => {
    const input: number[] = [];
    const result = shuffle(input, createRng(1));
    expect(result).toEqual([]);
    expect(result).not.toBe(input);
  });

  test('AC-4: a one-element array gives a new array with that element', () => {
    const input = ['only'];
    const result = shuffle(input, createRng(1));
    expect(result).toEqual(['only']);
    expect(result).not.toBe(input);
  });

  test('AC-5: is deterministic for a given seed', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(shuffle(items, createRng(2024))).toEqual(shuffle(items, createRng(2024)));
  });

  test('AC-5: different seeds can give different orders', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(shuffle(items, createRng(1))).not.toEqual(shuffle(items, createRng(2)));
  });

  test('AC-5: over 6,000 shuffles of [1, 2, 3] each of the 6 orders appears 800 to 1,200 times', () => {
    const rng = createRng(5);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i += 1) {
      const order = shuffle([1, 2, 3], rng).join(',');
      counts.set(order, (counts.get(order) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(800);
      expect(count).toBeLessThanOrEqual(1200);
    }
  });
});
