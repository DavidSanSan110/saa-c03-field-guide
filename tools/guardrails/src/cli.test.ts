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
