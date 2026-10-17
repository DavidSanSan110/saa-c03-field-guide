// Seeded random numbers (interface stub: implementation pending, spec 016).

/** Each call returns a float in [0, 1). */
export type Rng = () => number;

/** Mulberry32. `seed` is an integer in 0 ... 2^32 - 1, else RangeError. */
export function createRng(seed: number): Rng {
  void seed;
  throw new Error('not implemented');
}

/** Fisher-Yates shuffle driven by `rng`. Returns a new array, never changes `items`. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  void items;
  void rng;
  throw new Error('not implemented');
}
