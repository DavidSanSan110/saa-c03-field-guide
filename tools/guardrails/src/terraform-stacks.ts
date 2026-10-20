/** Terraform stack detection for CI (spec 030). Interface stub: the implementation comes later. */

/** Files whose change re-checks every stack. */
export const TERRAFORM_GLOBAL_FILES: readonly string[] = [];

/** Stacks among the tracked files: sorted, unique. */
export function terraformStacks(trackedFiles: string[]): string[] {
  void trackedFiles;
  throw new Error('not implemented');
}

/** The stacks a change set must check: sorted, unique, always a subset of `stacks`. */
export function stacksToCheck(stacks: string[], changedFiles: string[]): string[] {
  void stacks;
  void changedFiles;
  throw new Error('not implemented');
}
