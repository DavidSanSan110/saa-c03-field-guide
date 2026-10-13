import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Every test spawns real processes (tsx + git), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for assertions that do not depend on the stream. */
  output: string;
}

/** Environment without the GIT_* variables that a hook would leak into the temp repositories. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function runCli(cwd: string, args: string[], input?: string): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: cleanEnv(), stdio: 'pipe', windowsHide: true });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, path: string, content: string | Buffer): void {
  const full = join(dir, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function gitInit(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '-b', branch]);
  git(dir, ['config', 'user.email', 'tester@example.com']);
  git(dir, ['config', 'user.name', 'Tester']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
}

function commitAll(dir: string, subject: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', subject]);
}

// ---- Fixture: a public repo with local-only files and a nested private repo --------------------

const BLOB = Buffer.from([0, 1, 2, 13, 10, 255, 254, 128, 10, 13, 0]);

/** The local-only files that are backed up. */
const SOURCES: Record<string, string | Buffer> = {
  '.claude/agents/a.md': 'agent a\n',
  '.claude/settings.json': '{"theme":"dark"}\n',
  '.claude/skills/x/SKILL.md': '# skill x\r\nwith CRLF\r\n',
  '.claude/hooks/check.sh': '#!/bin/sh\nexit 0\n',
  '.claude/assets/blob.bin': BLOB,
  'CLAUDE.md': '# project rules\n',
  'PLAN.md': '# plan\n',
};

/** Local-only files that must never be backed up. */
const EXCLUDED: Record<string, string> = {
  '.claude/worktrees/x/wt.md': 'a nested checkout\n',
  '.claude/hooks/node_modules/pkg/index.js': 'module.exports = 1;\n',
  '.claude/node_modules/top.js': 'module.exports = 2;\n',
};

/** Backup-relative paths of SOURCES (7 files), and the whole backup folder with its .gitkeep. */
const BACKUP_FILES = [
  'CLAUDE.md',
  'PLAN.md',
  'agents/a.md',
  'assets/blob.bin',
  'hooks/check.sh',
  'settings.json',
  'skills/x/SKILL.md',
];
const BACKUP_WITH_KEEP = ['.gitkeep', ...BACKUP_FILES].sort();

const SUBJECT_PREFIX = 'chore(claude-setup): back up local setup (';
const SKIPPED_MAIN = 'skipped (main is updated through pull requests)';
const PROMPT = 'Push these? [y/N] ';

type PrivateKind = 'repo' | 'folder' | 'missing';

interface Fixture {
  base: string;
  /** The public repo. */
  root: string;
  /** The private repo (or plain folder) at <root>/private. */
  priv: string;
  publicRemote: string;
  privateRemote: string;
  branch: string;
}

function makeFixture(options: { branch?: string; privateKind?: PrivateKind } = {}): Fixture {
  const { branch = 'feat/6-demo', privateKind = 'repo' } = options;
  const base = makeTempDir();
  const root = join(base, 'public');
  const priv = join(root, 'private');

  gitInit(root, 'main');
  write(root, '.gitignore', 'private/\n');
  write(root, 'README.md', '# Public\n');
  commitAll(root, 'chore: seed');
  write(root, 'docs/a.md', 'a\n');
  commitAll(root, 'docs: add a');
  write(root, 'docs/b.md', 'b\n');
  commitAll(root, 'docs: add b');
  if (branch !== 'main') git(root, ['checkout', '--quiet', '-b', branch]);

  // The local-only files are not tracked: they sit in .git/info/exclude, as in the real repo.
  write(root, '.git/info/exclude', '.claude/\nCLAUDE.md\nPLAN.md\n');
  for (const [path, content] of Object.entries({ ...SOURCES, ...EXCLUDED })) {
    write(root, path, content);
  }

  if (privateKind === 'repo') {
    gitInit(priv, 'main');
    write(priv, 'claude-setup/.gitkeep', '');
    commitAll(priv, 'chore: scaffold claude-setup');
  } else if (privateKind === 'folder') {
    write(priv, 'claude-setup/.gitkeep', '');
  }

  return {
    base,
    root,
    priv,
    publicRemote: join(base, 'remotes', 'public.git'),
    privateRemote: join(base, 'remotes', 'private.git'),
    branch,
  };
}

/** Bare remotes for both repos; the private branch is pushed with an upstream. */
function addRemotes(fx: Fixture, options: { pushPublic: boolean }): void {
  for (const [remote, repo] of [
    [fx.publicRemote, fx.root],
    [fx.privateRemote, fx.priv],
  ] as const) {
    mkdirSync(remote, { recursive: true });
    git(remote, ['init', '--quiet', '--bare', '-b', 'main']);
    git(repo, ['remote', 'add', 'origin', remote]);
  }
  git(fx.priv, ['push', '--quiet', '-u', 'origin', 'main']);
  if (options.pushPublic) git(fx.root, ['push', '--quiet', '-u', 'origin', fx.branch]);
}

/** Adds a commit to the remote branch from another clone, so the local branch has diverged. */
function divergeRemote(fx: Fixture, remote: string, branch: string): string {
  const clone = join(
    fx.base,
    `clone-${createHash('sha1').update(remote).digest('hex').slice(0, 8)}`,
  );
  git(fx.base, ['clone', '--quiet', '--branch', branch, remote, clone]);
  git(clone, ['config', 'user.email', 'other@example.com']);
  git(clone, ['config', 'user.name', 'Other']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  write(clone, 'remote-only.txt', 'someone else pushed this\n');
  commitAll(clone, 'chore: remote only');
  git(clone, ['push', '--quiet', 'origin', branch]);
  return gitOut(clone, ['rev-parse', 'HEAD']);
}

/** A successful `--no-push` run, for tests that need an existing backup. */
function syncOnce(fx: Fixture): void {
  const run = runCli(fx.root, ['--no-push']);
  if (run.status !== 0) throw new Error(`setup sync failed (${run.status}): ${run.output}`);
}

function remoteRef(remote: string, ref: string): string {
  return gitOut(remote, ['for-each-ref', '--format=%(objectname)', ref]);
}

function remoteRefs(remote: string): string {
  return gitOut(remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

function head(repo: string): string {
  return gitOut(repo, ['rev-parse', 'HEAD']);
}

function shortHead(repo: string): string {
  return gitOut(repo, ['rev-parse', '--short', 'HEAD']);
}

function commitCount(repo: string): number {
  return Number(gitOut(repo, ['rev-list', '--count', 'HEAD']));
}

function subject(repo: string, ref = 'HEAD'): string {
  return gitOut(repo, ['log', '-1', '--format=%s', ref]);
}

/** Every file under `dir` (relative, with `/`), sorted, without any .git folder. */
function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(full);
      } else {
        found.push(relative(dir, full).split('\\').join('/'));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

/** Path -> content hash of the public working tree, without .git and the private folder. */
function snapshotPublic(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const path of listFiles(root)) {
    if (path === 'private' || path.startsWith('private/')) continue;
    const hash = createHash('sha1')
      .update(readFileSync(join(root, ...path.split('/'))))
      .digest('hex');
    snapshot.set(path, hash);
  }
  return snapshot;
}

function backupDir(fx: Fixture): string {
  return join(fx.priv, 'claude-setup');
}

function readBackup(fx: Fixture, path: string): Buffer {
  return readFileSync(join(backupDir(fx), ...path.split('/')));
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean);
}

describe('sync --no-push: mirror and private commit', () => {
  test('AC-3: creates the mirror with the documented layout and leaves out the excluded paths', () => {
    const fx = makeFixture();
    runCli(fx.root, ['--no-push']);
    expect(listFiles(backupDir(fx))).toEqual(BACKUP_WITH_KEEP);
  });

  test('AC-3: backup files are byte-for-byte copies of their sources', () => {
    const fx = makeFixture();
    runCli(fx.root, ['--no-push']);
    expect(readBackup(fx, 'agents/a.md')).toEqual(Buffer.from('agent a\n'));
    expect(readBackup(fx, 'skills/x/SKILL.md')).toEqual(Buffer.from('# skill x\r\nwith CRLF\r\n'));
    expect(readBackup(fx, 'assets/blob.bin')).toEqual(BLOB);
    expect(readBackup(fx, 'CLAUDE.md')).toEqual(Buffer.from('# project rules\n'));
    expect(readBackup(fx, 'PLAN.md')).toEqual(Buffer.from('# plan\n'));
  });

  test('AC-3: writes nothing in the private repo outside claude-setup/', () => {
    const fx = makeFixture();
    const run = runCli(fx.root, ['--no-push']);
    expect(run.status).toBe(0);
    expect(listFiles(fx.priv).filter((path) => !path.startsWith('claude-setup/'))).toEqual([]);
  });

  test('AC-3: makes exactly one private commit', () => {
    const fx = makeFixture();
    const before = commitCount(fx.priv);
    runCli(fx.root, ['--no-push']);
    expect(commitCount(fx.priv)).toBe(before + 1);
  });

  test('AC-3: the commit subject names the public short sha', () => {
    const fx = makeFixture();
    runCli(fx.root, ['--no-push']);
    expect(subject(fx.priv)).toBe(`${SUBJECT_PREFIX}${shortHead(fx.root)})`);
  });

  test('AC-3: the commit contains only the backup files', () => {
    const fx = makeFixture();
    runCli(fx.root, ['--no-push']);
    const changed = lines(gitOut(fx.priv, ['show', '--name-only', '--format=', 'HEAD']));
    expect(changed.sort()).toEqual(BACKUP_FILES.map((path) => `claude-setup/${path}`).sort());
  });

  test('AC-3: the commit message carries no AI trailer', () => {
    const fx = makeFixture();
    runCli(fx.root, ['--no-push']);
    expect(gitOut(fx.priv, ['log', '-1', '--format=%B'])).toBe(
      `${SUBJECT_PREFIX}${shortHead(fx.root)})`,
    );
  });

  test('AC-3: prints the counts line and exits 0', () => {
    const fx = makeFixture();
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: 7 written, 0 removed, 0 unchanged');
    expect(run.status).toBe(0);
  });

  test('AC-3: prints the short sha of the private commit', () => {
    const fx = makeFixture();
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain(`sync: committed ${shortHead(fx.priv)} in private`);
  });

  test('AC-3: --no-push says it did not push and never prompts', () => {
    const fx = makeFixture();
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: not pushed (--no-push)');
    expect(run.output).not.toContain('Push these?');
    expect(run.status).toBe(0);
  });

  test('AC-3: the public repo gets no commit, no staged change and no new file', () => {
    const fx = makeFixture();
    const headBefore = head(fx.root);
    const filesBefore = snapshotPublic(fx.root);
    const run = runCli(fx.root, ['--no-push']);
    expect(run.status).toBe(0);
    expect(head(fx.root)).toBe(headBefore);
    expect(gitOut(fx.root, ['diff', '--cached', '--name-only'])).toBe('');
    expect(gitOut(fx.root, ['status', '--porcelain'])).toBe('');
    expect(snapshotPublic(fx.root)).toEqual(filesBefore);
  });

  test('AC-3: works from a subdirectory of the public repo', () => {
    const fx = makeFixture();
    const cwd = join(fx.root, 'docs');
    const run = runCli(cwd, ['--no-push']);
    expect(listFiles(backupDir(fx))).toEqual(BACKUP_WITH_KEEP);
    expect(run.status).toBe(0);
  });
});

describe('sync --no-push: repeated runs', () => {
  test('AC-4: a second run with no change makes no commit and says the backup is up to date', () => {
    const fx = makeFixture();
    syncOnce(fx);
    const before = commitCount(fx.priv);
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: backup already up to date');
    expect(run.output).not.toContain('sync: committed');
    expect(commitCount(fx.priv)).toBe(before);
    expect(run.status).toBe(0);
  });

  test('AC-4: a second run with no change leaves every file identical', () => {
    const fx = makeFixture();
    syncOnce(fx);
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: 0 written, 0 removed, 7 unchanged');
  });

  test('AC-4: an edited source and a deleted source are written and removed, and nothing else', () => {
    const fx = makeFixture();
    syncOnce(fx);
    write(fx.root, '.claude/agents/a.md', 'agent a, second version\n');
    rmSync(join(fx.root, '.claude', 'hooks', 'check.sh'));
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: 1 written, 1 removed, 5 unchanged');
    expect(readBackup(fx, 'agents/a.md')).toEqual(Buffer.from('agent a, second version\n'));
    expect(existsSync(join(backupDir(fx), 'hooks', 'check.sh'))).toBe(false);
    expect(run.status).toBe(0);
  });

  test('AC-4: that change is committed once, with only the two touched paths', () => {
    const fx = makeFixture();
    syncOnce(fx);
    const before = commitCount(fx.priv);
    write(fx.root, '.claude/agents/a.md', 'agent a, second version\n');
    rmSync(join(fx.root, '.claude', 'hooks', 'check.sh'));
    runCli(fx.root, ['--no-push']);
    expect(commitCount(fx.priv)).toBe(before + 1);
    expect(subject(fx.priv)).toBe(`${SUBJECT_PREFIX}${shortHead(fx.root)})`);
    const changed = lines(gitOut(fx.priv, ['show', '--name-status', '--format=', 'HEAD'])).map(
      (line) => line.replace(/\s+/g, ' '),
    );
    expect(changed.sort()).toEqual(
      ['D claude-setup/hooks/check.sh', 'M claude-setup/agents/a.md'].sort(),
    );
  });

  test('AC-4: a new source file is written and committed', () => {
    const fx = makeFixture();
    syncOnce(fx);
    write(fx.root, '.claude/commands/new.md', 'new command\n');
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: 1 written, 0 removed, 7 unchanged');
    expect(gitOut(fx.priv, ['ls-files', 'claude-setup/commands/new.md'])).toBe(
      'claude-setup/commands/new.md',
    );
  });

  test('AC-4: an unrelated untracked file in the private repo is not committed', () => {
    const fx = makeFixture();
    syncOnce(fx);
    write(fx.priv, 'notes.md', 'my private notes\n');
    write(fx.priv, 'other/x.md', 'more notes\n');
    write(fx.root, '.claude/agents/a.md', 'agent a, second version\n');
    runCli(fx.root, ['--no-push']);
    const committed = lines(gitOut(fx.priv, ['show', '--name-only', '--format=', 'HEAD']));
    expect(committed).toEqual(['claude-setup/agents/a.md']);
    const status = lines(gitOut(fx.priv, ['status', '--porcelain']));
    expect(status).toContain('?? notes.md');
    expect(status).toContain('?? other/');
  });

  test('AC-4: an unrelated untracked file does not turn an unchanged backup into a commit', () => {
    const fx = makeFixture();
    syncOnce(fx);
    write(fx.priv, 'notes.md', 'my private notes\n');
    const before = commitCount(fx.priv);
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: backup already up to date');
    expect(commitCount(fx.priv)).toBe(before);
  });

  test('AC-4: a change the owner staged outside claude-setup/ stays staged and uncommitted', () => {
    const fx = makeFixture();
    syncOnce(fx);
    write(fx.priv, 'staged.md', 'staged by the owner\n');
    git(fx.priv, ['add', 'staged.md']);
    write(fx.root, '.claude/agents/a.md', 'agent a, second version\n');
    runCli(fx.root, ['--no-push']);
    const committed = lines(gitOut(fx.priv, ['show', '--name-only', '--format=', 'HEAD']));
    expect(committed).toEqual(['claude-setup/agents/a.md']);
    expect(lines(gitOut(fx.priv, ['status', '--porcelain']))).toContain('A  staged.md');
  });

  test('AC-4: stale backup files are removed, but .gitkeep files survive at every depth', () => {
    const fx = makeFixture();
    write(fx.priv, 'claude-setup/old/stale.md', 'no source for this\n');
    write(fx.priv, 'claude-setup/old/.gitkeep', '');
    commitAll(fx.priv, 'chore: stale state');
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: 7 written, 1 removed, 0 unchanged');
    expect(existsSync(join(backupDir(fx), 'old', 'stale.md'))).toBe(false);
    expect(existsSync(join(backupDir(fx), '.gitkeep'))).toBe(true);
    expect(existsSync(join(backupDir(fx), 'old', '.gitkeep'))).toBe(true);
    const tracked = lines(gitOut(fx.priv, ['ls-files', 'claude-setup']));
    expect(tracked).toContain('claude-setup/.gitkeep');
    expect(tracked).toContain('claude-setup/old/.gitkeep');
    expect(tracked).not.toContain('claude-setup/old/stale.md');
  });

  test('AC-4: claude-setup/.gitkeep survives repeated runs', () => {
    const fx = makeFixture();
    syncOnce(fx);
    write(fx.root, '.claude/agents/a.md', 'agent a, second version\n');
    runCli(fx.root, ['--no-push']);
    expect(existsSync(join(backupDir(fx), '.gitkeep'))).toBe(true);
    expect(gitOut(fx.priv, ['ls-files', 'claude-setup/.gitkeep'])).toBe('claude-setup/.gitkeep');
  });
});

describe('sync checks', () => {
  test('AC-5: private/ missing exits 1 with a message and writes nothing', () => {
    const fx = makeFixture({ privateKind: 'missing' });
    const headBefore = head(fx.root);
    const filesBefore = snapshotPublic(fx.root);
    const run = runCli(fx.root, ['--no-push']);
    expect(run.stderr).toMatch(/private/i);
    expect(existsSync(fx.priv)).toBe(false);
    expect(snapshotPublic(fx.root)).toEqual(filesBefore);
    expect(head(fx.root)).toBe(headBefore);
    expect(run.status).toBe(1);
  });

  test('AC-5: private/ as a plain folder inside the public repo exits 1 and writes nothing', () => {
    const fx = makeFixture({ privateKind: 'folder' });
    const headBefore = head(fx.root);
    const run = runCli(fx.root, ['--no-push']);
    expect(run.stderr).toMatch(/private/i);
    expect(listFiles(fx.priv)).toEqual(['claude-setup/.gitkeep']);
    expect(head(fx.root)).toBe(headBefore);
    expect(run.status).toBe(1);
  });

  test.each([['PLAN.md'], ['CLAUDE.md'], ['.claude']])(
    'AC-5: missing %s exits 1, names it, and keeps the existing backup',
    (missing) => {
      const fx = makeFixture();
      syncOnce(fx);
      const filesBefore = listFiles(backupDir(fx));
      const commitsBefore = commitCount(fx.priv);
      rmSync(join(fx.root, missing), { recursive: true, force: true, maxRetries: 3 });
      const run = runCli(fx.root, ['--no-push']);
      expect(run.stderr).toContain(missing);
      expect(listFiles(backupDir(fx))).toEqual(filesBefore);
      expect(commitCount(fx.priv)).toBe(commitsBefore);
      expect(gitOut(fx.priv, ['status', '--porcelain'])).toBe('');
      expect(run.status).toBe(1);
    },
  );

  test.each([['PLAN.md'], ['CLAUDE.md']])(
    'AC-5: a source .claude/%s collides with the top-level file, exits 1 and writes nothing',
    (name) => {
      const fx = makeFixture();
      write(fx.root, `.claude/${name}`, 'collides\n');
      const commitsBefore = commitCount(fx.priv);
      const run = runCli(fx.root, ['--no-push']);
      expect(run.stderr).toContain(name);
      expect(listFiles(backupDir(fx))).toEqual(['.gitkeep']);
      expect(commitCount(fx.priv)).toBe(commitsBefore);
      expect(run.status).toBe(1);
    },
  );
});

describe('sync push: confirmation', () => {
  test('AC-6: prints the plan of each repo before asking', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    // One private commit that is not pushed yet, plus the backup commit: 2 ahead.
    write(fx.priv, 'extra.txt', 'unpushed\n');
    commitAll(fx.priv, 'chore: extra');
    const run = runCli(fx.root, [], 'n\n');
    const plan = run.stdout.slice(0, run.stdout.indexOf(PROMPT));
    expect(run.stdout).toContain(PROMPT);
    expect(plan).toContain('feat/6-demo');
    expect(plan).toMatch(/\bnone\b/);
    expect(plan).toMatch(/\b3\b/);
    expect(plan).toContain('origin/main');
    expect(plan).toMatch(/\b2\b/);
  });

  test.each([
    ['n', 'n\n'],
    ['an empty line', '\n'],
    ['no input at all', ''],
    ['no', 'no\n'],
    ['an unrelated word', 'yep\n'],
    ['yes with extra text', 'yes please\n'],
  ])(
    'AC-6: %s does not push, says so, exits 0 and leaves the remotes unchanged',
    (_name, input) => {
      const fx = makeFixture();
      addRemotes(fx, { pushPublic: false });
      const privateBefore = remoteRefs(fx.privateRemote);
      const publicBefore = remoteRefs(fx.publicRemote);
      const run = runCli(fx.root, [], input);
      expect(lines(run.stdout)).toContain('sync: not pushed');
      expect(remoteRefs(fx.privateRemote)).toBe(privateBefore);
      expect(remoteRefs(fx.publicRemote)).toBe(publicBefore);
      expect(run.status).toBe(0);
    },
  );

  test('AC-6: declining still keeps the local backup commit', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    runCli(fx.root, [], 'n\n');
    expect(subject(fx.priv)).toBe(`${SUBJECT_PREFIX}${shortHead(fx.root)})`);
  });

  test.each([
    ['y', 'y\n'],
    ['YES surrounded by spaces', ' YES \n'],
    ['Yes with CRLF', 'Yes\r\n'],
    ['yes', 'yes\n'],
  ])('AC-6: %s pushes the backup commit and the current branch, exits 0', (_name, input) => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    const run = runCli(fx.root, [], input);
    expect(remoteRef(fx.privateRemote, 'refs/heads/main')).toBe(head(fx.priv));
    expect(subject(fx.priv)).toBe(`${SUBJECT_PREFIX}${shortHead(fx.root)})`);
    expect(remoteRef(fx.publicRemote, `refs/heads/${fx.branch}`)).toBe(head(fx.root));
    expect(lines(run.stdout)).not.toContain('sync: not pushed');
    expect(run.status).toBe(0);
  });

  test('AC-6: a public branch without upstream gets origin/<branch> as its upstream', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    runCli(fx.root, [], 'y\n');
    expect(gitOut(fx.root, ['rev-parse', '--abbrev-ref', '@{u}'])).toBe(`origin/${fx.branch}`);
  });

  test('AC-6: a public branch that already has an upstream receives its new commits', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    write(fx.root, 'docs/c.md', 'c\n');
    commitAll(fx.root, 'docs: add c');
    const run = runCli(fx.root, [], 'y\n');
    expect(remoteRef(fx.publicRemote, `refs/heads/${fx.branch}`)).toBe(head(fx.root));
    expect(run.status).toBe(0);
  });

  test('AC-6: a private repo without upstream is pushed and gets origin/main as upstream', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    git(fx.priv, ['branch', '--unset-upstream']);
    const run = runCli(fx.root, [], 'y\n');
    expect(remoteRef(fx.privateRemote, 'refs/heads/main')).toBe(head(fx.priv));
    expect(gitOut(fx.priv, ['rev-parse', '--abbrev-ref', 'main@{u}'])).toBe('origin/main');
    expect(run.status).toBe(0);
  });

  test('AC-6: the confirmation does not touch the public repo history', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    const headBefore = head(fx.root);
    const run = runCli(fx.root, [], 'y\n');
    expect(run.status).toBe(0);
    expect(head(fx.root)).toBe(headBefore);
    expect(gitOut(fx.root, ['status', '--porcelain'])).toBe('');
  });
});

describe('sync push: public repo on main', () => {
  test('AC-7: the plan shows the public repo as skipped', () => {
    const fx = makeFixture({ branch: 'main' });
    addRemotes(fx, { pushPublic: true });
    write(fx.root, 'docs/c.md', 'c\n');
    commitAll(fx.root, 'docs: add c');
    const run = runCli(fx.root, [], 'n\n');
    const plan = run.stdout.slice(0, run.stdout.indexOf(PROMPT));
    expect(plan).toContain(SKIPPED_MAIN);
  });

  test('AC-7: after y only the private repo is pushed; the public main stays as it was', () => {
    const fx = makeFixture({ branch: 'main' });
    addRemotes(fx, { pushPublic: true });
    const publicMain = remoteRef(fx.publicRemote, 'refs/heads/main');
    write(fx.root, 'docs/c.md', 'c\n');
    commitAll(fx.root, 'docs: add c');
    const run = runCli(fx.root, [], 'y\n');
    expect(remoteRef(fx.privateRemote, 'refs/heads/main')).toBe(head(fx.priv));
    expect(remoteRef(fx.publicRemote, 'refs/heads/main')).toBe(publicMain);
    expect(run.status).toBe(0);
  });

  test('AC-7: a main that was never pushed is not created on the public remote', () => {
    const fx = makeFixture({ branch: 'main' });
    addRemotes(fx, { pushPublic: false });
    const run = runCli(fx.root, [], 'y\n');
    expect(remoteRefs(fx.publicRemote)).toBe('');
    expect(remoteRef(fx.privateRemote, 'refs/heads/main')).toBe(head(fx.priv));
    expect(run.status).toBe(0);
  });
});

describe('sync push: failures', () => {
  test('AC-8: a rejected private push exits 1 with the failure line and git output', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    divergeRemote(fx, fx.privateRemote, 'main');
    const run = runCli(fx.root, [], 'y\n');
    expect(lines(run.output)).toContain('sync: push failed for private');
    expect(run.stderr).toMatch(/rejected/i);
    expect(run.status).toBe(1);
  });

  test('AC-8: the local backup commit still exists after a rejected push', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    divergeRemote(fx, fx.privateRemote, 'main');
    runCli(fx.root, [], 'y\n');
    expect(subject(fx.priv)).toBe(`${SUBJECT_PREFIX}${shortHead(fx.root)})`);
  });

  test('AC-8: a rejected push is never forced', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    const diverged = divergeRemote(fx, fx.privateRemote, 'main');
    const run = runCli(fx.root, [], 'y\n');
    expect(lines(run.output)).toContain('sync: push failed for private');
    expect(remoteRef(fx.privateRemote, 'refs/heads/main')).toBe(diverged);
  });

  test('AC-8: a rejected public push exits 1 naming public, after the private push went through', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    write(fx.root, 'docs/c.md', 'c\n');
    commitAll(fx.root, 'docs: add c');
    const diverged = divergeRemote(fx, fx.publicRemote, fx.branch);
    const run = runCli(fx.root, [], 'y\n');
    expect(lines(run.output)).toContain('sync: push failed for public');
    expect(run.stderr).toMatch(/rejected/i);
    expect(remoteRef(fx.privateRemote, 'refs/heads/main')).toBe(head(fx.priv));
    expect(remoteRef(fx.publicRemote, `refs/heads/${fx.branch}`)).toBe(diverged);
    expect(run.status).toBe(1);
  });
});

describe('sync usage errors', () => {
  test.each([[['--bogus']], [['--no-push', 'extra']], [['push']], [['-n']]])(
    'AC-9: arguments %j exit 2 with usage on stderr and change nothing',
    (args) => {
      const fx = makeFixture();
      const headBefore = head(fx.root);
      const privateBefore = head(fx.priv);
      const filesBefore = snapshotPublic(fx.root);
      const run = runCli(fx.root, args);
      expect(run.stderr).toMatch(/usage/i);
      expect(run.stderr).toContain('--no-push');
      expect(listFiles(backupDir(fx))).toEqual(['.gitkeep']);
      expect(head(fx.priv)).toBe(privateBefore);
      expect(head(fx.root)).toBe(headBefore);
      expect(snapshotPublic(fx.root)).toEqual(filesBefore);
      expect(run.status).toBe(2);
    },
  );
});

// ---- Spec 006 amendments: explicit refspecs, case-only renames, plan lines ---------------------

import { renameSync } from 'node:fs';

/** Public fixture on main, pushed, then a feature branch that tracks origin/main. */
function makeTrackingMainFixture(branch: string): Fixture {
  const fx = makeFixture({ branch: 'main' });
  addRemotes(fx, { pushPublic: true });
  git(fx.root, ['checkout', '--quiet', '-b', branch, '--track', 'origin/main']);
  write(fx.root, 'docs/feature.md', 'feature work\n');
  commitAll(fx.root, 'docs: feature work');
  return fx;
}

/** True when `dir` is on a case-sensitive file system (probed with a throwaway file). */
function isCaseSensitive(dir: string): boolean {
  write(dir, 'case-probe.tmp', 'x');
  const sensitive = !existsSync(join(dir, 'CASE-PROBE.TMP'));
  rmSync(join(dir, 'case-probe.tmp'), { force: true });
  return sensitive;
}

/** Both repos pushed and in step: a first sync, then the private commit is pushed by hand. */
function makeFullyPushedFixture(options: { branch?: string } = {}): Fixture {
  const fx = makeFixture(options);
  addRemotes(fx, { pushPublic: true });
  syncOnce(fx);
  git(fx.priv, ['push', '--quiet']);
  return fx;
}

describe('sync push: explicit refspecs', () => {
  test('AC-10: a feature branch tracking origin/main with push.default=upstream never moves main', () => {
    const fx = makeTrackingMainFixture('feat/x');
    git(fx.root, ['config', 'push.default', 'upstream']);
    const mainBefore = remoteRef(fx.publicRemote, 'refs/heads/main');
    const run = runCli(fx.root, [], 'y\n');
    expect(remoteRef(fx.publicRemote, 'refs/heads/main')).toBe(mainBefore);
    expect(remoteRef(fx.publicRemote, 'refs/heads/feat/x')).toBe(head(fx.root));
    expect(run.status).toBe(0);
  });

  test('AC-10: the pushed feature branch becomes the upstream of the local branch', () => {
    const fx = makeTrackingMainFixture('feat/x');
    git(fx.root, ['config', 'push.default', 'upstream']);
    runCli(fx.root, [], 'y\n');
    expect(gitOut(fx.root, ['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/feat/x');
  });

  test('AC-10: with push.default=matching a local main that is ahead is not pushed either', () => {
    const fx = makeFixture({ branch: 'main' });
    addRemotes(fx, { pushPublic: true });
    git(fx.root, ['checkout', '--quiet', '-b', 'feat/y']);
    git(fx.root, ['push', '--quiet', '-u', 'origin', 'feat/y']);
    git(fx.root, ['checkout', '--quiet', 'main']);
    write(fx.root, 'docs/c.md', 'main moved on\n');
    commitAll(fx.root, 'docs: main moved on');
    git(fx.root, ['checkout', '--quiet', 'feat/y']);
    write(fx.root, 'docs/d.md', 'feature work\n');
    commitAll(fx.root, 'docs: feature work');
    git(fx.root, ['config', 'push.default', 'matching']);
    const mainBefore = remoteRef(fx.publicRemote, 'refs/heads/main');
    const run = runCli(fx.root, [], 'y\n');
    expect(remoteRef(fx.publicRemote, 'refs/heads/main')).toBe(mainBefore);
    expect(remoteRef(fx.publicRemote, 'refs/heads/feat/y')).toBe(head(fx.root));
    expect(run.status).toBe(0);
  });
});

describe('sync mirror: case-only renames', () => {
  test('AC-11: renaming agents/a.md to agents/A.md keeps the file in the backup with its content', () => {
    const fx = makeFixture();
    syncOnce(fx);
    const agents = join(fx.root, '.claude', 'agents');
    renameSync(join(agents, 'a.md'), join(agents, 'a.md.tmp'));
    renameSync(join(agents, 'a.md.tmp'), join(agents, 'A.md'));
    const run = runCli(fx.root, ['--no-push']);
    const backupAgents = join(backupDir(fx), 'agents');
    expect(run.status).toBe(0);
    expect(readFileSync(join(backupAgents, 'A.md'))).toEqual(Buffer.from('agent a\n'));
    if (isCaseSensitive(fx.base)) {
      expect(listFiles(backupAgents)).toEqual(['A.md']);
    } else {
      const names = readdirSync(backupAgents);
      expect(names).toHaveLength(1);
      expect(names[0]?.toLowerCase()).toBe('a.md');
    }
  });

  test('AC-11: after the case-only rename the next run has nothing left to do', () => {
    const fx = makeFixture();
    syncOnce(fx);
    const agents = join(fx.root, '.claude', 'agents');
    renameSync(join(agents, 'a.md'), join(agents, 'a.md.tmp'));
    renameSync(join(agents, 'a.md.tmp'), join(agents, 'A.md'));
    syncOnce(fx);
    const run = runCli(fx.root, ['--no-push']);
    expect(lines(run.stdout)).toContain('sync: backup already up to date');
    expect(gitOut(fx.priv, ['status', '--porcelain'])).toBe('');
  });
});

describe('sync push: plan lines and nothing to push', () => {
  test('AC-12: prints one plan line per repo with its own branch, upstream and count', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    write(fx.priv, 'extra.txt', 'unpushed\n');
    commitAll(fx.priv, 'chore: extra');
    const run = runCli(fx.root, [], 'n\n');
    expect(lines(run.stdout)).toContain(
      'private: branch main, upstream origin/main, 2 commit(s) ahead',
    );
    expect(lines(run.stdout)).toContain(
      'public: branch feat/6-demo, upstream none, 3 commit(s) ahead',
    );
  });

  test('AC-12: a public branch with an upstream reports that upstream and only its own commits', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    write(fx.root, 'docs/c.md', 'c\n');
    commitAll(fx.root, 'docs: add c');
    write(fx.priv, 'extra.txt', 'unpushed\n');
    commitAll(fx.priv, 'chore: extra');
    const run = runCli(fx.root, [], 'n\n');
    expect(lines(run.stdout)).toContain(
      'public: branch feat/6-demo, upstream origin/feat/6-demo, 1 commit(s) ahead',
    );
    expect(lines(run.stdout)).toContain(
      'private: branch main, upstream origin/main, 2 commit(s) ahead',
    );
  });

  test('AC-12: the public repo on main is a skipped plan line', () => {
    const fx = makeFixture({ branch: 'main' });
    addRemotes(fx, { pushPublic: true });
    const run = runCli(fx.root, [], 'n\n');
    expect(lines(run.stdout)).toContain('public: skipped (main is updated through pull requests)');
    expect(lines(run.stdout)).toContain(
      'private: branch main, upstream origin/main, 1 commit(s) ahead',
    );
  });

  test('AC-12: a detached public HEAD is a skipped plan line', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: true });
    git(fx.root, ['checkout', '--quiet', '--detach']);
    const run = runCli(fx.root, [], 'n\n');
    expect(lines(run.stdout)).toContain('public: skipped (detached HEAD)');
  });

  test('AC-12: with nothing to push in either repo it says so, does not ask, and exits 0', () => {
    const fx = makeFullyPushedFixture();
    const privateBefore = remoteRefs(fx.privateRemote);
    const publicBefore = remoteRefs(fx.publicRemote);
    const run = runCli(fx.root, []);
    expect(lines(run.stdout)).toContain('sync: nothing to push');
    expect(run.output).not.toContain('Push these?');
    expect(remoteRefs(fx.privateRemote)).toBe(privateBefore);
    expect(remoteRefs(fx.publicRemote)).toBe(publicBefore);
    expect(run.status).toBe(0);
  });

  test('AC-12: a confirmation on stdin is not needed when there is nothing to push', () => {
    const fx = makeFullyPushedFixture();
    const run = runCli(fx.root, [], 'y\n');
    expect(lines(run.stdout)).toContain('sync: nothing to push');
    expect(lines(run.stdout)).not.toContain('sync: not pushed');
    expect(run.status).toBe(0);
  });
});

describe('sync push: progress lines', () => {
  const ELLIPSIS = '(?:…|\\.\\.\\.)';

  test('AC-6: a confirmed push prints pushing and pushed lines, private first, then public', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    const run = runCli(fx.root, [], 'y\n');
    const out = lines(run.stdout);
    const at = (pattern: RegExp): number => out.findIndex((line) => pattern.test(line));
    const pushingPrivate = at(new RegExp(`^sync: pushing private${ELLIPSIS}$`));
    const pushedPrivate = at(/^sync: pushed private$/);
    const pushingPublic = at(new RegExp(`^sync: pushing public${ELLIPSIS}$`));
    const pushedPublic = at(/^sync: pushed public$/);
    expect(pushingPrivate).toBeGreaterThanOrEqual(0);
    expect(pushedPrivate).toBeGreaterThan(pushingPrivate);
    expect(pushingPublic).toBeGreaterThan(pushedPrivate);
    expect(pushedPublic).toBeGreaterThan(pushingPublic);
  });

  test('AC-7: a skipped public main is never reported as pushing', () => {
    const fx = makeFixture({ branch: 'main' });
    addRemotes(fx, { pushPublic: true });
    const run = runCli(fx.root, [], 'y\n');
    expect(lines(run.stdout)).toContain('sync: pushed private');
    expect(run.output).not.toMatch(/sync: pushing public/);
    expect(run.output).not.toMatch(/sync: pushed public/);
  });

  test('AC-8: a rejected private push stops before the public push', () => {
    const fx = makeFixture();
    addRemotes(fx, { pushPublic: false });
    divergeRemote(fx, fx.privateRemote, 'main');
    const run = runCli(fx.root, [], 'y\n');
    expect(lines(run.output)).toContain('sync: push failed for private');
    expect(run.output).not.toMatch(/sync: pushing public/);
    expect(remoteRef(fx.publicRemote, `refs/heads/${fx.branch}`)).toBe('');
    expect(run.status).toBe(1);
  });
});
