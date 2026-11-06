import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { markdownReads } from './markdown-reads.ts';
import { STACK_EXTRA_INPUTS } from './stack-inputs.ts';

// Spec 047, section 3: no lab or module reads a Markdown file or a whole folder (pure), plus the
// same check over the real repo and the CONTRIBUTING.md sentence (section 4).

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root: the nearest parent that holds `.git` (a folder, or a file in a worktree). */
function findRepoRoot(): string {
  let dir = HERE;
  while (!existsSync(join(dir, '.git'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no repository root above ${HERE}`);
    dir = parent;
  }
  return dir;
}

const REPO_ROOT = findRepoRoot();

describe('markdownReads: file reads of a Markdown file', () => {
  test.each([
    'x = file("${path.module}/README.md")',
    'x = templatefile("t.MD", {})',
    'x = filebase64sha256("a/b.md")',
    'x = fileexists ("notes.md")',
    'source_file = "${path.module}/doc.md"',
    'x = filemd5("x.md")',
  ])('AC-11: %s gives one problem on line 1, "reads a Markdown file"', (text) => {
    const problems = markdownReads(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 1');
    expect(problems[0]).toContain('reads a Markdown file');
  });
});

describe('markdownReads: reads of a whole folder', () => {
  test.each([
    'x = fileset(path.module, "**")',
    'x = fileset (path.module, "*.py")',
    'source_dir = "${path.module}/src"',
    '  source_dir="src"',
  ])('AC-12: %s gives one problem on line 1, "reads a whole folder"', (text) => {
    const problems = markdownReads(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 1');
    expect(problems[0]).toContain('reads a whole folder');
  });
});

describe('markdownReads: texts that are not a problem', () => {
  test.each([
    ['a .md in a description', 'description = "… break-it.md changes it."'],
    ['a .md in a comment', '# see README.md'],
    ['a file read of a .js file', 'x = file("${path.module}/functions/viewer-request.js")'],
    ['a source_file of a .py file', 'source_file = "${path.module}/src/handler.py"'],
    ['a .mdx file', 'x = file("a.mdx")'],
    ['a .md5 file', 'x = file("a.md5")'],
    ['fileset without a call', 'profile = "fileset"'],
    ['a function that ends in file', 'x = myfile("a.js")'],
    ['source_dir without an equals sign', 'x = "source_dir"'],
    ['the empty text', ''],
  ])('AC-13: %s', (_name, text) => {
    expect(markdownReads(text)).toEqual([]);
  });
});

describe('markdownReads: line numbers', () => {
  test('AC-14: a problem on line 3 (LF) names line 3', () => {
    const problems = markdownReads('a = 1\nb = 2\nx = file("a.md")\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 3');
  });

  test('AC-14: a problem on line 3 (CRLF) names line 3', () => {
    const problems = markdownReads('a = 1\r\nb = 2\r\nx = file("a.md")\r\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 3');
  });

  test('AC-14: a Markdown read on line 1 and fileset( on line 2 give two messages in line order', () => {
    const problems = markdownReads('x = file("a.md")\ny = fileset(path.module, "*")\n');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('line 1');
    expect(problems[0]).toContain('reads a Markdown file');
    expect(problems[1]).toContain('line 2');
    expect(problems[1]).toContain('reads a whole folder');
  });
});

describe('the real repo', () => {
  /** Tracked `.tf` files under labs/ and modules/, repo-relative with forward slashes. */
  function trackedTerraformFiles(): string[] {
    const result = spawnSync('git', ['ls-files', '--', 'labs', 'modules'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
    return result.stdout
      .split(/\r?\n/)
      .filter(
        (file) => file.endsWith('.tf') && (file.startsWith('labs/') || file.startsWith('modules/')),
      );
  }

  test('AC-15: there is at least one tracked .tf file under labs/ and modules/ (sanity)', () => {
    expect(trackedTerraformFiles().length).toBeGreaterThan(0);
  });

  test('AC-15: no tracked .tf file under labs/ or modules/ reads Markdown or a whole folder', () => {
    const found: string[] = [];
    for (const file of trackedTerraformFiles()) {
      const text = readFileSync(join(REPO_ROOT, ...file.split('/')), 'utf8');
      for (const problem of markdownReads(text)) found.push(`${file}: ${problem}`);
    }
    expect(found).toEqual([]);
  });

  test('AC-16: no extra input of any stack is a Markdown file', () => {
    const inputs = Object.values(STACK_EXTRA_INPUTS).flat();
    expect(inputs.filter((input) => input.toLowerCase().endsWith('.md'))).toEqual([]);
  });
});

describe('CONTRIBUTING.md', () => {
  test('AC-17: says that a Markdown-only change touches no lab stack', () => {
    const sentence =
      'a change touches (a change to Markdown files only, in a lab or under `modules/`, touches none);';
    const lines = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8').split(/\r?\n/);
    expect(lines).toContainEqual(expect.stringContaining(sentence));
  });
});
