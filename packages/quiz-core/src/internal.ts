// Helpers shared by the scorer, the exam builder and the progress modules (not exported from the index).
import { domains } from '@field-guide/schema';
import type { DomainId, Progress, Question, QuestionStats } from '@field-guide/schema';

/** Throws an Error naming the first question id that appears twice. */
export function assertUniqueIds(questions: readonly Question[]): void {
  const seen = new Set<string>();
  for (const { id } of questions) {
    if (seen.has(id)) throw new Error(`duplicate question id: ${id}`);
    seen.add(id);
  }
}

/** A record with one value per domain id. */
export function perDomain<T>(make: (domain: DomainId) => T): Record<DomainId, T> {
  return Object.fromEntries(domains.map(({ id }) => [id, make(id)])) as Record<DomainId, T>;
}

/** Reviewed questions only, sorted by id so the file read order does not matter. */
export function sortedReviewed(bank: readonly Question[]): Question[] {
  return bank
    .filter((question) => question.status === 'reviewed')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Throws a RangeError unless `value` is a finite number. */
export function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value))
    throw new RangeError(`${name} must be a finite number, got ${value}`);
}

/** The own stats of a question id, if any. */
export function statsOf(progress: Progress, id: string): QuestionStats | undefined {
  return Object.hasOwn(progress.questions, id) ? progress.questions[id] : undefined;
}

const MAX_SIZE = 10_000;

/** Throws a RangeError unless `size` is an integer from 1 to 10,000 (keeps `size * weight` exact). */
export function assertSize(size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    throw new RangeError(`size must be an integer from 1 to ${MAX_SIZE}, got ${size}`);
  }
}

/** True for an object whose `version` is not `version`: data written by another build. */
export function hasOtherVersion(data: unknown, version: number): boolean {
  return typeof data === 'object' && data !== null && 'version' in data && data.version !== version;
}
