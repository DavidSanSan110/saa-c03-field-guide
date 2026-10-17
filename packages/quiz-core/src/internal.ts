// Helpers shared by the scorer and the exam builder (not exported from the index).
import { domains } from '@field-guide/schema';
import type { DomainId, Question } from '@field-guide/schema';

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
