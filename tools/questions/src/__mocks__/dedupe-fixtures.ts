// Test fixtures for near-duplicate detection (spec 020): questions with a known shingle set.
import type { Question } from '@field-guide/schema';
import type { BankEntry } from '../bank.ts';
import { makeEntry } from './fixtures.ts';
import type { Raw } from './fixtures.ts';

type Text = Pick<Question, 'stem' | 'options'>;

/** `<prefix>1 <prefix>2 ... <prefix><count>`: distinct words made of letters and digits. */
export function words(prefix: string, count: number): string {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${String(index + 1)}`).join(
    ' ',
  );
}

/** `<prefix>1 ... <prefix><count>` as a list. */
export function names(prefix: string, count: number): string[] {
  return words(prefix, count).split(' ');
}

/** The stem and options of a question, with any number of options (for the pure functions). */
export function textOf(stem: string, optionTexts: string[]): Text {
  return {
    stem,
    options: optionTexts.map((text, index) => ({
      key: String.fromCharCode(65 + index),
      text,
      correct: index === 0,
      why: 'Because.',
    })),
  };
}

/**
 * An entry whose shingle set is exactly `{"<key> pad pad" for key in keys}`: the stem has no words,
 * and each option is one three-word shingle. For tests that need an exact similarity.
 */
export function shingleEntry(id: string, slug: string, keys: string[]): BankEntry {
  const text = textOf(
    '---',
    keys.map((key) => `${key} pad pad`),
  );
  return makeEntry(id, slug, { stem: text.stem, options: text.options });
}

/**
 * Question overrides for the CLI tests (a valid single-answer question). Questions of the same
 * `group` share `common` stem words; each `member` has its own last stem word and 4 own options
 * (one shingle each). Same group and member: identical text (similarity 1). Same group, other
 * member: `(common - 2) / (common + 8)`, e.g. common 7 → 5/15, 11 → 9/19, 12 → 10/20 (exactly 0.5),
 * 13 → 11/21, 14 → 12/22. Different groups share no shingle (similarity 0).
 */
export function variant(group: string, member: string, common = 7): Raw {
  const own = (suffix: string, index: number): string =>
    `${group}${member}${suffix}${String(index)}`;
  return {
    stem: `${words(`${group}c`, common)} ${group}${member}t`,
    options: [1, 2, 3, 4].map((index) => ({
      key: String.fromCharCode(64 + index),
      text: `${own('o', index)} ${own('p', index)}`,
      correct: index === 3,
      why: `Because of ${group}.`,
    })),
  };
}
