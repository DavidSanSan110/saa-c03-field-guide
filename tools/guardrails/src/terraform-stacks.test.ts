import { describe, expect, test } from 'vitest';
import { TERRAFORM_GLOBAL_FILES, stacksToCheck, terraformStacks } from './terraform-stacks.ts';

// Spec 030, sections 1 (stack detection) and AC-1..AC-3.

describe('terraformStacks: which directories are stacks', () => {
  test('AC-1: finds bootstrap, lab and module stacks from their top-level .tf files', () => {
    const files = [
      'bootstrap/management/main.tf',
      'labs/00-site-hosting/main.tf',
      'labs/00-site-hosting/tests/main.tftest.hcl',
      'modules/tags/outputs.tf',
      'modules/tags/README.md',
    ];
    expect(terraformStacks(files)).toEqual([
      'bootstrap/management',
      'labs/00-site-hosting',
      'modules/tags',
    ]);
  });

  test('AC-1: ignores files that do not make a stack', () => {
    const files = [
      'labs/README.md',
      'labs/01-x/README.md',
      'labs/02-y/tests/a.tf',
      'bootstrap/main.tf',
      'other/x/main.tf',
      'labs/03-z/main.tf.bak',
    ];
    expect(terraformStacks(files)).toEqual([]);
  });

  test('AC-1: a .tf file below the stack level does not make the stack', () => {
    expect(terraformStacks(['labs/02-y/tests/a.tf'])).toEqual([]);
  });

  test('AC-1: a .tf file directly under bootstrap/ (one segment) is not a stack', () => {
    expect(terraformStacks(['bootstrap/main.tf'])).toEqual([]);
  });

  test('AC-1: a directory outside bootstrap/, labs/ and modules/ is not a stack', () => {
    expect(terraformStacks(['other/x/main.tf', 'apps/site/main.tf'])).toEqual([]);
  });

  test('AC-1: a .tf.bak file is not a .tf file', () => {
    expect(terraformStacks(['labs/03-z/main.tf.bak'])).toEqual([]);
  });

  test('AC-1: an empty file list has no stacks', () => {
    expect(terraformStacks([])).toEqual([]);
  });

  test('AC-1: two .tf files in one stack give one entry', () => {
    expect(terraformStacks(['labs/00-a/main.tf', 'labs/00-a/variables.tf'])).toEqual(['labs/00-a']);
  });

  test('AC-1: the output is sorted whatever the input order', () => {
    const files = ['modules/tags/a.tf', 'labs/01-b/main.tf', 'bootstrap/workload/x.tf'];
    const expected = ['bootstrap/workload', 'labs/01-b', 'modules/tags'];
    expect(terraformStacks(files)).toEqual(expected);
    expect(terraformStacks([...files].reverse())).toEqual(expected);
  });

  test('AC-1: a path with backslash separators (built at runtime) is accepted', () => {
    const windowsPath = ['labs', '00-site-hosting', 'main.tf'].join('\\');
    expect(terraformStacks([windowsPath])).toEqual(['labs/00-site-hosting']);
  });

  test('AC-1: a backslash path and its slash twin give one entry', () => {
    const windowsPath = ['labs', '00-site-hosting', 'variables.tf'].join('\\');
    expect(terraformStacks([windowsPath, 'labs/00-site-hosting/main.tf'])).toEqual([
      'labs/00-site-hosting',
    ]);
  });

  test('AC-1: matching is case-sensitive (git paths)', () => {
    expect(terraformStacks(['Labs/00-a/main.tf', 'labs/00-b/MAIN.TF'])).toEqual([]);
  });
});

describe('stacksToCheck: which stacks a change set re-checks', () => {
  const stacks = ['bootstrap/workload', 'labs/00-site-hosting', 'modules/tags'];

  test('AC-2: a changed file in a stack selects that stack', () => {
    expect(stacksToCheck(stacks, ['labs/00-site-hosting/README.md'])).toEqual([
      'labs/00-site-hosting',
    ]);
  });

  test('AC-2: a changed file at any depth in a stack selects that stack', () => {
    expect(stacksToCheck(stacks, ['labs/00-site-hosting/tests/main.tftest.hcl'])).toEqual([
      'labs/00-site-hosting',
    ]);
  });

  test('AC-2: a file outside every stack selects nothing', () => {
    expect(stacksToCheck(stacks, ['apps/site/x.ts'])).toEqual([]);
  });

  test('AC-2: no changed files select nothing', () => {
    expect(stacksToCheck(stacks, [])).toEqual([]);
  });

  test('AC-2: a changed module file selects every stack', () => {
    expect(stacksToCheck(stacks, ['modules/tags/variables.tf'])).toEqual(stacks);
  });

  test('AC-2: a changed file directly under modules/ selects every stack', () => {
    expect(stacksToCheck(stacks, ['modules/README.md'])).toEqual(stacks);
  });

  test.each([
    '.github/workflows/terraform.yml',
    '.tflint.hcl',
    '.checkov.yaml',
    '.terraform-version',
  ])('AC-2: the global file %s selects every stack', (file) => {
    expect(stacksToCheck(stacks, [file])).toEqual(stacks);
  });

  test('AC-2: a changed path of a stack that no longer exists selects nothing', () => {
    expect(stacksToCheck(stacks, ['labs/09-gone/main.tf'])).toEqual([]);
  });

  test('AC-2: a name that only shares a prefix with a stack does not select it', () => {
    expect(stacksToCheck(stacks, ['labs/00-site-hostingX/main.tf'])).toEqual([]);
  });

  test('AC-2: several changes give a sorted, unique list', () => {
    const changed = [
      'labs/00-site-hosting/b.tf',
      'bootstrap/workload/main.tf',
      'labs/00-site-hosting/a.tf',
      'apps/site/x.ts',
    ];
    expect(stacksToCheck(stacks, changed)).toEqual(['bootstrap/workload', 'labs/00-site-hosting']);
  });

  test('AC-2: the result is sorted even when the given stacks are not', () => {
    const shuffled = ['modules/tags', 'bootstrap/workload', 'labs/00-site-hosting'];
    expect(stacksToCheck(shuffled, ['modules/tags/main.tf'])).toEqual([
      'bootstrap/workload',
      'labs/00-site-hosting',
      'modules/tags',
    ]);
  });

  test('AC-2: the result is always a subset of the given stacks', () => {
    const result = stacksToCheck(stacks, ['modules/tags/main.tf', 'labs/09-gone/main.tf']);
    for (const stack of result) expect(stacks).toContain(stack);
  });

  test('AC-2: no stacks means nothing to check, even for a global file', () => {
    expect(stacksToCheck([], ['.tflint.hcl', 'modules/tags/main.tf'])).toEqual([]);
  });
});

describe('TERRAFORM_GLOBAL_FILES', () => {
  test('AC-3: lists exactly the files that re-check every stack', () => {
    expect([...TERRAFORM_GLOBAL_FILES]).toEqual([
      '.github/workflows/terraform.yml',
      '.tflint.hcl',
      '.checkov.yaml',
      '.terraform-version',
    ]);
  });
});
