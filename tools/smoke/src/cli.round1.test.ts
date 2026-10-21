import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

// Spec 036, review round 1: AC-36 and AC-37, the CLI on an unusable headers file. Every test spawns a
// real process (tsx) on a copy of tools/smoke/src/ inside a temporary tree, so the tests control what
// apps/site/headers.json contains (or whether it exists).
vi.setConfig({ testTimeout: 60_000 });

const SRC = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true, maxRetries: 3 });
});

/** A temporary tree with the CLI at tools/smoke/src/; `headers` undefined leaves headers.json out. */
function makeTree(headers: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'smoke-round1-'));
  trees.push(root);
  const src = join(root, 'tools', 'smoke', 'src');
  mkdirSync(src, { recursive: true });
  for (const name of readdirSync(SRC)) {
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      cpSync(join(SRC, name), join(src, name));
    }
  }
  writeFileSync(join(root, 'tools', 'smoke', 'package.json'), '{"type":"module"}\n');
  if (headers !== undefined) {
    mkdirSync(join(root, 'apps', 'site'), { recursive: true });
    writeFileSync(join(root, 'apps', 'site', 'headers.json'), headers);
  }
  return root;
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(headers: string | undefined): CliRun {
  const root = makeTree(headers);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const cli = join(root, 'tools', 'smoke', 'src', 'cli.ts');
  const result = spawnSync(process.execPath, [TSX_CLI, cli, '--url', 'https://smoke.invalid'], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 50_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectUnusableHeaders(run: CliRun): void {
  expect(run.status).toBe(2);
  expect(run.stderr.trim().length).toBeGreaterThan(0);
  expect(run.stderr).toContain('headers.json');
  expect(run.stdout).not.toMatch(/^(ok|FAIL|skip) /m);
}

describe('smoke CLI: the headers file', () => {
  test.each<[string, string | undefined]>([
    ['is missing', undefined],
    ['is not JSON', 'this is { not json'],
    ['is a JSON array', '["X-Frame-Options", "DENY"]'],
    ['is a JSON string', '"X-Frame-Options"'],
    ['is JSON null', 'null'],
    ['has a number value', '{"X-Frame-Options": 1}'],
    ['has a null value', '{"X-Frame-Options": null}'],
    ['has an object value', '{"X-Frame-Options": {"value": "DENY"}}'],
    ['has a non-string value next to a string one', '{"X-Frame-Options": "DENY", "Age": 0}'],
  ])('AC-36: a headers file that %s exits 2 naming headers.json, no check lines', (_n, text) => {
    expectUnusableHeaders(runCli(text));
  });

  test.each<[string, string]>([
    ['{}', '{}'],
    ['{} with whitespace', '  {\n}\n'],
  ])(
    'AC-37: an empty headers object (%s) exits 2 naming headers.json, no check lines',
    (_n, text) => {
      expectUnusableHeaders(runCli(text));
    },
  );

  test('AC-36: control, a valid one-header object runs the checks (exit 1 on smoke.invalid)', () => {
    const run = runCli('{"X-Frame-Options": "DENY"}');
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^FAIL /m);
  });
});
