// Interface stub (spec 033): the implementation comes after the tests.
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.

export interface PlanChange {
  address: string;
  actions: string[];
  previousAddress: string | null;
  importing: boolean;
}

export class PlanFormatError extends Error {}

/** The change set: entries of resource_changes that change state, sorted by address. */
export function changeSet(plan: unknown): PlanChange[] {
  void plan;
  throw new Error('not implemented');
}

/** Lowercase 64-hex SHA-256 of the canonical change set. */
export function planDigest(plan: unknown): string {
  void plan;
  throw new Error('not implemented');
}

/** Markdown for the PR comment and the run page; never contains attribute values. */
export function planSummary(plan: unknown, stack: string): string {
  void plan;
  void stack;
  throw new Error('not implemented');
}

/** CLI dispatcher used by the entry file: returns the exit code. */
export function runTfPlan(
  argv: string[],
  io: { readFile(path: string): string; stdout(text: string): void; stderr(text: string): void },
): number {
  void argv;
  void io;
  throw new Error('not implemented');
}
