// Drafts and answer sheets for the verdict CLI tests of review round 1.
import { parse } from 'yaml';
import { variant } from './dedupe-fixtures.ts';
import { DRAFTS, exists, put, readText, sidecarOf, write } from './cli-harness.ts';
import { makeQuestion } from './fixtures.ts';
import type { Raw } from './fixtures.ts';
import { DOCS_URL, resultsYaml } from './verify-fixtures.ts';
import type { ResultEntry } from './verify-fixtures.ts';
import { expect } from 'vitest';

export const QUOTE = 'The caller sends the key with each request.';
export const RESULTS = 'results.yaml';

export interface Draft {
  id: string;
  /** The path inside the drafts folder. */
  path: string;
  question: Raw;
}

/** A single-answer draft of the given group (see `variant`): the key is C, status draft. */
export function putDraft(
  dir: string,
  id: string,
  slug: string,
  group: string,
  folder = DRAFTS,
): Draft {
  const fields = { ...variant(group, 'a'), status: 'draft' };
  const path = put(dir, folder, id, slug, fields);
  return { id, path, question: makeQuestion({ id, ...fields }) };
}

/** A correct result for a draft (answer C, a quote and a docs source). */
export function good(draft: Draft, extra: ResultEntry = {}): ResultEntry {
  return { id: draft.id, answer: ['C'], quote: QUOTE, source: DOCS_URL, ...extra };
}

export function writeResults(dir: string, results: ResultEntry[]): void {
  write(dir, RESULTS, resultsYaml(results));
}

/** The `verification` value of a draft's sidecar (fails the test when there is no sidecar). */
export function verificationOf(dir: string, draft: Draft): Record<string, unknown> {
  const path = `${DRAFTS}/${sidecarOf(draft.path)}`;
  expect(exists(dir, path), `no sidecar at ${path}`).toBe(true);
  const sidecar = parse(readText(dir, path)) as { verification: Record<string, unknown> };
  return sidecar.verification;
}
