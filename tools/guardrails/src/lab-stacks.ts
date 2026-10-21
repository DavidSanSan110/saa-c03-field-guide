// Lab stacks (spec 033): the stacks under labs/ that CI plans and applies. Pure, no I/O.

/** Lab id rule, same as modules/tags: NN-slug. */
export const LAB_STACK_PATTERN: RegExp = /^labs\/[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

export class LabStackError extends Error {}

/** The lab stacks among `stacks` (spec 030 stack paths): sorted, unique. */
export function labStacks(stacks: string[]): string[] {
  const labs = [...new Set(stacks.filter((stack) => stack.startsWith('labs/')))].sort();
  const bad = labs.filter((stack) => !LAB_STACK_PATTERN.test(stack));
  if (bad.length > 0) {
    throw new LabStackError(`lab names must look like labs/NN-slug, not: ${bad.join(', ')}`);
  }
  return labs;
}

/** The lab id of a lab stack path: 'labs/00-site-hosting' -> '00-site-hosting'. */
export function labId(stack: string): string {
  if (!LAB_STACK_PATTERN.test(stack)) throw new LabStackError(`not a lab stack: ${stack}`);
  return stack.slice('labs/'.length);
}

/** The state key CI uses for a lab: 'labs/<id>.tfstate'. */
export function labStateKey(stack: string): string {
  return `labs/${labId(stack)}.tfstate`;
}

/**
 * The lab stacks a change set must plan (spec 033, AC-44). Interface stub: the implementation
 * comes after the tests.
 */
export function labStacksToPlan(stacks: string[], changedFiles: string[]): string[] {
  void stacks;
  void changedFiles;
  throw new Error('not implemented');
}
