// Test fixtures for the question bank: valid reviewed questions, built from a few overrides.
import type { Question } from '@field-guide/schema';
import { stringify } from 'yaml';
import type { BankEntry } from '../bank.ts';

export type Raw = Record<string, unknown>;

const ID_PARTS = /^d(\d)-(\d\.\d)-\d{4}$/;

function provenanceFor(status: string): Raw {
  if (status === 'draft') return { generated_by: 'claude' };
  if (status === 'verified') return { generated_by: 'claude', verified_by: 'claude' };
  return { generated_by: 'claude', verified_by: 'claude', reviewed_by: 'DavidSanSan110' };
}

/**
 * A schema-valid question as a plain object. The domain and task follow the id (default
 * `d1-1.3-0001`), the status defaults to `reviewed` and the provenance follows the status; any
 * top-level field can be replaced through `overrides`.
 */
export function makeQuestion(overrides: Raw = {}): Raw {
  const id = typeof overrides.id === 'string' ? overrides.id : 'd1-1.3-0001';
  const parts = ID_PARTS.exec(id);
  const status = typeof overrides.status === 'string' ? overrides.status : 'reviewed';
  return {
    id,
    domain: parts?.[1] === undefined ? 1 : Number(parts[1]),
    task: parts?.[2] ?? '1.3',
    services: ['s3', 'kms'],
    difficulty: 'medium',
    type: 'single',
    stem:
      'A company must encrypt objects in Amazon S3 at rest and keep the keys outside AWS. ' +
      `Which option meets these requirements? (${id})`,
    options: [
      { key: 'A', text: 'SSE-S3', correct: false, why: 'AWS creates and owns the keys.' },
      { key: 'B', text: 'SSE-KMS', correct: false, why: 'The key is stored in AWS KMS.' },
      {
        key: 'C',
        text: 'SSE-C',
        correct: true,
        why: 'The caller sends the key with each request.',
      },
      { key: 'D', text: 'None of them', correct: false, why: 'SSE-C meets the requirement.' },
    ],
    references: [
      'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html',
    ],
    status,
    provenance: provenanceFor(status),
    ...overrides,
  };
}

/** The YAML text of `makeQuestion(overrides)`. */
export function questionYaml(overrides: Raw = {}): string {
  return stringify(makeQuestion(overrides));
}

/** The path where the question must live: `d<domain>/<task>/<slug>.yaml`. */
export function pathFor(question: Raw, slug: string): string {
  return `d${String(question.domain)}/${String(question.task)}/${slug}.yaml`;
}

/** A valid file: its correct path, its YAML text and the question object it holds. */
export function fileFor(
  id: string,
  slug: string,
  overrides: Raw = {},
): { path: string; text: string; question: Raw } {
  const question = makeQuestion({ id, ...overrides });
  return { path: pathFor(question, slug), text: stringify(question), question };
}

/** A BankEntry for `readBank`-free tests of `planPromote`; the path is the correct one by default. */
export function makeEntry(id: string, slug: string, overrides: Raw = {}): BankEntry {
  const { path, text, question } = fileFor(id, slug, overrides);
  return { path, slug, question: question as unknown as Question, text };
}
