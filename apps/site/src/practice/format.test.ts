import { describe, expect, test } from 'vitest';
import { displayLetters, formatClock } from './format.ts';

describe('formatClock', () => {
  test('AC-1: 0 is 0:00:00', () => {
    expect(formatClock(0)).toBe('0:00:00');
  });

  test('AC-1: 7 800 000 ms (130 minutes) is 2:10:00', () => {
    expect(formatClock(7_800_000)).toBe('2:10:00');
  });

  test('AC-1: 59 999 ms floors to 0:00:59 instead of rounding up to a minute', () => {
    expect(formatClock(59_999)).toBe('0:00:59');
  });

  test('AC-1: a negative value is 0:00:00', () => {
    expect(formatClock(-1)).toBe('0:00:00');
    expect(formatClock(-7_800_000)).toBe('0:00:00');
  });

  test('AC-1: less than one second is 0:00:00', () => {
    expect(formatClock(999)).toBe('0:00:00');
  });

  test('AC-1: whole seconds and minutes are zero-padded to two digits', () => {
    expect(formatClock(1_000)).toBe('0:00:01');
    expect(formatClock(61_000)).toBe('0:01:01');
    expect(formatClock(600_000)).toBe('0:10:00');
  });

  test('AC-1: the hours are not padded', () => {
    expect(formatClock(3_599_999)).toBe('0:59:59');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(36_000_000)).toBe('10:00:00');
  });

  test('AC-1: a fractional millisecond count floors as well', () => {
    expect(formatClock(1_999.9)).toBe('0:00:01');
  });
});

describe('displayLetters', () => {
  test('AC-2: keys map to their position in the option order, sorted', () => {
    expect(displayLetters(['C', 'A', 'D', 'B'], ['A', 'B'])).toEqual(['B', 'D']);
  });

  test('AC-2: the result is sorted by letter, not by the order of the keys given', () => {
    expect(displayLetters(['C', 'A', 'D', 'B'], ['B', 'A'])).toEqual(['B', 'D']);
    expect(displayLetters(['D', 'C', 'B', 'A'], ['A', 'B'])).toEqual(['C', 'D']);
  });

  test('AC-2: letters follow the position, not the key itself', () => {
    expect(displayLetters(['B', 'A', 'C', 'D'], ['B'])).toEqual(['A']);
    expect(displayLetters(['B', 'A', 'C', 'D'], ['A'])).toEqual(['B']);
  });

  test('AC-2: with the options in key order the letters equal the keys', () => {
    expect(displayLetters(['A', 'B', 'C', 'D', 'E'], ['E', 'A', 'C'])).toEqual(['A', 'C', 'E']);
  });

  test('AC-2: unknown keys are ignored', () => {
    expect(displayLetters(['C', 'A', 'D', 'B'], ['A', 'Z', 'x'])).toEqual(['B']);
    expect(displayLetters(['C', 'A', 'D', 'B'], ['Z'])).toEqual([]);
  });

  test('AC-2: no keys give no letters', () => {
    expect(displayLetters(['C', 'A', 'D', 'B'], [])).toEqual([]);
  });

  test('AC-2: six options reach the letter F', () => {
    expect(displayLetters(['F', 'E', 'D', 'C', 'B', 'A'], ['A', 'F'])).toEqual(['A', 'F']);
    expect(displayLetters(['B', 'C', 'D', 'E', 'F', 'A'], ['A'])).toEqual(['F']);
  });
});
