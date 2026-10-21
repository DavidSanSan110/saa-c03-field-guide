import { describe, expect, test } from 'vitest';
import { LabStackError, labStacksToPlan } from './lab-stacks.ts';

// Spec 033 review round 1, AC-44: what selects every lab (pure).

const STACKS = ['bootstrap/workload', 'labs/00-a', 'labs/01-b', 'modules/tags'];
const BOTH = ['labs/00-a', 'labs/01-b'];

describe('labStacksToPlan', () => {
  test.each([
    '.github/workflows/terraform.yml',
    '.tflint.hcl',
    '.checkov.yaml',
    '.github/workflows/infra.yml',
  ])('AC-44: a change to %s alone selects no lab', (file) => {
    expect(labStacksToPlan(STACKS, [file])).toEqual([]);
  });

  test('AC-44: a changed .terraform-version selects every lab', () => {
    expect(labStacksToPlan(STACKS, ['.terraform-version'])).toEqual(BOTH);
  });

  test.each(['modules/tags/x.tf', 'modules/tags/tests/tags.tftest.hcl', 'modules/README.md'])(
    'AC-44: a changed %s selects every lab',
    (file) => {
      expect(labStacksToPlan(STACKS, [file])).toEqual(BOTH);
    },
  );

  test('AC-44: a change under bootstrap/ selects no lab', () => {
    expect(labStacksToPlan(STACKS, ['bootstrap/workload/main.tf'])).toEqual([]);
  });

  test.each(['labs/01-b/main.tf', 'labs/01-b/README.md', 'labs/01-b/tests/deep/x.tftest.hcl'])(
    'AC-44: a changed %s selects that lab (any depth)',
    (file) => {
      expect(labStacksToPlan(STACKS, [file])).toEqual(['labs/01-b']);
    },
  );

  test('AC-44: a path that only starts like a lab does not select it', () => {
    expect(labStacksToPlan(STACKS, ['labs/01-bX/main.tf'])).toEqual([]);
  });

  test('AC-44: a changed lab that is not a stack (no .tf left) selects nothing', () => {
    expect(labStacksToPlan(STACKS, ['labs/09-gone/main.tf'])).toEqual([]);
  });

  test('AC-44: unrelated files select nothing, and no changes select nothing', () => {
    expect(labStacksToPlan(STACKS, ['README.md', 'apps/site/x.ts'])).toEqual([]);
    expect(labStacksToPlan(STACKS, [])).toEqual([]);
  });

  test('AC-44: several changes give a sorted, unique list', () => {
    expect(
      labStacksToPlan(STACKS, ['labs/01-b/a.tf', 'labs/00-a/b.tf', 'labs/01-b/c.tf', 'README.md']),
    ).toEqual(BOTH);
  });

  test('AC-44: a global file next to a lab change still selects only that lab', () => {
    expect(labStacksToPlan(STACKS, ['.tflint.hcl', 'labs/00-a/main.tf'])).toEqual(['labs/00-a']);
  });

  test('AC-44: without lab stacks a module change selects nothing', () => {
    expect(labStacksToPlan(['bootstrap/workload', 'modules/tags'], ['modules/tags/x.tf'])).toEqual(
      [],
    );
  });

  test('AC-44: a badly named lab throws LabStackError, as labStacks does', () => {
    expect(() => labStacksToPlan([...STACKS, 'labs/bad_name'], ['labs/00-a/main.tf'])).toThrow(
      LabStackError,
    );
  });
});
