// Fixtures for the verifier helpers (spec 022): the digest test vectors and an answer sheet builder.
import { createHash } from 'node:crypto';
import type { Question } from '@field-guide/schema';
import { stringify } from 'yaml';
import { makeQuestion } from './fixtures.ts';
import type { Raw } from './fixtures.ts';

export const VECTOR_STEM = 'Which S3 encryption option keeps the keys out of AWS?';
export const VECTOR_DIGEST_C = '6498301f85802e9c';
export const VECTOR_DIGEST_D = 'c983a5e434db617f';

export const DOCS_URL =
  'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html';

/** The options of the spec's digest test vector, with `correct` set on `correctKey` only. */
export function vectorOptions(correctKey: string): Question['options'] {
  return [
    ['A', 'SSE-S3'],
    ['B', 'SSE-KMS'],
    ['C', 'SSE-C'],
    ['D', 'Client-side encryption'],
  ].map(([key = '', text = '']) => ({
    key,
    text,
    correct: key === correctKey,
    why: `Reason for ${key}.`,
  }));
}

/** A full question holding the digest test vector (only C correct unless `correctKey` says so). */
export function vectorQuestion(correctKey = 'C', overrides: Raw = {}): Question {
  return makeQuestion({
    id: 'd1-1.3-0007',
    stem: VECTOR_STEM,
    options: vectorOptions(correctKey),
    status: 'draft',
    ...overrides,
  }) as unknown as Question;
}

/**
 * The digest as the spec defines it, computed here independently of the code under test: the first
 * 16 hex characters of the SHA-256 of `{ type, stem, options: [{ key, text, correct }] }`.
 */
export function digestOf(question: Raw | Question): string {
  const { type, stem, options } = question as unknown as Pick<
    Question,
    'type' | 'stem' | 'options'
  >;
  const json = JSON.stringify({
    type,
    stem,
    options: options.map((o) => ({ key: o.key, text: o.text, correct: o.correct })),
  });
  return createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 16);
}

/** One entry of a `results:` list. */
export type ResultEntry = Record<string, unknown>;

/** The text of a verifier answer sheet. `verifier: undefined` leaves the line out. */
export function resultsYaml(
  results: ResultEntry[],
  extra: { verifier?: string | undefined; top?: Raw } = {},
): string {
  const head: Raw = {};
  if (!('verifier' in extra) || extra.verifier !== undefined) {
    head.verifier = 'verifier' in extra ? extra.verifier : 'claude-opus';
  }
  return stringify({ ...head, results, ...extra.top });
}
