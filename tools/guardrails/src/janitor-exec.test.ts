import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { runProgram } from './janitor-exec.ts';

// Spec 043, AC-39: runProgram runs `aws` and `gh` for the janitor and always resolves.
// No real `aws` or `gh` can run here: PATH is replaced by one folder that holds a stand-in `aws`.
// The stand-in is a copy of the running Node binary, named `aws` (plus `.exe` on Windows), so it
// is a real executable on every platform. Its first argument is the script it runs.
vi.setConfig({ testTimeout: 60_000 });

const STUB_SCRIPT = [
  'const [mode, text] = process.argv.slice(2);',
  "if (mode === 'echo-stdin') {",
  "  let data = '';",
  "  process.stdin.setEncoding('utf8');",
  "  process.stdin.on('data', (chunk) => { data += chunk; });",
  "  process.stdin.on('end', () => { process.stdout.write(data); });",
  "} else if (mode === 'fail') {",
  "  process.stdout.write(text ?? '');",
  "  process.stderr.write('STDERR-SECRET');",
  '  process.exitCode = 3;',
  "} else if (mode === 'ok') {",
  "  process.stdout.write(text ?? '');",
  "  process.stderr.write('STDERR-SECRET');",
  '}',
  '',
].join('\n');

let stubDir = '';
let script = '';
let savedPath: string | undefined;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'janitor-exec-'));
  copyFileSync(process.execPath, join(stubDir, process.platform === 'win32' ? 'aws.exe' : 'aws'));
  script = join(stubDir, 'stub.mjs');
  writeFileSync(script, STUB_SCRIPT);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

// The guard: from here on the only folder on PATH is the stub folder, so `gh` cannot be found and
// the real `aws` can never be reached.
beforeEach(() => {
  savedPath = process.env['PATH'];
  process.env['PATH'] = stubDir;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
});

describe('AC-39: runProgram always resolves', () => {
  test('AC-39: an argument holding a NUL resolves code 1 with empty stdout', async () => {
    await expect(runProgram('aws', ['a\0b'])).resolves.toEqual({ code: 1, stdout: '' });
  });

  test('AC-39: a program that cannot be started resolves code 1 with empty stdout', async () => {
    // `gh` is not in the guarded PATH.
    await expect(runProgram('gh', ['issue', 'list'])).resolves.toEqual({ code: 1, stdout: '' });
  });

  test('AC-39: a child that exits non-zero gives its code and its stdout', async () => {
    await expect(runProgram('aws', [script, 'fail', 'partial'])).resolves.toEqual({
      code: 3,
      stdout: 'partial',
    });
  });

  test('AC-39: a child that exits 0 gives code 0 and its stdout', async () => {
    await expect(runProgram('aws', [script, 'ok', 'fine'])).resolves.toEqual({
      code: 0,
      stdout: 'fine',
    });
  });

  test('AC-39: the child stderr is discarded', async () => {
    const failed = await runProgram('aws', [script, 'fail', 'partial']);
    const fine = await runProgram('aws', [script, 'ok', 'fine']);
    expect(Object.keys(failed).sort()).toEqual(['code', 'stdout']);
    expect(failed.stdout).not.toContain('STDERR-SECRET');
    expect(fine.stdout).not.toContain('STDERR-SECRET');
  });

  test('AC-39: input reaches the child on stdin', async () => {
    await expect(
      runProgram('aws', [script, 'echo-stdin'], 'the body\nline two\n'),
    ).resolves.toEqual({
      code: 0,
      stdout: 'the body\nline two\n',
    });
  });
});
