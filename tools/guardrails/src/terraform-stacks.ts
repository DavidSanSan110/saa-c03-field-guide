// Terraform stack detection for CI (spec 030): pure, no git or file system access.

const STACK_ROOTS = ['bootstrap', 'labs', 'modules'];

/** Files whose change re-checks every stack. */
export const TERRAFORM_GLOBAL_FILES: readonly string[] = [
  '.github/workflows/terraform.yml',
  '.tflint.hcl',
  '.checkov.yaml',
  '.terraform-version',
];

/** Repo-relative path segments; `\` is accepted as a separator. */
function segmentsOf(path: string): string[] {
  return path.replaceAll('\\', '/').split('/');
}

/** Stacks among the tracked files: sorted, unique. */
export function terraformStacks(trackedFiles: string[]): string[] {
  const stacks = new Set<string>();
  for (const file of trackedFiles) {
    const [root = '', name = '', leaf = '', ...deeper] = segmentsOf(file);
    if (STACK_ROOTS.includes(root) && name !== '' && deeper.length === 0 && leaf.endsWith('.tf')) {
      stacks.add(`${root}/${name}`);
    }
  }
  return [...stacks].sort();
}

/** The stacks a change set must check: sorted, unique, always a subset of `stacks`. */
export function stacksToCheck(stacks: string[], changedFiles: string[]): string[] {
  const selected = new Set<string>();
  for (const file of changedFiles) {
    const segments = segmentsOf(file);
    if (segments[0] === 'modules' || TERRAFORM_GLOBAL_FILES.includes(segments.join('/'))) {
      return [...new Set(stacks)].sort();
    }
    const stack = segments.slice(0, 2).join('/');
    if (segments.length > 2 && stacks.includes(stack)) selected.add(stack);
  }
  return [...selected].sort();
}
