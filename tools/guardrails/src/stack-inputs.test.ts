import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { labStacksToPlan } from './lab-stacks.ts';
import { stacksToCheck, terraformStacks } from './terraform-stacks.ts';

// Spec 035, section 12: files outside a stack that the stack reads (apps/site/headers.json for
// labs/00-site-hosting) select that stack for checks (tf-stacks) and plans (lab-stacks).

interface StackInputsModule {
  STACK_EXTRA_INPUTS: Readonly<Record<string, readonly string[]>>;
  stacksReadingChangedInputs: (stacks: string[], changedFiles: string[]) => string[];
}

// Loaded dynamically with a declared shape, so the file lints before stack-inputs.ts exists.
const { STACK_EXTRA_INPUTS, stacksReadingChangedInputs } =
  (await import('./stack-inputs.ts')) as StackInputsModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/00-site-hosting';
const HEADERS = 'apps/site/headers.json';

// ---- AC-46: the table and the module shape ---------------------------------------------------------

describe('AC-46: STACK_EXTRA_INPUTS', () => {
  test('AC-46: it lists apps/site/headers.json for labs/00-site-hosting and nothing else', () => {
    expect(STACK_EXTRA_INPUTS).toEqual({ [LAB]: [HEADERS] });
  });

  test('AC-46: stack-inputs.ts has no import (pure module)', () => {
    const source = readFileSync(join(HERE, 'stack-inputs.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\bimport\b/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

// ---- AC-47: stacksReadingChangedInputs ---------------------------------------------------------------

describe('AC-47: stacksReadingChangedInputs', () => {
  const stacks = ['bootstrap/workload', LAB, 'labs/01-x'];

  test.each([
    ['a forward-slash path', [HEADERS]],
    ['a backslash path', ['apps\\site\\headers.json']],
    ['the file among others', ['README.md', HEADERS, 'apps/site/x.ts']],
  ])('AC-47: %s selects labs/00-site-hosting', (_label, changed) => {
    expect(stacksReadingChangedInputs(stacks, changed)).toEqual([LAB]);
  });

  test.each([
    ['a longer file name', ['apps/site/headers.json.bak']],
    ['another file under apps/site', ['apps/site/x.ts']],
    ['a path that only ends the same way', ['x/apps/site/headers.json']],
    ['no changed files', []],
  ])('AC-47: %s selects nothing', (_label, changed) => {
    expect(stacksReadingChangedInputs(stacks, changed)).toEqual([]);
  });

  test('AC-47: with stacks that do not contain the lab it selects nothing', () => {
    expect(stacksReadingChangedInputs(['bootstrap/workload', 'labs/01-x'], [HEADERS])).toEqual([]);
    expect(stacksReadingChangedInputs([], [HEADERS])).toEqual([]);
  });

  test('AC-47: the result is unique even when the file is listed twice', () => {
    expect(stacksReadingChangedInputs([LAB, LAB], [HEADERS, HEADERS])).toEqual([LAB]);
  });
});

// ---- AC-48: the two selectors use it -------------------------------------------------------------------

describe('AC-48: stacksToCheck and labStacksToPlan add the stacks that read a changed input', () => {
  test('AC-48: stacksToCheck selects the lab when only headers.json changed', () => {
    expect(stacksToCheck(['bootstrap/workload', LAB], [HEADERS])).toEqual([LAB]);
  });

  test('AC-48: stacksToCheck returns both stacks, sorted, when a file of the other stack changed too', () => {
    expect(
      stacksToCheck(['bootstrap/workload', LAB], [HEADERS, 'bootstrap/workload/main.tf']),
    ).toEqual(['bootstrap/workload', LAB]);
  });

  test('AC-48: stacksToCheck still selects nothing for any other file under apps/', () => {
    expect(stacksToCheck(['bootstrap/workload', LAB], ['apps/site/x.ts'])).toEqual([]);
    expect(stacksToCheck(['bootstrap/workload', LAB], ['apps/site/headers.json.bak'])).toEqual([]);
  });

  test('AC-48: stacksToCheck does not select a lab that is not among the stacks', () => {
    expect(stacksToCheck(['bootstrap/workload'], [HEADERS])).toEqual([]);
  });

  test('AC-48: stacksToCheck keeps selecting every stack for a module change', () => {
    expect(stacksToCheck(['bootstrap/workload', LAB], [HEADERS, 'modules/tags/main.tf'])).toEqual([
      'bootstrap/workload',
      LAB,
    ]);
  });

  test('AC-48: labStacksToPlan selects the lab when only headers.json changed', () => {
    expect(labStacksToPlan([LAB, 'labs/01-x'], [HEADERS])).toEqual([LAB]);
  });

  test('AC-48: labStacksToPlan returns both labs, sorted, when a file of the other lab changed too', () => {
    expect(labStacksToPlan([LAB, 'labs/01-x'], [HEADERS, 'labs/01-x/main.tf'])).toEqual([
      LAB,
      'labs/01-x',
    ]);
  });

  test('AC-48: labStacksToPlan still selects nothing for any other file under apps/', () => {
    expect(labStacksToPlan([LAB, 'labs/01-x'], ['apps/site/x.ts'])).toEqual([]);
  });

  test('AC-48: labStacksToPlan with a backslash path selects the lab', () => {
    expect(labStacksToPlan([LAB, 'labs/01-x'], ['apps\\site\\headers.json'])).toEqual([LAB]);
  });
});

// ---- AC-50: every path a stack reads outside itself is listed -------------------------------------------

/** `${path.module}/../…` paths used in file(), templatefile() or fileexists(), as written. */
function outsidePaths(tfText: string): string[] {
  const pattern =
    /\b(?:file|templatefile|fileexists)\s*\(\s*"\$\{path\.module\}\/((?:\.\.\/)+[^"]*)"/g;
  return [...tfText.matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('AC-50: the scanner works (self-check)', () => {
  test('AC-50: it finds file, templatefile and fileexists paths that leave the stack', () => {
    const text = [
      'a = file("${path.module}/../../apps/site/headers.json")',
      'b = templatefile("${path.module}/../x/t.tpl", {})',
      'c = fileexists("${path.module}/../../y.json")',
      'd = file("${path.module}/functions/viewer-request.js")',
      'e = file("${path.module}/functions/../x.js")',
      'f = filebase64("${path.module}/../z")',
    ].join('\n');
    expect(outsidePaths(text)).toEqual([
      '../../apps/site/headers.json',
      '../x/t.tpl',
      '../../y.json',
    ]);
  });
});

function git(args: string[]): string[] {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter((line) => line !== '');
}

/** Files in git's view: tracked, plus new files that are not git-ignored (and exist). */
function repoFiles(): string[] {
  return git(['ls-files', '--cached', '--others', '--exclude-standard']).filter((file) =>
    existsSync(join(REPO_ROOT, file)),
  );
}

/** Repo-relative paths each stack reads outside itself. */
function stackReads(): Map<string, string[]> {
  const files = repoFiles();
  const reads = new Map<string, string[]>();
  for (const stack of terraformStacks(files)) {
    const found = files
      .filter(
        (file) => file.startsWith(`${stack}/`) && /^[^/]+$/.test(file.slice(stack.length + 1)),
      )
      .filter((file) => file.endsWith('.tf'))
      .flatMap((file) => outsidePaths(readFileSync(join(REPO_ROOT, file), 'utf8')))
      .map((relative) => posix.normalize(posix.join(stack, relative)));
    reads.set(stack, [...new Set(found)].sort());
  }
  return reads;
}

describe('AC-50: stack inputs outside the stack are all listed', () => {
  test('AC-50: labs/00-site-hosting reads apps/site/headers.json from its .tf files', () => {
    expect(stackReads().get(LAB)).toContain(HEADERS);
  });

  test('AC-50: every path a stack reads outside itself is listed in STACK_EXTRA_INPUTS for it', () => {
    const missing: string[] = [];
    for (const [stack, paths] of stackReads()) {
      const listed = STACK_EXTRA_INPUTS[stack] ?? [];
      for (const path of paths) if (!listed.includes(path)) missing.push(`${stack}: ${path}`);
    }
    expect(missing).toEqual([]);
  });

  test('AC-50: every listed path is a tracked file', () => {
    const tracked = new Set(git(['ls-files']));
    const untracked = Object.entries(STACK_EXTRA_INPUTS).flatMap(([stack, paths]) =>
      paths.filter((path) => !tracked.has(path)).map((path) => `${stack}: ${path}`),
    );
    expect(untracked).toEqual([]);
    expect(Object.keys(STACK_EXTRA_INPUTS).length).toBeGreaterThan(0);
  });
});
