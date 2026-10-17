import { describe, expect, test } from 'vitest';
import { buildIndex, findMatches, words } from './similarity.ts';

const BOM = String.fromCodePoint(0xfeff);

/** `from..to` numbered words of one prefix: `rye1 rye2 ...`, unique across prefixes. */
function seq(prefix: string, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
}

function sentence(...parts: string[][]): string {
  return parts.flat().join(' ');
}

describe('words', () => {
  test('AC-1: strips the BOM, drops apostrophes and splits on non-letters, keeping line numbers', () => {
    expect(words(`${BOM}Don't\nuse S3-IA`)).toEqual([
      { word: 'dont', line: 1 },
      { word: 'use', line: 2 },
      { word: 's3', line: 2 },
      { word: 'ia', line: 2 },
    ]);
  });

  test('AC-1: a typographic apostrophe is removed too, not split', () => {
    expect(words('Don’t stop')).toEqual([
      { word: 'dont', line: 1 },
      { word: 'stop', line: 1 },
    ]);
  });

  test('AC-1: lower-cases letters, including non-ASCII ones', () => {
    expect(words('CAFÉ Bakery')).toEqual([
      { word: 'café', line: 1 },
      { word: 'bakery', line: 1 },
    ]);
  });

  test('AC-1: applies NFKC (full-width characters and ligatures)', () => {
    expect(words('Ｓ３ ﬁle')).toEqual([
      { word: 's3', line: 1 },
      { word: 'file', line: 1 },
    ]);
  });

  test('AC-1: punctuation, underscores and symbols separate words', () => {
    expect(words('snake_case, (bread) & butter -- "jam"').map((entry) => entry.word)).toEqual([
      'snake',
      'case',
      'bread',
      'butter',
      'jam',
    ]);
  });

  test('AC-1: blank lines and CRLF line endings count as lines', () => {
    expect(words('one\r\n\r\ntwo\nthree')).toEqual([
      { word: 'one', line: 1 },
      { word: 'two', line: 3 },
      { word: 'three', line: 4 },
    ]);
  });

  test('AC-1: text without letters or digits has no words', () => {
    expect(words(`${BOM} \n -- ... \n`)).toEqual([]);
    expect(words('')).toEqual([]);
  });
});

describe('findMatches', () => {
  const TEN = 'The baker on Maple Street lights the oven before sunrise.';

  test('AC-2: a 10-word sentence of the corpus repeated in the target is one match with its details', () => {
    const index = buildIndex(
      {
        'handbook/bakery.txt': `Opening notes.\nStaff rota is posted weekly.\n${TEN}\nClosing notes.`,
      },
      8,
    );
    const target = `Welcome to the town guide.\n\n${TEN}\nVisit us soon.`;

    expect(findMatches(target, index)).toEqual([
      {
        line: 3,
        length: 10,
        text: 'the baker on maple street lights the oven before sunrise',
        corpusFile: 'handbook/bakery.txt',
        corpusLine: 3,
      },
    ]);
  });

  test.each([3, 8, 12])('AC-3: a run of exactly %i words (minWords) is a match', (minWords) => {
    const run = seq('rye', 1, minWords);
    const index = buildIndex({ 'a.txt': sentence(['before0'], run, ['after0']) }, minWords);

    const matches = findMatches(sentence(['intro0'], run, ['outro0']), index);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ line: 1, length: minWords, text: run.join(' ') });
  });

  test.each([3, 8, 12])('AC-3: a run of %i - 1 words is not a match', (minWords) => {
    const index = buildIndex(
      { 'a.txt': sentence(['before0'], seq('rye', 1, minWords), ['after0']) },
      minWords,
    );

    expect(
      findMatches(sentence(['intro0'], seq('rye', 1, minWords - 1), ['outro0']), index),
    ).toEqual([]);
  });

  test('AC-3: a target that is exactly the corpus run, with nothing around it, is a match', () => {
    const run = seq('rye', 1, 8);
    const index = buildIndex({ 'a.txt': run.join(' ') }, 8);

    expect(findMatches(run.join(' '), index)).toEqual([
      { line: 1, length: 8, text: run.join(' '), corpusFile: 'a.txt', corpusLine: 1 },
    ]);
  });

  test('AC-4: case, punctuation and apostrophes in the corpus do not prevent a match', () => {
    const index = buildIndex({ 'a.txt': "Amazon S3 — Standard-IA, isn't" }, 5);

    expect(findMatches('amazon s3 standard ia isnt', index)).toEqual([
      {
        line: 1,
        length: 5,
        text: 'amazon s3 standard ia isnt',
        corpusFile: 'a.txt',
        corpusLine: 1,
      },
    ]);
  });

  test('AC-4: case, punctuation and apostrophes in the target do not prevent a match', () => {
    const index = buildIndex({ 'a.txt': 'amazon s3 standard ia isnt' }, 5);

    const typed = findMatches("Amazon S3 — Standard-IA, isn't", index);
    const curly = findMatches('AMAZON S3 - STANDARD-IA, isn’t', index);

    expect(typed.map((match) => match.text)).toEqual(['amazon s3 standard ia isnt']);
    expect(curly.map((match) => match.text)).toEqual(['amazon s3 standard ia isnt']);
  });

  test('AC-4: an apostrophe is removed, not turned into a word break', () => {
    const index = buildIndex({ 'a.txt': 'it isnt here today' }, 4);

    expect(findMatches("It isn't here today", index).map((match) => match.text)).toEqual([
      'it isnt here today',
    ]);
  });

  test('AC-4: full-width characters match their plain form (NFKC)', () => {
    const index = buildIndex({ 'a.txt': 'amazon s3 standard ia isnt' }, 5);

    expect(findMatches('Amazon Ｓ３ Standard-IA isnt', index)).toHaveLength(1);
  });

  test('AC-4: a sentence wrapped over several target lines matches, reported at its first line', () => {
    const index = buildIndex({ 'a.txt': 'amazon s3 standard ia isnt' }, 5);

    const matches = findMatches("intro\nAmazon S3\nstandard\n\nIA\nisn't cheap", index);

    expect(matches).toEqual([
      {
        line: 2,
        length: 5,
        text: 'amazon s3 standard ia isnt',
        corpusFile: 'a.txt',
        corpusLine: 1,
      },
    ]);
  });

  test('AC-4: a sentence wrapped over several corpus lines matches, reported at its first line', () => {
    const index = buildIndex({ 'a.txt': 'first\namazon s3\nstandard\nia isnt\nlast' }, 5);

    const matches = findMatches('Amazon S3 Standard-IA isnt', index);

    expect(matches).toEqual([
      {
        line: 1,
        length: 5,
        text: 'amazon s3 standard ia isnt',
        corpusFile: 'a.txt',
        corpusLine: 2,
      },
    ]);
  });

  test('AC-4: a BOM at the start of the corpus file or of the target does not prevent a match', () => {
    const index = buildIndex({ 'a.txt': `${BOM}amazon s3 standard ia isnt` }, 5);

    expect(findMatches(`${BOM}Amazon S3 Standard-IA isnt`, index)).toHaveLength(1);
  });

  test('AC-5: two separate shared runs give two matches sorted by target line', () => {
    const first = seq('rye', 1, 8);
    const second = seq('oat', 1, 8);
    const index = buildIndex(
      { 'a.txt': `${first.join(' ')}\nfiller words here\n${second.join(' ')}` },
      8,
    );

    const matches = findMatches(
      `intro words\n${second.join(' ')}\nmiddle stuff\n${first.join(' ')}\n`,
      index,
    );

    expect(matches).toEqual([
      { line: 2, length: 8, text: second.join(' '), corpusFile: 'a.txt', corpusLine: 3 },
      { line: 4, length: 8, text: first.join(' '), corpusFile: 'a.txt', corpusLine: 1 },
    ]);
  });

  test('AC-5: the same shared run twice in the target is reported twice', () => {
    const run = seq('rye', 1, 8);
    const index = buildIndex({ 'a.txt': run.join(' ') }, 8);

    const matches = findMatches(`${run.join(' ')}\nbetween words\n${run.join(' ')}`, index);

    expect(matches.map((match) => match.line)).toEqual([1, 3]);
  });

  test('AC-5: overlapping windows 1-8 and 2-9 are one match of length 9', () => {
    const run = seq('rye', 1, 9);
    const index = buildIndex({ 'a.txt': sentence(['before0'], run, ['after0']) }, 8);

    expect(findMatches(sentence(['intro0'], run, ['outro0']), index)).toEqual([
      { line: 1, length: 9, text: run.join(' '), corpusFile: 'a.txt', corpusLine: 1 },
    ]);
  });

  test('AC-5: windows 1-8 and 2-9 found at different places of one file are one match of length 9', () => {
    const run = seq('rye', 1, 9);
    const corpus = `pre0 ${seq('rye', 1, 8).join(' ')} post0\nmid0 ${seq('rye', 2, 9).join(' ')} end0`;
    const index = buildIndex({ 'a.txt': corpus }, 8);

    expect(findMatches(`intro0 ${run.join(' ')} outro0`, index)).toEqual([
      { line: 1, length: 9, text: run.join(' '), corpusFile: 'a.txt', corpusLine: 1 },
    ]);
  });

  test('AC-5: a long shared run is reported once with its full length', () => {
    const run = seq('rye', 1, 12);
    const index = buildIndex({ 'a.txt': run.join(' ') }, 8);

    const matches = findMatches(`intro0 ${run.join(' ')} outro0`, index);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ length: 12, text: run.join(' ') });
  });

  const tail = sentence(['aa0'], seq('rye', 1, 5));
  const head = sentence(seq('rye', 6, 10), ['bb0']);

  test.each([
    ['the first half first', { 'a.txt': tail, 'b.txt': head }],
    ['the second half first', { 'b.txt': head, 'a.txt': tail }],
  ])('AC-6: a run split across two corpus files is not a match (%s)', (_label, corpus) => {
    const index = buildIndex(corpus, 8);

    expect(findMatches(sentence(['intro0'], seq('rye', 1, 10), ['outro0']), index)).toEqual([]);
  });

  test('AC-7: buildIndex reports the number of corpus files and minWords', () => {
    const index = buildIndex(
      {
        'a.txt': seq('rye', 1, 10).join(' '),
        'deep/b.md': seq('oat', 1, 10).join(' '),
        'c.txt': seq('corn', 1, 10).join(' '),
      },
      8,
    );

    expect(index.files).toBe(3);
    expect(index.minWords).toBe(8);
  });

  test('AC-7: an empty corpus has no files and finds nothing', () => {
    const index = buildIndex({}, 8);

    expect(index.files).toBe(0);
    expect(index.minWords).toBe(8);
    expect(findMatches(seq('rye', 1, 20).join(' '), index)).toEqual([]);
  });

  test('AC-7: a corpus file shorter than minWords words contributes nothing and does not throw', () => {
    const run = seq('rye', 1, 10);
    const build = () =>
      buildIndex({ 'short.txt': 'rye1 rye2 rye3', 'empty.txt': '', 'long.txt': run.join(' ') }, 8);

    expect(build).not.toThrow();
    const index = build();
    expect(findMatches(run.join(' '), index)).toEqual([
      { line: 1, length: 10, text: run.join(' '), corpusFile: 'long.txt', corpusLine: 1 },
    ]);
  });

  test('AC-7: a corpus made only of short files finds nothing', () => {
    const index = buildIndex({ 'short.txt': seq('rye', 1, 7).join(' ') }, 8);

    expect(findMatches(seq('rye', 1, 7).join(' '), index)).toEqual([]);
    expect(findMatches(seq('rye', 1, 20).join(' '), index)).toEqual([]);
  });

  test('AC-8: an empty target has no matches', () => {
    const index = buildIndex({ 'a.txt': seq('rye', 1, 10).join(' ') }, 8);

    expect(findMatches('', index)).toEqual([]);
    expect(findMatches(' \n -- \n', index)).toEqual([]);
  });

  test('AC-8: a target shorter than minWords words has no matches even if the corpus has them', () => {
    const index = buildIndex({ 'a.txt': seq('rye', 1, 10).join(' ') }, 8);

    expect(findMatches(seq('rye', 1, 7).join(' '), index)).toEqual([]);
    expect(findMatches(seq('rye', 1, 1).join(' '), index)).toEqual([]);
  });
});
