import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Spec 033 review round 1, AC-44: `lab-stacks --base` plans only what changes a plan.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, path: string, content: string): void {
  const full = join(dir, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(dir: string, message = 'chore: change'): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '--no-verify', '-m', message]);
}

/** main holds two labs, a module, the global Terraform files and the workflows. */
function seededRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-labplan-'));
  tempDirs.push(dir);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'tester@example.com']);
  git(dir, ['config', 'user.name', 'Tester']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  write(dir, 'README.md', '# repo\n');
  write(dir, 'labs/00-a/main.tf', '# a\n');
  write(dir, 'labs/01-b/main.tf', '# b\n');
  write(dir, 'modules/tags/main.tf', '# tags\n');
  write(dir, '.terraform-version', '1.14.9\n');
  write(dir, '.tflint.hcl', '# tflint\n');
  write(dir, '.checkov.yaml', 'quiet: true\n');
  write(dir, '.github/workflows/terraform.yml', 'name: Terraform\n');
  write(dir, '.github/workflows/infra.yml', 'name: Infra\n');
  commitAll(dir, 'chore: seed');
  return dir;
}

function expectStacks(run: Run, expected: string[]): void {
  expect(run.stderr).toBe('');
  expect(run.stdout).toBe(`${JSON.stringify(expected)}\n`);
  expect(run.status).toBe(0);
}

function branchEditing(file: string): string {
  const dir = seededRepo();
  git(dir, ['checkout', '--quiet', '-b', 'feature']);
  write(dir, file, '# changed\n');
  commitAll(dir);
  return dir;
}

describe('guardrails lab-stacks --base: what selects every lab', () => {
  test.each([
    '.github/workflows/terraform.yml',
    '.github/workflows/infra.yml',
    '.tflint.hcl',
    '.checkov.yaml',
  ])('AC-44: a branch editing only %s prints []', (file) => {
    const dir = branchEditing(file);
    // Precondition: the command works and selects a lab that really changed.
    git(dir, ['checkout', '--quiet', 'main']);
    git(dir, ['checkout', '--quiet', '-b', 'lab']);
    write(dir, 'labs/00-a/main.tf', '# a, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/00-a']);
    git(dir, ['checkout', '--quiet', 'feature']);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), []);
  });

  test('AC-44: a branch editing .terraform-version prints both labs', () => {
    const dir = branchEditing('.terraform-version');
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/00-a', 'labs/01-b']);
  });

  test('AC-44: a branch editing a module still prints both labs', () => {
    const dir = branchEditing('modules/tags/main.tf');
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), ['labs/00-a', 'labs/01-b']);
  });

  test('AC-44: --all and --stack are unchanged (every lab, whatever the diff)', () => {
    const dir = branchEditing('.github/workflows/terraform.yml');
    expectStacks(runCli(dir, ['lab-stacks', '--all']), ['labs/00-a', 'labs/01-b']);
    expectStacks(runCli(dir, ['lab-stacks', '--stack', 'labs/01-b']), ['labs/01-b']);
  });

  test('AC-44: tf-stacks is unchanged (a terraform.yml edit still re-checks every stack)', () => {
    const dir = branchEditing('.github/workflows/terraform.yml');
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), [
      'labs/00-a',
      'labs/01-b',
      'modules/tags',
    ]);
  });
});
