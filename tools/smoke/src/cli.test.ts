import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

// Spec 036, AC-19: the CLI on usage errors. Every test spawns a real process (tsx), which is slow
// on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** A directory that is not the repo, to prove the headers file is found from the module's path. */
const cwd = mkdtempSync(join(tmpdir(), 'smoke-cli-'));
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('smoke CLI: usage errors', () => {
  test.each<[string, string[]]>([
    ['no --url', []],
    ['--url with an http: URL', ['--url', 'http://smoke.invalid']],
    ['an unknown flag', ['--bogus']],
    ['an unknown flag next to a valid URL', ['--url', 'https://smoke.invalid', '--bogus']],
    [
      'a cloudfront domain outside cloudfront.net',
      ['--url', 'https://smoke.invalid', '--cloudfront-domain', 'example.org'],
    ],
    ['a repeated --url', ['--url', 'https://smoke.invalid', '--url', 'https://smoke.invalid']],
    ['--url without a value', ['--url']],
  ])('AC-19: %s exits 2 with a message on stderr and no check lines on stdout', (_name, args) => {
    const run = runCli(args);
    expect(run.status).toBe(2);
    expect(run.stderr.trim().length).toBeGreaterThan(0);
    expect(run.stdout).not.toMatch(/^(ok|FAIL|skip)\b/m);
    expect(run.stdout).not.toMatch(/^smoke:/m);
  });
});
