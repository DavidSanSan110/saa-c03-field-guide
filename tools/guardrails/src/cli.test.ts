import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';

// Every test spawns a real process (tsx + git), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

// AC-16: blocked strings are never written literally; they are assembled at runtime.
const CLIENT = 'Kraken' + 'Legrand';
const WINDOWS_USER_PATH = ['C:', 'Users', 'bob', 'notes'].join('\\');
const TRAILER = 'Co-Authored-By' + ': ';
const AI_NAME = 'Clau' + 'de';
const AI_DOMAIN = 'anthro' + 'pic.com';
const GENERATED = 'Generated' + ' with ';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-'));
  tempDirs.push(dir);
  return dir;
}

function makeTempRepo(): string {
  const dir = makeTempDir();
  git(dir, ['init', '--quiet']);
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

function commitAll(dir: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '--no-verify', '-m', 'chore: seed']);
}

/** A question that is valid under spec 002 with status reviewed (task 1.3 belongs to domain 1). */
function reviewedQuestion(overrides: Record<string, unknown> = {}): string {
  return stringify({
    id: 'd1-1.3-0007',
    domain: 1,
    task: '1.3',
    services: ['s3', 'kms'],
    difficulty: 'medium',
    type: 'single',
    stem:
      'A company must encrypt objects in Amazon S3 at rest. Its security policy says ' +
      'encryption keys must be kept on-premises. Which option meets these requirements?',
    options: [
      { key: 'A', text: 'SSE-S3', correct: false, why: 'AWS creates and stores the keys.' },
      { key: 'B', text: 'SSE-KMS', correct: false, why: 'The KMS key is stored in AWS.' },
      { key: 'C', text: 'SSE-C', correct: true, why: 'The key is supplied with each request.' },
      { key: 'D', text: 'Client-side', correct: false, why: 'Encryption happens before upload.' },
    ],
    references: [
      'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html',
    ],
    status: 'reviewed',
    provenance: { generated_by: 'model-a', verified_by: 'model-b', reviewed_by: 'owner' },
    ...overrides,
  });
}

describe('guardrails paths <files>', () => {
  test('AC-10: exits 1 and reports source-material for a .pdf', () => {
    const dir = makeTempDir();
    write(dir, 'slides.pdf', 'not really a pdf');
    const run = runCli(dir, ['paths', 'slides.pdf']);
    expect(run.output).toMatch(/✖ .*slides\.pdf \[source-material\]/);
    expect(run.output).not.toContain('✔');
    expect(run.status).toBe(1);
  });

  test('AC-10: exits 0 with the ok line for clean files', () => {
    const dir = makeTempDir();
    write(dir, 'README.md', '# Hello\n\nNothing to see.\n');
    write(dir, 'src/index.ts', 'export const answer = 42;\n');
    const run = runCli(dir, ['paths', 'README.md', join('src', 'index.ts')]);
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });

  test('AC-10: reads the given files from disk and flags a client reference in their content', () => {
    const dir = makeTempDir();
    write(dir, 'notes.md', `copied from ${CLIENT}\n`);
    write(dir, 'clean.md', 'fine\n');
    const run = runCli(dir, ['paths', 'notes.md', 'clean.md']);
    expect(run.output).toMatch(/✖ .*notes\.md \[client-reference\]/);
    expect(run.output).not.toMatch(/✖ .*clean\.md/);
    expect(run.status).toBe(1);
  });

  test('AC-10: flags a Windows user path in the content of a given file', () => {
    const dir = makeTempDir();
    write(dir, 'notes.md', `see ${WINDOWS_USER_PATH}\n`);
    const run = runCli(dir, ['paths', 'notes.md']);
    expect(run.output).toMatch(/✖ .*notes\.md \[client-reference\]/);
    expect(run.status).toBe(1);
  });

  test('AC-10: runs the question rules on a given question file', () => {
    const dir = makeTempDir();
    write(dir, 'questions/d1/1.3/draft.yaml', reviewedQuestion({ status: 'draft' }));
    const run = runCli(dir, ['paths', join('questions', 'd1', '1.3', 'draft.yaml')]);
    expect(run.output).toMatch(/✖ .*draft\.yaml \[question-schema\]/);
    expect(run.status).toBe(1);
  });

  test('AC-10: accepts a valid reviewed question file', () => {
    const dir = makeTempDir();
    write(dir, 'questions/d1/1.3/ok.yaml', reviewedQuestion());
    const run = runCli(dir, ['paths', join('questions', 'd1', '1.3', 'ok.yaml')]);
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });

  test('AC-10: prints one line per violation', () => {
    const dir = makeTempDir();
    write(dir, 'a.pdf', 'x');
    write(dir, 'b.pptx', 'x');
    const run = runCli(dir, ['paths', 'a.pdf', 'b.pptx']);
    const lines = run.output.split(/\r?\n/).filter((line) => line.startsWith('✖'));
    expect(lines).toHaveLength(2);
    expect(run.status).toBe(1);
  });
});

describe('guardrails paths --staged', () => {
  test('AC-11: blocks a staged private/x.md even after git add -f', () => {
    const dir = makeTempRepo();
    write(dir, '.gitignore', 'private/\n');
    write(dir, 'private/x.md', 'secret plans\n');
    git(dir, ['add', '-f', 'private/x.md']);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ private\/x\.md \[private-path\]/);
    expect(run.status).toBe(1);
  });

  test('AC-11: blocks a staged file whose staged content has a client reference', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', `from ${CLIENT}\n`);
    git(dir, ['add', 'docs/a.md']);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ docs\/a\.md \[client-reference\]/);
    expect(run.status).toBe(1);
  });

  test('AC-11: checks the staged content, not the working tree', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', `from ${CLIENT}\n`);
    git(dir, ['add', 'docs/a.md']);
    write(dir, 'docs/a.md', 'cleaned up after staging\n');
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ docs\/a\.md \[client-reference\]/);
    expect(run.status).toBe(1);
  });

  test('AC-11: ignores a staged file whose working tree copy is the only violation', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', 'clean when staged\n');
    git(dir, ['add', 'docs/a.md']);
    write(dir, 'docs/a.md', `dirty afterwards: ${CLIENT}\n`);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });

  test('AC-11: ignores unstaged changes and untracked files', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', 'clean\n');
    commitAll(dir);
    write(dir, 'docs/a.md', `unstaged edit with ${CLIENT}\n`);
    write(dir, 'slides.pdf', 'untracked');
    write(dir, 'docs/b.md', 'staged and clean\n');
    git(dir, ['add', 'docs/b.md']);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });

  test('AC-11: ignores staged deletions, even of files that would be violations', () => {
    const dir = makeTempRepo();
    write(dir, 'slides.pdf', 'old pdf');
    write(dir, 'docs/notes.md', `from ${CLIENT}\n`);
    commitAll(dir);
    git(dir, ['rm', '--quiet', 'slides.pdf', 'docs/notes.md']);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });

  test('AC-11: exits 0 when nothing is staged', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', 'clean\n');
    commitAll(dir);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });
});

describe('guardrails paths --all', () => {
  test('AC-12: reports violations across all tracked files', () => {
    const dir = makeTempRepo();
    write(dir, 'private/x.md', 'plans\n');
    write(dir, 'slides/deck.pdf', 'x');
    write(dir, 'docs/notes.md', `from ${CLIENT}\n`);
    write(dir, 'docs/clean.md', 'fine\n');
    git(dir, ['add', '-f', '.']);
    git(dir, ['commit', '--quiet', '--no-verify', '-m', 'chore: seed']);
    const run = runCli(dir, ['paths', '--all']);
    expect(run.output).toMatch(/✖ private\/x\.md \[private-path\]/);
    expect(run.output).toMatch(/✖ slides\/deck\.pdf \[source-material\]/);
    expect(run.output).toMatch(/✖ docs\/notes\.md \[client-reference\]/);
    expect(run.output).not.toMatch(/✖ docs\/clean\.md/);
    expect(run.status).toBe(1);
  });

  test('AC-12: does not report untracked files', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/clean.md', 'fine\n');
    commitAll(dir);
    write(dir, 'slides.pdf', 'untracked');
    const run = runCli(dir, ['paths', '--all']);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });

  test('AC-12: exits 0 with the ok line when every tracked file is clean', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/clean.md', 'fine\n');
    write(dir, 'questions/d1/1.3/ok.yaml', reviewedQuestion());
    commitAll(dir);
    const run = runCli(dir, ['paths', '--all']);
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });

  test('AC-12: runs the question rules on tracked question files', () => {
    const dir = makeTempRepo();
    write(dir, 'questions/d2/1.3/misplaced.yaml', reviewedQuestion());
    commitAll(dir);
    const run = runCli(dir, ['paths', '--all']);
    expect(run.output).toMatch(/✖ questions\/d2\/1\.3\/misplaced\.yaml \[question-schema\]/);
    expect(run.status).toBe(1);
  });
});

describe('guardrails commit-msg <file>', () => {
  const aiTrailer = `${TRAILER}${AI_NAME} Opus 5.5 <noreply@${AI_DOMAIN}>`;

  test('AC-13: exits 1 for a message with an AI trailer', () => {
    const dir = makeTempDir();
    write(dir, 'COMMIT_EDITMSG', `feat: add y\n\n${aiTrailer}\n`);
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.output).toMatch(/✖ COMMIT_EDITMSG \[ai-attribution\]/);
    expect(run.status).toBe(1);
  });

  test('AC-13: exits 0 with the ok line for a clean message', () => {
    const dir = makeTempDir();
    write(dir, 'COMMIT_EDITMSG', 'feat(guardrails): add the rules\n\nBecause.\n');
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.stdout).toContain('✔ guardrails: commit-msg ok');
    expect(run.status).toBe(0);
  });

  test('AC-13: ignores # comment lines, so a commented-out trailer does not fail', () => {
    const dir = makeTempDir();
    write(
      dir,
      'COMMIT_EDITMSG',
      `feat: add y\n\n# ${aiTrailer}\n# Please enter the commit message\n`,
    );
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: commit-msg ok');
    expect(run.status).toBe(0);
  });

  test('AC-13: a trailer is still caught when comment lines surround it', () => {
    const dir = makeTempDir();
    write(dir, 'COMMIT_EDITMSG', `# header\nfeat: add y\n\n${aiTrailer}\n# footer\n`);
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.output).toMatch(/\[ai-attribution\]/);
    expect(run.status).toBe(1);
  });

  test('AC-13: accepts the file path relative to the working directory', () => {
    const dir = makeTempDir();
    write(dir, 'msg.txt', `fix: z\n\n${aiTrailer}\n`);
    const run = runCli(dir, ['commit-msg', 'msg.txt']);
    expect(run.output).toMatch(/\[ai-attribution\]/);
    expect(run.status).toBe(1);
  });
});

describe('guardrails pre-push', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  test('AC-14: exits 1 when stdin has a refs/heads/main remote ref', () => {
    const dir = makeTempDir();
    const run = runCli(dir, ['pre-push'], `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`);
    expect(run.output).toMatch(/✖ .*\[push-main\]/);
    expect(run.status).toBe(1);
  });

  test('AC-14: exits 0 for any other remote ref', () => {
    const dir = makeTempDir();
    const stdin = `refs/heads/feat/2-guardrails ${SHA_A} refs/heads/feat/2-guardrails ${SHA_B}\n`;
    const run = runCli(dir, ['pre-push'], stdin);
    expect(run.stdout).toContain('✔ guardrails: pre-push ok');
    expect(run.status).toBe(0);
  });

  test('AC-14: exits 0 when stdin is empty', () => {
    const dir = makeTempDir();
    const run = runCli(dir, ['pre-push'], '');
    expect(run.stdout).toContain('✔ guardrails: pre-push ok');
    expect(run.status).toBe(0);
  });
});

describe('guardrails usage errors', () => {
  test('AC-15: an unknown command exits 2 with usage on stderr', () => {
    const dir = makeTempDir();
    const run = runCli(dir, ['frobnicate']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stdout).not.toContain('✔');
    expect(run.status).toBe(2);
  });

  test('AC-15: commit-msg without a file exits 2 with usage on stderr', () => {
    const dir = makeTempDir();
    const run = runCli(dir, ['commit-msg']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stdout).not.toContain('✔');
    expect(run.status).toBe(2);
  });

  test('AC-15: no command at all exits 2 with usage on stderr', () => {
    const dir = makeTempDir();
    const run = runCli(dir, []);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.status).toBe(2);
  });
});

describe('guardrails on this repository', () => {
  test('AC-16: paths --all exits 0 on the repository root (no blocked string is written literally)', () => {
    const run = runCli(REPO_ROOT, ['paths', '--all']);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });
});

/** Writes `content` as a blob into the repository and returns its object id. */
function hashObject(dir: string, content: string): string {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    env: cleanEnv(),
    input: content,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/** Adds an index entry without touching the working tree. */
function setIndexEntry(dir: string, mode: string, sha: string, path: string): void {
  git(dir, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`]);
}

const GITLINK_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('guardrails paths with a gitlink (the nested private repo)', () => {
  test('AC-18: paths --staged flags a staged gitlink at private as private-path, not exit 2', () => {
    const dir = makeTempRepo();
    setIndexEntry(dir, '160000', GITLINK_SHA, 'private');
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ private \[private-path\]/);
    expect(run.status).toBe(1);
  });

  test('AC-18: paths --all flags a committed gitlink at private as private-path, not exit 2', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', 'clean\n');
    git(dir, ['add', 'docs/a.md']);
    setIndexEntry(dir, '160000', GITLINK_SHA, 'private');
    git(dir, ['commit', '--quiet', '--no-verify', '-m', 'chore: seed']);
    const run = runCli(dir, ['paths', '--all']);
    expect(run.output).toMatch(/✖ private \[private-path\]/);
    expect(run.output).not.toMatch(/✖ docs\/a\.md/);
    expect(run.status).toBe(1);
  });

  test('AC-18: a gitlink at an allowed path is path-checked and skipped for content', () => {
    const dir = makeTempRepo();
    setIndexEntry(dir, '160000', GITLINK_SHA, 'vendor/lib');
    const staged = runCli(dir, ['paths', '--staged']);
    expect(staged.output).not.toContain('✖');
    expect(staged.stdout).toContain('✔ guardrails: paths ok');
    expect(staged.status).toBe(0);
  });
});

describe('guardrails paths --staged with type changes', () => {
  test('AC-20: flags a file that changed from symlink to regular file with a client reference', () => {
    const dir = makeTempRepo();
    setIndexEntry(dir, '120000', hashObject(dir, 'target.md'), 'link');
    git(dir, ['commit', '--quiet', '--no-verify', '-m', 'chore: seed']);
    setIndexEntry(dir, '100644', hashObject(dir, `copied from ${CLIENT}\n`), 'link');
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ link \[client-reference\]/);
    expect(run.status).toBe(1);
  });

  test('AC-20: a clean type change from symlink to regular file passes', () => {
    const dir = makeTempRepo();
    setIndexEntry(dir, '120000', hashObject(dir, 'target.md'), 'link');
    git(dir, ['commit', '--quiet', '--no-verify', '-m', 'chore: seed']);
    setIndexEntry(dir, '100644', hashObject(dir, 'plain text\n'), 'link');
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });

  test('AC-20: flags a path violation on a type change', () => {
    const dir = makeTempRepo();
    setIndexEntry(dir, '120000', hashObject(dir, 'target.md'), 'deck.pdf');
    git(dir, ['commit', '--quiet', '--no-verify', '-m', 'chore: seed']);
    setIndexEntry(dir, '100644', hashObject(dir, 'now a file\n'), 'deck.pdf');
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ deck\.pdf \[source-material\]/);
    expect(run.status).toBe(1);
  });
});

describe('guardrails commit-msg with the scissors line', () => {
  const aiTrailer = `${TRAILER}${AI_NAME} Opus 5.5 <noreply@${AI_DOMAIN}>`;
  const SCISSORS = '# ------------------------ >8 ------------------------';
  const verboseTail = [
    SCISSORS,
    '# Do not modify or remove the line above.',
    '# Everything below it will be ignored.',
    'diff --git a/docs/a.md b/docs/a.md',
    `+${aiTrailer}`,
    aiTrailer,
    `+${GENERATED}${AI_NAME} Code`,
    '',
  ].join('\n');

  test('AC-21: ignores a trailer in the diff below the scissors line (git commit -v)', () => {
    const dir = makeTempDir();
    write(dir, 'COMMIT_EDITMSG', `feat: add y\n\nBecause.\n${verboseTail}`);
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: commit-msg ok');
    expect(run.status).toBe(0);
  });

  test('AC-21: still catches a trailer above the scissors line', () => {
    const dir = makeTempDir();
    write(dir, 'COMMIT_EDITMSG', `feat: add y\n\n${aiTrailer}\n${verboseTail}`);
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.output).toMatch(/✖ COMMIT_EDITMSG \[ai-attribution\]/);
    expect(run.status).toBe(1);
  });

  test('AC-21: allows a Co-authored-by trailer for a person named like the assistant', () => {
    const dir = makeTempDir();
    const person = `Co-authored-by: ${AI_NAME}tte Dupont <c@example.com>`;
    write(dir, 'COMMIT_EDITMSG', `feat: add y\n\n${person}\n`);
    const run = runCli(dir, ['commit-msg', join(dir, 'COMMIT_EDITMSG')]);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });
});

describe('guardrails paths --staged from a subdirectory', () => {
  test('AC-24: flags a staged client reference when run with cwd = <repo>/docs', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', `from ${CLIENT}\n`);
    git(dir, ['add', 'docs/a.md']);
    const run = runCli(join(dir, 'docs'), ['paths', '--staged']);
    expect(run.output).toMatch(/✖ .*a\.md \[client-reference\]/);
    expect(run.status).toBe(1);
  });

  test('AC-24: gives the same result when run from the repository root', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', `from ${CLIENT}\n`);
    git(dir, ['add', 'docs/a.md']);
    const run = runCli(dir, ['paths', '--staged']);
    expect(run.output).toMatch(/✖ .*a\.md \[client-reference\]/);
    expect(run.status).toBe(1);
  });

  test('AC-24: a clean staged file passes when run from a subdirectory', () => {
    const dir = makeTempRepo();
    write(dir, 'docs/a.md', 'clean\n');
    git(dir, ['add', 'docs/a.md']);
    const run = runCli(join(dir, 'docs'), ['paths', '--staged']);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: paths ok');
    expect(run.status).toBe(0);
  });
});

// ---- Spec 004: test-lock and commits commands -------------------------------------------------

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

/** Commits everything that is staged or changed, bypassing the repository's own hooks. */
function commitWith(dir: string, subject: string, body?: string): string {
  git(dir, ['add', '-A']);
  const message = body === undefined ? ['-m', subject] : ['-m', subject, '-m', body];
  git(dir, ['commit', '--quiet', '--no-verify', ...message]);
  return gitOut(dir, ['rev-parse', 'HEAD']);
}

const TEST_FILE = 'src/a.test.ts';
const TEST_BODY = ["test('one', () => {});", "test('two', () => {});", "test('three', () => {});"];

/**
 * A repository with a seed commit (the base) and a feature branch holding the usual
 * spec, tests, code sequence: a `test:` commit adding a test file plus a stub, then a
 * `feat:` commit that changes only source.
 */
function makeFeatureRepo(): { dir: string; base: string; testSha: string; featSha: string } {
  const dir = makeTempRepo();
  write(dir, 'README.md', '# Seed\n');
  const base = commitWith(dir, 'chore: seed');
  git(dir, ['checkout', '--quiet', '-b', 'feature']);
  write(dir, TEST_FILE, TEST_BODY.join('\n') + '\n');
  write(
    dir,
    'src/a.ts',
    "export const a = (): never => { throw new Error('not implemented'); };\n",
  );
  const testSha = commitWith(dir, 'test(a): add tests and stubs');
  write(dir, 'src/a.ts', 'export const a = (): number => 1;\n');
  const featSha = commitWith(dir, 'feat(a): implement a');
  return { dir, base, testSha, featSha };
}

describe('guardrails test-lock --base <ref>', () => {
  test('AC-7: a test commit then a source-only feat commit exits 0 with the ok line', () => {
    const { dir, base } = makeFeatureRepo();
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-7: a branch ref works as the base', () => {
    const { dir, base } = makeFeatureRepo();
    git(dir, ['branch', 'base-branch', base]);
    const run = runCli(dir, ['test-lock', '--base', 'base-branch']);
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-7: an empty range exits 0', () => {
    const { dir, featSha } = makeFeatureRepo();
    const run = runCli(dir, ['test-lock', '--base', featSha]);
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-7: a later fix commit that edits the test exits 1 with [test-lock], naming the commit', () => {
    const { dir, base } = makeFeatureRepo();
    write(dir, TEST_FILE, TEST_BODY.join('\n').replace('three', 'THREE') + '\n');
    const fixSha = commitWith(dir, 'fix(a): make it pass');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*a\.test\.ts.*\[test-lock\]/);
    expect(run.output).toContain(fixSha.slice(0, 7));
    expect(run.status).toBe(1);
  });

  test('AC-7: --head limits the range, so a bad commit after it is not seen', () => {
    const { dir, base, featSha } = makeFeatureRepo();
    write(dir, TEST_FILE, TEST_BODY.join('\n').replace('three', 'THREE') + '\n');
    commitWith(dir, 'fix(a): make it pass');
    const run = runCli(dir, ['test-lock', '--base', base, '--head', featSha]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-7: a fix commit that deletes the test file exits 1 with [test-lock]', () => {
    const { dir, base } = makeFeatureRepo();
    rmSync(join(dir, 'src', 'a.test.ts'));
    commitWith(dir, 'fix(a): drop the failing test');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*a\.test\.ts.*\[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-7: a later test commit that only appends a test exits 0', () => {
    const { dir, base } = makeFeatureRepo();
    write(dir, TEST_FILE, [...TEST_BODY, "test('four', () => {});"].join('\n') + '\n');
    commitWith(dir, 'test(a): one more case');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-7: a later test commit that deletes a line exits 1 with [test-lock]', () => {
    const { dir, base } = makeFeatureRepo();
    write(dir, TEST_FILE, TEST_BODY.slice(0, 2).join('\n') + '\n');
    commitWith(dir, 'test(a): trim');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*a\.test\.ts.*\[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-7: a later test commit that renames the test file exits 1 with [test-lock]', () => {
    const { dir, base } = makeFeatureRepo();
    git(dir, ['mv', TEST_FILE, 'src/b.test.ts']);
    commitWith(dir, 'test(a): rename');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*\.test\.ts.*\[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-7: merge commits in the range are ignored', () => {
    const { dir, base } = makeFeatureRepo();
    git(dir, ['checkout', '--quiet', '-b', 'other', base]);
    write(dir, 'src/other.ts', 'export const other = 1;\n');
    commitWith(dir, 'feat(other): add other');
    git(dir, ['checkout', '--quiet', 'feature']);
    git(dir, ['merge', '--quiet', '--no-ff', '--no-verify', '-m', 'Merge branch other', 'other']);
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });
});

describe('guardrails commits --base <ref>', () => {
  const aiBody = `${TRAILER}${AI_NAME} Opus 5.5 <noreply@${AI_DOMAIN}>`;

  function makeRangeRepo(): { dir: string; base: string } {
    const dir = makeTempRepo();
    write(dir, 'README.md', '# Seed\n');
    const base = commitWith(dir, 'chore: seed');
    git(dir, ['checkout', '--quiet', '-b', 'feature']);
    write(dir, 'a.txt', 'a\n');
    commitWith(dir, 'feat: add a');
    write(dir, 'b.txt', 'b\n');
    commitWith(dir, 'feat: add b', 'A body paragraph.');
    return { dir, base };
  }

  test('AC-8: exits 0 with the ok line when no commit in the range has an AI trailer', () => {
    const { dir, base } = makeRangeRepo();
    const run = runCli(dir, ['commits', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: commits ok');
    expect(run.status).toBe(0);
  });

  test('AC-8: exits 1 and reports ai-attribution when one commit has an AI trailer', () => {
    const { dir, base } = makeRangeRepo();
    write(dir, 'c.txt', 'c\n');
    const badSha = commitWith(dir, 'feat: add c', aiBody);
    write(dir, 'd.txt', 'd\n');
    commitWith(dir, 'feat: add d');
    const run = runCli(dir, ['commits', '--base', base]);
    expect(run.output).toMatch(/✖ .* \[ai-attribution\]/);
    expect(run.output).toContain(badSha.slice(0, 7));
    expect(run.status).toBe(1);
  });

  test('AC-8: a trailer on a commit outside the range (at or before the base) is not reported', () => {
    const dir = makeTempRepo();
    write(dir, 'README.md', '# Seed\n');
    commitWith(dir, 'chore: seed', aiBody);
    write(dir, 'a.txt', 'a\n');
    const base = commitWith(dir, 'chore: before the range', aiBody);
    write(dir, 'b.txt', 'b\n');
    commitWith(dir, 'feat: add b');
    const run = runCli(dir, ['commits', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });

  test('AC-8: --head limits the range, so a bad commit after it is not seen', () => {
    const { dir, base } = makeRangeRepo();
    const head = gitOut(dir, ['rev-parse', 'HEAD']);
    write(dir, 'c.txt', 'c\n');
    commitWith(dir, 'feat: add c', aiBody);
    const run = runCli(dir, ['commits', '--base', base, '--head', head]);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });

  test('AC-8: an empty range exits 0', () => {
    const { dir } = makeRangeRepo();
    const run = runCli(dir, ['commits', '--base', 'HEAD']);
    expect(run.stdout).toContain('✔ guardrails: commits ok');
    expect(run.status).toBe(0);
  });

  test('AC-8: merge commits in the range are ignored', () => {
    const { dir, base } = makeRangeRepo();
    git(dir, ['checkout', '--quiet', '-b', 'other', base]);
    write(dir, 'o.txt', 'o\n');
    commitWith(dir, 'feat: add o');
    git(dir, ['checkout', '--quiet', 'feature']);
    git(dir, [
      'merge',
      '--quiet',
      '--no-ff',
      '--no-verify',
      '-m',
      'Merge branch other',
      '-m',
      aiBody,
      'other',
    ]);
    const run = runCli(dir, ['commits', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: commits ok');
    expect(run.status).toBe(0);
  });
});

describe('guardrails test-lock and commits usage errors', () => {
  test('AC-9: test-lock without --base exits 2 with usage on stderr', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['test-lock']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stderr).toContain('test-lock');
    expect(run.stderr).toContain('--base');
    expect(run.stdout).not.toContain('✔');
    expect(run.status).toBe(2);
  });

  test('AC-9: commits without --base exits 2 with usage on stderr', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['commits']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stderr).toContain('commits');
    expect(run.stderr).toContain('--base');
    expect(run.stdout).not.toContain('✔');
    expect(run.status).toBe(2);
  });

  test('AC-9: --head alone is not enough, test-lock still exits 2', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['test-lock', '--head', 'HEAD']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stderr).toContain('--base');
    expect(run.status).toBe(2);
  });

  test('AC-9: --head alone is not enough, commits still exits 2', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['commits', '--head', 'HEAD']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stderr).toContain('--base');
    expect(run.status).toBe(2);
  });
});

// ---- Spec 005: test-control files and the no-merges command -----------------------------------

const PACKAGE_JSON = [
  '{',
  '  "name": "sample",',
  '  "scripts": {',
  '    "test": "vitest run",',
  '    "e2e": "playwright test",',
  '    "lint": "eslint ."',
  '  },',
  '  "dependencies": {',
  '    "left-pad": "^1.0.0"',
  '  }',
  '}',
  '',
].join('\n');

const PLAYWRIGHT_CONFIG = [
  "import { defineConfig } from '@playwright/test';",
  '',
  'retries();',
  '',
];

/**
 * A repository whose base commit holds the test-control files, plus a feature branch
 * that is checked out and still empty.
 */
function makeControlRepo(): { dir: string; base: string } {
  const dir = makeTempRepo();
  write(dir, 'README.md', '# Seed\n');
  write(dir, 'package.json', PACKAGE_JSON);
  write(dir, 'packages/x/package.json', PACKAGE_JSON);
  write(dir, 'vitest.config.ts', 'export default { test: { include: ["src/**/*.test.ts"] } };\n');
  write(dir, 'vitest.setup.ts', 'export {};\n');
  write(dir, 'playwright.config.ts', PLAYWRIGHT_CONFIG.join('\n'));
  const base = commitWith(dir, 'chore: seed');
  git(dir, ['checkout', '--quiet', '-b', 'feature']);
  return { dir, base };
}

describe('guardrails test-lock --base <ref> and test-control files', () => {
  test('AC-8: a fix commit editing vitest.config.ts exits 1 with [test-lock] naming it', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'vitest.config.ts', 'export default { test: { include: [] } };\n');
    const fixSha = commitWith(dir, 'fix: make the suite pass');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*vitest\.config\.ts.*\[test-lock\]/);
    expect(run.output).toContain(fixSha.slice(0, 7));
    expect(run.status).toBe(1);
  });

  test('AC-8: a feat commit adding --pass-with-no-tests to a package.json script exits 1 naming package.json', () => {
    const { dir, base } = makeControlRepo();
    write(
      dir,
      'package.json',
      PACKAGE_JSON.replace(
        '"e2e": "playwright test"',
        '"e2e": "playwright test --pass-with-no-tests"',
      ),
    );
    commitWith(dir, 'feat: tolerate empty suites');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*package\.json.*\[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-8: a feat commit removing the test script of a nested package.json exits 1 naming it', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'packages/x/package.json', PACKAGE_JSON.replace('    "test": "vitest run",\n', ''));
    commitWith(dir, 'feat: drop the test script');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*packages\/x\/package\.json.*\[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-8: a chore(deps) commit changing only a dependency version in package.json exits 0', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'package.json', PACKAGE_JSON.replace('^1.0.0', '^1.1.0'));
    commitWith(dir, 'chore(deps): bump left-pad');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-8: a feat commit changing a non-test script in package.json exits 0', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'package.json', PACKAGE_JSON.replace('"lint": "eslint ."', '"lint": "eslint src"'));
    commitWith(dir, 'feat: lint only src');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });

  test('AC-8: a test commit removing a line from playwright.config.ts exits 0', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'playwright.config.ts', PLAYWRIGHT_CONFIG.slice(0, 2).join('\n') + '\n');
    commitWith(dir, 'test(e2e): simplify the runner config');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: test-lock ok');
    expect(run.status).toBe(0);
  });

  test('AC-8: a test commit changing a test script in package.json exits 0', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'package.json', PACKAGE_JSON.replace('"vitest run"', '"vitest run --coverage"'));
    commitWith(dir, 'test: run the suite with coverage');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });

  test('AC-8: a feat commit deleting vitest.setup.ts exits 1 naming it', () => {
    const { dir, base } = makeControlRepo();
    rmSync(join(dir, 'vitest.setup.ts'));
    commitWith(dir, 'feat: drop the global setup');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ .*vitest\.setup\.ts.*\[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-8: a feat commit touching only ordinary source exits 0', () => {
    const { dir, base } = makeControlRepo();
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    commitWith(dir, 'feat: add a');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.status).toBe(0);
  });
});

describe('guardrails no-merges --base <ref>', () => {
  /** Merges a side branch (created from `from`) into the current branch with a merge commit. */
  function mergeSideBranch(dir: string, from: string): string {
    const current = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(dir, ['checkout', '--quiet', '-b', `side-${from.slice(0, 7)}`, from]);
    write(dir, 'src/side.ts', 'export const side = 1;\n');
    commitWith(dir, 'feat(side): add side');
    git(dir, ['checkout', '--quiet', current]);
    git(dir, [
      'merge',
      '--quiet',
      '--no-ff',
      '--no-verify',
      '-m',
      'Merge branch side',
      `side-${from.slice(0, 7)}`,
    ]);
    return gitOut(dir, ['rev-parse', 'HEAD']);
  }

  test('AC-9: a linear branch exits 0 with the ok line', () => {
    const { dir, base } = makeFeatureRepo();
    const run = runCli(dir, ['no-merges', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: no-merges ok');
    expect(run.status).toBe(0);
  });

  test('AC-9: a branch containing a merge commit exits 1 with [no-merges] and the merge short sha', () => {
    const { dir, base } = makeFeatureRepo();
    const mergeSha = mergeSideBranch(dir, base);
    const run = runCli(dir, ['no-merges', '--base', base]);
    expect(run.output).toMatch(/✖ .* \[no-merges\]/);
    expect(run.output).toContain(mergeSha.slice(0, 7));
    expect(run.output).not.toContain('✔');
    expect(run.status).toBe(1);
  });

  test('AC-9: only the merge commit is reported, not the linear commits around it', () => {
    const { dir, base, featSha } = makeFeatureRepo();
    const mergeSha = mergeSideBranch(dir, base);
    write(dir, 'src/after.ts', 'export const after = 1;\n');
    commitWith(dir, 'feat: after the merge');
    const run = runCli(dir, ['no-merges', '--base', base]);
    expect(run.output).toContain(mergeSha.slice(0, 7));
    expect(run.output).not.toContain(featSha.slice(0, 7));
    expect(run.output.match(/\[no-merges\]/g)).toHaveLength(1);
    expect(run.status).toBe(1);
  });

  test('AC-9: a merge commit at or before the base is not reported', () => {
    const dir = makeTempRepo();
    write(dir, 'README.md', '# Seed\n');
    const seed = commitWith(dir, 'chore: seed');
    const base = mergeSideBranch(dir, seed);
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    commitWith(dir, 'feat: add a');
    const run = runCli(dir, ['no-merges', '--base', base]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: no-merges ok');
    expect(run.status).toBe(0);
  });

  test('AC-9: --head set to the commit before the merge exits 0', () => {
    const { dir, base, featSha } = makeFeatureRepo();
    mergeSideBranch(dir, base);
    const run = runCli(dir, ['no-merges', '--base', base, '--head', featSha]);
    expect(run.output).not.toContain('✖');
    expect(run.stdout).toContain('✔ guardrails: no-merges ok');
    expect(run.status).toBe(0);
  });

  test('AC-9: --head set to the merge commit itself exits 1', () => {
    const { dir, base } = makeFeatureRepo();
    const mergeSha = mergeSideBranch(dir, base);
    write(dir, 'src/after.ts', 'export const after = 1;\n');
    commitWith(dir, 'feat: after the merge');
    const run = runCli(dir, ['no-merges', '--base', base, '--head', mergeSha]);
    expect(run.output).toMatch(/✖ .* \[no-merges\]/);
    expect(run.status).toBe(1);
  });

  test('AC-9: an empty range exits 0', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['no-merges', '--base', 'HEAD']);
    expect(run.stdout).toContain('✔ guardrails: no-merges ok');
    expect(run.status).toBe(0);
  });

  test('AC-9: without --base exits 2 with usage on stderr', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['no-merges']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stderr).toContain('no-merges');
    expect(run.stderr).toContain('--base');
    expect(run.stdout).not.toContain('✔');
    expect(run.status).toBe(2);
  });

  test('AC-9: --head alone is not enough, no-merges still exits 2', () => {
    const { dir } = makeFeatureRepo();
    const run = runCli(dir, ['no-merges', '--head', 'HEAD']);
    expect(run.stderr).toMatch(/usage/i);
    expect(run.stderr).toContain('no-merges');
    expect(run.stderr).toContain('--base');
    expect(run.status).toBe(2);
  });
});

// ---- Spec 008: package.json renames and the guardrails script ---------------------------------

const GUARDRAILS_SCRIPT = '    "guardrails": "tsx tools/guardrails/src/cli.ts",\n';

/** PACKAGE_JSON with a root-style `guardrails` script next to the other scripts. */
const GUARDRAILS_PACKAGE_JSON = PACKAGE_JSON.replace(
  '    "lint"',
  `${GUARDRAILS_SCRIPT}    "lint"`,
);

/**
 * A repository whose base holds `packages/a/package.json` (test and e2e scripts), a disabled
 * `packages/c/package.json.off` with a test script, and a root package.json with a guardrails
 * script, plus a feature branch that is checked out and still empty.
 */
function makeMoveRepo(): { dir: string; base: string } {
  const dir = makeTempRepo();
  write(dir, 'README.md', '# Seed\n');
  write(dir, 'package.json', GUARDRAILS_PACKAGE_JSON);
  write(dir, 'packages/a/package.json', PACKAGE_JSON);
  write(
    dir,
    'packages/c/package.json.off',
    PACKAGE_JSON.replace('"name": "sample"', '"name": "disabled"'),
  );
  const base = commitWith(dir, 'chore: seed');
  git(dir, ['checkout', '--quiet', '-b', 'feature']);
  return { dir, base };
}

function expectLockOk(run: Run): void {
  expect(run.output).not.toContain('✖');
  expect(run.stdout).toContain('✔ guardrails: test-lock ok');
  expect(run.status).toBe(0);
}

describe('guardrails test-lock --base <ref> and package.json renames', () => {
  test('AC-6: a refactor commit moving a package directory unchanged exits 0 with the ok line', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/a', 'packages/b']);
    commitWith(dir, 'refactor: move a to b');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });

  test('AC-6: a refactor commit moving it and removing its test script exits 1 naming the new path', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/a', 'packages/b']);
    write(dir, 'packages/b/package.json', PACKAGE_JSON.replace('    "test": "vitest run",\n', ''));
    commitWith(dir, 'refactor: move a to b');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ packages\/b\/package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-6: a refactor commit moving it and changing only its name exits 0', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/a', 'packages/b']);
    write(dir, 'packages/b/package.json', PACKAGE_JSON.replace('"sample"', '"moved"'));
    commitWith(dir, 'refactor: move and rename a');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });

  test('AC-6: a feat commit renaming package.json away exits 1 naming the old path', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/a/package.json', 'packages/a/package.json.off']);
    commitWith(dir, 'feat: disable a');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ packages\/a\/package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-6: a test commit renaming package.json away exits 0', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/a/package.json', 'packages/a/package.json.off']);
    commitWith(dir, 'test: disable a');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });

  test('AC-6: a feat commit renaming package.json.off to package.json exits 1 naming the new path', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/c/package.json.off', 'packages/c/package.json']);
    commitWith(dir, 'feat: enable c');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ packages\/c\/package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-6: a feat commit renaming package.json.off to another name without scripts changing exits 0', () => {
    const { dir, base } = makeMoveRepo();
    git(dir, ['mv', 'packages/c/package.json.off', 'packages/c/package.json.bak']);
    commitWith(dir, 'feat: park c');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });
});

describe('guardrails test-lock --base <ref> and the guardrails script', () => {
  test('AC-7: a feat commit changing the root guardrails script to echo ok exits 1 naming package.json', () => {
    const { dir, base } = makeMoveRepo();
    write(
      dir,
      'package.json',
      GUARDRAILS_PACKAGE_JSON.replace('"tsx tools/guardrails/src/cli.ts"', '"echo ok"'),
    );
    commitWith(dir, 'feat: silence the guardrails');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-7: a test commit changing the root guardrails script exits 0', () => {
    const { dir, base } = makeMoveRepo();
    write(
      dir,
      'package.json',
      GUARDRAILS_PACKAGE_JSON.replace('"tsx tools/guardrails/src/cli.ts"', '"echo ok"'),
    );
    commitWith(dir, 'test(guardrails): change the entry point');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });

  test('AC-7: a chore(deps) commit bumping a dependency next to a guardrails script exits 0', () => {
    const { dir, base } = makeMoveRepo();
    write(dir, 'package.json', GUARDRAILS_PACKAGE_JSON.replace('^1.0.0', '^1.1.0'));
    commitWith(dir, 'chore(deps): bump left-pad');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });

  test('AC-7: a feat commit removing the guardrails script exits 1 naming package.json', () => {
    const { dir, base } = makeMoveRepo();
    write(dir, 'package.json', PACKAGE_JSON);
    commitWith(dir, 'feat: drop the guardrails script');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });
});

// ---- Spec 008, review round 1: hidden package.json script changes -----------------------------

const ECHO_OK_PACKAGE_JSON = GUARDRAILS_PACKAGE_JSON.replace(
  '"tsx tools/guardrails/src/cli.ts"',
  '"echo ok"',
);

describe('guardrails test-lock --base <ref> and .gitattributes', () => {
  test('AC-10: a chore commit adding "package.json -diff" and setting the guardrails script to echo ok exits 1 naming package.json', () => {
    const { dir, base } = makeMoveRepo();
    write(dir, '.gitattributes', 'package.json -diff\n');
    write(dir, 'package.json', ECHO_OK_PACKAGE_JSON);
    commitWith(dir, 'chore: tidy the repository');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-10: with "package.json binary" already in the base, a feat commit changing the test script exits 1', () => {
    const { dir } = makeMoveRepo();
    write(dir, '.gitattributes', 'package.json binary\n');
    const base = commitWith(dir, 'chore: mark package.json as binary');
    write(dir, 'package.json', GUARDRAILS_PACKAGE_JSON.replace('"vitest run"', '"echo skipped"'));
    commitWith(dir, 'feat: speed up the tests');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-10: with "package.json -diff" in the base, a chore(deps) bump still exits 0', () => {
    const { dir } = makeMoveRepo();
    write(dir, '.gitattributes', 'package.json -diff\n');
    const base = commitWith(dir, 'chore: hide package.json diffs');
    write(dir, 'package.json', GUARDRAILS_PACKAGE_JSON.replace('^1.0.0', '^1.1.0'));
    commitWith(dir, 'chore(deps): bump left-pad');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });
});

describe('guardrails test-lock --base <ref> and scripts written on one line', () => {
  const minified = (guardrails: string): string =>
    JSON.stringify({
      name: 'sample',
      scripts: { test: 'vitest run', guardrails },
      dependencies: { 'left-pad': '^1.0.0' },
    }) + '\n';

  test('AC-11: a feat commit rewriting the root scripts onto one line with guardrails set to echo ok exits 1 naming package.json', () => {
    const { dir, base } = makeMoveRepo();
    write(dir, 'package.json', minified('echo ok'));
    commitWith(dir, 'feat: compact package.json');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-11: a feat commit changing the guardrails script inside an already one-line package.json exits 1', () => {
    const { dir } = makeMoveRepo();
    write(dir, 'package.json', minified('tsx tools/guardrails/src/cli.ts'));
    const base = commitWith(dir, 'chore: compact package.json');
    write(dir, 'package.json', minified('echo ok'));
    commitWith(dir, 'feat: silence the guardrails');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ package\.json \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-11: a test commit changing the guardrails script inside a one-line package.json exits 0', () => {
    const { dir } = makeMoveRepo();
    write(dir, 'package.json', minified('tsx tools/guardrails/src/cli.ts'));
    const base = commitWith(dir, 'chore: compact package.json');
    write(dir, 'package.json', minified('echo ok'));
    commitWith(dir, 'test(guardrails): change the entry point');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });
});

describe('guardrails test-lock --base <ref> and a case-only package.json rename', () => {
  /** Renames packages/a/package.json to PACKAGE.JSON in the index through a temporary name. */
  function renameToUpperCase(dir: string, subject: string): void {
    git(dir, ['mv', 'packages/a/package.json', 'packages/a/tmp.json']);
    git(dir, ['mv', 'packages/a/tmp.json', 'packages/a/PACKAGE.JSON']);
    commitWith(dir, subject);
    // The scenario is only meaningful if git records the case change as a pure rename.
    expect(gitOut(dir, ['show', '--format=', '--name-status', '-M', 'HEAD'])).toMatch(
      /^R100\s+packages\/a\/package\.json\s+packages\/a\/PACKAGE\.JSON$/m,
    );
  }

  test('AC-12: a refactor commit renaming package.json to PACKAGE.JSON exits 1 with a [test-lock] line under packages/a/', () => {
    const { dir, base } = makeMoveRepo();
    renameToUpperCase(dir, 'refactor: shout the manifest');
    const run = runCli(dir, ['test-lock', '--base', base]);
    expect(run.output).toMatch(/✖ packages\/a\/\S+ \[test-lock\]/);
    expect(run.status).toBe(1);
  });

  test('AC-12: a test commit doing the same exits 0', () => {
    const { dir, base } = makeMoveRepo();
    renameToUpperCase(dir, 'test: shout the manifest');
    expectLockOk(runCli(dir, ['test-lock', '--base', base]));
  });
});
