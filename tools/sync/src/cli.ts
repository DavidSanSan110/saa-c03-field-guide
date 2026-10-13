// Sync CLI: argument parsing, git calls, file I/O and exit codes only; the mirror plan is in sync.ts.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { backupPath, planSync } from './sync.ts';
import type { FileMap } from './sync.ts';

const USAGE = `Usage:
  sync [--no-push]   back up the local-only setup into private/ and push both repos after confirmation`;

class UsageError extends Error {}

/** A failed check or git call: the message goes to stderr and the exit code is 1. */
class SyncError extends Error {}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` and returns its output, whatever the exit status. */
function run(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Runs git in `cwd` and returns its trimmed stdout; a failure becomes a SyncError with git's message. */
function git(cwd: string, args: string[]): string {
  const result = run(cwd, args);
  if (!result.ok) {
    throw new SyncError(`git ${args.join(' ')} failed in ${cwd}\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Every file under `dir` as `relative path -> bytes`; directories for which `prune` is true are skipped. */
function readTree(dir: string, prune: (relativeDir: string) => boolean = () => false): FileMap {
  const files: FileMap = new Map();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!prune(path)) walk(path);
      } else if (entry.isFile()) {
        files.set(path, readFileSync(join(dir, path)));
      }
    }
  };
  if (existsSync(dir)) walk('');
  return files;
}

/** The private repo must be its own repository, not a folder of the public one. */
function checkPrivateRepo(privateDir: string): void {
  if (!existsSync(privateDir)) throw new SyncError('private/ is missing');
  const top = run(privateDir, ['rev-parse', '--show-toplevel']);
  if (!top.ok || realpathSync.native(top.stdout.trim()) !== realpathSync.native(privateDir)) {
    throw new SyncError('private/ is not the top of its own git repository');
  }
}

/** The backup source files as `backup path -> bytes`. */
function readSources(root: string): FileMap {
  for (const name of ['.claude', 'CLAUDE.md', 'PLAN.md']) {
    if (!existsSync(join(root, name))) throw new SyncError(`${name} is missing`);
  }
  // A directory like `.claude/worktrees` or `node_modules` is pruned instead of walked.
  const claude = readTree(join(root, '.claude'), (dir) => backupPath(`.claude/${dir}/x`) === null);
  for (const name of ['CLAUDE.md', 'PLAN.md']) {
    if (claude.has(name)) {
      throw new SyncError(`.claude/${name} collides with ${name} in the backup`);
    }
  }
  const source: FileMap = new Map();
  for (const [path, content] of claude) {
    const target = backupPath(`.claude/${path}`);
    if (target !== null) source.set(target, content);
  }
  source.set('CLAUDE.md', readFileSync(join(root, 'CLAUDE.md')));
  source.set('PLAN.md', readFileSync(join(root, 'PLAN.md')));
  return source;
}

/** Mirrors `source` into `backupDir` and prints the counts. */
function mirror(source: FileMap, backupDir: string): void {
  const plan = planSync(source, readTree(backupDir));
  for (const path of plan.write) {
    const target = join(backupDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.get(path) ?? Buffer.alloc(0));
  }
  for (const path of plan.remove) {
    rmSync(join(backupDir, path));
    // Drop the folders that the removal left empty, up to the backup folder.
    for (let dir = dirname(join(backupDir, path)); dir !== backupDir; dir = dirname(dir)) {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
  console.log(
    `sync: ${plan.write.length} written, ${plan.remove.length} removed, ${plan.unchanged} unchanged`,
  );
}

/** Commits the backup folder, and only that folder, in the private repo. */
function commitBackup(privateDir: string, publicSha: string): void {
  git(privateDir, ['add', '-A', 'claude-setup']);
  // `diff --cached --quiet` exits 1 when something under claude-setup/ is staged.
  if (run(privateDir, ['diff', '--cached', '--quiet', '--', 'claude-setup']).ok) {
    console.log('sync: backup already up to date');
    return;
  }
  const message = `chore(claude-setup): back up local setup (${publicSha})`;
  git(privateDir, ['commit', '--quiet', '-m', message, '--', 'claude-setup']);
  console.log(`sync: committed ${git(privateDir, ['rev-parse', '--short', 'HEAD'])} in private`);
}

function runSync(args: string[]): void {
  const noPush = args.length === 1 && args[0] === '--no-push';
  if (args.length > 0 && !noPush) throw new UsageError();

  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const privateDir = join(root, 'private');
  checkPrivateRepo(privateDir);
  const source = readSources(root);

  mirror(source, join(privateDir, 'claude-setup'));
  commitBackup(privateDir, git(root, ['rev-parse', '--short', 'HEAD']));
  if (noPush) console.log('sync: not pushed (--no-push)');
}

/** Runs the CLI and resolves to the process exit code (0 ok, 1 check or push failure, 2 usage). */
export function main(argv: string[]): Promise<number> {
  try {
    runSync(argv);
  } catch (error) {
    if (error instanceof UsageError) console.error(USAGE);
    else console.error(error instanceof SyncError ? `sync: ${error.message}` : String(error));
    return Promise.resolve(error instanceof UsageError ? 2 : 1);
  }
  return Promise.resolve(0);
}

process.exitCode = await main(process.argv.slice(2));
