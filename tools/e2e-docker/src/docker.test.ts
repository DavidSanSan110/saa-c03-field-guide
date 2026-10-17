import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { containerScript, dockerRunArgs } from './docker.ts';

// Some tests start bash with stubs (Git Bash on Windows is slow to start).
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const IS_WINDOWS = process.platform === 'win32';

const IMAGE = 'mcr.microsoft.com/playwright:v1.64.0-noble@sha256:' + 'a'.repeat(64);
const EXCLUDED = [
  'node_modules',
  '.git',
  'private',
  'test-results',
  'playwright-report',
  'dist',
  '.astro',
];
const ARGS = ['--update-snapshots', '-g', "it's $(x)"];

// ---------------------------------------------------------------------------
// AC-8 docker run arguments
// ---------------------------------------------------------------------------

describe('dockerRunArgs', () => {
  test('AC-8: returns run, --rm, --ipc=host, the env, the volume, the image, then bash -c and the script', () => {
    const playwrightArgs = ['--update-snapshots', '-g', 's3-sse-kms-upload'];

    const args = dockerRunArgs({ repoDir: '/home/me/repo', image: IMAGE, playwrightArgs });

    expect(args).toEqual([
      'run',
      '--rm',
      '--ipc=host',
      '-e',
      'FIELD_GUIDE_VISUAL=1',
      '-v',
      '/home/me/repo:/src',
      IMAGE,
      'bash',
      '-c',
      containerScript(playwrightArgs),
    ]);
  });

  test('AC-8: passes a Windows repoDir unchanged', () => {
    const repoDir = 'C:\\x\\y';

    const args = dockerRunArgs({ repoDir, image: IMAGE, playwrightArgs: [] });

    expect(args[args.indexOf('-v') + 1]).toBe('C:\\x\\y:/src');
  });

  test('AC-8: the playwright arguments are not docker arguments: they live in the script only', () => {
    const args = dockerRunArgs({
      repoDir: '/repo',
      image: IMAGE,
      playwrightArgs: ['--grep-marker'],
    });

    expect(args.slice(0, -1)).not.toContain('--grep-marker');
    expect(args).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// AC-9 the container script, run under bash with stubs
// ---------------------------------------------------------------------------

/** `C:\a\b` -> `/c/a/b` on Windows (Git Bash), unchanged elsewhere. */
function posix(path: string): string {
  const slashes = path.replaceAll('\\', '/');
  return IS_WINDOWS
    ? slashes.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    : slashes;
}

/** The bash to run the script with: Git Bash on Windows (never the WSL launcher), `bash` elsewhere. */
function bashTools(): { bash: string; extraPath: string[] } {
  if (!IS_WINDOWS) return { bash: 'bash', extraPath: [] };
  const execPath = execFileSync('git', ['--exec-path'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const gitRoot = resolve(execPath, '..', '..', '..');
  const bash = join(gitRoot, 'bin', 'bash.exe');
  if (!existsSync(bash)) return { bash: 'bash', extraPath: [] };
  return { bash, extraPath: [join(gitRoot, 'usr', 'bin')] };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-docker-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): void {
  const file = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function read(root: string, relativePath: string): string {
  return readFileSync(join(root, ...relativePath.split('/')), 'utf8');
}

/** The stubbed `pnpm`: logs its arguments, and plays the part of install and of `pnpm e2e`. */
const PNPM_STUB = `#!/bin/bash
{ printf '%s\\n' "$@"; printf '%s\\n' '--END--'; } >> "$STUB_LOG"
case "\${1:-}" in
  install)
    find . -type f | sort > "$STUB_TREE"
    mkdir -p node_modules
    echo installed-in-the-copy > node_modules/installed-in-work.txt
    ;;
  e2e)
    mkdir -p e2e/site/example.spec.ts-snapshots e2e/other/deep/second.spec.ts-snapshots apps/site/dist .astro
    printf 'new' > e2e/site/example.spec.ts-snapshots/shot-chromium-linux.png
    printf 'second' > e2e/other/deep/second.spec.ts-snapshots/other-chromium-linux.png
    echo built > apps/site/dist/built.txt
    echo cache > .astro/cache.txt
    if [ -z "\${STUB_ONLY_SNAPSHOTS:-}" ]; then
      mkdir -p test-results playwright-report
      echo failed-run > test-results/results.txt
      echo report > playwright-report/index.html
    fi
    exit "\${PNPM_E2E_EXIT:-0}"
    ;;
esac
exit 0
`;

/** Stubs for the other tools the container has and the host must not run for real. */
const NOOP_STUB = '#!/bin/bash\nexit 0\n';

interface ScriptRun {
  status: number | null;
  output: string;
  /** The arguments of each `pnpm` call, in order. */
  pnpmCalls: string[][];
  /** The files of the copy at the moment `pnpm install` ran (`./a/b`), sorted. */
  treeAtInstall: string[];
  src: string;
  work: string;
}

function parseCalls(log: string): string[][] {
  const calls: string[][] = [];
  let current: string[] = [];
  for (const line of log.split('\n')) {
    if (line === '--END--') {
      calls.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  return calls;
}

/**
 * Runs `script` under bash the way `docker run ... bash -c` does, with `/src` and `/work` pointed at
 * folders of a temp directory, and `pnpm` and `corepack` replaced by stubs.
 */
function runScript(
  script: string,
  options: { e2eExit?: number; onlySnapshots?: boolean } = {},
): ScriptRun {
  const root = makeTempDir();
  const src = join(root, 'src');
  const work = join(root, 'work');
  const stubs = join(root, 'stubs');
  mkdirSync(stubs);
  mkdirSync(src);
  for (const [name, content] of [
    ['pnpm', PNPM_STUB],
    ['corepack', NOOP_STUB],
  ] as const) {
    writeFileSync(join(stubs, name), content);
    chmodSync(join(stubs, name), 0o755);
  }
  populateSource(src);

  // The script names the mount points `/src` and `/work` (spec 014). One pass, so a replaced
  // temp path is never replaced again.
  const retargeted = script.replace(/(?<![\w.~$-])\/(src|work)(?![\w-])/g, (_match, name: string) =>
    posix(name === 'src' ? src : work),
  );

  const { bash, extraPath } = bashTools();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== 'path') env[key] = value;
  }
  env['PATH'] = [stubs, ...extraPath, process.env['PATH'] ?? ''].join(delimiter);
  env['STUB_LOG'] = posix(join(root, 'pnpm.log'));
  env['STUB_TREE'] = posix(join(root, 'tree.txt'));
  env['PNPM_E2E_EXIT'] = String(options.e2eExit ?? 0);
  if (options.onlySnapshots === true) env['STUB_ONLY_SNAPSHOTS'] = '1';
  delete env['FIELD_GUIDE_VISUAL'];

  const result = spawnSync(bash, ['-c', retargeted], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });

  const logFile = join(root, 'pnpm.log');
  const treeFile = join(root, 'tree.txt');
  return {
    status: result.status,
    output: String(result.stdout) + String(result.stderr) + String(result.error ?? ''),
    pnpmCalls: existsSync(logFile) ? parseCalls(readFileSync(logFile, 'utf8')) : [],
    treeAtInstall: existsSync(treeFile)
      ? readFileSync(treeFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
      : [],
    src,
    work,
  };
}

/** A repo-like source folder: files to keep, and each excluded folder at the root and nested. */
function populateSource(src: string): void {
  write(src, 'package.json', '{}');
  write(src, 'pnpm-lock.yaml', 'lock');
  write(src, '.gitignore', 'dist');
  write(src, '.gitattributes', '* text');
  write(src, '.github/workflows/ci.yml', 'name: CI');
  write(src, 'apps/site/src/page.astro', 'page');
  write(src, 'distribution/keep.txt', 'not dist');
  write(src, 'docs/private-notes.md', 'not private');
  write(src, 'src/privateer/keep.txt', 'not private either');
  write(src, 'e2e/site/example.spec.ts-snapshots/shot-chromium-linux.png', 'old');
  for (const name of EXCLUDED) {
    if (name === '.git') {
      // In a git worktree `.git` is a file; nested, it is a folder.
      write(src, '.git', 'gitdir: /elsewhere');
      write(src, 'apps/site/.git/HEAD', 'ref');
    } else {
      write(src, `${name}/host-only.txt`, `host ${name}`);
      write(src, `apps/site/${name}/nested.txt`, `nested ${name}`);
    }
  }
}

function e2eCall(run: ScriptRun): string[] | undefined {
  return run.pnpmCalls.find((call) => call[0] === 'e2e');
}

describe('containerScript: what is copied', () => {
  test('AC-9: the copy leaves out node_modules, .git, private, test-results, playwright-report, dist and .astro at any depth', () => {
    const run = runScript(containerScript(ARGS));

    expect(run.status, run.output).toBe(0);
    expect(run.treeAtInstall.length, 'pnpm install ran in a copy').toBeGreaterThan(0);
    const leaked = run.treeAtInstall.filter((file) =>
      file.split('/').some((segment) => EXCLUDED.includes(segment)),
    );
    expect(leaked).toEqual([]);
  });

  test('AC-9: the copy keeps every other file, including look-alike names such as .github, .gitignore and distribution', () => {
    const run = runScript(containerScript(ARGS));

    expect(run.status, run.output).toBe(0);
    expect(run.treeAtInstall).toEqual(
      expect.arrayContaining([
        './package.json',
        './pnpm-lock.yaml',
        './.gitignore',
        './.gitattributes',
        './.github/workflows/ci.yml',
        './apps/site/src/page.astro',
        './distribution/keep.txt',
        './docs/private-notes.md',
        './src/privateer/keep.txt',
        './e2e/site/example.spec.ts-snapshots/shot-chromium-linux.png',
      ]),
    );
  });
});

describe('containerScript: the commands it runs', () => {
  test('AC-9: runs pnpm install --frozen-lockfile before pnpm e2e', () => {
    const run = runScript(containerScript(ARGS));

    expect(run.status, run.output).toBe(0);
    const installAt = run.pnpmCalls.findIndex((call) => call[0] === 'install');
    const e2eAt = run.pnpmCalls.findIndex((call) => call[0] === 'e2e');
    expect(run.pnpmCalls[installAt]).toEqual(['install', '--frozen-lockfile']);
    expect(e2eAt).toBeGreaterThan(installAt);
  });

  test("AC-9: pnpm e2e receives each playwright argument literally, it's and $(x) included", () => {
    const run = runScript(containerScript(ARGS));

    expect(run.status, run.output).toBe(0);
    expect(e2eCall(run)).toEqual(['e2e', '--update-snapshots', '-g', "it's $(x)"]);
  });

  test('AC-9: pnpm e2e receives no extra arguments when there are none', () => {
    const run = runScript(containerScript([]));

    expect(run.status, run.output).toBe(0);
    expect(e2eCall(run)).toEqual(['e2e']);
  });

  test('AC-9: arguments with spaces, quotes, backticks and globs arrive as single literal arguments', () => {
    const awkward = ['-g', 'a "b" `c` *.ts \\n $HOME', ''];

    const run = runScript(containerScript(awkward));

    expect(run.status, run.output).toBe(0);
    expect(e2eCall(run)).toEqual(['e2e', ...awkward]);
  });

  test('AC-9: the script does not execute the arguments: $(x) creates nothing', () => {
    const run = runScript(containerScript(['-g', '$(touch executed.txt)']));

    expect(run.status, run.output).toBe(0);
    expect(existsSync(join(run.src, 'executed.txt'))).toBe(false);
    expect(existsSync(join(run.work, 'executed.txt'))).toBe(false);
  });
});

describe('containerScript: copying the results back', () => {
  test('AC-9: when pnpm e2e exits 3 the script exits 3', () => {
    const run = runScript(containerScript(ARGS), { e2eExit: 3 });

    expect(run.status, run.output).toBe(3);
  });

  test('AC-9: when pnpm e2e exits 3 every e2e snapshots folder, test-results and playwright-report are still copied back', () => {
    const run = runScript(containerScript(ARGS), { e2eExit: 3 });

    expect(run.status, run.output).toBe(3);
    expect(read(run.src, 'e2e/site/example.spec.ts-snapshots/shot-chromium-linux.png')).toBe('new');
    expect(read(run.src, 'e2e/other/deep/second.spec.ts-snapshots/other-chromium-linux.png')).toBe(
      'second',
    );
    expect(read(run.src, 'test-results/results.txt')).toContain('failed-run');
    expect(read(run.src, 'playwright-report/index.html')).toContain('report');
  });

  test('AC-9: when pnpm e2e passes the snapshots are copied back and the script exits 0', () => {
    const run = runScript(containerScript(ARGS));

    expect(run.status, run.output).toBe(0);
    expect(read(run.src, 'e2e/site/example.spec.ts-snapshots/shot-chromium-linux.png')).toBe('new');
  });

  test('AC-9: test-results and playwright-report are copied only when present: their absence is no error', () => {
    // The container run produced no test-results/ and no playwright-report/: nothing to copy back.
    const run = runScript(containerScript(ARGS), { onlySnapshots: true });

    expect(run.status, run.output).toBe(0);
    expect(read(run.src, 'e2e/site/example.spec.ts-snapshots/shot-chromium-linux.png')).toBe('new');
    expect(existsSync(join(run.src, 'test-results', 'results.txt'))).toBe(false);
    expect(existsSync(join(run.src, 'playwright-report', 'index.html'))).toBe(false);
  });

  test('AC-9: the host node_modules is never changed and nothing built in the copy is copied back', () => {
    const run = runScript(containerScript(ARGS), { e2eExit: 3 });

    expect(run.status, run.output).toBe(3);
    expect(read(run.src, 'node_modules/host-only.txt')).toBe('host node_modules');
    expect(readdirSync(join(run.src, 'node_modules'))).toEqual(['host-only.txt']);
    expect(existsSync(join(run.src, 'apps', 'site', 'dist', 'built.txt'))).toBe(false);
    expect(existsSync(join(run.src, '.astro', 'cache.txt'))).toBe(false);
  });
});

describe('the prepare script', () => {
  test('AC-9: `lefthook install` (prepare) does not fail the install in a folder without .git', () => {
    const prepare = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts['prepare'];
    expect(prepare).toBeTruthy();
    const folder = makeTempDir();
    const { bash, extraPath } = bashTools();
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toLowerCase() !== 'path' && !key.startsWith('GIT_')) env[key] = value;
    }
    env['PATH'] = [
      join(REPO_ROOT, 'node_modules', '.bin'),
      dirname(process.execPath),
      ...extraPath,
      process.env['PATH'] ?? '',
    ].join(delimiter);

    const result = spawnSync(bash, ['-c', prepare ?? 'false'], {
      cwd: folder,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });

    expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
  });
});
