import { describe, expect, test } from 'vitest';
import { LabStackError, labStacksToPlan, labStacksToRun } from './lab-stacks.ts';

// Spec 047, section 1: Markdown-only changes under labs/ and modules/ select no lab (pure).

const STACKS = ['labs/00-a', 'labs/01-b'];
const BOTH = ['labs/00-a', 'labs/01-b'];

describe('labStacksToRun: ignored Markdown files', () => {
  test.each([
    'labs/01-b/README.md',
    'labs/01-b/break-it.md',
    'labs/01-b/docs/deep/x.md',
    'labs/01-b/NOTES.MD',
  ])('AC-1: %s alone selects no lab', (file) => {
    expect(labStacksToRun(STACKS, [file])).toEqual([]);
  });
});

describe('labStacksToRun: files that are not ignored', () => {
  test('AC-2: a lab README next to a lab .tf file still selects the lab', () => {
    expect(labStacksToRun(STACKS, ['labs/01-b/README.md', 'labs/01-b/main.tf'])).toEqual([
      'labs/01-b',
    ]);
  });

  test("AC-2: another lab's README does not add that lab", () => {
    expect(labStacksToRun(STACKS, ['labs/00-a/README.md', 'labs/01-b/main.tf'])).toEqual([
      'labs/01-b',
    ]);
  });

  test('AC-2: a name that only holds .md in the middle (x.md.tf) still selects the lab', () => {
    expect(labStacksToRun(STACKS, ['labs/01-b/x.md.tf'])).toEqual(['labs/01-b']);
  });

  test('AC-2: README.markdown still selects the lab (only .md is ignored)', () => {
    expect(labStacksToRun(STACKS, ['labs/01-b/README.markdown'])).toEqual(['labs/01-b']);
  });
});

describe('labStacksToRun: modules', () => {
  test('AC-3: a module README alone selects no lab', () => {
    expect(labStacksToRun(STACKS, ['modules/tags/README.md'])).toEqual([]);
  });

  test('AC-3: a module .tf file selects every lab', () => {
    expect(labStacksToRun(STACKS, ['modules/tags/main.tf'])).toEqual(BOTH);
  });

  test('AC-3: a module README next to a module .tf file selects every lab', () => {
    expect(labStacksToRun(STACKS, ['modules/tags/README.md', 'modules/tags/main.tf'])).toEqual(
      BOTH,
    );
  });
});

describe('labStacksToRun: same as labStacksToPlan without an ignored file', () => {
  const cases: [string, string[], string[]][] = [
    ['no change', STACKS, []],
    ['bootstrap/workload/main.tf', STACKS, ['bootstrap/workload/main.tf']],
    ['.terraform-version', STACKS, ['.terraform-version']],
    ['README.md at the repo root', STACKS, ['README.md']],
    ['apps/site/x.md', STACKS, ['apps/site/x.md']],
    ['labs/01-b/main.tf', STACKS, ['labs/01-b/main.tf']],
    ['a deep test file', STACKS, ['labs/01-b/tests/deep/x.tftest.hcl']],
    ['a workflow file', STACKS, ['.github/workflows/infra.yml']],
    [
      'an extra input of a stack',
      ['labs/00-site-hosting', 'labs/01-x'],
      ['apps/site/headers.json'],
    ],
  ];

  test.each(cases)('AC-4: %s', (_name, stacks, changed) => {
    expect(labStacksToRun(stacks, changed)).toEqual(labStacksToPlan(stacks, changed));
  });

  test('AC-4: the extra input of lab 00-site-hosting selects that lab only', () => {
    expect(
      labStacksToRun(['labs/00-site-hosting', 'labs/01-x'], ['apps/site/headers.json']),
    ).toEqual(['labs/00-site-hosting']);
  });
});

describe('labStacksToRun: Windows separators', () => {
  test('AC-5: a lab README with backslashes selects no lab', () => {
    expect(labStacksToRun(STACKS, ['labs\\01-b\\README.md'])).toEqual([]);
  });

  test('AC-5: a lab .tf file with backslashes selects the lab', () => {
    expect(labStacksToRun(STACKS, ['labs\\01-b\\main.tf'])).toEqual(['labs/01-b']);
  });

  test('AC-5: a module README with backslashes selects no lab', () => {
    expect(labStacksToRun(STACKS, ['modules\\tags\\README.md'])).toEqual([]);
  });
});

describe('labStacksToRun: errors and shape', () => {
  test('AC-6: a badly named lab throws LabStackError even when every changed file is ignored', () => {
    expect(() => labStacksToRun(['labs/1-bad'], ['labs/1-bad/README.md'])).toThrow(LabStackError);
  });

  test('AC-6: labStacksToPlan throws the same error for that stack list (reference)', () => {
    expect(() => labStacksToPlan(['labs/1-bad'], ['labs/1-bad/README.md'])).toThrow(LabStackError);
  });

  test('AC-7: the result is sorted, unique and only lab stacks', () => {
    expect(
      labStacksToRun(
        ['labs/01-b', 'labs/00-a', 'labs/00-a', 'bootstrap/workload'],
        ['labs/01-b/a.tf', 'labs/00-a/b.tf', 'labs/00-a/README.md'],
      ),
    ).toEqual(['labs/00-a', 'labs/01-b']);
  });
});
