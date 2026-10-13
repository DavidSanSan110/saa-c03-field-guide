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
import { createInterface } from 'node:readline';
import { backupPath, planSync } from './sync.ts';
import type { FileMap } from './sync.ts';

const USAGE = `Usage:
  sync [--no-push]   back up the local-only setup into private/ and push both repos after confirmation`;

const SKIPPED_MAIN = 'skipped (main is updated through pull requests)';
const PROMPT = 'Push these? [y/N] ';

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
  // Stale files go first: on a case-insensitive file system `a.md` -> `A.md` is a remove plus a
  // write of the same file, and removing last would delete the new copy.
  for (const path of plan.remove) {
    rmSync(join(backupDir, path));
    // Drop the folders that the removal left empty, up to the backup folder.
    for (let dir = dirname(join(backupDir, path)); dir !== backupDir; dir = dirname(dir)) {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
  for (const path of plan.write) {
    const target = join(backupDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.get(path) ?? Buffer.alloc(0));
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

interface PushPlan {
  name: 'private' | 'public';
  dir: string;
  branch: string;
  /** The upstream branch, or undefined when there is none. */
  upstream: string | undefined;
  /** Commits not on the upstream (all commits if there is none). */
  ahead: number;
  /** Why the repo is not pushed, if it is not. */
  skip: string | undefined;
}

function pushPlan(name: PushPlan['name'], dir: string): PushPlan {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstreamResult = run(dir, ['rev-parse', '--abbrev-ref', '@{u}']);
  const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() : undefined;
  const ahead = Number(git(dir, ['rev-list', '--count', upstream ? `${upstream}..HEAD` : 'HEAD']));
  let skip: string | undefined;
  if (branch === 'HEAD') skip = 'skipped (detached HEAD)';
  else if (name === 'public' && branch === 'main') skip = SKIPPED_MAIN;
  return { name, dir, branch, upstream, ahead, skip };
}

function describePlan({ name, branch, upstream, ahead, skip }: PushPlan): string {
  const state = skip ?? `upstream ${upstream ?? 'none'}, ${ahead} commit(s) ahead`;
  return `${name}: branch ${branch}, ${state}`;
}

/** Reads one line from stdin; end of input gives an empty line. */
function readLine(): Promise<string> {
  const input = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    input.once('line', (line) => {
      resolve(line); // before close(), which resolves with an empty line
      input.close();
    });
    input.once('close', () => resolve(''));
  });
}

/** Plans, asks and pushes the private repo, then the public branch. Returns the exit code. */
async function pushBoth(root: string, privateDir: string): Promise<number> {
  const plans = [pushPlan('private', privateDir), pushPlan('public', root)];
  for (const plan of plans) console.log(describePlan(plan));
  const pushes = plans.filter((plan) => plan.skip === undefined && plan.ahead > 0);
  if (pushes.length === 0) {
    console.log('sync: nothing to push');
    return 0;
  }

  process.stdout.write(PROMPT);
  const answer = (await readLine()).trim().toLowerCase();
  if (!process.stdin.isTTY) console.log(); // the typed newline is not echoed from a pipe
  if (answer !== 'y' && answer !== 'yes') {
    console.log('sync: not pushed');
    return 0;
  }

  for (const { name, dir, branch, upstream } of pushes) {
    // Always an explicit refspec: a bare `git push` depends on push.default and the upstream.
    const setUpstream = upstream === `origin/${branch}` ? [] : ['-u'];
    const result = run(dir, ['push', ...setUpstream, 'origin', branch]);
    if (!result.ok) {
      console.error(`sync: push failed for ${name}\n${result.stderr.trim()}`);
      return 1;
    }
    console.log(`sync: pushed ${name}`);
  }
  return 0;
}

async function runSync(args: string[]): Promise<number> {
  const noPush = args.length === 1 && args[0] === '--no-push';
  if (args.length > 0 && !noPush) throw new UsageError();

  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const privateDir = join(root, 'private');
  checkPrivateRepo(privateDir);
  const source = readSources(root);

  mirror(source, join(privateDir, 'claude-setup'));
  commitBackup(privateDir, git(root, ['rev-parse', '--short', 'HEAD']));
  if (!noPush) return pushBoth(root, privateDir);
  console.log('sync: not pushed (--no-push)');
  return 0;
}

/** Runs the CLI and resolves to the process exit code (0 ok, 1 check or push failure, 2 usage). */
export async function main(argv: string[]): Promise<number> {
  try {
    return await runSync(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(USAGE);
      return 2;
    }
    console.error(error instanceof SyncError ? `sync: ${error.message}` : String(error));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
