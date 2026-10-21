// Files outside a Terraform stack that the stack reads (spec 035, section 12). Pure, no imports.

/**
 * Repo-relative files outside a stack that the stack reads (through `file(` and friends). A change
 * to one of them changes the stack's plan, so it selects the stack for checks and plans.
 * Keep it in step with the `.tf` files: the consistency test fails when a path is missing.
 */
export const STACK_EXTRA_INPUTS: Readonly<Record<string, readonly string[]>> = {
  'labs/00-site-hosting': ['apps/site/headers.json'],
};

/** The stacks (only those in `stacks`) that read a changed file: sorted, unique. */
export function stacksReadingChangedInputs(stacks: string[], changedFiles: string[]): string[] {
  const changed = new Set(changedFiles.map((file) => file.replaceAll('\\', '/')));
  const selected = new Set<string>();
  for (const stack of stacks) {
    const inputs = STACK_EXTRA_INPUTS[stack] ?? [];
    if (inputs.some((input) => changed.has(input))) selected.add(stack);
  }
  return [...selected].sort();
}
