import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { questionYaml } from './__mocks__/fixtures.ts';

// Every test spawns a real process (tsx, sometimes git), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const ROOT = join(HERE, '..', '..', '..');
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

function runCli(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
  };
}

function git(cwd: string, args: string[]): string {
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
  const dir = mkdtempSync(join(tmpdir(), 'questions-'));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, path: string, content: string | Buffer): void {
  const full = join(dir, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(dir: string, path: string): Buffer {
  return readFileSync(join(dir, ...path.split('/')));
}

function exists(dir: string, path: string): boolean {
  return existsSync(join(dir, ...path.split('/')));
}

/** Every file (as hex bytes) and folder under `dir`, to prove that nothing was written or deleted. */
function snapshot(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        tree[`${path}/`] = '<dir>';
        walk(path);
      } else {
        tree[path] = readFileSync(join(dir, path)).toString('hex');
      }
    }
  };
  walk('');
  return tree;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

const DRAFTS = 'private/questions-drafts';
const BANK = 'questions';

/** A reviewed question file at its correct path inside `folder`. Returns the path in the folder. */
function put(
  dir: string,
  folder: string,
  id: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): string {
  const parts = /^d(\d)-(\d\.\d)-/.exec(id);
  const path = `d${parts?.[1] ?? '1'}/${parts?.[2] ?? '1.3'}/${slug}.yaml`;
  write(dir, `${folder}/${path}`, questionYaml({ id, ...overrides }));
  return path;
}

/** A draft text with comments, odd spacing and a trailing comment, so that re-serialising differs. */
function decorated(id: string, overrides: Record<string, unknown> = {}): string {
  const body = questionYaml({ id, ...overrides }).replace(
    'status: reviewed',
    'status:   reviewed    # reviewed by hand',
  );
  expect(body).toContain('# reviewed by hand');
  return `# header comment   \n\n${body}\n\n# end comment\n\n\n`;
}

const TEXT_WITH_UNICODE = {
  stem: 'A company keeps café data — résumé 日本語 — in S3 and needs SSE-C keys. Which option?',
};

describe('check', () => {
  test('AC-24: valid folders print a summary with the number of drafts and bank questions, exit 0', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one', { status: 'draft' });
    put(dir, DRAFTS, 'd2-2.1-0001', 'two', { status: 'verified' });
    put(dir, DRAFTS, 'd3-3.4-0001', 'three');
    put(dir, BANK, 'd1-1.2-0001', 'four');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/\b3\b[^\n]*draft|draft[^\n]*\b3\b/i);
    expect(run.output).toMatch(/\b1\b[^\n]*(bank|question)|(bank|question)[^\n]*\b1\b/i);
  });

  test('AC-24: a larger bank is counted too', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one', { status: 'draft' });
    put(dir, BANK, 'd1-1.2-0001', 'a');
    put(dir, BANK, 'd1-1.2-0002', 'b');
    put(dir, BANK, 'd2-2.1-0001', 'c');
    put(dir, BANK, 'd3-3.4-0001', 'd');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/\b4\b[^\n]*(bank|question)|(bank|question)[^\n]*\b4\b/i);
  });

  test('AC-25: each problem is printed as <folder>/<file>: <message> and the exit code is 1', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'fine', { status: 'draft' });
    write(dir, `${DRAFTS}/d1/1.3/bad.yaml`, 'id: [unclosed\n');
    put(dir, BANK, 'd1-1.2-0001', 'ok');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/d1/1.3/bad.yaml: invalid YAML`);
  });

  test('AC-25: the bank is read as public only, so a draft-status question there is a problem', () => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.3-0001', 'pending', { status: 'draft' });

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${BANK}/d1/1.3/pending.yaml: `);
  });

  test('AC-25: a draft-status question in the drafts folder is not a problem', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'pending', { status: 'draft' });

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(run.output).not.toContain('pending.yaml');
  });

  test('AC-25: the folder is printed as given with --drafts and --bank', () => {
    const dir = makeTempDir();
    write(dir, 'my-drafts/d1/1.3/bad.yaml', 'id: [unclosed\n');
    put(dir, 'my-bank', 'd1-1.3-0001', 'pending', { status: 'verified' });

    const run = runCli(dir, ['check', '--drafts', 'my-drafts', '--bank', 'my-bank']);

    expect(run.status).toBe(1);
    expect(run.output).toContain('my-drafts/d1/1.3/bad.yaml: invalid YAML');
    expect(run.output).toContain('my-bank/d1/1.3/pending.yaml: ');
  });

  test('AC-25: a reserved file or rejected/ folder in the drafts is not a problem', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'real', { status: 'draft' });
    write(dir, `${DRAFTS}/.gitkeep`, '');
    write(dir, `${DRAFTS}/d1/1.3/real.check.yaml`, 'anything: [goes\n');
    write(dir, `${DRAFTS}/rejected/d1/1.3/old.yaml`, 'id: [unclosed\n');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
  });

  test('AC-26: an id used both in the drafts and in the bank is a problem', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'mine');
    put(dir, BANK, 'd1-1.3-0001', 'theirs');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(1);
    expect(run.output).toMatch(
      /(private\/questions-drafts|questions)\/d1\/1\.3\/(mine|theirs)\.yaml: /,
    );
  });

  test('AC-26: different ids in the two folders are not a problem', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'mine');
    put(dir, BANK, 'd1-1.3-0002', 'theirs');

    expect(runCli(dir, ['check']).status).toBe(0);
  });

  test('AC-27: missing folders print "no folder at <dir>, treated as empty" and exit 0', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('no folder at private/questions-drafts, treated as empty');
    expect(run.output).toContain('no folder at questions, treated as empty');
  });

  test('AC-27: only the missing folder gets the notice', () => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.3-0001', 'ok');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('no folder at private/questions-drafts, treated as empty');
    expect(run.output).not.toContain('no folder at questions,');
  });

  test('AC-27: the notice names the folder as given with --drafts', () => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.3-0001', 'ok');

    const run = runCli(dir, ['check', '--drafts', 'nowhere']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('no folder at nowhere, treated as empty');
  });

  test('AC-28: --drafts and --bank override the default folders', () => {
    const dir = makeTempDir();
    // The default folders hold problems; the overrides are clean and hold 2 drafts and 1 question.
    write(dir, `${DRAFTS}/d1/1.3/default-bad.yaml`, 'id: [unclosed\n');
    write(dir, `${BANK}/d1/1.3/default-bad.yaml`, 'id: [unclosed\n');
    put(dir, 'other-drafts', 'd1-1.3-0001', 'one', { status: 'draft' });
    put(dir, 'other-drafts', 'd2-2.1-0001', 'two', { status: 'draft' });
    put(dir, 'other-bank', 'd3-3.4-0001', 'three');

    const run = runCli(dir, ['check', '--drafts', 'other-drafts', '--bank', 'other-bank']);

    expect(run.status).toBe(0);
    expect(run.output).not.toContain('default-bad');
    expect(run.output).toMatch(/\b2\b[^\n]*draft|draft[^\n]*\b2\b/i);
  });

  test('AC-28: the defaults are used when no flag is given', () => {
    const dir = makeTempDir();
    write(dir, `${DRAFTS}/d1/1.3/default-bad.yaml`, 'id: [unclosed\n');
    put(dir, 'other-drafts', 'd1-1.3-0001', 'one', { status: 'draft' });

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/d1/1.3/default-bad.yaml`);
  });

  test('AC-28: --bank alone overrides only the bank', () => {
    const dir = makeTempDir();
    write(dir, `${DRAFTS}/d1/1.3/draft-bad.yaml`, 'id: [unclosed\n');
    write(dir, `${BANK}/d1/1.3/default-bank-bad.yaml`, 'id: [unclosed\n');
    put(dir, 'other-bank', 'd3-3.4-0001', 'three');

    const run = runCli(dir, ['check', '--bank', 'other-bank']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/d1/1.3/draft-bad.yaml`);
    expect(run.output).not.toContain('default-bank-bad');
  });

  test('AC-28: --drafts and --bank can come in either order', () => {
    const dir = makeTempDir();
    write(dir, 'a/d1/1.3/bad.yaml', 'id: [unclosed\n');
    put(dir, 'b', 'd1-1.3-0001', 'pending', { status: 'draft' });

    const run = runCli(dir, ['check', '--bank', 'b', '--drafts', 'a']);

    expect(run.status).toBe(1);
    expect(run.output).toContain('a/d1/1.3/bad.yaml: invalid YAML');
    expect(run.output).toContain('b/d1/1.3/pending.yaml: ');
  });

  test('AC-28: next-id reads the overridden folders', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0009', 'default');
    put(dir, 'other-drafts', 'd1-1.3-0004', 'custom', { status: 'draft' });
    put(dir, 'other-bank', 'd1-1.3-0002', 'custom');

    const run = runCli(dir, ['next-id', '1.3', '--drafts', 'other-drafts', '--bank', 'other-bank']);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('d1-1.3-0005');
  });

  test('AC-28: promote works between the overridden folders', () => {
    const dir = makeTempDir();
    put(dir, 'in', 'd1-1.3-0001', 'ready');
    put(dir, DRAFTS, 'd1-1.3-0002', 'default-draft');

    const run = runCli(dir, ['promote', '--drafts', 'in', '--bank', 'out']);

    expect(run.status).toBe(0);
    expect(exists(dir, 'out/d1/1.3/ready.yaml')).toBe(true);
    expect(exists(dir, 'in/d1/1.3/ready.yaml')).toBe(false);
    expect(exists(dir, `${DRAFTS}/d1/1.3/default-draft.yaml`)).toBe(true);
    expect(exists(dir, `${BANK}/d1/1.3/ready.yaml`)).toBe(false);
  });
});

describe('next-id', () => {
  test('AC-29: prints only the next id, counting rejected drafts and schema-invalid files', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0003', 'draft', { status: 'draft' });
    put(dir, BANK, 'd1-1.3-0001', 'public');
    // The highest numbers sit in files that are not valid questions.
    write(dir, `${DRAFTS}/rejected/d1/1.3/old.yaml`, questionYaml({ id: 'd1-1.3-0005' }));
    write(dir, `${BANK}/d1/1.3/invalid.yaml`, 'id: d1-1.3-0008\nstem: too short\n');
    // Other tasks and a sidecar do not count.
    put(dir, DRAFTS, 'd1-1.2-0050', 'other-task', { status: 'draft' });
    write(dir, `${DRAFTS}/d1/1.3/draft.check.yaml`, 'id: d1-1.3-0090\n');

    const run = runCli(dir, ['next-id', '1.3']);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('d1-1.3-0009');
    expect(lines(run.stdout)).toHaveLength(1);
  });

  test('AC-29: both folders count, not only one of them', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd3-3.4-0002', 'in-drafts', { status: 'draft' });
    put(dir, BANK, 'd3-3.4-0006', 'in-bank');

    const run = runCli(dir, ['next-id', '3.4']);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('d3-3.4-0007');
  });

  test('AC-29: an empty task starts at 0001', () => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.2-0050', 'other');
    mkdirSync(join(dir, ...DRAFTS.split('/')), { recursive: true });

    const run = runCli(dir, ['next-id', '2.2']);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('d2-2.2-0001');
  });

  test('AC-29: missing folders still give the first id', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['next-id', '1.3']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('d1-1.3-0001');
  });

  test.each([
    ['a task that is not in the catalog', ['next-id', '9.9']],
    ['no task', ['next-id']],
  ])('AC-30: next-id with %s exits 2 with the usage text', (_name, args) => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.3-0001', 'ok');

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
  });
});

describe('promote', () => {
  /** Two reviewed drafts (one with a sidecar), as raw texts; the bank folder does not exist. */
  function setupPromote(dir: string): {
    first: { id: string; slug: string; text: string };
    second: { id: string; slug: string; text: string };
  } {
    const first = {
      id: 'd3-3.4-0002',
      slug: 's3-sse-c-keys',
      text: decorated('d3-3.4-0002', TEXT_WITH_UNICODE),
    };
    const second = {
      id: 'd1-1.3-0001',
      slug: 'cf-oac',
      text: decorated('d1-1.3-0001').replace(/\n/g, '\r\n'),
    };
    write(dir, `${DRAFTS}/d3/3.4/${first.slug}.yaml`, first.text);
    write(dir, `${DRAFTS}/d3/3.4/${first.slug}.check.yaml`, 'sidecar: private data\n');
    write(dir, `${DRAFTS}/d1/1.3/${second.slug}.yaml`, second.text);
    return { first, second };
  }

  test('AC-31: each draft is written to the bank byte for byte, folders created as needed', () => {
    const dir = makeTempDir();
    const { first, second } = setupPromote(dir);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(read(dir, `${BANK}/d3/3.4/${first.slug}.yaml`).equals(Buffer.from(first.text))).toBe(
      true,
    );
    expect(read(dir, `${BANK}/d1/1.3/${second.slug}.yaml`).equals(Buffer.from(second.text))).toBe(
      true,
    );
  });

  test('AC-31: the drafts are deleted, and the sidecar too when there is one', () => {
    const dir = makeTempDir();
    const { first, second } = setupPromote(dir);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(exists(dir, `${DRAFTS}/d3/3.4/${first.slug}.yaml`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/d3/3.4/${first.slug}.check.yaml`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/d1/1.3/${second.slug}.yaml`)).toBe(false);
  });

  test('AC-31: one line per move with the id and both paths, then a hint to review and commit questions/', () => {
    const dir = makeTempDir();
    const { first, second } = setupPromote(dir);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    for (const { id, slug } of [first, second]) {
      const domain = id.slice(1, 2);
      const task = id.slice(3, 6);
      const moveLines = lines(run.stdout).filter((line) => line.includes(id));
      expect(moveLines).toHaveLength(1);
      expect(moveLines[0]).toContain(`${DRAFTS}/d${domain}/${task}/${slug}.yaml`);
      expect(moveLines[0]).toContain(`${BANK}/d${domain}/${task}/${slug}.yaml`);
    }
    const last = lines(run.stdout).at(-1) ?? '';
    expect(last).toMatch(/review/i);
    expect(last).toMatch(/commit/i);
    expect(last).toContain('questions/');
  });

  test('AC-31: a sidecar of a draft that stays is not deleted', () => {
    const dir = makeTempDir();
    setupPromote(dir);
    put(dir, DRAFTS, 'd1-1.3-0003', 'stays', { status: 'draft' });
    write(dir, `${DRAFTS}/d1/1.3/stays.check.yaml`, 'sidecar: keep me\n');

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(read(dir, `${DRAFTS}/d1/1.3/stays.check.yaml`).toString()).toBe('sidecar: keep me\n');
    expect(exists(dir, `${DRAFTS}/d1/1.3/stays.yaml`)).toBe(true);
  });

  test('AC-31: an existing bank folder keeps its other questions', () => {
    const dir = makeTempDir();
    setupPromote(dir);
    put(dir, BANK, 'd2-2.1-0001', 'already');
    const before = read(dir, `${BANK}/d2/2.1/already.yaml`);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(read(dir, `${BANK}/d2/2.1/already.yaml`).equals(before)).toBe(true);
    expect(exists(dir, `${BANK}/d3/3.4/s3-sse-c-keys.yaml`)).toBe(true);
  });

  test('AC-32: --dry-run prints the moves and writes and deletes nothing', () => {
    const dir = makeTempDir();
    const { first, second } = setupPromote(dir);
    const before = snapshot(dir);

    const run = runCli(dir, ['promote', '--dry-run']);

    expect(run.status).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(exists(dir, BANK)).toBe(false);
    for (const { id, slug } of [first, second]) {
      const domain = id.slice(1, 2);
      const task = id.slice(3, 6);
      const moveLines = lines(run.stdout).filter((line) => line.includes(id));
      expect(moveLines).toHaveLength(1);
      expect(moveLines[0]).toContain(`${DRAFTS}/d${domain}/${task}/${slug}.yaml`);
      expect(moveLines[0]).toContain(`${BANK}/d${domain}/${task}/${slug}.yaml`);
    }
  });

  test('AC-32: --dry-run can come after ids', () => {
    const dir = makeTempDir();
    setupPromote(dir);
    const before = snapshot(dir);

    const run = runCli(dir, ['promote', 'd1-1.3-0001', '--dry-run']);

    expect(run.status).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(run.output).toContain('d1-1.3-0001');
    expect(run.output).not.toContain('d3-3.4-0002');
  });

  describe.each([
    ['--dry-run', ['promote', '--dry-run']],
    ['a real run', ['promote']],
  ])('AC-33: nothing is written or deleted with %s when', (_name, args) => {
    test('AC-33: a drafts file has a problem', () => {
      const dir = makeTempDir();
      setupPromote(dir);
      write(dir, `${DRAFTS}/d1/1.3/bad.yaml`, 'id: [unclosed\n');
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(run.output).toContain(`${DRAFTS}/d1/1.3/bad.yaml: invalid YAML`);
      expect(snapshot(dir)).toEqual(before);
    });

    test('AC-33: a bank file has a problem', () => {
      const dir = makeTempDir();
      setupPromote(dir);
      put(dir, BANK, 'd2-2.1-0001', 'pending', { status: 'draft' });
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(run.output).toContain(`${BANK}/d2/2.1/pending.yaml: `);
      expect(snapshot(dir)).toEqual(before);
    });

    test('AC-33: a reviewed draft has its id in the bank (plan error)', () => {
      const dir = makeTempDir();
      setupPromote(dir);
      put(dir, DRAFTS, 'd2-2.1-0007', 'clash');
      put(dir, BANK, 'd2-2.1-0007', 'theirs');
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(run.output).toMatch(/d2-2\.1-0007|\/d2\/2\.1\/(clash|theirs)\.yaml/);
      expect(snapshot(dir)).toEqual(before);
    });

    test('AC-33: a reviewed draft has its target path taken in the bank (plan error)', () => {
      const dir = makeTempDir();
      setupPromote(dir);
      put(dir, DRAFTS, 'd2-2.1-0007', 'same-path');
      put(dir, BANK, 'd2-2.1-0008', 'same-path');
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(run.output).toContain('d2/2.1/same-path.yaml');
      expect(snapshot(dir)).toEqual(before);
    });

    test('AC-33: a draft that is not reviewed shares its id with a bank question (check problem)', () => {
      const dir = makeTempDir();
      setupPromote(dir);
      put(dir, DRAFTS, 'd2-2.1-0007', 'wip', { status: 'draft' });
      put(dir, BANK, 'd2-2.1-0007', 'theirs');
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(1);
      expect(run.output).toMatch(/\/d2\/2\.1\/(wip|theirs)\.yaml: /);
      expect(snapshot(dir)).toEqual(before);
    });
  });

  test('AC-34: with ids, only those drafts are promoted and the others stay in place', () => {
    const dir = makeTempDir();
    const r1 = put(dir, DRAFTS, 'd1-1.3-0001', 'one');
    const r2 = put(dir, DRAFTS, 'd3-3.4-0002', 'two');
    const r3 = put(dir, DRAFTS, 'd1-1.2-0003', 'three');
    const wip = put(dir, DRAFTS, 'd2-2.1-0004', 'wip', { status: 'verified' });
    for (const [path, name] of [
      [r1, 'one'],
      [r3, 'three'],
      [wip, 'wip'],
    ] as const) {
      write(dir, `${DRAFTS}/${path.replace(`${name}.yaml`, `${name}.check.yaml`)}`, 'sidecar\n');
    }
    const draftOne = read(dir, `${DRAFTS}/${r1}`);
    const draftTwo = read(dir, `${DRAFTS}/${r2}`);
    const stay = snapshot(join(dir, DRAFTS, 'd1', '1.2'));
    const stayWip = snapshot(join(dir, DRAFTS, 'd2'));

    const run = runCli(dir, ['promote', 'd3-3.4-0002', 'd1-1.3-0001']);

    expect(run.status).toBe(0);
    expect(read(dir, `${BANK}/${r1}`).equals(draftOne)).toBe(true);
    expect(read(dir, `${BANK}/${r2}`).equals(draftTwo)).toBe(true);
    expect(exists(dir, `${DRAFTS}/${r1}`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/d1/1.3/one.check.yaml`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/${r2}`)).toBe(false);
    // Not asked for: a reviewed draft and a verified one stay, with their sidecars.
    expect(exists(dir, `${BANK}/${r3}`)).toBe(false);
    expect(exists(dir, `${BANK}/${wip}`)).toBe(false);
    expect(snapshot(join(dir, DRAFTS, 'd1', '1.2'))).toEqual(stay);
    expect(snapshot(join(dir, DRAFTS, 'd2'))).toEqual(stayWip);
    expect(run.output).not.toContain('d1-1.2-0003');
  });

  test('AC-34: an id that matches no draft exits 1 and moves nothing', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one');
    const before = snapshot(dir);

    const run = runCli(dir, ['promote', 'd1-1.3-0001', 'd1-1.3-0099']);

    expect(run.status).toBe(1);
    expect(run.output).toContain('d1-1.3-0099');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-34: asking for a draft that is not reviewed exits 1 and moves nothing', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one');
    put(dir, DRAFTS, 'd1-1.3-0002', 'wip', { status: 'draft' });
    const before = snapshot(dir);

    const run = runCli(dir, ['promote', 'd1-1.3-0001', 'd1-1.3-0002']);

    expect(run.status).toBe(1);
    expect(run.output).toMatch(/d1-1\.3-0002|wip\.yaml/);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-35: with no reviewed drafts promote prints "nothing to promote" and exits 0', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'wip', { status: 'draft' });
    put(dir, DRAFTS, 'd1-1.3-0002', 'checked', { status: 'verified' });
    const before = snapshot(dir);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('nothing to promote');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-35: a missing drafts folder also has nothing to promote', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('nothing to promote');
    expect(exists(dir, BANK)).toBe(false);
  });

  test('AC-36: promote never runs git: the index is unchanged and no commit is made', () => {
    const dir = makeTempDir();
    git(dir, ['init', '--quiet', '-b', 'main']);
    git(dir, ['config', 'user.email', 'tester@example.com']);
    git(dir, ['config', 'user.name', 'Tester']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    put(dir, DRAFTS, 'd1-1.3-0001', 'one');
    put(dir, DRAFTS, 'd3-3.4-0002', 'two');
    write(dir, 'committed.txt', 'committed\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'initial']);
    // Something unrelated is staged, so that an untouched index is not just an empty one.
    write(dir, 'staged.txt', 'staged\n');
    git(dir, ['add', 'staged.txt']);
    const indexBefore = git(dir, ['ls-files', '--stage']);
    const headBefore = git(dir, ['rev-parse', 'HEAD']);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(0);
    expect(exists(dir, `${BANK}/d1/1.3/one.yaml`)).toBe(true);
    expect(exists(dir, `${DRAFTS}/d1/1.3/one.yaml`)).toBe(false);
    expect(git(dir, ['ls-files', '--stage'])).toBe(indexBefore);
    expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('staged.txt');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(dir, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });
});

describe('usage', () => {
  test.each([
    ['an unknown command', ['frobnicate']],
    ['an unknown flag on check', ['check', '--bogus']],
    ['an unknown flag on promote', ['promote', '--bogus']],
    ['an unknown flag on next-id', ['next-id', '1.3', '--bogus']],
    ['--drafts without a value', ['check', '--drafts']],
    ['--bank without a value', ['check', '--bank']],
    ['--drafts without a value on promote', ['promote', '--drafts']],
    ['no command', []],
  ])('AC-37: %s exits 2 with the usage text', (_name, args) => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.3-0001', 'ok');

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
  });

  test('AC-37: a usage error does not touch any file', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one');
    const before = snapshot(dir);

    const run = runCli(dir, ['promote', '--bogus']);

    expect(run.status).toBe(2);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('root script', () => {
  test('AC-38: the root package.json has a questions script that runs this CLI', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    const script = manifest.scripts?.questions;

    expect(script).toMatch(/^tsx (\.\/)?tools\/questions\/src\/cli\.ts(\s|$)/);
    expect(existsSync(join(ROOT, 'tools', 'questions', 'src', 'cli.ts'))).toBe(true);
  });
});

// ---- Review round 1 regressions (AC-39 to AC-45) -------------------------------------------------

/** Like `snapshot`, but a link is recorded as a link and never followed. */
function snapshotLinks(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        tree[path] = '<link>';
      } else if (entry.isDirectory()) {
        tree[`${path}/`] = '<dir>';
        walk(path);
      } else {
        tree[path] = readFileSync(join(dir, path)).toString('hex');
      }
    }
  };
  walk('');
  return tree;
}

/** Creates a link; false when the OS refuses (for example EPERM for file links on Windows). */
function tryLink(target: string, path: string, type: 'file' | 'junction'): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe('review round 1 regressions', () => {
  test('AC-39: a copy that fails partway is rolled back: nothing moved, nothing deleted, exit 1', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'aaa');
    put(dir, DRAFTS, 'd1-1.3-0002', 'bbb');
    write(dir, `${DRAFTS}/d1/1.3/aaa.check.yaml`, 'sidecar a\n');
    write(dir, `${DRAFTS}/d1/1.3/bbb.check.yaml`, 'sidecar b\n');
    // A folder sits where the second copy must go; readBank does not see it.
    mkdirSync(join(dir, BANK, 'd1', '1.3', 'bbb.yaml'), { recursive: true });
    const before = snapshot(dir);

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(1);
    expect(run.output).not.toMatch(/\bmoved\b/i);
    expect(run.output).toContain('bbb');
    expect(snapshot(dir)).toEqual(before);
    expect(exists(dir, `${BANK}/d1/1.3/aaa.yaml`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/d1/1.3/aaa.yaml`)).toBe(true);
    expect(exists(dir, `${DRAFTS}/d1/1.3/aaa.check.yaml`)).toBe(true);
    expect(exists(dir, `${DRAFTS}/d1/1.3/bbb.yaml`)).toBe(true);
    expect(exists(dir, `${DRAFTS}/d1/1.3/bbb.check.yaml`)).toBe(true);
  });

  test('AC-39: the failure is the same when the first copy needs new folders', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'aaa');
    put(dir, DRAFTS, 'd3-3.4-0002', 'bbb');
    mkdirSync(join(dir, BANK, 'd3', '3.4', 'bbb.yaml'), { recursive: true });

    const run = runCli(dir, ['promote']);

    expect(run.status).toBe(1);
    expect(run.output).not.toMatch(/\bmoved\b/i);
    expect(exists(dir, `${BANK}/d1/1.3/aaa.yaml`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/d1/1.3/aaa.yaml`)).toBe(true);
    expect(exists(dir, `${DRAFTS}/d3/3.4/bbb.yaml`)).toBe(true);
  });

  test('AC-40: the check summary line is exactly "drafts: N, bank questions: M, problems: K"', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one', { status: 'draft' });
    put(dir, DRAFTS, 'd2-2.1-0001', 'two', { status: 'verified' });
    put(dir, DRAFTS, 'd3-3.4-0001', 'three');
    put(dir, BANK, 'd1-1.2-0001', 'four');

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(lines(run.output)).toContain('drafts: 3, bank questions: 1, problems: 0');
  });

  test('AC-40: valid entries and problems are counted separately', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one', { status: 'draft' });
    put(dir, DRAFTS, 'd2-2.1-0001', 'two');
    write(dir, `${DRAFTS}/d1/1.3/bad.yaml`, 'id: [unclosed\n');
    put(dir, BANK, 'd1-1.2-0001', 'four');
    put(dir, BANK, 'd1-1.2-0002', 'five', { status: 'draft' });

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(1);
    expect(lines(run.output)).toContain('drafts: 2, bank questions: 1, problems: 2');
  });

  test('AC-40: empty folders give zeros', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['check']);

    expect(run.status).toBe(0);
    expect(lines(run.output)).toContain('drafts: 0, bank questions: 0, problems: 0');
  });

  test.each([
    ['check -x', ['check', '-x']],
    ['check -h', ['check', '-h']],
    ['check --bogus', ['check', '--bogus']],
    ['next-id 1.3 -x', ['next-id', '1.3', '-x']],
    ['next-id 1.3 -h', ['next-id', '1.3', '-h']],
    ['next-id -x', ['next-id', '-x']],
    ['next-id 1.3 --bogus', ['next-id', '1.3', '--bogus']],
    ['promote -x', ['promote', '-x']],
    ['promote -h', ['promote', '-h']],
    ['promote --bogus', ['promote', '--bogus']],
    ['promote id -x', ['promote', 'd1-1.3-0001', '-x']],
  ])('AC-44: %s exits 2 with the usage text', (_name, args) => {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.2-0001', 'ok');

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
  });

  test('AC-44: promote with -x touches nothing', () => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd1-1.3-0001', 'one');
    write(dir, `${DRAFTS}/d1/1.3/one.check.yaml`, 'sidecar\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['promote', '-x']);

    expect(run.status).toBe(2);
    expect(snapshot(dir)).toEqual(before);
  });

  describe.each([
    ['drafts', DRAFTS],
    ['bank', BANK],
  ])('AC-45: links inside the %s folder', (_name, folder) => {
    test('AC-45: a junction to a folder is a problem naming the link, and promote writes nothing', (ctx) => {
      const dir = makeTempDir();
      put(dir, DRAFTS, 'd1-1.3-0001', 'ready');
      put(dir, 'outside', 'd1-1.3-0002', 'beyond');
      if (!tryLink(join(dir, 'outside'), join(dir, folder, 'linked-folder'), 'junction')) {
        ctx.skip();
        return;
      }
      const before = snapshotLinks(dir);

      const check = runCli(dir, ['check']);
      const promote = runCli(dir, ['promote']);

      expect(check.status).toBe(1);
      expect(check.output).toContain('linked-folder');
      expect(promote.status).toBe(1);
      expect(promote.output).toContain('linked-folder');
      expect(snapshotLinks(dir)).toEqual(before);
    });

    test('AC-45: a file symlink is a problem naming the link, and promote writes nothing', (ctx) => {
      const dir = makeTempDir();
      put(dir, DRAFTS, 'd1-1.3-0001', 'ready');
      put(dir, 'outside', 'd1-1.3-0002', 'beyond');
      const target = join(dir, 'outside', 'd1', '1.3', 'beyond.yaml');
      if (!tryLink(target, join(dir, folder, 'd1', '1.3', 'linked-file.yaml'), 'file')) {
        ctx.skip();
        return;
      }
      const before = snapshotLinks(dir);

      const check = runCli(dir, ['check']);
      const promote = runCli(dir, ['promote']);

      expect(check.status).toBe(1);
      expect(check.output).toContain('linked-file.yaml');
      expect(promote.status).toBe(1);
      expect(promote.output).toContain('linked-file.yaml');
      expect(snapshotLinks(dir)).toEqual(before);
    });
  });
});

describe('review round 2 regressions', () => {
  test.for<[string, string]>([
    ['drafts', `${DRAFTS}/rejected`],
    ['bank', `${BANK}/linked-folder`],
  ])(
    'AC-46: next-id refuses to allocate when a junction sits in the %s folder',
    ([, linkPath], ctx) => {
      const dir = makeTempDir();
      put(dir, DRAFTS, 'd1-1.3-0007', 'real', { status: 'draft' });
      // The linked folder holds the highest id, which next-id must not silently miss.
      put(dir, 'outside', 'd1-1.3-0042', 'hidden');
      if (!tryLink(join(dir, 'outside'), join(dir, ...linkPath.split('/')), 'junction')) {
        ctx.skip();
        return;
      }
      const before = snapshotLinks(dir);

      const run = runCli(dir, ['next-id', '1.3']);

      expect(run.status).toBe(1);
      expect(run.stdout).not.toMatch(/d\d-\d\.\d-\d{4}/);
      expect(run.output).toContain(linkPath.split('/').at(-1));
      expect(snapshotLinks(dir)).toEqual(before);
    },
  );

  test('AC-47: a junction at d1 is a problem and the valid question behind it is neither counted nor promoted', (ctx) => {
    const dir = makeTempDir();
    put(dir, DRAFTS, 'd3-3.4-0001', 'real');
    // Followed through the link, this would be the valid, reviewed d1/1.3/ready.yaml.
    write(dir, 'elsewhere/1.3/ready.yaml', questionYaml({ id: 'd1-1.3-0042' }));
    if (!tryLink(join(dir, 'elsewhere'), join(dir, ...`${DRAFTS}/d1`.split('/')), 'junction')) {
      ctx.skip();
      return;
    }
    const before = snapshotLinks(dir);

    const check = runCli(dir, ['check']);
    const promote = runCli(dir, ['promote']);

    expect(check.status).toBe(1);
    expect(check.output).toContain(`${DRAFTS}/d1`);
    expect(lines(check.output)).toContainEqual(
      expect.stringMatching(/^drafts: 1, bank questions: 0, problems: [1-9]\d*$/),
    );
    expect(promote.status).toBe(1);
    expect(exists(dir, `${BANK}/d1/1.3/ready.yaml`)).toBe(false);
    expect(exists(dir, 'elsewhere/1.3/ready.yaml')).toBe(true);
    expect(snapshotLinks(dir)).toEqual(before);
  });
});
