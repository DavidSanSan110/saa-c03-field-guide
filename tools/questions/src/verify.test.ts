import type { Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { judge, questionDigest, quoteInPage, renderBlind } from './verify.ts';
import type { QuoteCheck, VerifierResult } from './verify.ts';
import { makeQuestion } from './__mocks__/fixtures.ts';
import {
  DOCS_URL,
  VECTOR_DIGEST_C,
  VECTOR_DIGEST_D,
  VECTOR_STEM,
  digestOf,
  vectorOptions,
  vectorQuestion,
} from './__mocks__/verify-fixtures.ts';

const asQuestion = (overrides: Record<string, unknown> = {}): Question =>
  makeQuestion({ status: 'draft', ...overrides }) as unknown as Question;

/** Five options A-E, the keys in `correct` are the correct ones. */
function multipleQuestion(correct: string[], overrides: Record<string, unknown> = {}): Question {
  const options = ['A', 'B', 'C', 'D', 'E'].map((key) => ({
    key,
    text: `Option text ${key}`,
    correct: correct.includes(key),
    why: `Reason ${key}.`,
  }));
  return asQuestion({
    type: 'multiple',
    stem: 'Which options meet the requirements of the workload? Choose two.',
    options,
    ...overrides,
  });
}

describe('renderBlind', () => {
  test('AC-16: a single-answer question is exactly the blind format with (choose 1)', () => {
    const question = asQuestion({
      id: 'd1-1.3-0007',
      stem: 'Which option keeps the keys out of the provider?',
    });

    const text = renderBlind(question).trimEnd();

    expect(text).toBe(
      [
        'id: d1-1.3-0007',
        'type: single (choose 1)',
        '',
        'Which option keeps the keys out of the provider?',
        '',
        'A. SSE-S3',
        'B. SSE-KMS',
        'C. SSE-C',
        'D. None of them',
      ].join('\n'),
    );
  });

  test('AC-16: a multiple-answer question with 2 correct options says (choose 2)', () => {
    const question = multipleQuestion(['B', 'E'], { id: 'd1-1.3-0008' });

    const text = renderBlind(question).trimEnd();

    expect(text).toBe(
      [
        'id: d1-1.3-0008',
        'type: multiple (choose 2)',
        '',
        'Which options meet the requirements of the workload? Choose two.',
        '',
        'A. Option text A',
        'B. Option text B',
        'C. Option text C',
        'D. Option text D',
        'E. Option text E',
      ].join('\n'),
    );
  });

  test('AC-16: a multiple-answer question with 3 correct options says (choose 3)', () => {
    const question = multipleQuestion(['A', 'C', 'D']);

    expect(renderBlind(question)).toContain('type: multiple (choose 3)');
  });

  test('AC-16: the stem and the option texts are trimmed', () => {
    const question = asQuestion({
      stem: '\n  Which option keeps the keys out of the provider?  \n\n',
      options: [
        { key: 'A', text: '  first  ', correct: false, why: 'x' },
        { key: 'B', text: '\tsecond\n', correct: true, why: 'x' },
        { key: 'C', text: 'third', correct: false, why: 'x' },
        { key: 'D', text: 'fourth ', correct: false, why: 'x' },
      ],
    });

    const text = renderBlind(question).trimEnd();

    expect(text.split('\n')).toEqual([
      'id: d1-1.3-0001',
      'type: single (choose 1)',
      '',
      'Which option keeps the keys out of the provider?',
      '',
      'A. first',
      'B. second',
      'C. third',
      'D. fourth',
    ]);
  });

  test('AC-16: the output uses LF line endings only', () => {
    expect(renderBlind(asQuestion())).not.toContain('\r');
  });
});

describe('renderBlind never gives the key away', () => {
  const marked = asQuestion({
    id: 'd1-1.3-0042',
    services: ['svcmarkone', 'svcmarktwo'],
    difficulty: 'hard',
    cue: 'CUEMARKER about the answer',
    references: ['https://docs.aws.amazon.com/REFMARKER/guide.html'],
    links: { guide: '/GUIDEMARKER/', diagram: 'DIAGRAMMARKER', lab: 'LABMARKER' },
    provenance: { generated_by: 'PROVMARKER' },
    options: [
      { key: 'A', text: 'first choice', correct: false, why: 'WHYMARKERA is the reason' },
      { key: 'B', text: 'second choice', correct: false, why: 'WHYMARKERB is the reason' },
      { key: 'C', text: 'third choice', correct: true, why: 'WHYMARKERC is the reason' },
      { key: 'D', text: 'fourth choice', correct: false, why: 'WHYMARKERD is the reason' },
    ],
  });

  test.each([
    'WHYMARKERA',
    'WHYMARKERB',
    'WHYMARKERC',
    'WHYMARKERD',
    'CUEMARKER',
    'REFMARKER',
    'https://',
    'docs.aws.amazon.com',
    'GUIDEMARKER',
    'DIAGRAMMARKER',
    'LABMARKER',
    'PROVMARKER',
    'svcmarkone',
    'svcmarktwo',
  ])('AC-17: the text does not contain %s', (marker) => {
    expect(renderBlind(marked)).not.toContain(marker);
  });

  test('AC-17: the text does not show the difficulty, the status or the words correct and true', () => {
    const text = renderBlind(marked);

    expect(text).not.toMatch(/\bhard\b|\bdifficulty\b/i);
    expect(text).not.toMatch(/\bcorrect\b|\btrue\b|\bfalse\b/i);
    expect(text).not.toMatch(/\bdraft\b|\bstatus\b|\bprovenance\b/i);
  });

  test('AC-17: the text is the same whichever option is the key', () => {
    const keyIsA = asQuestion({
      options: ['A', 'B', 'C', 'D'].map((key) => ({
        key,
        text: `choice ${key}`,
        correct: key === 'A',
        why: 'reason',
      })),
    });
    const keyIsD = asQuestion({
      options: ['A', 'B', 'C', 'D'].map((key) => ({
        key,
        text: `choice ${key}`,
        correct: key === 'D',
        why: 'reason',
      })),
    });

    expect(renderBlind(keyIsA)).toBe(renderBlind(keyIsD));
  });
});

describe('questionDigest', () => {
  test('AC-20: the first test vector gives 6498301f85802e9c', () => {
    expect(questionDigest(vectorQuestion('C'))).toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: the same question with only D correct gives c983a5e434db617f', () => {
    expect(questionDigest(vectorQuestion('D'))).toBe(VECTOR_DIGEST_D);
  });

  test('AC-20: it takes just type, stem and options', () => {
    const digest = questionDigest({
      type: 'single',
      stem: VECTOR_STEM,
      options: vectorOptions('C'),
    });

    expect(digest).toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: it matches the formula of the spec on another question', () => {
    const question = multipleQuestion(['A', 'D']);

    expect(questionDigest(question)).toBe(digestOf(question));
  });

  test('AC-20: changing the stem changes the digest', () => {
    const changed = vectorQuestion('C', { stem: `${VECTOR_STEM} Please.` });

    expect(questionDigest(changed)).not.toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: changing the text of one option changes the digest', () => {
    const options = vectorOptions('C').map((option) =>
      option.key === 'B' ? { ...option, text: 'SSE-KMS (managed)' } : option,
    );

    expect(questionDigest(vectorQuestion('C', { options }))).not.toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: changing which option is correct changes the digest', () => {
    expect(questionDigest(vectorQuestion('A'))).not.toBe(VECTOR_DIGEST_C);
    expect(questionDigest(vectorQuestion('A'))).not.toBe(VECTOR_DIGEST_D);
  });

  test('AC-20: the values are not trimmed: extra whitespace changes the digest', () => {
    const changed = vectorQuestion('C', { stem: `${VECTOR_STEM} ` });

    expect(questionDigest(changed)).not.toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: changing why, cue or references does not change the digest', () => {
    const options = vectorOptions('C').map((option) => ({ ...option, why: 'Another reason.' }));
    const changed = vectorQuestion('C', {
      options,
      cue: 'A new cue',
      references: ['https://docs.aws.amazon.com/other/page.html'],
    });

    expect(questionDigest(changed)).toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: changing the difficulty, the services or the status does not change the digest', () => {
    const changed = vectorQuestion('C', {
      difficulty: 'hard',
      services: ['ec2'],
      status: 'verified',
    });

    expect(questionDigest(changed)).toBe(VECTOR_DIGEST_C);
  });

  test('AC-20: the digest is 16 lower-case hex characters', () => {
    expect(questionDigest(multipleQuestion(['A', 'B']))).toMatch(/^[0-9a-f]{16}$/);
  });
});

const QUOTE = 'The caller sends the key with each request.';

/** A result whose fields can be left out by passing `undefined` (the key is then absent). */
type Override = { [K in keyof VerifierResult]?: VerifierResult[K] | undefined };

function result(overrides: Override = {}): VerifierResult {
  const merged = { id: 'd1-1.3-0007', answer: ['C'], quote: QUOTE, source: DOCS_URL, ...overrides };
  const present = Object.entries(merged).filter(([, value]) => value !== undefined);
  return Object.fromEntries(present) as unknown as VerifierResult;
}

describe('judge: verified', () => {
  test('AC-21: matching answer, quote and docs source with a found quote are verified', () => {
    const verification = judge(vectorQuestion('C'), result(), 'claude-opus', 'found');

    expect(verification).toEqual({
      result: 'verified',
      reasons: [],
      verifier: 'claude-opus',
      answer: ['C'],
      key: ['C'],
      quote: QUOTE,
      source: DOCS_URL,
      quote_check: 'found',
      digest: VECTOR_DIGEST_C,
    });
  });

  test('AC-21: a skipped quote check is accepted', () => {
    const verification = judge(vectorQuestion('C'), result(), 'claude-opus', 'skipped');

    expect(verification.result).toBe('verified');
    expect(verification.reasons).toEqual([]);
    expect(verification.quote_check).toBe('skipped');
  });

  test('AC-21: the case of the answer is ignored and the answer is reported upper-case', () => {
    const verification = judge(vectorQuestion('C'), result({ answer: ['c'] }), 'v', 'found');

    expect(verification.result).toBe('verified');
    expect(verification.answer).toEqual(['C']);
    expect(verification.key).toEqual(['C']);
  });

  test('AC-21: the order of the answer is ignored and answer and key are sorted', () => {
    const question = multipleQuestion(['A', 'D']);

    const verification = judge(question, result({ answer: ['d', 'A'] }), 'v', 'found');

    expect(verification.result).toBe('verified');
    expect(verification.answer).toEqual(['A', 'D']);
    expect(verification.key).toEqual(['A', 'D']);
  });

  test('AC-21: notes are kept when given and absent when not', () => {
    const withNotes = judge(vectorQuestion('C'), result({ notes: 'A remark.' }), 'v', 'found');
    const without = judge(vectorQuestion('C'), result(), 'v', 'found');

    expect(withNotes.notes).toBe('A remark.');
    expect('notes' in without).toBe(false);
  });

  test('AC-21: the digest is the digest of the question', () => {
    const question = multipleQuestion(['B', 'C']);

    const verification = judge(question, result({ answer: ['B', 'C'] }), 'v', 'found');

    expect(verification.digest).toBe(digestOf(question));
  });

  test('AC-21: the verifier name is passed through', () => {
    expect(judge(vectorQuestion('C'), result(), 'claude-opus-x', 'found').verifier).toBe(
      'claude-opus-x',
    );
  });
});

describe('judge: mismatch', () => {
  test('AC-22: another key is a mismatch with a reason naming the answer and the key', () => {
    const verification = judge(vectorQuestion('C'), result({ answer: ['B'] }), 'v', 'found');

    expect(verification.result).toBe('mismatch');
    expect(verification.reasons.length).toBeGreaterThan(0);
    const reasons = verification.reasons.join(' ');
    expect(reasons).toMatch(/\bB\b/);
    expect(reasons).toMatch(/\bC\b/);
    expect(verification.answer).toEqual(['B']);
    expect(verification.key).toEqual(['C']);
  });

  test('AC-22: a subset of the key is a mismatch', () => {
    const question = multipleQuestion(['A', 'D']);

    const verification = judge(question, result({ answer: ['A'] }), 'v', 'found');

    expect(verification.result).toBe('mismatch');
    expect(verification.reasons.length).toBeGreaterThan(0);
  });

  test('AC-22: a superset of the key is a mismatch', () => {
    const question = multipleQuestion(['A', 'D']);

    const verification = judge(question, result({ answer: ['A', 'D', 'E'] }), 'v', 'found');

    expect(verification.result).toBe('mismatch');
    expect(verification.reasons.length).toBeGreaterThan(0);
    expect(verification.reasons.join(' ')).toMatch(/\bE\b/);
  });

  test('AC-22: no answer at all is a mismatch', () => {
    const verification = judge(vectorQuestion('C'), result({ answer: [] }), 'v', 'found');

    expect(verification.result).toBe('mismatch');
    expect(verification.reasons.length).toBeGreaterThan(0);
    expect(verification.answer).toEqual([]);
  });

  test('AC-22: a wrong answer with a missing quote is still a mismatch, not unsupported', () => {
    const verification = judge(
      vectorQuestion('C'),
      result({ answer: ['A'], quote: '', source: 'http://example.com/' }),
      'v',
      'none',
    );

    expect(verification.result).toBe('mismatch');
  });

  test('AC-22: a mismatch keeps the digest and the quote fields', () => {
    const verification = judge(vectorQuestion('C'), result({ answer: ['A'] }), 'v', 'found');

    expect(verification.digest).toBe(VECTOR_DIGEST_C);
    expect(verification.quote).toBe(QUOTE);
    expect(verification.source).toBe(DOCS_URL);
    expect(verification.quote_check).toBe('found');
  });
});

describe('judge: unsupported', () => {
  function unsupported(overrides: Override, check: QuoteCheck): ReturnType<typeof judge> {
    return judge(vectorQuestion('C'), result(overrides), 'claude-opus', check);
  }

  test.each([
    ['no quote', { quote: undefined }, 'none'],
    ['an empty quote', { quote: '' }, 'none'],
    ['a blank quote', { quote: '  \n\t ' }, 'none'],
    ['no source', { source: undefined }, 'none'],
    ['an http:// source', { source: 'http://docs.aws.amazon.com/s3/x.html' }, 'none'],
    ['a source that is not on the docs site', { source: 'https://example.com/s3' }, 'none'],
    [
      'a source whose host only starts like the docs site',
      { source: 'https://docs.aws.amazon.com.evil.example/s3' },
      'none',
    ],
    ['a blog post source', { source: 'https://aws.amazon.com/blogs/x/' }, 'none'],
    ['a quote that is not on the page', {}, 'not-found'],
    ['a page that could not be fetched', {}, 'fetch-failed'],
  ] as [string, Override, QuoteCheck][])(
    'AC-23: with a matching answer, %s is unsupported with a reason',
    (_name, overrides, check) => {
      const verification = unsupported(overrides, check);

      expect(verification.result).toBe('unsupported');
      expect(verification.reasons.length).toBeGreaterThan(0);
      expect(verification.answer).toEqual(['C']);
      expect(verification.key).toEqual(['C']);
    },
  );

  test('AC-23: a missing quote and a missing source are reported as empty strings', () => {
    const verification = judge(
      vectorQuestion('C'),
      { id: 'd1-1.3-0007', answer: ['C'] },
      'claude-opus',
      'none',
    );

    expect(verification.result).toBe('unsupported');
    expect(verification.quote).toBe('');
    expect(verification.source).toBe('');
    expect(verification.quote_check).toBe('none');
  });

  test('AC-23: every failed check gets its own reason', () => {
    const verification = judge(
      vectorQuestion('C'),
      { id: 'd1-1.3-0007', answer: ['C'] },
      'claude-opus',
      'none',
    );

    expect(verification.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test('AC-23: the check result is passed through', () => {
    expect(unsupported({}, 'not-found').quote_check).toBe('not-found');
    expect(unsupported({}, 'fetch-failed').quote_check).toBe('fetch-failed');
  });
});

describe('quoteInPage', () => {
  test('AC-24: finds a quote that spans tags and entities, ignoring case and punctuation', () => {
    const html = '<p>Use <code>SSE-C</code> &amp; HTTPS.</p>';

    expect(quoteInPage(html, 'use SSE-C & https')).toBe(true);
  });

  test('AC-24: finds the exact text of a sentence', () => {
    const html =
      '<html><body><h1>Title</h1><p>The caller sends the key with each request.</p></body></html>';

    expect(quoteInPage(html, QUOTE)).toBe(true);
  });

  test('AC-24: ignores case', () => {
    expect(quoteInPage('<p>Server-Side Encryption</p>', 'SERVER-SIDE ENCRYPTION')).toBe(true);
  });

  test('AC-24: ignores punctuation on either side', () => {
    expect(
      quoteInPage('<p>keys, (rotated) yearly; always!</p>', 'keys rotated yearly always'),
    ).toBe(true);
  });

  test('AC-24: decodes named, decimal and hexadecimal entities', () => {
    const html = '<p>don&#39;t use &quot;plain&quot; text &#x26; more</p>';

    expect(quoteInPage(html, 'dont use plain text')).toBe(true);
  });

  test('AC-24: does not match text that is only inside a script', () => {
    const html = '<p>Other text.</p><script>var tip = "use SSE-C for customer keys";</script>';

    expect(quoteInPage(html, 'use SSE-C for customer keys')).toBe(false);
  });

  test('AC-24: does not match text that is only inside a style', () => {
    const html = '<style>.note::after { content: "use SSE-C for customer keys"; }</style><p>x</p>';

    expect(quoteInPage(html, 'use SSE-C for customer keys')).toBe(false);
  });

  test('AC-24: still finds text outside the script when a script is present', () => {
    const html = '<script>var a = 1;</script><p>use SSE-C for customer keys</p>';

    expect(quoteInPage(html, 'use SSE-C for customer keys')).toBe(true);
  });

  test('AC-24: does not match words that are present but not contiguous', () => {
    const html = '<p>Use SSE-C and then HTTPS for the requests.</p>';

    expect(quoteInPage(html, 'use SSE-C https')).toBe(false);
  });

  test('AC-24: does not match words in a different order', () => {
    expect(quoteInPage('<p>keys are rotated</p>', 'rotated keys')).toBe(false);
  });

  test('AC-24: does not match a quote that is not on the page at all', () => {
    expect(quoteInPage('<p>Nothing about the topic here.</p>', QUOTE)).toBe(false);
  });
});
