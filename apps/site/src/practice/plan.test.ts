import { describe, expect, test } from 'vitest';
import { examDurationMs } from './plan.ts';

describe('examDurationMs', () => {
  test('AC-3: 65 questions take 7 800 000 ms (130 minutes)', () => {
    expect(examDurationMs(65)).toBe(7_800_000);
  });

  test('AC-3: 56 questions take 6 720 000 ms (2 minutes each)', () => {
    expect(examDurationMs(56)).toBe(6_720_000);
  });

  test('AC-3: one question takes 120 000 ms', () => {
    expect(examDurationMs(1)).toBe(120_000);
  });

  test('AC-3: a size below 1 throws a RangeError', () => {
    expect(() => examDurationMs(0)).toThrow(RangeError);
    expect(() => examDurationMs(-5)).toThrow(RangeError);
    expect(() => examDurationMs(0.5)).toThrow(RangeError);
  });
});
