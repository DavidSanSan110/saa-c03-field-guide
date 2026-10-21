// Interface stub (spec 033): the implementation comes after the tests.

/** Lab id rule, same as modules/tags: NN-slug. */
export const LAB_STACK_PATTERN: RegExp = /(?!)/;

export class LabStackError extends Error {}

/** The lab stacks among `stacks` (spec 030 stack paths): sorted, unique. */
export function labStacks(stacks: string[]): string[] {
  void stacks;
  throw new Error('not implemented');
}

/** The lab id of a lab stack path: 'labs/00-site-hosting' -> '00-site-hosting'. */
export function labId(stack: string): string {
  void stack;
  throw new Error('not implemented');
}

/** The state key CI uses for a lab: 'labs/<id>.tfstate'. */
export function labStateKey(stack: string): string {
  void stack;
  throw new Error('not implemented');
}
