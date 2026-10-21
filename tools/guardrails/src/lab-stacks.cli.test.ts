import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Spec 033, section 2: `guardrails lab-stacks`. Every test spawns a real process (tsx + git).
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanEnv(),
    stdio: 'pipe',
    windowsHide: true,
    encoding: 'utf8',
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp repo whose default branch is `main`. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-lab-'));
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

function commitAll(dir: string, message = 'chore: change'): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '--no-verify', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** main holds a bootstrap stack, two lab stacks and a module; HEAD is left on `main`. */
function seededRepo(): string {
  const dir = makeTempRepo();
  write(dir, 'README.md', '# repo\n');
  write(dir, 'bootstrap/workload/main.tf', '# workload\n');
  write(dir, 'labs/00-a/main.tf', '# a\n');
  write(dir, 'labs/01-b/main.tf', '# b\n');
  write(dir, 'modules/tags/main.tf', '# tags\n');
  commitAll(dir, 'chore: seed');
  return dir;
}

/** Expects exactly one stdout line holding the JSON array, and a clean exit. */
function expectStacks(run: Run, expected: string[]): void {
  expect(run.stderr).toBe('');
  expect(run.stdout).toBe(`${JSON.stringify(expected)}\n`);
  expect(run.status).toBe(0);
}

describe('guardrails lab-stacks --base <ref>', () => {
  test('AC-5: prints the lab a branch edited, as exactly one JSON line, and exits 0', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'labs/01-b/main.tf', '# b changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/01-b']);
  });

  test('AC-5: a changed module selects every lab, and only labs', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'module']);
    write(dir, 'modules/tags/main.tf', '# tags, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/00-a', 'labs/01-b']);
  });

  test('AC-5: a branch that only edits bootstrap/workload prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'bootstrap']);
    write(dir, 'bootstrap/workload/main.tf', '# workload, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
  });

  test('AC-5: a branch with no change at all prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'same']);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
  });

  test('AC-5: changes made on main after the branch point are not counted (three-dot diff)', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'labs/01-b/main.tf', '# b changed on the branch\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', 'main']);
    write(dir, 'labs/00-a/main.tf', '# a changed on main\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', 'feature']);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/01-b']);
  });

  test('AC-5: --head names the tip to compare, defaulting to HEAD', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'labs/00-a/main.tf', '# a changed\n');
    commitAll(dir);
    git(dir, ['checkout', '--quiet', 'main']);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main', '--head', 'feature']), ['labs/00-a']);
  });

  test('AC-5: --base <sha1> --head <sha2> counts only the commits in that range', () => {
    const dir = seededRepo();
    const first = git(dir, ['rev-parse', 'HEAD']).trim();
    write(dir, 'labs/00-a/main.tf', '# a changed\n');
    const second = commitAll(dir, 'chore: change a');
    write(dir, 'labs/01-b/main.tf', '# b changed\n');
    const third = commitAll(dir, 'chore: change b');
    expectStacks(runCli(dir, ['lab-stacks', '--base', first, '--head', second]), ['labs/00-a']);
    expectStacks(runCli(dir, ['lab-stacks', '--base', second, '--head', third]), ['labs/01-b']);
    expectStacks(runCli(dir, ['lab-stacks', '--base', first, '--head', third]), [
      'labs/00-a',
      'labs/01-b',
    ]);
  });

  test('AC-5: moving a file between two labs selects both (--no-renames, as tf-stacks)', () => {
    const dir = seededRepo();
    const variables = Array.from(
      { length: 12 },
      (_, index) => `variable "v${index}" {\n  type    = string\n  default = "value-${index}"\n}\n`,
    ).join('\n');
    write(dir, 'labs/01-b/variables.tf', variables);
    commitAll(dir, 'chore: add variables');
    git(dir, ['checkout', '--quiet', '-b', 'move']);
    git(dir, ['mv', 'labs/01-b/variables.tf', 'labs/00-a/variables.tf']);
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/00-a', 'labs/01-b']);
  });
});

describe('guardrails lab-stacks --all', () => {
  test('AC-5: prints every tracked lab as exactly one JSON line and exits 0', () => {
    const dir = seededRepo();
    expectStacks(runCli(dir, ['lab-stacks', '--all']), ['labs/00-a', 'labs/01-b']);
  });

  test('AC-5: prints [] when the repo has no lab', () => {
    const dir = makeTempRepo();
    write(dir, 'bootstrap/workload/main.tf', '# workload\n');
    write(dir, 'modules/tags/main.tf', '# tags\n');
    commitAll(dir, 'chore: seed');
    expectStacks(runCli(dir, ['lab-stacks', '--all']), []);
  });
});

describe('guardrails lab-stacks --stack <path>', () => {
  test('AC-6: a tracked lab stack prints it as a one-element JSON array', () => {
    expectStacks(runCli(seededRepo(), ['lab-stacks', '--stack', 'labs/00-a']), ['labs/00-a']);
  });

  test.each(['labs/02-gone', 'modules/tags', 'bootstrap/workload', 'labs/00-a;id'])(
    'AC-6: --stack %s is refused with "not a lab stack" and exit 2',
    (stack) => {
      const dir = seededRepo();
      // Precondition: the command exists and works for a real lab.
      expectStacks(runCli(dir, ['lab-stacks', '--stack', 'labs/00-a']), ['labs/00-a']);
      const run = runCli(dir, ['lab-stacks', '--stack', stack]);
      expect(run.stderr).toContain('not a lab stack');
      expect(run.stdout).toBe('');
      expect(run.status).toBe(2);
    },
  );
});

describe('guardrails lab-stacks: usage errors', () => {
  function expectUsageError(run: Run): void {
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    // The usage text must list the new command (it does not exist before the implementation).
    expect(run.stderr).toMatch(/^\s*guardrails lab-stacks\b/m);
  }

  const cases: [string, string[]][] = [
    ['no arguments', []],
    ['--base without a value', ['--base']],
    ['--stack without a value', ['--stack']],
    ['an unknown flag', ['--bogus']],
    ['an unknown flag next to a valid one', ['--base', 'main', '--bogus']],
    ['--all together with --stack', ['--all', '--stack', 'labs/00-a']],
    ['--base together with --all', ['--base', 'main', '--all']],
    ['--base together with --stack', ['--base', 'main', '--stack', 'labs/00-a']],
    ['--head alone', ['--head', 'x']],
    ['--head with --all', ['--all', '--head', 'main']],
    ['--head with --stack', ['--stack', 'labs/00-a', '--head', 'main']],
    ['an extra positional argument', ['--all', 'extra']],
  ];

  test.each(cases)('AC-7: %s exits 2 with usage on stderr and nothing on stdout', (_name, args) => {
    expectUsageError(runCli(seededRepo(), ['lab-stacks', ...args]));
  });

  test('AC-7: --base with a ref that does not exist exits 2 with a message on stderr', () => {
    const dir = seededRepo();
    // Precondition: the command exists and works with a valid ref.
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
    const run = runCli(dir, ['lab-stacks', '--base', 'no-such-ref']);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toBe('');
  });

  test('AC-7: --head with a ref that does not exist exits 2', () => {
    const dir = seededRepo();
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
    const run = runCli(dir, ['lab-stacks', '--base', 'main', '--head', 'no-such-ref']);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
  });
});

describe('guardrails lab-stacks: lab names that break the rule', () => {
  function repoWithBadLab(): string {
    const dir = seededRepo();
    write(dir, 'labs/bad_name/main.tf', '# bad\n');
    commitAll(dir, 'chore: add a badly named lab');
    return dir;
  }

  test('AC-8: --all exits 2 naming the bad stack, with nothing on stdout', () => {
    const dir = repoWithBadLab();
    const run = runCli(dir, ['lab-stacks', '--all']);
    expect(run.stderr).toContain('labs/bad_name');
    expect(run.stdout).toBe('');
    expect(run.status).toBe(2);
  });

  test('AC-8: --base exits 2 when the changed set holds the bad stack', () => {
    const dir = repoWithBadLab();
    git(dir, ['checkout', '--quiet', '-b', 'touch-bad']);
    write(dir, 'labs/bad_name/main.tf', '# bad, changed\n');
    commitAll(dir);
    const run = runCli(dir, ['lab-stacks', '--base', 'main']);
    expect(run.stderr).toContain('labs/bad_name');
    expect(run.stdout).toBe('');
    expect(run.status).toBe(2);
  });
});
