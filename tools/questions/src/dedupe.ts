// Near-duplicate detection (spec 020). Interface stubs: the implementation comes after the tests.
/* eslint-disable @typescript-eslint/no-unused-vars -- stubs: the parameters are used by the implementation */
import type { Question } from '@field-guide/schema';
import type { BankEntry } from './bank.ts';

export function normalise(_text: string): string[] {
  throw new Error('not implemented');
}

export function shingles(_question: Pick<Question, 'stem' | 'options'>): Set<string> {
  throw new Error('not implemented');
}

export function similarity(_a: Set<string>, _b: Set<string>): number {
  throw new Error('not implemented');
}

export interface SimilarPair {
  a: BankEntry;
  aFolder: 'drafts';
  b: BankEntry;
  bFolder: 'drafts' | 'bank';
  score: number;
}

export function findSimilar(
  _drafts: BankEntry[],
  _bank: BankEntry[],
  _threshold: number,
): SimilarPair[] {
  throw new Error('not implemented');
}

export interface SimilarRef {
  id: string;
  folder: 'drafts' | 'bank';
  path: string;
  score: number;
}

/** The `similar` list of every draft (by draft path), [] when nothing is flagged. */
export function similarByDraft(
  _drafts: BankEntry[],
  _pairs: SimilarPair[],
): Map<string, SimilarRef[]> {
  throw new Error('not implemented');
}

/** New sidecar text: `existing` (or nothing) with its `dedupe` key replaced. Throws on invalid YAML or a non-mapping. */
export function withDedupe(
  _existing: string | undefined,
  _threshold: number,
  _similar: SimilarRef[],
): string {
  throw new Error('not implemented');
}
