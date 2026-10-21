import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';

// Spec 034, section 4: Zod must not probe `Function('')` (a CSP violation) once the schema package
// is loaded. AC-18 runs in spawned Node processes so the Zod module graph is fresh each time.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SRC = import.meta.dirname;
const REPO_ROOT = resolve(SRC, '..', '..', '..');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

describe('the schema package entry point', () => {
  test('AC-17: after importing @field-guide/schema, z.config().jitless is true', async () => {
    // The package entry point (exports "." of @field-guide/schema is ./src/index.ts).
    await import('./index.ts');

    expect(z.config().jitless).toBe(true);
  });

  test('AC-17: the first import declaration of index.ts is ./zod-config.ts', () => {
    const source = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const firstImport = /^import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/m.exec(source);

    expect(firstImport?.[1]).toBe('./zod-config.ts');
  });
});

// ---------------------------------------------------------------------------
// AC-18: spawned processes with a Function spy that throws, as a CSP without 'unsafe-eval' does.
// ---------------------------------------------------------------------------

/** Runs first in each process: records every call to the Function constructor and throws. */
const SPY_SCRIPT = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const calls = [];
const RealFunction = globalThis.Function;
function record(args) {
  calls.push(args.map(String));
  throw new Error('Function() blocked, like a CSP without unsafe-eval');
}
globalThis.Function = new Proxy(RealFunction, {
  construct(_target, args) {
    return record(args);
  },
  apply(_target, _this, args) {
    return record(args);
  },
});

const [, , mode, payloadFile] = process.argv;
const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
const files = payload.files;

let questionSchema;
let diagramSchema;
if (mode === 'control') {
  // The modules directly: nothing configures Zod.
  ({ questionSchema } = await import(pathToFileURL(files.question).href));
  ({ diagramSchema } = await import(pathToFileURL(files.diagram).href));
} else {
  // The package entry point.
  ({ questionSchema, diagramSchema } = await import(pathToFileURL(files.index).href));
}

function summarise(schema, data) {
  const result = schema.safeParse(data);
  return {
    success: result.success,
    paths: result.success ? [] : result.error.issues.map((issue) => issue.path.join('.')),
  };
}

const outcome = {
  validQuestion: summarise(questionSchema, payload.validQuestion),
  invalidQuestion: summarise(questionSchema, payload.invalidQuestion),
  validDiagram: summarise(diagramSchema, payload.validDiagram),
  invalidDiagram: summarise(diagramSchema, payload.invalidDiagram),
};
process.stdout.write('RESULT ' + JSON.stringify({ calls, outcome }) + '\\n');
`;

interface Summary {
  success: boolean;
  paths: string[];
}

interface Probe {
  calls: string[][];
  outcome: {
    validQuestion: Summary;
    invalidQuestion: Summary;
    validDiagram: Summary;
    invalidDiagram: Summary;
  };
}

// A valid question (the example of PLAN.md section 5.2) and its invalid variant.
const validQuestion = {
  id: 'd1-1.3-0007',
  domain: 1,
  task: '1.3',
  services: ['s3', 'kms'],
  difficulty: 'medium',
  type: 'single',
  stem: 'A company must encrypt objects in Amazon S3 at rest and keep the keys on-premises. Which option meets these requirements?\n',
  options: [
    { key: 'A', text: 'SSE-S3', correct: false, why: 'AWS creates, owns and stores the keys.' },
    { key: 'B', text: 'SSE-KMS', correct: false, why: 'The KMS key is stored in AWS KMS.' },
    { key: 'C', text: 'SSE-C', correct: true, why: 'The key is sent with each request.' },
    {
      key: 'D',
      text: 'Client-side',
      correct: false,
      why: 'Encryption would happen before the upload.',
    },
  ],
  cue: 'Encryption in S3 + keys never stored in AWS → SSE-C',
  references: [
    'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html',
  ],
  links: { guide: '/d1/1-3-data-security/s3-encryption', diagram: 's3-sse-kms-upload' },
  status: 'reviewed',
  provenance: { generated_by: 'claude', verified_by: 'claude', reviewed_by: 'DavidSanSan110' },
};
const invalidQuestion = { ...validQuestion, domain: 9, options: [], status: 'published' };

let tempDir = '';
let control: Probe;
let main: Probe;

function runProbe(mode: 'control' | 'main', payloadFile: string, scriptFile: string): Probe {
  const result = spawnSync(process.execPath, [TSX_CLI, scriptFile, mode, payloadFile], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
  if (line === undefined) {
    throw new Error(
      `the ${mode} process printed no result (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(line.slice('RESULT '.length)) as Probe;
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'zod-config-'));
  const diagram: unknown = parse(
    readFileSync(join(REPO_ROOT, 'diagrams', 's3-sse-kms-upload.yaml'), 'utf8'),
  );
  const payloadFile = join(tempDir, 'payload.json');
  writeFileSync(
    payloadFile,
    JSON.stringify({
      files: {
        question: join(SRC, 'question.ts'),
        diagram: join(SRC, 'diagram.ts'),
        index: join(SRC, 'index.ts'),
      },
      validQuestion,
      invalidQuestion,
      validDiagram: diagram,
      invalidDiagram: { ...(diagram as object), nodes: [], bogus: true },
    }),
  );
  const scriptFile = join(tempDir, 'probe.mjs');
  writeFileSync(scriptFile, SPY_SCRIPT);
  control = runProbe('control', payloadFile, scriptFile);
  main = runProbe('main', payloadFile, scriptFile);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Zod in a process where Function() throws', () => {
  test('AC-18: control: importing question.ts directly (no config) calls the Function spy', () => {
    expect(control.calls.length).toBeGreaterThan(0);
  });

  test('AC-18: control: the schemas still validate (the probe falls back)', () => {
    expect(control.outcome.validQuestion.success).toBe(true);
    expect(control.outcome.invalidQuestion.success).toBe(false);
    expect(control.outcome.validDiagram.success).toBe(true);
    expect(control.outcome.invalidDiagram.success).toBe(false);
  });

  test('AC-18: importing @field-guide/schema never calls the Function spy', () => {
    expect(main.calls).toEqual([]);
  });

  test('AC-18: a valid question and a valid diagram parse successfully', () => {
    expect(main.outcome.validQuestion.success).toBe(true);
    expect(main.outcome.validDiagram.success).toBe(true);
  });

  test('AC-18: an invalid question and an invalid diagram fail', () => {
    expect(main.outcome.invalidQuestion.success).toBe(false);
    expect(main.outcome.invalidDiagram.success).toBe(false);
  });

  test('AC-18: the invalid question fails with the same issue paths as in the control process', () => {
    expect(main.outcome.invalidQuestion.paths.length).toBeGreaterThan(0);
    expect(main.outcome.invalidQuestion.paths).toEqual(control.outcome.invalidQuestion.paths);
  });

  test('AC-18: the invalid diagram fails with the same issue paths as in the control process', () => {
    expect(main.outcome.invalidDiagram.paths.length).toBeGreaterThan(0);
    expect(main.outcome.invalidDiagram.paths).toEqual(control.outcome.invalidDiagram.paths);
  });
});
