import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Spec 035, section 12 (AC-49): `guardrails tf-stacks` and `guardrails lab-stacks` select the lab
// when only apps/site/headers.json changed. Every test spawns a real process (tsx + git).
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const LAB = 'labs/00-site-hosting';

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
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-inputs-'));
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

/** main holds the lab, the file it reads, another app file and a bootstrap stack. */
function seededRepo(): string {
  const dir = makeTempRepo();
  write(dir, 'README.md', '# repo\n');
  write(dir, 'bootstrap/workload/main.tf', '# workload\n');
  write(dir, `${LAB}/main.tf`, '# lab\n');
  write(dir, 'apps/site/headers.json', '{}\n');
  write(dir, 'apps/site/x.ts', '// x\n');
  commitAll(dir, 'chore: seed');
  return dir;
}

/** Expects exactly one stdout line holding the JSON array, and a clean exit. */
function expectStacks(run: Run, expected: string[]): void {
  expect(run.stderr).toBe('');
  expect(run.stdout).toBe(`${JSON.stringify(expected)}\n`);
  expect(run.status).toBe(0);
}

describe.each(['tf-stacks', 'lab-stacks'])('AC-49: guardrails %s --base <ref>', (command) => {
  test(`AC-49: a commit that changes only apps/site/headers.json prints ["${LAB}"]`, () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'headers']);
    write(dir, 'apps/site/headers.json', '{"X-Test":"1"}\n');
    commitAll(dir);
    expectStacks(runCli(dir, [command, '--base', 'main']), [LAB]);
  });

  test('AC-49: a commit that changes only another file under apps/ prints []', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'other']);
    write(dir, 'apps/site/x.ts', '// x, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, [command, '--base', 'main']), []);
  });
});

describe('AC-49: other stacks are unaffected', () => {
  test('AC-49: tf-stacks prints both stacks, sorted, when headers.json and the other stack changed', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'both']);
    write(dir, 'apps/site/headers.json', '{"X-Test":"2"}\n');
    write(dir, 'bootstrap/workload/main.tf', '# workload, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['tf-stacks', '--base', 'main']), ['bootstrap/workload', LAB]);
  });

  test('AC-49: lab-stacks prints only the lab when headers.json and a bootstrap stack changed', () => {
    const dir = seededRepo();
    git(dir, ['checkout', '--quiet', '-b', 'both']);
    write(dir, 'apps/site/headers.json', '{"X-Test":"2"}\n');
    write(dir, 'bootstrap/workload/main.tf', '# workload, changed\n');
    commitAll(dir);
    expectStacks(runCli(dir, ['lab-stacks', '--base', 'main']), [LAB]);
  });
});
