// The blind verifier helpers (spec 022): the blind text of a question, the digest, the answer
// sheet, the quote check and the verdict. No file system or network access: the fetch is in
// tools/questions/src/cli.ts.
import { createHash } from 'node:crypto';
import type { Question } from '@field-guide/schema';
import { parse } from 'yaml';
import { normalise } from './dedupe.ts';

const DOCS_PREFIX = 'https://docs.aws.amazon.com/';
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Code-unit order, the same on every machine (unlike localeCompare). */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The first 16 hex characters of the SHA-256 of what the verifier judged plus the key. */
export function questionDigest(q: Pick<Question, 'type' | 'stem' | 'options'>): string {
  const json = JSON.stringify({
    type: q.type,
    stem: q.stem,
    options: q.options.map(({ key, text, correct }) => ({ key, text, correct })),
  });
  return createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 16);
}

/** The question as the verifier sees it: id, type, stem and options, without the key. */
export function renderBlind(q: Question): string {
  const choose = q.options.filter((option) => option.correct).length;
  return [
    `id: ${q.id}`,
    `type: ${q.type} (choose ${String(choose)})`,
    '',
    q.stem.trim(),
    '',
    ...q.options.map((option) => `${option.key}. ${option.text.trim()}`),
  ].join('\n');
}

export interface VerifierResult {
  id: string;
  answer: string[];
  quote?: string;
  source?: string;
  notes?: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first unknown key of a mapping, as a problem text; else undefined. */
function unknownKey(value: Record<string, unknown>, allowed: string[], where: string) {
  const key = Object.keys(value).find((name) => !allowed.includes(name));
  return key === undefined ? undefined : `${where}: unknown key "${key}"`;
}

function parseResult(value: unknown, index: number): VerifierResult | string {
  const where = `results[${String(index)}]`;
  if (!isMapping(value)) return `${where}: must be a mapping`;
  const unknown = unknownKey(value, ['id', 'answer', 'quote', 'source', 'notes'], where);
  if (unknown !== undefined) return unknown;
  const { id, answer, quote, source, notes } = value;
  if (typeof id !== 'string' || id === '') return `${where}: id must be a non-empty string`;
  if (!Array.isArray(answer) || !answer.every((key) => typeof key === 'string')) {
    return `${where} (${id}): answer must be a list of option keys`;
  }
  const result: VerifierResult = { id, answer: answer };
  for (const [name, text] of [
    ['quote', quote],
    ['source', source],
    ['notes', notes],
  ] as const) {
    if (text === undefined) continue;
    if (typeof text !== 'string') return `${where} (${id}): ${name} must be a string`;
    result[name] = text;
  }
  return result;
}

/** Parses the verifier's answer sheet. */
export function parseResults(text: string): {
  verifier?: string;
  results: VerifierResult[];
  problems: string[];
} {
  const fail = (problem: string) => ({ results: [], problems: [problem] });
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return fail(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isMapping(data)) return fail('the results file must be a mapping');
  const unknown = unknownKey(data, ['verifier', 'results'], 'results file');
  if (unknown !== undefined) return fail(unknown);
  const { verifier, results } = data;
  if (typeof verifier !== 'string' || !SLUG_PATTERN.test(verifier)) {
    return fail('verifier must be a lowercase slug such as claude-opus');
  }
  if (!Array.isArray(results)) return fail('results must be a list');
  if (results.length === 0) return fail('results is empty');

  const parsed: VerifierResult[] = [];
  const problems: string[] = [];
  results.forEach((item: unknown, index) => {
    const result = parseResult(item, index);
    if (typeof result === 'string') problems.push(result);
    else if (parsed.some((other) => other.id === result.id)) {
      problems.push(`the id ${result.id} appears twice in the results`);
    } else parsed.push(result);
  });
  return { verifier, results: parsed, problems };
}

export type QuoteCheck = 'found' | 'not-found' | 'fetch-failed' | 'skipped' | 'none';

/** Named entities; the quotes become ASCII ones, which `normalise` drops like the typographic ones. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  copy: '©',
  reg: '®',
  trade: '™',
};
const UPPER_CASE_ENTITIES = ['amp', 'lt', 'gt', 'quot'];

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec, hex, name) => {
    if (typeof name === 'string') {
      const lower = name.toLowerCase();
      const known = name === lower || UPPER_CASE_ENTITIES.includes(lower);
      return (known ? NAMED_ENTITIES[lower] : undefined) ?? all;
    }
    const code = typeof dec === 'string' ? Number(dec) : parseInt(hex as string, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

/** The words of a text; NFKC turns the trade mark sign into the letters TM, so it is set apart. */
function wordsOf(text: string): string[] {
  return normalise(text.replace(/™/g, ' ™ '));
}

/** The words of the visible text of an HTML page. */
function pageWords(html: string): string[] {
  const visible = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  return wordsOf(decodeEntities(visible));
}

/** Whether the quote's words appear as one contiguous run of the page's text words. */
export function quoteInPage(html: string, quote: string): boolean {
  const wanted = wordsOf(quote);
  if (wanted.length === 0) return false;
  const words = pageWords(html);
  for (let start = 0; start + wanted.length <= words.length; start++) {
    if (wanted.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/** Whether the source is a page of the AWS documentation. */
export function isDocsSource(source: string | undefined): boolean {
  return source !== undefined && source.startsWith(DOCS_PREFIX);
}

/** Whether the final URL of a fetch is acceptable: on the docs site (empty when not reported). */
export function isFinalDocsUrl(url: string): boolean {
  return url === '' || isDocsSource(url);
}

/** The page to fetch for the quote check of a result: its docs source, when it has a quote. */
export function pageToCheck(r: VerifierResult): string | undefined {
  const hasQuote = (r.quote ?? '').trim() !== '';
  return hasQuote && isDocsSource(r.source) ? r.source : undefined;
}

/**
 * The quote check of a result. `pages` maps a fetched source to its HTML (undefined when the fetch
 * failed); without it nothing was fetched.
 */
export function quoteCheckOf(
  r: VerifierResult,
  pages: Map<string, string | undefined> | undefined,
): QuoteCheck {
  const url = pageToCheck(r);
  if (url === undefined) return 'none';
  if (pages === undefined) return 'skipped';
  const html = pages.get(url);
  if (html === undefined) return 'fetch-failed';
  return quoteInPage(html, r.quote ?? '') ? 'found' : 'not-found';
}

export interface Verification {
  result: 'verified' | 'mismatch' | 'unsupported';
  reasons: string[];
  verifier: string;
  answer: string[];
  key: string[];
  quote: string;
  source: string;
  quote_check: QuoteCheck;
  notes?: string;
  digest: string;
}

const sortedUnique = (keys: string[]): string[] => [...new Set(keys)].sort(compare);

/** Why the quote and source of a result do not support the key; empty when they do. */
function unsupportedReasons(r: VerifierResult, check: QuoteCheck): string[] {
  const reasons: string[] = [];
  if ((r.quote ?? '').trim() === '') reasons.push('the quote is missing');
  if (r.source === undefined || r.source.trim() === '') reasons.push('the source is missing');
  else if (!isDocsSource(r.source)) reasons.push(`the source is not a ${DOCS_PREFIX} page`);
  if (check === 'not-found') reasons.push('the quote was not found on the source page');
  if (check === 'fetch-failed') reasons.push('the source page could not be fetched');
  return reasons;
}

/** Compares the verifier's result with the question's key and the quote check. */
export function judge(
  q: Question,
  r: VerifierResult,
  verifier: string,
  check: QuoteCheck,
): Verification {
  const answer = sortedUnique(r.answer.map((key) => key.toUpperCase()));
  const key = sortedUnique(q.options.filter((option) => option.correct).map((o) => o.key));
  const list = (keys: string[]): string => (keys.length === 0 ? 'nothing' : keys.join(', '));
  const mismatch = answer.join() !== key.join();
  const reasons = mismatch
    ? [`the verifier answered ${list(answer)} but the key is ${list(key)}`]
    : unsupportedReasons(r, check);
  let result: Verification['result'] = 'verified';
  if (mismatch) result = 'mismatch';
  else if (reasons.length > 0) result = 'unsupported';
  return {
    result,
    reasons,
    verifier,
    answer,
    key,
    quote: r.quote ?? '',
    source: r.source ?? '',
    quote_check: check,
    ...(r.notes === undefined ? {} : { notes: r.notes }),
    digest: questionDigest(q),
  };
}
