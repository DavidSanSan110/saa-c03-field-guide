import { describe, expect, test } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { withDedupe } from './dedupe.ts';
import { withSidecarKey } from './sidecar.ts';

/** Any error message but the one of an unimplemented stub: a real YAML or validation error. */
const NOT_A_STUB = /^(?!not implemented)/;

const CRLF = '\r\n';

const VERIFICATION = {
  result: 'verified',
  reasons: [],
  verifier: 'claude-opus',
  answer: ['C'],
  key: ['C'],
  quote: 'The caller sends the key with each request.',
  source: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/x.html',
  quote_check: 'found',
  notes: 'A remark.',
  digest: '6498301f85802e9c',
};

const FAILED = {
  result: 'unsupported',
  reasons: ['the quote was not found on the page', 'the source is missing'],
  verifier: 'claude-opus',
  answer: ['A', 'C'],
  key: ['A', 'C'],
  quote: '',
  source: '',
  quote_check: 'none',
  digest: 'c983a5e434db617f',
};

/** Nested mappings and lists of mappings, which a flow-style writer would put in `{ }` / `[ ]`. */
const NESTED = {
  name: 'nested',
  checks: [
    { name: 'facts', ok: true, tags: ['a', 'b'] },
    { name: 'wording', ok: false, tags: [] },
  ],
  deep: { one: { two: { three: [1, 2, 3] } } },
};

/** The lines of an LF text, without the final line break. */
const linesOfLf = (text: string): string[] => text.replace(/\n$/, '').split('\n');

/** A top-level `verification:` block: the key line and the indented lines that follow it. */
function splitBlock(
  textLines: string[],
  key = 'verification',
): { block: string[]; rest: string[]; at: number } {
  const at = textLines.indexOf(`${key}:`);
  if (at < 0) return { block: [], rest: textLines, at: textLines.length };
  let end = at + 1;
  while (end < textLines.length && /^\s/.test(textLines[end] as string)) end++;
  return {
    block: textLines.slice(at, end),
    rest: [...textLines.slice(0, at), ...textLines.slice(end)],
    at,
  };
}

describe('withSidecarKey basics', () => {
  test('AC-31: without an existing file, the text is a mapping with only that key', () => {
    const text = withSidecarKey(undefined, 'verification', VERIFICATION);

    expect(parse(text)).toEqual({ verification: VERIFICATION });
  });

  test('AC-31: it works for any key name', () => {
    const text = withSidecarKey(undefined, 'other_key', { a: 1 });

    expect(parse(text)).toEqual({ other_key: { a: 1 } });
  });

  test('AC-31: every other top-level key is kept with the same value', () => {
    const existing = [
      'dedupe:',
      '  threshold: 0.5',
      '  similar:',
      '    - { id: d1-1.3-0001, folder: bank, path: d1/1.3/sse-c.yaml, score: 0.62 }',
      'notes: written by hand',
      'count: 3',
      '',
    ].join('\n');

    const result = parse(withSidecarKey(existing, 'verification', VERIFICATION)) as Record<
      string,
      unknown
    >;

    expect(result.dedupe).toEqual({
      threshold: 0.5,
      similar: [{ id: 'd1-1.3-0001', folder: 'bank', path: 'd1/1.3/sse-c.yaml', score: 0.62 }],
    });
    expect(result.notes).toBe('written by hand');
    expect(result.count).toBe(3);
    expect(result.verification).toEqual(VERIFICATION);
    expect(Object.keys(result).sort()).toEqual(['count', 'dedupe', 'notes', 'verification']);
  });

  test('AC-31: an existing key is replaced, not merged', () => {
    const existing = [
      'verification:',
      '  result: mismatch',
      '  stale: true',
      '  answer:',
      '    - A',
      'dedupe: { threshold: 0.5, similar: [] }',
      '',
    ].join('\n');

    const result = parse(withSidecarKey(existing, 'verification', FAILED)) as Record<
      string,
      unknown
    >;

    expect(result.verification).toEqual(FAILED);
    expect(result.dedupe).toEqual({ threshold: 0.5, similar: [] });
  });

  test('AC-31: the result holds the key once', () => {
    const text = withSidecarKey('verification: { result: mismatch }\n', 'verification', FAILED);

    expect(text.match(/^verification:/gm)).toHaveLength(1);
    expect(parse(text)).toEqual({ verification: FAILED });
  });

  test('AC-31: the other text of the file stays as it is when the key is replaced in place', () => {
    const existing = 'a: 1 # one\nverification: { result: mismatch }\nz: 2 # two\n';

    const text = withSidecarKey(existing, 'verification', FAILED);

    const { rest, at } = splitBlock(linesOfLf(text));
    expect(rest).toEqual(['a: 1 # one', 'z: 2 # two']);
    expect(at).toBe(1);
  });
});

describe('withSidecarKey rejects what it cannot splice', () => {
  test('AC-31: invalid YAML throws', () => {
    expect(() => withSidecarKey('a: [unclosed\n', 'verification', VERIFICATION)).toThrow(
      NOT_A_STUB,
    );
  });

  test.each([
    ['a sequence', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
    ['a number', '42\n'],
    ['null', 'null\n'],
  ])('AC-31: a YAML document that is %s throws', (_name, existing) => {
    expect(() => withSidecarKey(existing, 'verification', VERIFICATION)).toThrow(NOT_A_STUB);
  });
});

describe('withSidecarKey block style', () => {
  /** No `{` or `[` at all, except the empty list `[]`. */
  const flowFree = (text: string): string => text.replaceAll('[]', '');

  test('AC-31: the verification value has no flow mapping or flow list', () => {
    const text = withSidecarKey(undefined, 'verification', VERIFICATION);

    expect(flowFree(text)).not.toContain('{');
    expect(flowFree(text)).not.toContain('[');
  });

  test('AC-31: nested mappings and lists of mappings are written in block style', () => {
    const text = withSidecarKey(undefined, 'verification', NESTED);

    expect(parse(text)).toEqual({ verification: NESTED });
    expect(flowFree(text)).not.toMatch(/[{[]/);
    expect(text).toMatch(/^\s+- name: facts$/m);
  });

  test('AC-31: an empty list is the only flow collection allowed', () => {
    const text = withSidecarKey(undefined, 'verification', { reasons: [], answer: ['C'] });

    expect(parse(text)).toEqual({ verification: { reasons: [], answer: ['C'] } });
    expect(text).toMatch(/reasons: \[\]/);
    expect(flowFree(text)).not.toMatch(/[{[]/);
  });

  test('AC-31: text with colons, quotes, hashes and look-alike scalars survives a round trip', () => {
    const value = {
      colon: 'He said: use SSE-C',
      quotes: `"double" and 'single'`,
      hash: 'not # a comment',
      dash: '- not a list item',
      yes: 'yes',
      nothing: 'null',
      number: '0123',
      version: '1.0',
      blank: '',
      multiline: 'first line\nsecond line',
      long: `${'word '.repeat(60)}end`,
    };

    const text = withSidecarKey(undefined, 'verification', value);

    expect(parse(text)).toEqual({ verification: value });
  });

  test('AC-31: a later splice of another key keeps working and keeps the first key', () => {
    const once = withSidecarKey(undefined, 'verification', VERIFICATION);

    const twice = withSidecarKey(once, 'extra', NESTED);

    expect(parse(twice)).toEqual({ verification: VERIFICATION, extra: NESTED });
  });

  test('AC-31: withDedupe on a sidecar written by withSidecarKey keeps the verification', () => {
    const once = withSidecarKey(undefined, 'verification', VERIFICATION);

    const text = withDedupe(once, 0.5, []);

    expect(parse(text)).toEqual({
      verification: VERIFICATION,
      dedupe: { threshold: 0.5, similar: [] },
    });
  });

  test('AC-31: withSidecarKey on a sidecar written by withDedupe keeps the dedupe key', () => {
    const once = withDedupe(undefined, 0.5, []);

    const text = withSidecarKey(once, 'verification', VERIFICATION);

    expect(parse(text)).toEqual({
      dedupe: { threshold: 0.5, similar: [] },
      verification: VERIFICATION,
    });
  });
});

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

describe('withSidecarKey keeps the rest of the file as text', () => {
  test('AC-31: comments, key order and the text of the other keys are kept; a new key goes last', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withSidecarKey(existing, 'verification', VERIFICATION);

    const rows = linesOfLf(output).filter((line) => line.trim() !== '');
    const { block, rest, at } = splitBlock(rows);
    expect(rest).toEqual(COMMENTED_SIDECAR);
    expect(at).toBe(COMMENTED_SIDECAR.length);
    expect(parse(block.join('\n'))).toEqual({ verification: VERIFICATION });
  });

  test('AC-31: the long string is not re-wrapped', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withSidecarKey(existing, 'verification', VERIFICATION);

    expect(linesOfLf(output)).toContain(`long: ${LONG_VALUE}`);
  });

  test('AC-31: the keys are not sorted', () => {
    const existing = COMMENTED_SIDECAR.join(CRLF) + CRLF;

    const output = withSidecarKey(existing, 'verification', VERIFICATION);

    expect(Object.keys(parse(output) as object)).toEqual([
      'zeta',
      'alpha',
      'long',
      'omega',
      'verification',
    ]);
  });

  test('AC-31: an existing key is replaced in place, the other lines are kept', () => {
    const before = COMMENTED_SIDECAR.slice(0, 5);
    const after = COMMENTED_SIDECAR.slice(5);
    const stale = [
      'verification:',
      '  result: mismatch',
      '  answer:',
      '    - A',
      '  key: { 0: C }',
    ];
    const existing = [...before, ...stale, ...after].join(CRLF) + CRLF;

    const output = withSidecarKey(existing, 'verification', VERIFICATION);

    const rows = linesOfLf(output).filter((line) => line.trim() !== '');
    const { block, rest, at } = splitBlock(rows);
    expect(rest).toEqual(COMMENTED_SIDECAR);
    expect(at).toBe(before.length);
    expect(parse(block.join('\n'))).toEqual({ verification: VERIFICATION });
  });

  test('AC-31: the output has LF line endings only', () => {
    const withCrlf = COMMENTED_SIDECAR.join(CRLF) + CRLF;
    const withMixed = `${COMMENTED_SIDECAR.join(CRLF)}\nextra: 1\r\n`;

    expect(withSidecarKey(withCrlf, 'verification', VERIFICATION)).not.toContain('\r');
    expect(withSidecarKey(withMixed, 'verification', VERIFICATION)).not.toContain('\r');
    expect(withSidecarKey(undefined, 'verification', VERIFICATION)).not.toContain('\r');
  });

  test.each([
    ['a CRLF sidecar with comments', COMMENTED_SIDECAR.join(CRLF) + CRLF],
    [
      'a sidecar with an existing verification key',
      'a: 1\nverification:\n  result: mismatch\n  answer:\n    - A\nb: 2\n',
    ],
    ['no sidecar', undefined],
  ])('AC-31: a second call with the same arguments gives the same text (%s)', (_name, existing) => {
    const once = withSidecarKey(existing, 'verification', VERIFICATION);

    expect(withSidecarKey(once, 'verification', VERIFICATION)).toBe(once);
  });

  test('AC-31: the same input always gives the same text', () => {
    const existing = COMMENTED_SIDECAR.join('\n') + '\n';

    expect(withSidecarKey(existing, 'verification', FAILED)).toBe(
      withSidecarKey(existing, 'verification', FAILED),
    );
  });
});

describe('withSidecarKey on an empty sidecar', () => {
  test.each([
    ['an empty string', ''],
    ['only a comment', '# only a comment\n'],
    ['only a document marker', '---\n'],
    ['a document marker with a comment', '--- # c\n'],
  ])('AC-31: %s counts as an empty mapping', (_name, existing) => {
    const output = withSidecarKey(existing, 'verification', VERIFICATION);

    expect(parse(output)).toEqual({ verification: VERIFICATION });
  });

  test('AC-31: the output has no CR and the same text again on a second call', () => {
    const once = withSidecarKey('# only a comment\n', 'verification', VERIFICATION);

    expect(once).not.toContain('\r');
    expect(withSidecarKey(once, 'verification', VERIFICATION)).toBe(once);
  });
});

/**
 * `withSidecarKey` must either throw or return one YAML document, without errors, whose value is
 * the input mapping with only the key replaced (added last when absent).
 */
function outcomeOf(
  existing: string,
):
  | { threw: false; documents: number; errors: number; value: unknown }
  | { threw: true; error: unknown } {
  let output: string;
  try {
    output = withSidecarKey(existing, 'verification', FAILED);
  } catch (error) {
    return { threw: true, error };
  }
  const documents = parseAllDocuments(output);
  let value: unknown;
  try {
    value = documents[0]?.toJS();
  } catch (error) {
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
  if (outcome.threw) {
    // A rejection must be a real error, not the "not implemented" of a stub.
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(NOT_A_STUB);
    return;
  }
  expect(outcome.documents).toBe(1);
  expect(outcome.errors).toBe(0);
  expect(outcome.value).toEqual(expected);
}

describe('withSidecarKey never loses or moves data', () => {
  test('AC-31: a document end marker (...) is handled or rejected', () => {
    expectThrowsOrKeepsData('a: 1\n...\n', { a: 1, verification: FAILED });
  });

  test('AC-31: a document end marker with a comment is handled or rejected', () => {
    expectThrowsOrKeepsData('a: 1\n... # end\n', { a: 1, verification: FAILED });
  });

  test('AC-31: a mapping indented by spaces is handled or rejected', () => {
    expectThrowsOrKeepsData('  a: 1\n  b: 2\n', { a: 1, b: 2, verification: FAILED });
  });

  test('AC-31: an indented mapping with the key followed by another key keeps that key', () => {
    expectThrowsOrKeepsData('  verification: 1\n  b: 2\n', { verification: FAILED, b: 2 });
  });

  test('AC-31: an indented mapping with a dedupe mapping after the key keeps the mapping', () => {
    expectThrowsOrKeepsData('  verification: 1\n  dedupe:\n    threshold: 0.5\n', {
      verification: FAILED,
      dedupe: { threshold: 0.5 },
    });
  });

  test('AC-31: an anchor on the old value that is used elsewhere is handled or rejected', () => {
    expectThrowsOrKeepsData('verification: &d 1\nx: *d\n', { verification: FAILED, x: 1 });
  });
});
