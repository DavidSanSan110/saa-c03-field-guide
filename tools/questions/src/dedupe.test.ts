import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { parseAllDocuments } from 'yaml';
import type { BankEntry } from './bank.ts';
import {
  findSimilar,
  normalise,
  shingles,
  similarByDraft,
  similarity,
  withDedupe,
} from './dedupe.ts';
import type { SimilarPair, SimilarRef } from './dedupe.ts';
import { names, shingleEntry, textOf } from './__mocks__/dedupe-fixtures.ts';
import { makeEntry } from './__mocks__/fixtures.ts';

const chars = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const RIGHT_QUOTE = chars(0x2019);
const E_ACUTE = chars(0xe9);
const E_ACUTE_UPPER = chars(0xc9);
const SUPERSCRIPT_D = chars(0x1d48);

/** Any error message but the one of an unimplemented stub: a real YAML or validation error. */
const NOT_A_STUB = /^(?!not implemented)/;

const set = (...values: string[]): Set<string> => new Set(values);

describe('normalise', () => {
  test('AC-1: lower-cases, removes apostrophes, splits on non-alphanumerics and applies NFKC', () => {
    const text = `Don't  use S3-IA; it${RIGHT_QUOTE}s ${E_ACUTE_UPPER}T${E_ACUTE_UPPER} 2${SUPERSCRIPT_D}!`;

    expect(normalise(text)).toEqual([
      'dont',
      'use',
      's3',
      'ia',
      'its',
      `${E_ACUTE}t${E_ACUTE}`,
      '2d',
    ]);
  });

  test('AC-1: a straight apostrophe is removed, not turned into a space', () => {
    expect(normalise("don't")).toEqual(['dont']);
  });

  test('AC-1: a typographic apostrophe is removed, not turned into a space', () => {
    expect(normalise(`don${RIGHT_QUOTE}t`)).toEqual(['dont']);
  });

  test('AC-1: apostrophes at the edges of a word are removed', () => {
    expect(normalise("'quoted' users'")).toEqual(['quoted', 'users']);
  });

  test('AC-1: NFKC turns a modifier letter into its plain letter', () => {
    expect(normalise(`2${SUPERSCRIPT_D}`)).toEqual(['2d']);
  });

  test('AC-1: NFKC composes a letter with a combining accent', () => {
    expect(normalise(`cafe${chars(0x301)}`)).toEqual([`caf${E_ACUTE}`]);
  });

  test('AC-1: NFKC turns full-width characters into plain ones before lower-casing', () => {
    expect(normalise(chars(0xff21, 0xff22, 0xff23, 0xff11))).toEqual(['abc1']);
  });

  test('AC-1: NFKC expands a ligature', () => {
    expect(normalise(`${chars(0xfb01)}le`)).toEqual(['file']);
  });

  test('AC-1: upper case letters are lower-cased', () => {
    expect(normalise('SSE-KMS Encryption')).toEqual(['sse', 'kms', 'encryption']);
  });

  test('AC-1: every run of other characters (punctuation, underscores, tabs, newlines) is one separator', () => {
    expect(normalise('a_b--c  d\te\nf,,;;g')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  test('AC-1: leading and trailing separators do not produce empty words', () => {
    expect(normalise('  --hello world!!  ')).toEqual(['hello', 'world']);
  });

  test('AC-1: letters of other scripts and digits are words', () => {
    expect(normalise('日本語 テスト 42')).toEqual(['日本語', 'テスト', '42']);
  });

  test.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['only punctuation', '--- ... !!!'],
  ])('AC-1: %s gives no words', (_name, text) => {
    expect(normalise(text)).toEqual([]);
  });
});

describe('shingles', () => {
  test('AC-2: a stem of 5 words gives its 3 shingles of 3 consecutive words', () => {
    const result = shingles(textOf('one two three four five', []));

    expect(result).toEqual(set('one two three', 'two three four', 'three four five'));
  });

  test('AC-2: the option shingles are added and none joins the stem to an option', () => {
    const result = shingles(textOf('one two three four five', ['red green blue yellow']));

    expect(result).toEqual(
      set(
        'one two three',
        'two three four',
        'three four five',
        'red green blue',
        'green blue yellow',
      ),
    );
    expect(result.has('four five red')).toBe(false);
    expect(result.has('five red green')).toBe(false);
  });

  test('AC-2: no shingle joins the last words of an option with the next option', () => {
    const result = shingles(textOf('---', ['alpha beta', 'gamma delta', 'epsilon zeta eta theta']));

    expect(result).toEqual(set('alpha beta', 'gamma delta', 'epsilon zeta eta', 'zeta eta theta'));
  });

  test('AC-2: shingles are made of normalised words joined by one space', () => {
    const result = shingles(textOf("Don't Panic -- Now, SSE-C!", []));

    expect(result).toEqual(set('dont panic now', 'panic now sse', 'now sse c'));
  });

  test('AC-2: a stem of exactly 3 words gives one shingle', () => {
    expect(shingles(textOf('Which option fits', []))).toEqual(set('which option fits'));
  });

  test('AC-2: repeated shingles collapse in the set', () => {
    expect(shingles(textOf('go go go go', []))).toEqual(set('go go go'));
  });

  test('AC-3: an option of 2 words contributes itself, normalised, as one shingle', () => {
    expect(shingles(textOf('---', ['SSE-C']))).toEqual(set('sse c'));
  });

  test('AC-3: an option of 1 word contributes itself', () => {
    expect(shingles(textOf('---', ['KMS']))).toEqual(set('kms'));
  });

  test('AC-3: an option of exactly 3 words contributes itself', () => {
    expect(shingles(textOf('---', ['Amazon S3 Glacier']))).toEqual(set('amazon s3 glacier'));
  });

  test('AC-3: a stem of 1 or 2 words contributes itself as one shingle', () => {
    expect(shingles(textOf('Which one?', []))).toEqual(set('which one'));
    expect(shingles(textOf('Which', []))).toEqual(set('which'));
  });

  test.each([
    ['an empty option', ''],
    ['an option of only punctuation', '!!! --'],
  ])('AC-3: %s contributes nothing', (_name, text) => {
    expect(shingles(textOf('---', [text, 'kms']))).toEqual(set('kms'));
  });

  test('AC-3: a question without any word has no shingles', () => {
    expect(shingles(textOf('---', ['', '...']))).toEqual(set());
  });

  test('AC-4: the same stem and options in a different order have similarity 1', () => {
    const stem = 'A company must encrypt objects in Amazon S3 and keep the keys outside AWS';
    const options = ['SSE-S3', 'SSE-KMS with a customer managed key', 'SSE-C', 'None of them'];
    const shuffled = [
      options[2] as string,
      options[0] as string,
      options[3] as string,
      options[1] as string,
    ];

    const a = shingles(textOf(stem, options));
    const b = shingles(textOf(stem, shuffled));

    expect(similarity(a, b)).toBe(1);
  });

  test('AC-4: the shingle set does not depend on the option order', () => {
    const a = shingles(textOf('Which is correct here', ['one two three', 'four five six']));
    const b = shingles(textOf('Which is correct here', ['four five six', 'one two three']));

    expect(a).toEqual(b);
  });
});

describe('similarity', () => {
  test('AC-5: {a,b,c} and {b,c,d} have Jaccard similarity 0.5', () => {
    expect(similarity(set('a', 'b', 'c'), set('b', 'c', 'd'))).toBe(0.5);
  });

  test('AC-5: disjoint sets have similarity 0', () => {
    expect(similarity(set('a', 'b'), set('c', 'd'))).toBe(0);
  });

  test('AC-5: two empty sets have similarity 0', () => {
    expect(similarity(set(), set())).toBe(0);
  });

  test('AC-5: an empty set and a non-empty set have similarity 0', () => {
    expect(similarity(set(), set('a'))).toBe(0);
    expect(similarity(set('a'), set())).toBe(0);
  });

  test('AC-5: equal sets have similarity 1', () => {
    expect(similarity(set('a', 'b'), set('b', 'a'))).toBe(1);
  });

  test('AC-5: it is symmetric, also for sets of different sizes', () => {
    const small = set('a');
    const big = set('a', 'b', 'c', 'd');

    expect(similarity(small, big)).toBe(0.25);
    expect(similarity(big, small)).toBe(0.25);
  });

  test('AC-5: it is the intersection over the union, not over the smaller set', () => {
    expect(similarity(set('a', 'b', 'c', 'd'), set('a', 'b'))).toBe(0.5);
  });

  test('AC-5: it does not change its arguments', () => {
    const a = set('a', 'b');
    const b = set('b', 'c');

    similarity(a, b);

    expect(a).toEqual(set('a', 'b'));
    expect(b).toEqual(set('b', 'c'));
  });
});

/** Ids of a pair as `<a> <aFolder> | <b> <bFolder>`, for comparing lists of pairs. */
function keyOf(pair: SimilarPair): string {
  return `${pair.a.question.id} ${pair.aFolder} | ${pair.b.question.id} ${pair.bFolder}`;
}

describe('findSimilar', () => {
  // A = c1..c3 + a1 (4 shingles), B = c1..c3 + b1, b2 (5 shingles): 3 shared of 6 in all.
  const common = names('c', 3);
  const half = {
    a: shingleEntry('d1-1.3-0001', 'half-a', [...common, 'a1']),
    b: shingleEntry('d1-1.3-0002', 'half-b', [...common, 'b1', 'b2']),
  };

  test('AC-6: a pair with exactly the threshold similarity is flagged (>=, not >)', () => {
    const pairs = findSimilar([half.a], [half.b], 0.5);

    expect(pairs.map(keyOf)).toEqual(['d1-1.3-0001 drafts | d1-1.3-0002 bank']);
    expect(pairs[0]?.score).toBe(0.5);
  });

  test('AC-6: the same pair is flagged between two drafts', () => {
    const pairs = findSimilar([half.a, half.b], [], 0.5);

    expect(pairs.map(keyOf)).toEqual(['d1-1.3-0001 drafts | d1-1.3-0002 drafts']);
  });

  test('AC-6: a pair just above the threshold is flagged', () => {
    expect(findSimilar([half.a], [half.b], 0.4999)).toHaveLength(1);
  });

  test('AC-6: a pair just below the threshold is not flagged', () => {
    expect(findSimilar([half.a], [half.b], 0.5001)).toEqual([]);
  });

  test('AC-6: a similarity of 0.4996 is not flagged at 0.5, though it rounds to 0.50', () => {
    // 1249 shared of 2500 in all: 0.4996.
    const shared = names('s', 1249);
    const a = shingleEntry('d1-1.3-0001', 'big-a', [...shared, ...names('a', 626)]);
    const b = shingleEntry('d1-1.3-0002', 'big-b', [...shared, ...names('b', 625)]);

    expect(findSimilar([a], [b], 0.5)).toEqual([]);
    expect(findSimilar([a], [b], 0.4996)).toHaveLength(1);
  });

  test('AC-6: a threshold of 1 flags only identical questions', () => {
    const twin = shingleEntry('d1-1.3-0003', 'twin', [...common, 'a1']);

    const pairs = findSimilar([half.a], [half.b, twin], 1);

    expect(pairs.map(keyOf)).toEqual(['d1-1.3-0001 drafts | d1-1.3-0003 bank']);
    expect(pairs[0]?.score).toBe(1);
  });

  test('AC-6: questions without any shingle are never flagged (similarity 0)', () => {
    const empty = shingleEntry('d1-1.3-0001', 'empty-a', []);
    const alsoEmpty = shingleEntry('d1-1.3-0002', 'empty-b', []);

    expect(findSimilar([empty], [alsoEmpty], 0.01)).toEqual([]);
  });

  test('AC-7: 3 drafts and 2 bank questions, all identical, give 3 + 6 = 9 pairs', () => {
    const keys = names('k', 4);
    const drafts = [
      shingleEntry('d1-1.3-0002', 'draft-two', keys),
      shingleEntry('d1-1.3-0003', 'draft-three', keys),
      shingleEntry('d1-1.3-0001', 'draft-one', keys),
    ];
    const bank = [
      shingleEntry('d1-1.3-0101', 'bank-one', keys),
      shingleEntry('d1-1.3-0102', 'bank-two', keys),
    ];

    const pairs = findSimilar(drafts, bank, 0.5);

    expect(pairs).toHaveLength(9);
    expect(pairs.map(keyOf).sort()).toEqual(
      [
        'd1-1.3-0001 drafts | d1-1.3-0002 drafts',
        'd1-1.3-0001 drafts | d1-1.3-0003 drafts',
        'd1-1.3-0002 drafts | d1-1.3-0003 drafts',
        'd1-1.3-0001 drafts | d1-1.3-0101 bank',
        'd1-1.3-0001 drafts | d1-1.3-0102 bank',
        'd1-1.3-0002 drafts | d1-1.3-0101 bank',
        'd1-1.3-0002 drafts | d1-1.3-0102 bank',
        'd1-1.3-0003 drafts | d1-1.3-0101 bank',
        'd1-1.3-0003 drafts | d1-1.3-0102 bank',
      ].sort(),
    );
    expect(pairs.every((pair) => pair.score === 1)).toBe(true);
  });

  test('AC-7: bank questions are not compared with each other', () => {
    const keys = names('k', 4);
    const bank = [
      shingleEntry('d1-1.3-0101', 'bank-one', keys),
      shingleEntry('d1-1.3-0102', 'bank-two', keys),
    ];

    expect(findSimilar([], bank, 0.5)).toEqual([]);
  });

  test('AC-7: a single draft is not compared with itself', () => {
    const only = shingleEntry('d1-1.3-0001', 'only', names('k', 4));

    expect(findSimilar([only], [], 0.5)).toEqual([]);
  });

  test('AC-7: no drafts and no bank give no pairs', () => {
    expect(findSimilar([], [], 0.5)).toEqual([]);
  });

  test('AC-7: pairs are labelled with their folders', () => {
    const keys = names('k', 4);
    const draft = shingleEntry('d1-1.3-0001', 'draft', keys);
    const other = shingleEntry('d1-1.3-0002', 'other', keys);
    const bank = shingleEntry('d1-1.3-0003', 'bank', keys);

    const pairs = findSimilar([draft, other], [bank], 0.5);

    expect(pairs.every((pair) => pair.aFolder === 'drafts')).toBe(true);
    expect(pairs.map((pair) => pair.bFolder).sort()).toEqual(['bank', 'bank', 'drafts']);
    const crossing = pairs.find((pair) => pair.bFolder === 'bank' && pair.a === draft);
    expect(crossing?.b).toBe(bank);
  });

  // The ids sort differently from the slugs (and so from the paths) and from the input order.
  describe('order', () => {
    const keys = names('k', 4);

    test('AC-8: pairs of the same score are sorted by the first id, then by the second id', () => {
      const drafts = [
        shingleEntry('d1-1.3-0030', 'aa-first-slug', keys),
        shingleEntry('d1-1.3-0010', 'bb-second-slug', keys),
        shingleEntry('d1-1.3-0020', 'cc-third-slug', keys),
      ];
      const bank = [
        shingleEntry('d1-1.3-0050', 'dd-bank', keys),
        shingleEntry('d1-1.3-0040', 'ee-bank', keys),
      ];

      const pairs = findSimilar(drafts, bank, 0.5);

      expect(pairs.map(keyOf)).toEqual([
        'd1-1.3-0010 drafts | d1-1.3-0020 drafts',
        'd1-1.3-0010 drafts | d1-1.3-0030 drafts',
        'd1-1.3-0010 drafts | d1-1.3-0040 bank',
        'd1-1.3-0010 drafts | d1-1.3-0050 bank',
        'd1-1.3-0020 drafts | d1-1.3-0030 drafts',
        'd1-1.3-0020 drafts | d1-1.3-0040 bank',
        'd1-1.3-0020 drafts | d1-1.3-0050 bank',
        'd1-1.3-0030 drafts | d1-1.3-0040 bank',
        'd1-1.3-0030 drafts | d1-1.3-0050 bank',
      ]);
    });

    test('AC-8: for a draft-draft pair, a is the draft with the smaller id', () => {
      const larger = shingleEntry('d1-1.3-0090', 'aaa', keys);
      const smaller = shingleEntry('d1-1.3-0005', 'zzz', keys);

      const [pair] = findSimilar([larger, smaller], [], 0.5);

      expect(pair?.a).toBe(smaller);
      expect(pair?.b).toBe(larger);
      expect(pair?.bFolder).toBe('drafts');
    });

    test('AC-8: a higher score comes first, whatever the ids', () => {
      // Three separate groups: 3/4 = 0.75, 1 and 2/4 = 0.5; no shingle is shared between groups.
      const drafts = [
        shingleEntry('d1-1.3-0030', 'g1', names('g', 4)),
        shingleEntry('d1-1.3-0010', 'g2', names('h', 4)),
        shingleEntry('d1-1.3-0020', 'g3', names('k', 4)),
      ];
      const bank = [
        shingleEntry('d1-1.3-0001', 'b1', names('g', 3)),
        shingleEntry('d1-1.3-0002', 'b2', names('h', 2)),
        shingleEntry('d1-1.3-0003', 'b3', names('k', 4)),
      ];

      const pairs = findSimilar(drafts, bank, 0.5);

      expect(pairs.map(keyOf)).toEqual([
        'd1-1.3-0020 drafts | d1-1.3-0003 bank',
        'd1-1.3-0030 drafts | d1-1.3-0001 bank',
        'd1-1.3-0010 drafts | d1-1.3-0002 bank',
      ]);
      expect(pairs.map((pair) => pair.score)).toEqual([1, 0.75, 0.5]);
    });

    test('AC-8: the order does not depend on the order of the inputs', () => {
      const drafts = [
        shingleEntry('d1-1.3-0030', 'one', keys),
        shingleEntry('d1-1.3-0010', 'two', keys),
      ];
      const bank = [
        shingleEntry('d1-1.3-0050', 'three', keys),
        shingleEntry('d1-1.3-0040', 'four', keys),
      ];

      const forward = findSimilar(drafts, bank, 0.5).map(keyOf);
      const backward = findSimilar([...drafts].reverse(), [...bank].reverse(), 0.5).map(keyOf);

      expect(backward).toEqual(forward);
    });
  });
});

describe('similarByDraft', () => {
  const keys = names('k', 4);
  const entryA = shingleEntry('d1-1.3-0030', 'zz-a', keys);
  const entryB = shingleEntry('d1-1.3-0010', 'yy-b', keys);
  const entryC = shingleEntry('d1-1.3-0020', 'xx-c', keys);
  const entryE = shingleEntry('d1-1.3-0040', 'ww-e', keys);
  const bankX = shingleEntry('d1-1.3-0100', 'bank-x', keys);
  const bankY = shingleEntry('d1-1.3-0050', 'bank-y', keys);
  const drafts = [entryA, entryB, entryC, entryE];

  const pair = (
    a: BankEntry,
    b: BankEntry,
    bFolder: 'drafts' | 'bank',
    score: number,
  ): SimilarPair => ({ a, aFolder: 'drafts', b, bFolder, score });

  const pairs = [
    pair(entryA, bankX, 'bank', 0.6249),
    pair(entryA, bankY, 'bank', 0.6249),
    pair(entryB, entryA, 'drafts', 0.556),
    pair(entryB, entryC, 'drafts', 0.8),
  ];

  const ref = (entry: BankEntry, folder: 'drafts' | 'bank', score: number): SimilarRef => ({
    id: entry.question.id,
    folder,
    path: entry.path,
    score,
  });

  test('AC-9: a draft lists every pair it is in, as a (a side) or as b, pointing at the other question', () => {
    const result = similarByDraft(drafts, pairs);

    expect(result.get(entryB.path)).toEqual([
      ref(entryC, 'drafts', 0.8),
      ref(entryA, 'drafts', 0.56),
    ]);
    expect(result.get(entryC.path)).toEqual([ref(entryB, 'drafts', 0.8)]);
  });

  test('AC-9: the score is rounded to 2 decimals', () => {
    const result = similarByDraft(drafts, pairs);

    expect(result.get(entryC.path)?.[0]?.score).toBe(0.8);
    expect(result.get(entryA.path)?.map((item) => item.score)).toEqual([0.62, 0.62, 0.56]);
  });

  test('AC-9: 0.4996 is stored as 0.5 and 1 as 1', () => {
    const near = pair(entryA, bankX, 'bank', 0.4996);
    const exact = pair(entryB, bankX, 'bank', 1);

    const result = similarByDraft([entryA, entryB], [near, exact]);

    expect(result.get(entryA.path)?.map((item) => item.score)).toEqual([0.5]);
    expect(result.get(entryB.path)?.map((item) => item.score)).toEqual([1]);
  });

  test('AC-9: refs are sorted by score (high first) and then by id', () => {
    const result = similarByDraft(drafts, pairs);

    // Y and X tie at 0.62 (Y has the smaller id); B has the lowest score and the smallest id.
    expect(result.get(entryA.path)).toEqual([
      ref(bankY, 'bank', 0.62),
      ref(bankX, 'bank', 0.62),
      ref(entryB, 'drafts', 0.56),
    ]);
  });

  test('AC-9: a draft with no pair gets an empty list', () => {
    const result = similarByDraft(drafts, pairs);

    expect(result.get(entryE.path)).toEqual([]);
  });

  test('AC-9: without any pair, every draft gets an empty list', () => {
    const result = similarByDraft(drafts, []);

    expect([...result.keys()].sort()).toEqual(drafts.map((entry) => entry.path).sort());
    expect([...result.values()]).toEqual([[], [], [], []]);
  });

  test('AC-9: only drafts get a list, not the bank entries', () => {
    const result = similarByDraft(drafts, pairs);

    expect([...result.keys()].sort()).toEqual(drafts.map((entry) => entry.path).sort());
    expect(result.has(bankX.path)).toBe(false);
    expect(result.has(bankY.path)).toBe(false);
  });

  test('AC-9: no drafts give an empty map', () => {
    expect(similarByDraft([], []).size).toBe(0);
  });
});

describe('withDedupe', () => {
  const ref: SimilarRef = {
    id: 'd1-1.3-0001',
    folder: 'bank',
    path: 'd1/1.3/sse-c.yaml',
    score: 0.62,
  };

  test('AC-10: without an existing file, the text is a mapping with only the dedupe key', () => {
    const text = withDedupe(undefined, 0.5, []);

    expect(parse(text)).toEqual({ dedupe: { threshold: 0.5, similar: [] } });
  });

  test('AC-10: the similar list and the threshold are written as given', () => {
    const other: SimilarRef = {
      id: 'd1-1.3-0009',
      folder: 'drafts',
      path: 'd1/1.3/again.yaml',
      score: 0.55,
    };

    const text = withDedupe(undefined, 0.3, [ref, other]);

    expect(parse(text)).toEqual({ dedupe: { threshold: 0.3, similar: [ref, other] } });
  });

  test('AC-11: every other top-level key is kept with the same value', () => {
    const existing = [
      'verification:',
      '  verified_by: claude',
      '  checks:',
      '    - { name: facts, ok: true }',
      '    - { name: wording, ok: false }',
      'notes: written by hand',
      'count: 3',
      '',
    ].join('\n');

    const result = parse(withDedupe(existing, 0.5, [ref])) as Record<string, unknown>;

    expect(result.verification).toEqual({
      verified_by: 'claude',
      checks: [
        { name: 'facts', ok: true },
        { name: 'wording', ok: false },
      ],
    });
    expect(result.notes).toBe('written by hand');
    expect(result.count).toBe(3);
    expect(result.dedupe).toEqual({ threshold: 0.5, similar: [ref] });
    expect(Object.keys(result).sort()).toEqual(['count', 'dedupe', 'notes', 'verification']);
  });

  test('AC-11: an existing dedupe key is replaced, not merged', () => {
    const existing = [
      'dedupe:',
      '  threshold: 0.9',
      '  stale: true',
      '  similar:',
      '    - { id: gone, folder: bank, path: gone.yaml, score: 0.99 }',
      'verification: { verified_by: claude }',
      '',
    ].join('\n');

    const result = parse(withDedupe(existing, 0.5, [])) as Record<string, unknown>;

    expect(result.dedupe).toEqual({ threshold: 0.5, similar: [] });
    expect(result.verification).toEqual({ verified_by: 'claude' });
  });

  test('AC-11: the result parses as YAML with a single dedupe key', () => {
    const text = withDedupe('dedupe: { threshold: 0.9, similar: [] }\n', 0.4, []);

    expect(text.match(/^dedupe:/gm)).toHaveLength(1);
    expect(parse(text)).toEqual({ dedupe: { threshold: 0.4, similar: [] } });
  });

  test('AC-12: invalid YAML throws', () => {
    expect(() => withDedupe('a: [unclosed\n', 0.5, [])).toThrow(NOT_A_STUB);
  });

  test.each([
    ['a sequence', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
    ['a number', '42\n'],
    ['null', 'null\n'],
  ])('AC-12: a YAML document that is %s throws', (_name, existing) => {
    expect(() => withDedupe(existing, 0.5, [])).toThrow(NOT_A_STUB);
  });
});

// Review round 1 (regression ACs).

const CRLF = '\r\n';

/** The lines of an LF text, without the final line break. */
const linesOfLf = (text: string): string[] => text.replace(/\n$/, '').split('\n');

/** A top-level `dedupe:` block: the key line and the indented lines that follow it. */
function splitDedupeBlock(textLines: string[]): { block: string[]; rest: string[]; at: number } {
  const at = textLines.indexOf('dedupe:');
  if (at < 0) return { block: [], rest: textLines, at: textLines.length };
  let end = at + 1;
  while (end < textLines.length && /^\s/.test(textLines[end] as string)) end++;
  return {
    block: textLines.slice(at, end),
    rest: [...textLines.slice(0, at), ...textLines.slice(end)],
    at,
  };
}

const LONG_VALUE =
  'This is a long plain scalar that goes well past one hundred and twenty characters, so a YAML ' +
  'writer with the default line width would fold it onto several lines when it writes it again';

const COMMENTED_SIDECAR = [
  '# header comment, kept as it is',
  'zeta: last key, written first   # inline note on zeta',
  'alpha:',
  '  - one # note on one',
  '  - two',
  `long: ${LONG_VALUE}`,
  'omega: end # note on omega',
];

describe('withDedupe keeps the rest of the file as text', () => {
  const similar: SimilarRef[] = [
    { id: 'd1-1.3-0001', folder: 'bank', path: 'd1/1.3/sse-c.yaml', score: 0.62 },
  ];

  test('AC-24: the long string used by these tests is longer than 120 characters', () => {
    expect(LONG_VALUE.length).toBeGreaterThan(120);
    expect(LONG_VALUE).not.toContain(': ');
  });

  test('AC-24: comments, key order and the text of the other keys are kept; dedupe goes last', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withDedupe(existing, 0.5, similar);

    const lines = linesOfLf(output).filter((line) => line.trim() !== '');
    const { block, rest, at } = splitDedupeBlock(lines);
    expect(rest).toEqual(COMMENTED_SIDECAR);
    expect(at).toBe(COMMENTED_SIDECAR.length);
    expect(parse(block.join('\n'))).toEqual({ dedupe: { threshold: 0.5, similar } });
  });

  test('AC-24: the long string is not re-wrapped', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withDedupe(existing, 0.5, similar);

    expect(linesOfLf(output)).toContain(`long: ${LONG_VALUE}`);
  });

  test('AC-24: the comments are still there', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withDedupe(existing, 0.5, similar);

    expect(output).toContain('# header comment, kept as it is');
    expect(output).toContain('zeta: last key, written first   # inline note on zeta');
    expect(output).toContain('  - one # note on one');
    expect(output).toContain('omega: end # note on omega');
  });

  test('AC-24: the keys are not sorted', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withDedupe(existing, 0.5, similar);

    expect(Object.keys(parse(output) as object)).toEqual([
      'zeta',
      'alpha',
      'long',
      'omega',
      'dedupe',
    ]);
  });

  test('AC-24: an existing dedupe key is replaced in place, the other lines are kept', () => {
    const before = COMMENTED_SIDECAR.slice(0, 5);
    const after = COMMENTED_SIDECAR.slice(5);
    const stale = [
      'dedupe:',
      '  threshold: 0.9',
      '  similar:',
      '    - { id: gone, folder: bank, path: gone.yaml, score: 0.99 }',
    ];
    const existing = [...before, ...stale, ...after].join(CRLF) + CRLF;

    const output = withDedupe(existing, 0.5, similar);

    const lines = linesOfLf(output).filter((line) => line.trim() !== '');
    const { block, rest, at } = splitDedupeBlock(lines);
    expect(rest).toEqual(COMMENTED_SIDECAR);
    expect(at).toBe(before.length);
    expect(parse(block.join('\n'))).toEqual({ dedupe: { threshold: 0.5, similar } });
  });

  test('AC-24: the output has LF line endings only', () => {
    const withCrlf = COMMENTED_SIDECAR.join(CRLF) + CRLF;
    const withMixed = `${COMMENTED_SIDECAR.join(CRLF)}\nextra: 1\r\n`;

    expect(withDedupe(withCrlf, 0.5, similar)).not.toContain('\r');
    expect(withDedupe(withMixed, 0.5, similar)).not.toContain('\r');
    expect(withDedupe(undefined, 0.5, similar)).not.toContain('\r');
  });

  test.each([
    ['a CRLF sidecar with comments', COMMENTED_SIDECAR.join(CRLF) + CRLF],
    [
      'a sidecar with an existing dedupe key',
      'a: 1\ndedupe:\n  threshold: 0.9\n  similar: []\nb: 2\n',
    ],
    ['no sidecar', undefined],
  ])('AC-24: a second call with the same arguments gives the same text (%s)', (_name, existing) => {
    const once = withDedupe(existing, 0.5, similar);

    expect(withDedupe(once, 0.5, similar)).toBe(once);
  });
});

describe('cue and why are not compared', () => {
  const stem = 'Which service stores the objects of the archive for ten years';
  const optionTexts = [
    'alpha beta gamma',
    'delta epsilon zeta',
    'eta theta iota',
    'kappa lambda mu',
  ];

  /** A question with its options' `why` text and a `cue`. */
  function withNotes(
    question: ReturnType<typeof textOf>,
    cue: string,
    why: string,
  ): ReturnType<typeof textOf> & { cue: string } {
    return {
      ...question,
      cue,
      options: question.options.map((option) => ({ ...option, why })),
    };
  }

  test('AC-25: questions identical except for cue and why have similarity 1', () => {
    const a = withNotes(textOf(stem, optionTexts), 'one cue about glacier', 'one reason');
    const b = withNotes(
      textOf(stem, optionTexts),
      'a different cue about vaults',
      'another reason',
    );

    expect(shingles(a).size).toBeGreaterThan(0);
    expect(shingles(a)).toEqual(shingles(b));
    expect(similarity(shingles(a), shingles(b))).toBe(1);
  });

  test('AC-25: questions that share only cue and why text have similarity 0', () => {
    const cue = 'shared cue about retrieval times';
    const why = 'Shared reason, word for word.';
    const a = withNotes(textOf(stem, optionTexts), cue, why);
    const b = withNotes(
      textOf('Where should the logs of the web tier land every night', [
        'omega sigma tau',
        'upsilon phi chi',
        'psi nu xi',
        'rho pi omicron',
      ]),
      cue,
      why,
    );

    expect(shingles(a).size).toBeGreaterThan(0);
    expect(shingles(b).size).toBeGreaterThan(0);
    expect(similarity(shingles(a), shingles(b))).toBe(0);
  });

  test('AC-25: the cue and why text never become shingles', () => {
    const a = withNotes(textOf(stem, optionTexts), 'secretcue words here', 'secretwhy words here');

    const all = [...shingles(a)].join(' | ');

    expect(all).not.toContain('secretcue');
    expect(all).not.toContain('secretwhy');
  });

  test('AC-25: findSimilar flags two entries that differ only in cue and why, with score 1', () => {
    const draft = makeEntry('d1-1.3-0002', 'copy', {
      stem,
      cue: 'first cue',
      options: withNotes(textOf(stem, optionTexts), 'x', 'first reason').options,
    });
    const original = makeEntry('d1-1.3-0001', 'original', {
      stem,
      cue: 'second cue',
      options: withNotes(textOf(stem, optionTexts), 'x', 'second reason').options,
    });

    const pairs = findSimilar([draft], [original], 0.5);

    expect(pairs.map((pair) => pair.score)).toEqual([1]);
  });

  test('AC-25: findSimilar does not flag entries that share only cue and why', () => {
    const cue = 'shared cue about retrieval times';
    const left = makeEntry('d1-1.3-0002', 'left', {
      stem,
      cue,
      options: withNotes(textOf(stem, optionTexts), cue, 'Shared reason.').options,
    });
    const otherStem = 'Where should the logs of the web tier land every night';
    const right = makeEntry('d1-1.3-0001', 'right', {
      stem: otherStem,
      cue,
      options: withNotes(
        textOf(otherStem, ['omega sigma tau', 'upsilon phi chi', 'psi nu xi', 'rho pi omicron']),
        cue,
        'Shared reason.',
      ).options,
    });

    expect(findSimilar([left], [right], 0.01)).toEqual([]);
  });
});

describe('withDedupe on an empty sidecar', () => {
  test.each([
    ['an empty string', ''],
    ['only a comment', '# only a comment\n'],
    ['only a document marker', '---\n'],
    ['a document marker with a comment', '--- # c\n'],
  ])('AC-26: %s counts as an empty mapping', (_name, existing) => {
    const output = withDedupe(existing, 0.5, []);

    expect(parse(output)).toEqual({ dedupe: { threshold: 0.5, similar: [] } });
  });

  test('AC-26: the output has no CR and the same text again on a second call', () => {
    const once = withDedupe('# only a comment\n', 0.5, []);

    expect(once).not.toContain('\r');
    expect(withDedupe(once, 0.5, [])).toBe(once);
  });
});

// Review round 2 (regression AC).

const NEW_DEDUPE = { threshold: 0.5, similar: [] };

/**
 * `withDedupe` must either throw or return one YAML document, without errors, whose value is the
 * input mapping with only `dedupe` replaced (added last when absent).
 */
function outcomeOf(
  existing: string,
):
  | { threw: false; documents: number; errors: number; value: unknown }
  | { threw: true; error: unknown } {
  let output: string;
  try {
    output = withDedupe(existing, 0.5, []);
  } catch (error) {
    return { threw: true, error };
  }
  const documents = parseAllDocuments(output);
  let value: unknown;
  try {
    value = documents[0]?.toJS();
  } catch (error) {
    // For instance an alias whose anchor was dropped: the text does not hold the data.
    value = `the document cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    threw: false,
    documents: documents.length,
    errors: documents.reduce((sum, document) => sum + document.errors.length, 0),
    value,
  };
}

function expectThrowsOrKeepsData(existing: string, expected: unknown): void {
  const outcome = outcomeOf(existing);
  if (outcome.threw) return;
  expect(outcome.documents).toBe(1);
  expect(outcome.errors).toBe(0);
  expect(outcome.value).toEqual(expected);
}

describe('withDedupe never loses or moves data', () => {
  test('AC-27: a document end marker (...) is handled or rejected', () => {
    expectThrowsOrKeepsData('a: 1\n...\n', { a: 1, dedupe: NEW_DEDUPE });
  });

  test('AC-27: a document end marker with a comment is handled or rejected', () => {
    expectThrowsOrKeepsData('a: 1\n... # end\n', { a: 1, dedupe: NEW_DEDUPE });
  });

  test('AC-27: a mapping indented by spaces is handled or rejected', () => {
    expectThrowsOrKeepsData('  a: 1\n  b: 2\n', { a: 1, b: 2, dedupe: NEW_DEDUPE });
  });

  test('AC-27: an indented mapping with a dedupe key followed by another key keeps that key', () => {
    expectThrowsOrKeepsData('  dedupe: 1\n  b: 2\n', { dedupe: NEW_DEDUPE, b: 2 });
  });

  test('AC-27: an indented mapping with dedupe and a verification mapping keeps the mapping', () => {
    expectThrowsOrKeepsData('  dedupe: 1\n  verification:\n    answer: B\n', {
      dedupe: NEW_DEDUPE,
      verification: { answer: 'B' },
    });
  });

  test('AC-27: an anchor on the old dedupe value that is used elsewhere is handled or rejected', () => {
    expectThrowsOrKeepsData('dedupe: &d 1\nx: *d\n', { dedupe: NEW_DEDUPE, x: 1 });
  });

  test.each([
    ['a document end marker', 'a: 1\n...\n'],
    ['a document end marker with a comment', 'a: 1\n... # end\n'],
    ['an indented mapping', '  a: 1\n  b: 2\n'],
    ['an indented dedupe key', '  dedupe: 1\n  b: 2\n'],
    ['an anchor on the old dedupe value', 'dedupe: &d 1\nx: *d\n'],
  ])('AC-27: with %s, a rejection is a real Error', (_name, existing) => {
    const outcome = outcomeOf(existing);

    if (outcome.threw) expect(outcome.error).toBeInstanceOf(Error);
    else expect(outcome.documents).toBe(1);
  });
});
