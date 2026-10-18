// Interface stub (spec 022): the implementation comes after the tests.
import type { Question } from '@field-guide/schema';

/** The first 16 hex characters of the SHA-256 of what the verifier judged plus the key. */
export function questionDigest(q: Pick<Question, 'type' | 'stem' | 'options'>): string {
  void q;
  throw new Error('not implemented');
}

/** The question as the verifier sees it: id, type, stem and options, without the key. */
export function renderBlind(q: Question): string {
  void q;
  throw new Error('not implemented');
}

export interface VerifierResult {
  id: string;
  answer: string[];
  quote?: string;
  source?: string;
  notes?: string;
}

/** Parses the verifier's answer sheet. */
export function parseResults(text: string): {
  verifier?: string;
  results: VerifierResult[];
  problems: string[];
} {
  void text;
  throw new Error('not implemented');
}

export type QuoteCheck = 'found' | 'not-found' | 'fetch-failed' | 'skipped' | 'none';

/** Whether the quote's words appear as one contiguous run of the page's text words. */
export function quoteInPage(html: string, quote: string): boolean {
  void [html, quote];
  throw new Error('not implemented');
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

/** Compares the verifier's result with the question's key and the quote check. */
export function judge(
  q: Question,
  r: VerifierResult,
  verifier: string,
  check: QuoteCheck,
): Verification {
  void [q, r, verifier, check];
  throw new Error('not implemented');
}
