import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 046 (issue #143), AC-15 to AC-18: labs/05-sqs-lambda-dlq/src/handler.py.
//
// The handler is run for real with `python3 -I` (isolated mode), or `python -I` when python3 is not on
// PATH; the tests fail, they never skip, when neither exists. A small driver, passed with -c, loads the
// file by path (so nothing is imported from the current directory), calls handler(event, None) and
// prints the result as JSON on the line after a sentinel line. What the handler printed comes before the
// sentinel, so the two are told apart.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB_DIR = join(REPO_ROOT, 'labs', '05-sqs-lambda-dlq');
const HANDLER_RELATIVE = 'src/handler.py';
const HANDLER = join(LAB_DIR, 'src', 'handler.py');

const SENTINEL = '--- handler result ---';

// One line, single quotes only: on Windows python3 is a shim that goes through a batch file, which
// cuts an argument at its first line end.
const DRIVER = [
  'import importlib.util, json, sys',
  "spec = importlib.util.spec_from_file_location('lab05_handler', sys.argv[1])",
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  'event = json.load(sys.stdin)',
  'result = module.handler(event, None)',
  'sys.stdout.flush()',
  `print('${SENTINEL}')`,
  'print(json.dumps(result))',
].join('; ');

let pythonCache: string | undefined;

/**
 * The Python that runs the tests: python3, else python; a failure when neither works. Both are looked
 * up by bash: on Windows they are shims (batch files and bash scripts) that Node cannot spawn itself.
 */
function python(): string {
  if (pythonCache !== undefined) return pythonCache;
  const probe = spawnSync(
    'bash',
    [
      '-c',
      'for name in python3 python; do if "$name" -I -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >/dev/null 2>&1; then echo "$name"; exit 0; fi; done; exit 1',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const name = probe.stdout.trim();
  if (probe.status !== 0 || name === '') {
    throw new Error('neither python3 nor python (3.10 or newer) works on PATH');
  }
  pythonCache = name;
  return name;
}

interface Run {
  /** What the handler printed, line by line. */
  stdout: string[];
  /** What the handler returned, parsed. */
  result: unknown;
}

function runHandler(event: unknown): Run {
  if (!existsSync(HANDLER)) throw new Error('missing file: labs/05-sqs-lambda-dlq/src/handler.py');
  // Run from the lab folder with a relative path: no absolute path reaches the shell.
  const done = spawnSync(
    'bash',
    ['-c', 'exec "$0" "$@"', python(), '-I', '-c', DRIVER, HANDLER_RELATIVE],
    { cwd: LAB_DIR, input: JSON.stringify(event), encoding: 'utf8', windowsHide: true },
  );
  expect(done.status, `python exited with ${String(done.status)}: ${done.stderr}`).toBe(0);
  const lines = done.stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const at = lines.lastIndexOf(SENTINEL);
  expect(at, `no result after the sentinel; stdout: ${done.stdout}`).toBeGreaterThanOrEqual(0);
  return { stdout: lines.slice(0, at), result: JSON.parse(lines[at + 1] ?? 'null') };
}

const record = (messageId: string, body: string): { messageId: string; body: string } => ({
  messageId,
  body,
});

const failure = (messageId: string): { itemIdentifier: string } => ({ itemIdentifier: messageId });

// =================================================================================================
// AC-15: a good order, a poison message and a good order
// =================================================================================================

describe('AC-15: partial batch response', () => {
  const POISON_ID = '059f36b4-87a3-44ab-83d2-661975830a7d';
  const event = {
    Records: [
      record('2e1424d4-f796-459a-8184-9c92662be6da', '{"order_id":"o-1"}'),
      record(POISON_ID, 'not an order'),
      record('c2c0f1d4-8b8e-4f0e-9a38-0d6cbb8ab2f1', '{"order_id":"o-2"}'),
    ],
  };

  test('AC-15: the result lists only the poison message', () => {
    expect(runHandler(event).result).toEqual({ batchItemFailures: [failure(POISON_ID)] });
  });

  test('AC-15: stdout is processed, failed, processed, one line per record in order', () => {
    expect(runHandler(event).stdout).toEqual([
      'processed order o-1',
      `failed message ${POISON_ID}`,
      'processed order o-2',
    ]);
  });

  test('AC-15: a batch of good orders only returns an empty failure list', () => {
    const run = runHandler({
      Records: [record('m-1', '{"order_id":"a"}'), record('m-2', '{"order_id":"b"}')],
    });
    expect(run.result).toEqual({ batchItemFailures: [] });
    expect(run.stdout).toEqual(['processed order a', 'processed order b']);
  });

  test('AC-15: a good order with more keys is still a good order', () => {
    const run = runHandler({
      Records: [record('m-1', '{"order_id":"o-9","items":[1,2],"note":null}')],
    });
    expect(run.result).toEqual({ batchItemFailures: [] });
    expect(run.stdout).toEqual(['processed order o-9']);
  });

  test('AC-15: a batch of poison messages only returns every ID, in order', () => {
    const run = runHandler({
      Records: [record('m-3', 'nope'), record('m-1', '{"order_id":"o-1"}'), record('m-2', 'nah')],
    });
    expect(run.result).toEqual({ batchItemFailures: [failure('m-3'), failure('m-2')] });
    expect(run.stdout).toEqual(['failed message m-3', 'processed order o-1', 'failed message m-2']);
  });
});

// =================================================================================================
// AC-16: bad bodies
// =================================================================================================

describe('AC-16: every bad body is a failure and nothing raises', () => {
  const BAD_BODIES: [string, string][] = [
    ['an empty list', '[]'],
    ['a JSON string', '"o-1"'],
    ['an empty object', '{}'],
    ['an empty order_id', '{"order_id":""}'],
    ['a number as order_id', '{"order_id":7}'],
    ['a null order_id', '{"order_id":null}'],
    ['a different key', '{"orderId":"o-1"}'],
    ['an empty string', ''],
    ['a lone brace', '{'],
    ['a boolean order_id', '{"order_id":true}'],
    ['a list as order_id', '{"order_id":["o-1"]}'],
    ['an object as order_id', '{"order_id":{"id":"o-1"}}'],
    ['a list holding an order', '[{"order_id":"o-1"}]'],
    ['a JSON number', '42'],
    ['a JSON null', 'null'],
    ['plain text', 'order o-1'],
  ];

  test.each(BAD_BODIES)('AC-16: %s is a failure with its message ID', (_name, body) => {
    const run = runHandler({ Records: [record('bad-1', body)] });
    expect(run.result).toEqual({ batchItemFailures: [failure('bad-1')] });
    expect(run.stdout).toEqual(['failed message bad-1']);
  });

  test('AC-16: all the bad bodies in one batch fail in record order, with one line each', () => {
    const records = BAD_BODIES.map(([, body], index) => record(`bad-${index}`, body));
    const run = runHandler({ Records: records });
    expect(run.result).toEqual({
      batchItemFailures: records.map((entry) => failure(entry.messageId)),
    });
    expect(run.stdout).toEqual(records.map((entry) => `failed message ${entry.messageId}`));
  });

  test('AC-16: a non-empty order_id is a good order, even when it is only a space', () => {
    const run = runHandler({ Records: [record('m-1', '{"order_id":" "}')] });
    expect(run.result).toEqual({ batchItemFailures: [] });
    expect(run.stdout).toEqual(['processed order  ']);
  });

  test('AC-16: bad and good bodies mixed keep the record order of the failures', () => {
    const run = runHandler({
      Records: [
        record('m-1', '{'),
        record('m-2', '{"order_id":"ok"}'),
        record('m-3', '{"order_id":""}'),
        record('m-4', '{"order_id":"ok2"}'),
        record('m-5', '[]'),
      ],
    });
    expect(run.result).toEqual({
      batchItemFailures: [failure('m-1'), failure('m-3'), failure('m-5')],
    });
    expect(run.stdout).toEqual([
      'failed message m-1',
      'processed order ok',
      'failed message m-3',
      'processed order ok2',
      'failed message m-5',
    ]);
  });
});

// =================================================================================================
// AC-17: no records
// =================================================================================================

describe('AC-17: no records', () => {
  test.each([
    ['an empty Records list', { Records: [] }],
    ['an event without Records', {}],
  ])('AC-17: %s returns an empty failure list and prints nothing', (_name, event) => {
    const run = runHandler(event);
    expect(run.result).toEqual({ batchItemFailures: [] });
    expect(run.stdout).toEqual([]);
  });
});

// =================================================================================================
// AC-18: the text of handler.py
// =================================================================================================

/** The Python text without comments and without triple-quoted strings. */
function code(text: string): string {
  return text
    .replace(/("""|''')[\s\S]*?\1/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

describe('AC-18: the text of handler.py', () => {
  const source = (): string => {
    if (!existsSync(HANDLER))
      throw new Error('missing file: labs/05-sqs-lambda-dlq/src/handler.py');
    return readFileSync(HANDLER, 'utf8');
  };

  test('AC-18: its import lines are exactly "import json"', () => {
    const imports = code(source())
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(import|from)\s/.test(line));
    expect(imports).toEqual(['import json']);
  });

  test('AC-18: it defines handler(event, context)', () => {
    expect(code(source())).toMatch(/^def handler\(\s*event\s*,\s*context\s*\)\s*(->\s*[^:]+)?:/m);
  });

  test('AC-18: it contains no raise', () => {
    expect(code(source())).not.toMatch(/\braise\b/);
  });
});
