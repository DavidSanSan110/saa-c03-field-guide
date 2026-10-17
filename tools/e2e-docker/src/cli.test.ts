import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { dockerRunArgs } from './docker.ts';
import { ciPlaywrightImage } from './image.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const IS_WINDOWS = process.platform === 'win32';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-docker-cli-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Preloaded (NODE_OPTIONS=--require) into the fake docker, which is a copy of the node binary named
 * `docker`: it records its arguments, prints a line and exits with FAKE_DOCKER_EXIT. In every other
 * node process (the CLI itself, tsx) it does nothing. A copy of node works as a fake `docker` on
 * Windows too, where a spawn without a shell only finds `.exe` files.
 */
const FAKE_DOCKER_PRELOAD = `
const fs = require('node:fs');
const path = require('node:path');
if (path.basename(process.execPath, '.exe').toLowerCase() === 'docker') {
  // Node resolves its first argument ("run") to an absolute script path; undo that.
  const first = path.isAbsolute(process.argv[1]) ? path.relative(process.cwd(), process.argv[1]) : process.argv[1];
  const args = [first, ...process.argv.slice(2)];
  fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
  process.stdout.write('fake docker ran\\n');
  process.exit(Number(process.env.FAKE_DOCKER_EXIT || '0'));
}
`;

interface Run {
  status: number | null;
  output: string;
}

function envWithPath(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== 'path' && !key.startsWith('GIT_') && key !== 'NODE_OPTIONS') {
      env[key] = value;
    }
  }
  env['PATH'] = path;
  return Object.assign(env, extra);
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, output: String(result.stdout) + String(result.stderr) };
}

interface FakeDocker {
  run: (args: string[], exitCode?: number) => Run;
  /** The argument lists the fake docker was started with, in order. */
  calls: () => string[][];
}

/** A temp PATH folder with a fake `docker` in it. */
function withFakeDocker(): FakeDocker {
  const root = makeTempDir();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fake = join(bin, IS_WINDOWS ? 'docker.exe' : 'docker');
  copyFileSync(process.execPath, fake);
  chmodSync(fake, 0o755);
  const preload = join(root, 'fake-docker.cjs');
  writeFileSync(preload, FAKE_DOCKER_PRELOAD);
  const log = join(root, 'calls.log');
  return {
    run: (args, exitCode = 0) =>
      runCli(
        args,
        envWithPath([bin, dirname(process.execPath)].join(delimiter), {
          NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
          FAKE_DOCKER_LOG: log,
          FAKE_DOCKER_EXIT: String(exitCode),
        }),
      ),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

/** The `docker` arguments the CLI has to produce for `playwrightArgs` in this repository. */
function expectedDockerArgs(playwrightArgs: string[]): string[] {
  const ciYaml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  return dockerRunArgs({
    repoDir: REPO_ROOT,
    image: ciPlaywrightImage(ciYaml),
    playwrightArgs,
  });
}

describe('pnpm e2e:docker', () => {
  test('AC-10: with docker missing from PATH it exits 1 and prints "docker not found"', () => {
    const emptyBin = join(makeTempDir(), 'empty');
    mkdirSync(emptyBin);

    const run = runCli([], envWithPath(emptyBin));

    expect(run.output).toContain('docker not found');
    expect(run.status).toBe(1);
  });

  test('AC-10: the fake docker receives exactly dockerRunArgs for the repo root, the image of ci.yml and the forwarded arguments', () => {
    const playwrightArgs = ['--update-snapshots', '-g', "it's $(x)"];
    const docker = withFakeDocker();

    const run = docker.run(playwrightArgs);

    expect(run.output).toContain('fake docker ran');
    expect(docker.calls()).toEqual([expectedDockerArgs(playwrightArgs)]);
  });

  test('AC-10: with no arguments docker receives dockerRunArgs with no playwright arguments', () => {
    const docker = withFakeDocker();

    docker.run([]);

    expect(docker.calls()).toEqual([expectedDockerArgs([])]);
  });

  test('AC-10: the CLI exits with the exit code of docker', () => {
    const docker = withFakeDocker();

    const run = docker.run([], 7);

    expect(docker.calls()).toHaveLength(1);
    expect(run.status).toBe(7);
  });

  test('AC-10: the CLI exits 0 when docker exits 0', () => {
    const docker = withFakeDocker();

    const run = docker.run([], 0);

    expect(docker.calls()).toHaveLength(1);
    expect(run.status).toBe(0);
  });

  test('AC-10: the output of docker reaches the output of the CLI (stdio is inherited)', () => {
    const docker = withFakeDocker();

    const run = docker.run([]);

    expect(run.output).toContain('fake docker ran');
  });
});
