import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Spec 047, section 2: `guardrails lab-stacks --base` ignores Markdown-only changes in labs and
// modules. Every test spawns a real process (tsx + git).
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
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-lab-run-'));
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

/** main holds two lab stacks and a module, each with a README; HEAD is left on `main`. */
function seededRepo(): string {
  const dir = makeTempRepo();
  write(dir, 'labs/00-a/main.tf', '# a\n');
  write(dir, 'labs/01-b/main.tf', '# b\n');
  write(dir, 'labs/01-b/README.md', '# lab b\n');
  write(dir, 'modules/tags/main.tf', '# tags\n');
  write(dir, 'modules/tags/README.md', '# tags module\n');
  commitAll(dir, 'chore: seed');
  return dir;
}

/** Expects exactly one stdout line holding the JSON array, and a clean exit. */
function expectStacks(run: Run, expected: string[]): void {
  expect(run.stderr).toBe('');
  expect(run.stdout).toBe(`${JSON.stringify(expected)}\n`);
  expect(run.status).toBe(0);
}

describe('guardrails lab-stacks --base: Markdown-only changes', () => {
  test('AC-8: a branch that only changes a lab README prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'docs']);
    write(dir, 'labs/01-b/README.md', '# lab b, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
  });

  test('AC-8: a branch that only adds break-it.md to a lab prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'docs']);
    write(dir, 'labs/00-a/break-it.md', '# break it\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
  });

  test('AC-8: a branch that only changes a module README prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'docs']);
    write(dir, 'modules/tags/README.md', '# tags module, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
  });
});

describe('guardrails lab-stacks --base: Markdown next to other files', () => {
  test('AC-9: a lab README and the same lab main.tf select that lab', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'mixed']);
    write(dir, 'labs/01-b/README.md', '# lab b, changed\n');
    write(dir, 'labs/01-b/main.tf', '# b changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/01-b']);
  });

  test("AC-9: one lab's README and a module .tf file select every lab", () => {
    const dir = seededRepo();
    write(dir, 'labs/00-a/README.md', '# lab a\n');
    commitAll(dir, 'chore: add a README');
    git(dir, ['checkout', '--quiet', '-b', 'mixed']);
    write(dir, 'labs/00-a/README.md', '# lab a, changed\n');
    write(dir, 'modules/tags/main.tf', '# tags, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/00-a', 'labs/01-b']);
  });
});

describe('guardrails lab-stacks: ranges and the other modes', () => {
  test('AC-10: --base <sha1> --head <sha2> over a README-only range prints []', () => {
    const dir = seededRepo();
    const first = git(dir, ['rev-parse', 'HEAD']).trim();
    write(dir, 'labs/01-b/README.md', '# lab b, changed\n');
    const second = commitAll(dir, 'docs: change the README');
    expectStacks(runCli(dir, ['lab-stacks', '--base', first, '--head', second]), []);
  });

  test('AC-10: --stack still prints the lab, whatever changed', () => {
    const dir = seededRepo();
    expectStacks(runCli(dir, ['lab-stacks', '--stack', 'labs/01-b']), ['labs/01-b']);
  });
});
