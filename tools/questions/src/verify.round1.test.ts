// Review round 1 (regression ACs) of spec 022: AC-33 and AC-35 at unit level.
import { describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { parseResults, quoteInPage } from './verify.ts';

describe('quoteInPage decodes the common named entities', () => {
  test('AC-33: &rsquo; gives the typographic apostrophe, so the quote matches with either apostrophe', () => {
    const html = '<p>The service doesn&rsquo;t store it.</p>';

    expect(quoteInPage(html, 'doesn’t store it')).toBe(true);
    expect(quoteInPage(html, "doesn't store it")).toBe(true);
  });

  test('AC-33: &lsquo; gives an apostrophe-like character that normalise removes', () => {
    expect(quoteInPage('<p>it&lsquo;s fine</p>', "it's fine")).toBe(true);
  });

  test('AC-33: &mdash; separates words: keys&mdash;rotated contains "keys rotated"', () => {
    expect(quoteInPage('<p>keys&mdash;rotated</p>', 'keys rotated')).toBe(true);
  });

  test.each([
    ['ldquo', 'say&ldquo;hello&rdquo;now'],
    ['rdquo', 'say&ldquo;hello&rdquo;now'],
    ['ndash', 'say&ndash;hello&ndash;now'],
    ['mdash', 'say&mdash;hello&mdash;now'],
    ['hellip', 'say&hellip;hello&hellip;now'],
    ['copy', 'say&copy;hello&copy;now'],
    ['reg', 'say&reg;hello&reg;now'],
    ['nbsp', 'say&nbsp;hello&nbsp;now'],
  ])('AC-33: &%s; is decoded: the entity name does not stay as a word', (name, text) => {
    const html = `<p>${text}</p>`;

    expect(quoteInPage(html, 'say hello now')).toBe(true);
    expect(quoteInPage(html, `say ${name} hello ${name} now`)).toBe(false);
  });

  test('AC-33: &trade; is decoded (the character normalises to the word tm, not to "trade")', () => {
    const html = '<p>Brand&trade; service</p>';

    expect(quoteInPage(html, 'brand tm service')).toBe(true);
    expect(quoteInPage(html, 'brand trade service')).toBe(false);
  });

  test.each([
    ['&AMP;', 'use SSE-C &AMP; HTTPS', 'use SSE-C & https'],
    ['&LT; and &GT;', 'a &LT; b &GT; c', 'a b c'],
  ])('AC-33: upper-case %s is decoded too', (_name, text, quote) => {
    expect(quoteInPage(`<p>${text}</p>`, quote)).toBe(true);
  });

  test('AC-33: &QUOT; in upper case is a quotation mark, not a word', () => {
    const html = '<p>say &QUOT;hello&QUOT; now</p>';

    expect(quoteInPage(html, 'say hello now')).toBe(true);
    expect(quoteInPage(html, 'say quot hello quot now')).toBe(false);
  });

  test('AC-33: &amp;, &lt;, &gt; and &quot; in lower case still work', () => {
    const html = '<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>';

    expect(quoteInPage(html, 'a b c d e')).toBe(true);
    expect(quoteInPage(html, 'a amp b')).toBe(false);
  });

  test('AC-33: an unknown entity stays as text', () => {
    const html = '<p>keep &zzfoo; here</p>';

    expect(quoteInPage(html, 'keep zzfoo here')).toBe(true);
    expect(quoteInPage(html, 'keep here')).toBe(false);
  });

  test('AC-33: a decoded entity does not become a tag', () => {
    const html = '<p>use &lt;script&gt;alert(1)&lt;/script&gt; never</p>';

    expect(quoteInPage(html, 'use script alert 1 script never')).toBe(true);
  });
});

/** An answer sheet as text: the valid base with the given changes. */
function sheet(
  overrides: Record<string, unknown> = {},
  result: Record<string, unknown> = {},
): string {
  return stringify({
    verifier: 'claude-opus',
    results: [{ id: 'd1-1.3-0007', answer: ['C'], quote: 'A sentence.', ...result }],
    ...overrides,
  });
}

describe('parseResults problems', () => {
  test('AC-35: a valid sheet has no problem', () => {
    const parsed = parseResults(sheet());

    expect(parsed.problems).toEqual([]);
    expect(parsed.verifier).toBe('claude-opus');
    expect(parsed.results).toHaveLength(1);
  });

  test('AC-35: an empty results list is a problem', () => {
    expect(parseResults(sheet({ results: [] })).problems.length).toBeGreaterThan(0);
  });

  test('AC-35: a missing verifier is a problem', () => {
    const text = stringify({ results: [{ id: 'd1-1.3-0007', answer: ['C'] }] });

    expect(parseResults(text).problems.length).toBeGreaterThan(0);
  });

  test.each([
    ['uppercase letters', 'Claude-Opus'],
    ['a space', 'claude opus'],
    ['an underscore', 'claude_opus'],
    ['an empty string', ''],
    ['a number', 5],
    ['a leading hyphen', '-claude'],
  ])('AC-35: a verifier with %s is not a slug and is a problem', (_name, verifier) => {
    expect(parseResults(sheet({ verifier })).problems.length).toBeGreaterThan(0);
  });

  test('AC-35: an unknown top-level key is a problem', () => {
    expect(parseResults(sheet({ extra: 1 })).problems.length).toBeGreaterThan(0);
  });

  test('AC-35: an unknown key in a result is a problem', () => {
    expect(parseResults(sheet({}, { confidence: 'high' })).problems.length).toBeGreaterThan(0);
  });

  test.each([
    ['a string', 'C'],
    ['a mapping', { C: true }],
    ['a number', 3],
    ['null', null],
  ])('AC-35: an answer that is %s (not a list) is a problem', (_name, answer) => {
    expect(parseResults(sheet({}, { answer })).problems.length).toBeGreaterThan(0);
  });

  test.each([
    ['quote', 5],
    ['quote', ['a sentence']],
    ['source', 5],
    ['source', { url: 'https://docs.aws.amazon.com/x' }],
    ['notes', 5],
    ['notes', ['a remark']],
    ['notes', { remark: 'x' }],
  ])('AC-35: a %s that is not a string (%j) is a problem', (key, value) => {
    expect(parseResults(sheet({}, { [key]: value })).problems.length).toBeGreaterThan(0);
  });

  test('AC-35: invalid YAML is a problem', () => {
    expect(parseResults('verifier: [unclosed\n').problems.length).toBeGreaterThan(0);
  });
});
