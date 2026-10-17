// Near-duplicate detection (spec 020): word shingles, Jaccard similarity and the `dedupe` key of a
// draft's check file (sidecar). No file system access: tools/questions/src/cli.ts does the I/O.
import type { Question } from '@field-guide/schema';
import { isMap, isNode, isScalar, parseDocument, stringify } from 'yaml';
import type { BankEntry } from './bank.ts';

const SHINGLE_SIZE = 3;

/** Code-unit order, the same on every machine (unlike localeCompare). */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A score with two decimals, as stored in a check file and printed (0.285 gives 0.29). */
export function roundScore(score: number): number {
  return Math.round(score * 100 + 1e-9) / 100;
}

/** NFKC, lower case, no apostrophes, then the runs of letters and digits as words. */
export function normalise(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** The 3-word shingles of the stem and of each option, never across two segments. */
export function shingles(question: Pick<Question, 'stem' | 'options'>): Set<string> {
  const result = new Set<string>();
  const segments = [question.stem, ...question.options.map((option) => option.text)];
  for (const segment of segments) {
    const words = normalise(segment);
    if (words.length === 0) continue;
    if (words.length < SHINGLE_SIZE) {
      result.add(words.join(' '));
      continue;
    }
    for (let start = 0; start + SHINGLE_SIZE <= words.length; start++) {
      result.add(words.slice(start, start + SHINGLE_SIZE).join(' '));
    }
  }
  return result;
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|, 0 when both sets are empty. */
export function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const shingle of a) {
    if (b.has(shingle)) shared++;
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface SimilarPair {
  a: BankEntry;
  aFolder: 'drafts';
  b: BankEntry;
  bFolder: 'drafts' | 'bank';
  score: number;
}

/**
 * Every draft against every bank question and every pair of drafts (once) whose similarity is at
 * least `threshold`, sorted by score (high first), then by the two ids.
 */
export function findSimilar(
  drafts: BankEntry[],
  bank: BankEntry[],
  threshold: number,
): SimilarPair[] {
  const sets = new Map<BankEntry, Set<string>>();
  for (const entry of [...drafts, ...bank]) sets.set(entry, shingles(entry.question));
  const setOf = (entry: BankEntry): Set<string> => sets.get(entry) ?? new Set();

  const pairs: SimilarPair[] = [];
  const consider = (a: BankEntry, b: BankEntry, bFolder: 'drafts' | 'bank'): void => {
    const score = similarity(setOf(a), setOf(b));
    if (score >= threshold) pairs.push({ a, aFolder: 'drafts', b, bFolder, score });
  };
  drafts.forEach((draft, index) => {
    for (const other of drafts.slice(index + 1)) {
      const [first, second] =
        compare(draft.question.id, other.question.id) <= 0 ? [draft, other] : [other, draft];
      consider(first, second, 'drafts');
    }
    for (const entry of bank) consider(draft, entry, 'bank');
  });

  return pairs.sort(
    (x, y) =>
      y.score - x.score ||
      compare(x.a.question.id, y.a.question.id) ||
      compare(x.b.question.id, y.b.question.id),
  );
}

export interface SimilarRef {
  id: string;
  folder: 'drafts' | 'bank';
  path: string;
  score: number;
}

/** The `similar` list of every draft (by draft path), [] when nothing is flagged. */
export function similarByDraft(
  drafts: BankEntry[],
  pairs: SimilarPair[],
): Map<string, SimilarRef[]> {
  const lists = new Map<string, SimilarRef[]>(drafts.map((draft) => [draft.path, []]));
  const add = (draft: BankEntry, other: BankEntry, folder: 'drafts' | 'bank', score: number) => {
    lists.get(draft.path)?.push({
      id: other.question.id,
      folder,
      path: other.path,
      score: roundScore(score),
    });
  };
  for (const { a, b, bFolder, score } of pairs) {
    add(a, b, bFolder, score);
    if (bFolder === 'drafts') add(b, a, 'drafts', score);
  }
  for (const list of lists.values()) {
    list.sort((x, y) => y.score - x.score || compare(x.id, y.id));
  }
  return lists;
}

/** The offset just after the line that holds `at` (or `at` itself when it starts a line). */
function endOfLine(text: string, at: number): number {
  if (at > 0 && text[at - 1] === '\n') return at;
  const newline = text.indexOf('\n', at);
  return newline === -1 ? text.length : newline + 1;
}

/**
 * New sidecar text: `existing` (or nothing) with its `dedupe` key replaced. Only the lines of that
 * key change (a new key goes last), so the comments and the text of the other keys stay as they
 * are; line endings become LF. Throws on invalid YAML or a non-mapping.
 */
export function withDedupe(
  existing: string | undefined,
  threshold: number,
  similar: SimilarRef[],
): string {
  const text = (existing ?? '').replace(/\r\n?/g, '\n');
  const doc = parseDocument(text);
  const [problem] = doc.errors;
  if (problem !== undefined) throw new Error(`invalid YAML: ${problem.message}`);
  const { contents } = doc;
  // An empty file, only comments, or only a document marker count as an empty mapping.
  const isEmpty =
    contents === null ||
    (isScalar(contents) && contents.value === null && contents.range?.[0] === contents.range?.[1]);
  // A top-level { ... } has no lines to replace, so only a block mapping is accepted.
  if (!isEmpty && !(isMap(contents) && contents.flow !== true)) {
    throw new Error('the YAML top level must be a block mapping');
  }

  const block = stringify({ dedupe: { threshold, similar } }, { lineWidth: 0 });
  const pair = isMap(contents)
    ? contents.items.find((item) => isScalar(item.key) && item.key.value === 'dedupe')
    : undefined;
  const keyStart = isNode(pair?.key) ? pair.key.range?.[0] : undefined;
  if (pair === undefined || keyStart === undefined) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    return `${text}${separator}${block}`;
  }
  const valueEnd = isNode(pair.value) ? pair.value.range?.[1] : undefined;
  const start = text.lastIndexOf('\n', keyStart - 1) + 1;
  const end = endOfLine(text, valueEnd ?? keyStart);
  return `${text.slice(0, start)}${block}${text.slice(end)}`;
}
