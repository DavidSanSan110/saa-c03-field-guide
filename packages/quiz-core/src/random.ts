// Seeded random numbers: a small 32-bit generator and a shuffle driven by it (spec 016).

/** Each call returns a float in [0, 1). */
export type Rng = () => number;

const SEED_LIMIT = 2 ** 32;

/** Mulberry32. `seed` is an integer in 0 ... 2^32 - 1, else RangeError. */
export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) {
    throw new RangeError(`seed must be an integer from 0 to ${SEED_LIMIT - 1}, got ${seed}`);
  }
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / SEED_LIMIT;
  };
}

function swap<T>(items: T[], i: number, j: number): void {
  const held = items[i] as T;
  items[i] = items[j] as T;
  items[j] = held;
}

/** Fisher-Yates shuffle driven by `rng`. Returns a new array, never changes `items`. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    swap(result, i, Math.floor(rng() * (i + 1)));
  }
  return result;
}
