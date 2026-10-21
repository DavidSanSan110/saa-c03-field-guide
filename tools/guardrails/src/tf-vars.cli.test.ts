import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Spec 035, section 1: tf-vars-cli.ts runs with plain Node (no tsx, no pnpm install) inside the
// infra.yml "Export lab variables" step. Every test spawns a real process.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CLI = join(REPO_ROOT, 'tools', 'guardrails', 'src', 'tf-vars-cli.ts');

const VALUE = 'sentinel-value-123';

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tf-vars-cli-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Runs the CLI as the workflow does (`node --experimental-strip-types <cli>`) in an empty working
 * directory, with exactly the given environment variables on top of the basics Node needs.
 */
function runCli(env: Record<string, string | undefined>, cwd: string): Run {
  if (!existsSync(CLI)) throw new Error('missing file: tools/guardrails/src/tf-vars-cli.ts');
  const base: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...base, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A working directory plus a GITHUB_ENV file that already holds one line. */
function setup(): { dir: string; envFile: string } {
  const dir = tempDir();
  const envFile = join(dir, 'github-env');
  writeFileSync(envFile, 'EXISTING=1\n');
  return { dir, envFile };
}

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

describe('AC-6: the CLI exports the variables', () => {
  test('AC-6: valid REPO_VARS appends exactly the name=value lines to GITHUB_ENV, keeping the rest', () => {
    const { dir, envFile } = setup();
    const repoVars = JSON.stringify({
      TF_VAR_HOSTED_ZONE_ID: 'Z0123456789EXAMPLE',
      TF_VAR_DOMAIN_NAME: VALUE,
      UNRELATED: 'ignored',
    });
    const run = runCli({ REPO_VARS: repoVars, GITHUB_ENV: envFile }, dir);
    expect(run.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe(
      `EXISTING=1\nTF_VAR_domain_name=${VALUE}\nTF_VAR_hosted_zone_id=Z0123456789EXAMPLE\n`,
    );
  });

  test('AC-6: it prints one "exported <name>" line per variable and never a value', () => {
    const { dir, envFile } = setup();
    const repoVars = JSON.stringify({ TF_VAR_B: VALUE, TF_VAR_A: `${VALUE}-2` });
    const run = runCli({ REPO_VARS: repoVars, GITHUB_ENV: envFile }, dir);
    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual(['exported TF_VAR_a', 'exported TF_VAR_b']);
    expect(run.stdout).not.toContain(VALUE);
    expect(run.stderr).not.toContain(VALUE);
  });

  test('AC-6: a GITHUB_ENV file that does not exist yet is created', () => {
    const dir = tempDir();
    const envFile = join(dir, 'new-env');
    const run = runCli({ REPO_VARS: '{"TF_VAR_X":"1"}', GITHUB_ENV: envFile }, dir);
    expect(run.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe('TF_VAR_x=1\n');
  });

  test.each([
    ['an empty object', '{}'],
    ['the empty string', ''],
    ['the JSON null', 'null'],
    ['only unrelated variables', '{"OTHER":"x"}'],
  ])(
    'AC-6: with %s it writes nothing, prints "no TF_VAR_ repository variables" and exits 0',
    (_label, repoVars) => {
      const { dir, envFile } = setup();
      const run = runCli({ REPO_VARS: repoVars, GITHUB_ENV: envFile }, dir);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('no TF_VAR_ repository variables');
      expect(run.stdout).not.toContain('exported');
      expect(readFileSync(envFile, 'utf8')).toBe('EXISTING=1\n');
    },
  );
});

describe('AC-7: the CLI fails closed', () => {
  test.each([
    ['invalid JSON', '{'],
    ['a JSON array', '["TF_VAR_A"]'],
    ['a non-string value', '{"TF_VAR_A":1}'],
    ['a bad variable name', '{"TF_VAR_OK":"1","TF_VAR_bad-name":"2"}'],
    ['a value with a line feed', JSON.stringify({ TF_VAR_OK: '1', TF_VAR_BAD: `${VALUE}\nX=1` })],
    ['two keys with the same output name', '{"TF_VAR_A":"1","tf_var_a":"2"}'],
  ])(
    'AC-7: %s exits 1 with a stderr message and leaves GITHUB_ENV unchanged',
    (_label, repoVars) => {
      const { dir, envFile } = setup();
      const run = runCli({ REPO_VARS: repoVars, GITHUB_ENV: envFile }, dir);
      expect(run.status).toBe(1);
      expect(run.stderr.trim()).not.toBe('');
      expect(run.stderr).not.toContain(VALUE);
      expect(readFileSync(envFile, 'utf8')).toBe('EXISTING=1\n');
    },
  );

  test('AC-7: it prints no "exported" line when it fails', () => {
    const { dir, envFile } = setup();
    const run = runCli(
      { REPO_VARS: '{"TF_VAR_OK":"1","TF_VAR_bad-name":"2"}', GITHUB_ENV: envFile },
      dir,
    );
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('exported');
  });

  test('AC-7: with GITHUB_ENV unset it exits 1 with a stderr message and writes nothing', () => {
    const dir = tempDir();
    const run = runCli({ REPO_VARS: '{"TF_VAR_X":"1"}' }, dir);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).not.toBe('');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('AC-7: with GITHUB_ENV empty it exits 1 with a stderr message and writes nothing', () => {
    const dir = tempDir();
    const run = runCli({ REPO_VARS: '{"TF_VAR_X":"1"}', GITHUB_ENV: '' }, dir);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).not.toBe('');
    expect(readdirSync(dir)).toEqual([]);
  });
});
