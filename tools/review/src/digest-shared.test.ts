// Spec 029: the review tool uses the questionDigest of tools/questions instead of its own copy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { questionDigest as sharedDigest } from '@field-guide/questions/verify';
import type { Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { draft, verification } from './__mocks__/review-fixtures.ts';
import { questionDigest as reviewDigest, verificationState } from './review.ts';

/** The lines of a text that contain `needle` (a short diff when the test fails). */
function linesWith(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

describe('the shared questionDigest', () => {
  test('AC-1: questionDigest from review.ts is the same function as the one in questions/verify', () => {
    expect(reviewDigest).toBe(sharedDigest);
  });

  test('AC-2: review.ts has no copy of questionDigest', () => {
    const source = readFileSync(fileURLToPath(new URL('./review.ts', import.meta.url)), 'utf8');
    expect(linesWith(source, 'function questionDigest')).toEqual([]);
  });

  test('AC-2: review.ts does not hash anything itself (no createHash)', () => {
    const source = readFileSync(fileURLToPath(new URL('./review.ts', import.meta.url)), 'utf8');
    expect(linesWith(source, 'createHash')).toEqual([]);
  });

  describe('verificationState with the shared digest', () => {
    const d = draft({ id: 'd1-1.3-0007' });

    test('AC-4: a sidecar holding the shared digest of the question is verified', () => {
      const sidecar = { verification: verification(d, { digest: sharedDigest(d.question) }) };
      expect(verificationState(d.question, sidecar)).toBe('verified');
    });

    test('AC-4: the same sidecar is changed when one option text differs', () => {
      const sidecar = { verification: verification(d, { digest: sharedDigest(d.question) }) };
      const options = d.question.options.map((option, index) =>
        index === 0 ? { ...option, text: `${option.text} (edited)` } : option,
      );
      const edited: Question = { ...d.question, options };
      expect(verificationState(edited, sidecar)).toBe('changed');
    });
  });
});
