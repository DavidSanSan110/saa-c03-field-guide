import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Every test spawns a real process (tsx + git), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Environment without the GIT_* variables that a hook would leak into the temp repositories. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function runCli(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: cleanEnv(), stdio: 'pipe', windowsHide: true });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp repo whose default branch is `main`. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-tf-'));
  tempDirs.push(dir);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'tester@example.com']);
  git(dir, ['config', 'user.name', 'Tester']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(dir: string, message = 'chore: change'): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '--no-verify', '-m', message]);
}

/** main holds two lab stacks (and a README); HEAD is left on `main`. */
function seededRepo(): string {
  const dir = makeTempRepo();
  write(dir, 'README.md', '# repo\n');
  write(dir, 'labs/00-a/main.tf', '# a\n');
  write(dir, 'labs/01-b/main.tf', '# b\n');
  commitAll(dir, 'chore: seed');
  return dir;
}

/** Expects exactly one stdout line holding the JSON array, and a clean exit. */
function expectStacks(run: Run, expected: string[]): void {
  expect(run.stderr).toBe('');
  expect(run.stdout).toBe(`${JSON.stringify(expected)}\n`);
  expect(run.status).toBe(0);
}

describe('guardrails tf-stacks --base <ref>', () => {
  test('AC-4: prints the stack a branch edited, as exactly one JSON line, and exits 0', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'labs/01-b/main.tf', '# b changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), ['labs/01-b']);
  });

  test('AC-4: a branch that only edits README.md prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'docs']);
    write(dir, 'README.md', '# repo, edited\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), []);
  });

  test('AC-4: a branch with no change at all prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'same']);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), []);
  });

  test('AC-4: renaming a stack prints only the new name', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'rename']);
    mkdirSync(join(dir, 'labs', '02-c'), { recursive: true });
    git(dir, ['mv', 'labs/01-b/main.tf', 'labs/02-c/main.tf']);
    commitAll(dir);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), ['labs/02-c']);
  });

  test('AC-4: changes made on main after the branch point are not counted (three-dot diff)', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'labs/01-b/main.tf', '# b changed on the branch\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', 'main']);
    write(dir, 'labs/00-a/main.tf', '# a changed on main\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', 'feature']);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), ['labs/01-b']);
  });

  test('AC-4: a changed module selects every stack, sorted', () => {
    const dir = seededRepo();
    write(dir, 'modules/tags/main.tf', '# tags\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', '-b', 'module']);
    write(dir, 'modules/tags/main.tf', '# tags, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), [
      'labs/00-a',
      'labs/01-b',
      'modules/tags',
    ]);
  });

  test('AC-4: --head names the tip to compare, defaulting to HEAD', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'labs/00-a/main.tf', '# a changed\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', 'main']);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), []);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main', '--head', 'feature']), ['labs/00-a']);
  });
});

describe('guardrails tf-stacks --all', () => {
  test('AC-4: prints every tracked stack as exactly one JSON line and exits 0', () => {
    const dir = seededRepo();
    expectStacks(runCli(dir, ['tf-stacks', '--all']), ['labs/00-a', 'labs/01-b']);
  });

  test('AC-4: prints [] when the repo has no stack', () => {
    const dir = makeTempRepo();
    write(dir, 'README.md', '# repo\n');
    commitAll(dir, 'chore: seed');
    expectStacks(runCli(dir, ['tf-stacks', '--all']), []);
  });
});

describe('guardrails tf-stacks: usage errors', () => {
  function expectUsageError(run: Run): void {
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    // The usage text must list the new command (it does not exist before the implementation).
    expect(run.stderr).toMatch(/^\s*guardrails tf-stacks\b/m);
  }

  test('AC-5: no arguments exits 2 with usage on stderr and nothing on stdout', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks']));
  });

  test('AC-5: --base without a value exits 2 with nothing on stdout', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks', '--base']));
  });

  test('AC-5: an unknown flag exits 2 with nothing on stdout', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks', '--bogus']));
  });

  test('AC-5: an unknown flag next to a valid one exits 2', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks', '--base', 'main', '--bogus']));
  });

  test('AC-5: --all together with --base exits 2 with nothing on stdout', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks', '--all', '--base', 'x']));
  });

  test('AC-5: an extra positional argument exits 2', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks', '--base', 'main', 'extra']));
  });

  test('AC-5: --head without --base exits 2', () => {
    expectUsageError(runCli(seededRepo(), ['tf-stacks', '--head', 'HEAD']));
  });

  test('AC-5: --base with a ref that does not exist exits 2 with a message on stderr', () => {
    const dir = seededRepo();
    // Precondition: the command exists and works with a valid ref.
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), []);
    const run = runCli(dir, ['tf-stacks', '--base', 'no-such-ref']);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toBe('');
  });
});

describe('guardrails tf-stacks: renames across stacks (review round 1)', () => {
  test('AC-24: moving a file from one stack to another selects both stacks (--no-renames)', () => {
    const dir = seededRepo();
    // Enough identical content for git to detect the move as a rename.
    const variables = Array.from(
      { length: 12 },
      (_, index) => `variable "v${index}" {\n  type    = string\n  default = "value-${index}"\n}\n`,
    ).join('\n');
    write(dir, 'labs/01-b/variables.tf', variables);
    commitAll(dir, 'chore: add variables');
    git(dir, ['checkout', '--quiet', '-b', 'move']);
    git(dir, ['mv', 'labs/01-b/variables.tf', 'labs/00-a/variables.tf']);
    commitAll(dir);
    // labs/01-b/main.tf stays, so labs/01-b still exists and lost a file: it must be re-checked.
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), ['labs/00-a', 'labs/01-b']);
  });
});
