// Practice pools by domain, task, service and weak spots (spec 018).
import { domains, isTaskId } from '@field-guide/schema';
import type { DomainId, Progress, Question, TaskId } from '@field-guide/schema';
import type { Exam } from './build.ts';
import {
  assertFinite,
  assertSize,
  assertUniqueIds,
  perDomain,
  sortedReviewed,
  statsOf,
} from './internal.ts';
import { createRng, shuffle } from './random.ts';

export type PoolFilter =
  | { kind: 'domain'; domain: DomainId }
  | { kind: 'task'; task: TaskId }
  | { kind: 'service'; service: string }
  | { kind: 'weak'; now: number };

/** Which questions a filter keeps. RangeError for a domain, task, service or time that is invalid. */
function matcher(progress: Progress, filter: PoolFilter): (question: Question) => boolean {
  switch (filter.kind) {
    case 'domain': {
      const { domain } = filter;
      if (!domains.some(({ id }) => id === domain)) {
        throw new RangeError(`not a domain of the exam: ${String(domain)}`);
      }
      return (question) => question.domain === domain;
    }
    case 'task': {
      const { task } = filter;
      if (!isTaskId(task)) throw new RangeError(`not a task of the exam: ${String(task)}`);
      return (question) => question.task === task;
    }
    case 'service': {
      const { service } = filter;
      if (service === '') throw new RangeError('service must not be empty');
      return (question) => question.services.includes(service);
    }
    case 'weak': {
      const { now } = filter;
      assertFinite('now', now);
      return ({ id }) => (statsOf(progress, id)?.dueAt ?? Infinity) <= now;
    }
  }
}

/**
 * The reviewed bank questions that match `filter`, sorted by id. `weak` keeps the questions in
 * boxes 1 to 5 that are due at `now`. Throws an Error for duplicate ids in the bank.
 */
export function practicePool(
  bank: readonly Question[],
  progress: Progress,
  filter: PoolFilter,
): Question[] {
  assertUniqueIds(bank);
  return sortedReviewed(bank).filter(matcher(progress, filter));
}

/** The services of the reviewed questions with how many questions name each, sorted by name. */
export function listServices(bank: readonly Question[]): { service: string; count: number }[] {
  assertUniqueIds(bank);
  const counts = new Map<string, number>();
  for (const { services } of sortedReviewed(bank)) {
    for (const service of services) counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  return [...counts]
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => (a.service < b.service ? -1 : 1));
}

/**
 * An exam of `min(size, reviewed in pool)` questions drawn uniformly from the pool, with no domain
 * weighting. Deterministic for the same pool (in any order) and options.
 */
export function buildPracticeExam(
  pool: readonly Question[],
  options: { seed: number; size: number; shuffleOptions?: boolean },
): Exam {
  const rng = createRng(options.seed);
  const { seed, size } = options;
  assertSize(size);
  assertUniqueIds(pool);

  const reviewed = sortedReviewed(pool);
  const items = shuffle(reviewed, rng)
    .slice(0, size)
    .map((question) => {
      const keys = question.options.map((option) => option.key);
      return {
        question,
        optionOrder: options.shuffleOptions === false ? keys : shuffle(keys, rng),
      };
    });

  return {
    seed,
    size,
    items,
    complete: items.length === size,
    byDomain: perDomain((id) => {
      const picked = items.filter((item) => item.question.domain === id).length;
      const available = reviewed.filter((question) => question.domain === id).length;
      return { quota: picked, available, picked, short: 0 };
    }),
  };
}
