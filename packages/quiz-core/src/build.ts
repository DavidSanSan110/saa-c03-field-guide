// Weighted exam builder: seeded, domain-weighted, never borrows across domains (spec 016).
import { domains } from '@field-guide/schema';
import type { DomainId, Question } from '@field-guide/schema';
import { assertUniqueIds, perDomain } from './internal.ts';
import { createRng, shuffle } from './random.ts';

export const EXAM_SIZE = 65;

/** Keeps `size * weight` exact. */
const MAX_SIZE = 10_000;

/** Largest-remainder split of `size` by the domain weights. `size` is an integer from 1 to 10,000. */
export function domainQuotas(size: number): Record<DomainId, number> {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    throw new RangeError(`size must be an integer from 1 to ${MAX_SIZE}, got ${size}`);
  }
  const shares = domains.map(({ id, weight }) => {
    const share = size * weight;
    const remainder = share % 100;
    return { id, remainder, quota: (share - remainder) / 100 };
  });
  const seats = size - shares.reduce((sum, { quota }) => sum + quota, 0);
  const winners = [...shares]
    .sort((a, b) => b.remainder - a.remainder || a.id - b.id)
    .slice(0, seats);
  const winnerIds = new Set(winners.map(({ id }) => id));
  return Object.fromEntries(
    shares.map(({ id, quota }) => [id, quota + (winnerIds.has(id) ? 1 : 0)]),
  ) as Record<DomainId, number>;
}

export interface ExamItem {
  question: Question;
  optionOrder: string[];
}

export interface DomainPlan {
  quota: number;
  available: number;
  picked: number;
  short: number;
}

export interface Exam {
  seed: number;
  size: number;
  items: ExamItem[];
  complete: boolean;
  byDomain: Record<DomainId, DomainPlan>;
}

/** Reviewed questions only, sorted by id so the file read order does not matter. */
function sortedReviewed(bank: readonly Question[]): Question[] {
  return bank
    .filter((question) => question.status === 'reviewed')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function buildExam(
  bank: readonly Question[],
  options: { seed: number; size?: number; shuffleOptions?: boolean },
): Exam {
  const rng = createRng(options.seed);
  const size = options.size ?? EXAM_SIZE;
  const quotas = domainQuotas(size);
  assertUniqueIds(bank);

  const pools = sortedReviewed(bank);
  const picks = perDomain((id) => {
    const pool = pools.filter((question) => question.domain === id);
    return { available: pool.length, picked: shuffle(pool, rng).slice(0, quotas[id]) };
  });
  const chosen = shuffle(
    domains.flatMap(({ id }) => picks[id].picked),
    rng,
  );
  const items = chosen.map((question) => {
    const keys = question.options.map((option) => option.key);
    return { question, optionOrder: options.shuffleOptions === false ? keys : shuffle(keys, rng) };
  });

  return {
    seed: options.seed,
    size,
    items,
    complete: items.length === size,
    byDomain: perDomain((id) => {
      const { available, picked } = picks[id];
      return {
        quota: quotas[id],
        available,
        picked: picked.length,
        short: quotas[id] - picked.length,
      };
    }),
  };
}
