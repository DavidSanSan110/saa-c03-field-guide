import { describe, expect, test } from 'vitest';
import { buildIndex, findMatches, words } from './similarity.ts';
import { stripMarkup } from './similarity.ts';
import { stripUrls } from './similarity.ts';

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

// Review round 1 (regression ACs). The format characters are built at runtime, never typed.
describe('format characters (review round 1)', () => {
  const FORMAT_CHARACTERS: [string, number][] = [
    ['soft hyphen', 0x00ad],
    ['zero-width space', 0x200b],
    ['zero-width non-joiner', 0x200c],
    ['zero-width joiner', 0x200d],
    ['word joiner', 0x2060],
    ['byte order mark', 0xfeff],
  ];
  const RUN = 'lemon tarts cool slowly beside the quiet harbour window';

  test.each(FORMAT_CHARACTERS)('AC-24: a %s inside a word does not split it', (_label, code) => {
    const mark = String.fromCodePoint(code);

    expect(words(`slo${mark}wly`)).toEqual([{ word: 'slowly', line: 1 }]);
  });

  test.each(FORMAT_CHARACTERS)('AC-24: a %s does not change the line numbers', (_label, code) => {
    const mark = String.fromCodePoint(code);

    expect(words(`first\nslo${mark}wly${mark} baked\n\nlast`)).toEqual([
      { word: 'first', line: 1 },
      { word: 'slowly', line: 2 },
      { word: 'baked', line: 2 },
      { word: 'last', line: 4 },
    ]);
  });

  test('AC-24: several different format characters in one word are all removed', () => {
    const marks = FORMAT_CHARACTERS.map(([, code]) => String.fromCodePoint(code)).join('');

    expect(words(`Lem${marks}on`)).toEqual([{ word: 'lemon', line: 1 }]);
  });

  test('AC-24: a copied 9-word run with a soft hyphen in a word still matches at min 8', () => {
    const shy = String.fromCodePoint(0x00ad);
    const index = buildIndex({ 'a.txt': `before0 ${RUN} after0` }, 8);

    const matches = findMatches(`intro0 ${RUN.replace('slowly', `slo${shy}wly`)} outro0`, index);

    expect(matches).toEqual([
      { line: 1, length: 9, text: RUN, corpusFile: 'a.txt', corpusLine: 1 },
    ]);
  });

  test('AC-24: a soft hyphen in the corpus text does not prevent a match either', () => {
    const shy = String.fromCodePoint(0x00ad);
    const zwsp = String.fromCodePoint(0x200b);
    const index = buildIndex(
      {
        'a.txt': `before0 ${RUN.replace('quiet', `qui${shy}et`).replace('tarts', `ta${zwsp}rts`)} after0`,
      },
      8,
    );

    const matches = findMatches(`intro0 ${RUN} outro0`, index);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ length: 9, text: RUN });
  });
});

// Review round 2 (regression AC).
describe('stripMarkup (review round 2)', () => {
  /** The words of a text after stripMarkup, without line numbers. */
  const stripped = (text: string): string[] => words(stripMarkup(text)).map((entry) => entry.word);

  test.each(['&#39;', '&#039;', '&#x27;', '&#x0027;', '&apos;', '&rsquo;', '&#8217;', '&#x2019;'])(
    'AC-26: the apostrophe entity %s inside baker...s gives one word, bakers',
    (entity) => {
      expect(stripped(`baker${entity}s`)).toEqual(['bakers']);
    },
  );

  test.each(['&amp;', '&nbsp;', '&copy;', '&#160;'])(
    'AC-26: the other entity %s becomes a space even without spaces around it',
    (entity) => {
      expect(stripped(`cool${entity}slowly`)).toEqual(['cool', 'slowly']);
    },
  );

  test('AC-26: cool&nbsp;slowly is two words on the same line', () => {
    expect(words(stripMarkup('first\ncool&nbsp;slowly'))).toEqual([
      { word: 'first', line: 1 },
      { word: 'cool', line: 2 },
      { word: 'slowly', line: 2 },
    ]);
  });

  test('AC-26: an unclosed [x]( on line 1 with the ) on line 3 keeps every line', () => {
    const text = 'see [x](unclosed\nmiddle words here\nend) tail';

    const output = stripMarkup(text);

    expect(output.split('\n')).toHaveLength(text.split('\n').length);
    const middle = words(output).filter((entry) => entry.line === 2);
    expect(middle).toEqual([
      { word: 'middle', line: 2 },
      { word: 'words', line: 2 },
      { word: 'here', line: 2 },
    ]);
  });

  test('AC-26: a link target never spans lines, so the words after it on later lines stay', () => {
    const text = 'a [x](first\nsecond line\nthird) fourth';

    const found = words(stripMarkup(text));

    expect(found.filter((entry) => entry.line === 2).map((entry) => entry.word)).toEqual([
      'second',
      'line',
    ]);
  });

  test('AC-26: image alt text stays and the image path goes', () => {
    expect(stripped('![alt words](img.png)')).toEqual(['alt', 'words']);
  });

  test('AC-26: nested link text stays and only the target goes', () => {
    expect(stripped('[a [b] c](u)')).toEqual(['a', 'b', 'c']);
  });

  test('AC-26: a normal link keeps its text and drops its target', () => {
    expect(stripped('see [the docs](https://example.com/a/b) now')).toEqual([
      'see',
      'the',
      'docs',
      'now',
    ]);
  });

  test('AC-26: the output has as many lines as the input for a multi-line sample', () => {
    const text = [
      '# Title &amp; more',
      '',
      'A [link](https://example.com/x) and ![image](pic.png) here.',
      'An unclosed [x](oops',
      'baker&#039;s &nbsp; tarts)',
      '',
      '[a [b] c](u) end&rsquo;',
    ].join('\n');

    expect(stripMarkup(text).split('\n')).toHaveLength(text.split('\n').length);
  });

  test('AC-26: text without markup is left as it is', () => {
    const text = 'Plain words, no links.\nSecond line (with brackets) here.';

    expect(words(stripMarkup(text))).toEqual(words(text));
  });
});

// Spec 024: URLs in YAML targets. The AC ids below are spec 024's, not spec 021's.
describe('spec 024 stripUrls', () => {
  /** The words of a text after stripUrls, without line numbers. */
  const stripped = (text: string): string[] => words(stripUrls(text)).map((entry) => entry.word);

  test('AC-1: a quoted doc URL goes and the words around it stay', () => {
    expect(stripped('see "https://docs.aws.amazon.com/a/b.html" now')).toEqual(['see', 'now']);
  });

  test('AC-1: a YAML list item that is only a URL leaves no words', () => {
    expect(words(stripUrls('- https://example.com/x/y'))).toEqual([]);
  });

  test.each(['HTTPS://Example.COM/x', 'http://example.com/x', 'HtTp://example.com/x'])(
    'AC-1: the URL %s is removed whatever the case of its scheme',
    (url) => {
      expect(stripped(`before ${url} after`)).toEqual(['before', 'after']);
    },
  );

  test('AC-1: a URL is replaced by exactly one space', () => {
    expect(stripUrls('a https://example.com/x b')).toBe('a   b');
  });

  test.each(['"', "'", '`', '<', '>', '(', ')', '[', ']', '{', '}'])(
    'AC-1: the URL ends before %s and that character is kept',
    (delimiter) => {
      expect(stripUrls(`a https://a.example/b${delimiter} c`)).toBe(`a  ${delimiter} c`);
    },
  );

  test.each([')', ']', '>', '"', "'"])(
    'AC-1: a URL wrapped by a bracket or quote keeps the closing %s',
    (closing) => {
      const opening = { ')': '(', ']': '[', '>': '<', '"': '"', "'": "'" }[closing] as string;

      expect(stripUrls(`see ${opening}https://a.example/b${closing} now`)).toBe(
        `see ${opening} ${closing} now`,
      );
    },
  );

  test('AC-1: a URL ends at whitespace, a tab as well as a space', () => {
    expect(stripUrls('a https://a.example/b\tc d')).toBe('a  \tc d');
    expect(stripped('a https://a.example/b c d')).toEqual(['a', 'c', 'd']);
  });

  test('AC-1: query, fragment, comma and a trailing dot belong to the URL', () => {
    expect(
      stripped('go to https://example.com/p?a=1&b=2#top, then https://example.com/q. Next'),
    ).toEqual(['go', 'to', 'then', 'next']);
  });

  test('AC-1: every URL of a line is removed', () => {
    expect(stripped('one https://a.example/1 two http://b.example/2 three')).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('AC-1: text outside the URLs is unchanged, including case and punctuation', () => {
    expect(stripUrls('Keep: "Quoted", (this)! https://example.com/x - End.')).toBe(
      'Keep: "Quoted", (this)!   - End.',
    );
  });

  test('AC-2: the output has as many lines as the input', () => {
    const text = [
      'references:',
      '  - https://example.com/one',
      '',
      '  - https://example.com/two',
      'why: see https://example.com/three',
      'last line',
    ].join('\n');

    expect(stripUrls(text).split('\n')).toHaveLength(text.split('\n').length);
  });

  test('AC-2: a URL at the end of a line does not remove the next line', () => {
    const output = stripUrls('a https://x.example/y\nnext line');

    expect(output.split('\n')).toHaveLength(2);
    expect(words(output)).toEqual([
      { word: 'a', line: 1 },
      { word: 'next', line: 2 },
      { word: 'line', line: 2 },
    ]);
  });

  test('AC-2: a URL at the end of a CRLF line stops before the line break', () => {
    const output = stripUrls('a https://x.example/y\r\nnext line');

    expect(output.split('\n')).toHaveLength(2);
    expect(words(output)).toEqual([
      { word: 'a', line: 1 },
      { word: 'next', line: 2 },
      { word: 'line', line: 2 },
    ]);
  });

  test('AC-2: a URL at the very end of the text is removed and the line count stays', () => {
    const output = stripUrls('first\nsee https://x.example/y');

    expect(output.split('\n')).toHaveLength(2);
    expect(words(output)).toEqual([
      { word: 'first', line: 1 },
      { word: 'see', line: 2 },
    ]);
  });

  test('AC-2: consecutive lines that are only URLs stay separate lines', () => {
    const text = 'a\nhttps://x.example/1\nhttps://x.example/2\nb';

    const output = stripUrls(text);

    expect(output.split('\n')).toHaveLength(4);
    expect(words(output)).toEqual([
      { word: 'a', line: 1 },
      { word: 'b', line: 4 },
    ]);
  });

  test.each([
    ['ftp://host/path', 'get ftp://host/path now'],
    ['a host with a path and no scheme', 'see example.com/path for more'],
    ['a www host', 'see www.example.com/path for more'],
    ['a broken scheme', 'see http:/ /broken for more'],
    ['plain prose', 'Lemon tarts cool slowly.\nSecond line, with (brackets) and "quotes".'],
    ['an empty text', ''],
  ])('AC-3: text with no http(s) URL is returned unchanged (%s)', (_label, text) => {
    expect(stripUrls(text)).toBe(text);
  });

  test('AC-8: a comma and a dot inside or after a URL go with it, leaving no stray word', () => {
    expect(stripUrls('x https://a.example/b,c. d')).toBe('x   d');
  });

  test.each([
    ['a dot', 'x https://a.example/b. d', 'x   d'],
    ['a comma', 'x https://a.example/b, d', 'x   d'],
    ['a comma and a dot', 'x https://a.example/b,. d', 'x   d'],
  ])('AC-8: a URL ending in %s before a space loses that character', (_label, text, expected) => {
    expect(stripUrls(text)).toBe(expected);
  });
});
