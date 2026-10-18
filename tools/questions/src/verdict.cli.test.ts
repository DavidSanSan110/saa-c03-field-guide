import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { variant } from './__mocks__/dedupe-fixtures.ts';
import {
  BANK,
  DRAFTS,
  cleanTempDirs,
  escapeRe,
  exists,
  lines,
  makeTempDir,
  put,
  read,
  readText,
  runCli,
  sidecarOf,
  snapshot,
  write,
} from './__mocks__/cli-harness.ts';
import type { Run } from './__mocks__/cli-harness.ts';
import { stubFetch } from './__mocks__/fetch-stub-env.ts';
import { makeQuestion } from './__mocks__/fixtures.ts';
import type { Raw } from './__mocks__/fixtures.ts';
import { DOCS_URL, digestOf, resultsYaml } from './__mocks__/verify-fixtures.ts';
import type { ResultEntry } from './__mocks__/verify-fixtures.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

const QUOTE = 'The caller sends the key with each request.';
const RESULTS = 'results.yaml';

interface Draft {
  id: string;
  /** The path inside the drafts folder. */
  path: string;
  /** The question as the file holds it. */
  question: Raw;
}

/** A draft of the given group (see `variant`): single answer, the key is C, status draft. */
function putDraft(
  dir: string,
  id: string,
  slug: string,
  group: string,
  folder = DRAFTS,
  overrides: Raw = {},
): Draft {
  const fields = { ...variant(group, 'a'), status: 'draft', ...overrides };
  const path = put(dir, folder, id, slug, fields);
  return { id, path, question: makeQuestion({ id, ...fields }) };
}

interface Seeded {
  first: Draft;
  second: Draft;
  third: Draft;
}

/** Three drafts whose ids sort differently from their paths: first = 0001 (zzz), third = 0003 (aaa). */
function seed(dir: string, folder = DRAFTS): Seeded {
  const third = putDraft(dir, 'd1-1.3-0003', 'aaa-third-id', 'alpha', folder);
  const first = putDraft(dir, 'd1-1.3-0001', 'zzz-first-id', 'bravo', folder);
  const second = putDraft(dir, 'd1-1.3-0002', 'mmm-second-id', 'charlie', folder);
  return { first, second, third };
}

/** A correct result for a draft (answer C, a quote and a docs source). */
function good(draft: Draft, extra: ResultEntry = {}): ResultEntry {
  return { id: draft.id, answer: ['C'], quote: QUOTE, source: DOCS_URL, ...extra };
}

function writeResults(dir: string, results: ResultEntry[], name = RESULTS): void {
  write(dir, name, resultsYaml(results));
}

interface Entry {
  result: string;
  id: string;
  path: string;
  reasons: string[];
}

/** The result lines and their `  - reason` lines in the output. */
function entriesOf(run: Run): Entry[] {
  const entries: Entry[] = [];
  for (const line of run.output.split(/\r?\n/)) {
    const match = /^(verified|mismatch|unsupported) (\S+) (\S+)$/.exec(line);
    if (match !== null) {
      entries.push({
        result: match[1] ?? '',
        id: match[2] ?? '',
        path: match[3] ?? '',
        reasons: [],
      });
      continue;
    }
    const reason = /^ {2}- (.+)$/.exec(line);
    if (reason !== null) entries.at(-1)?.reasons.push(reason[1] ?? '');
  }
  return entries;
}

/** `<drafts>/<path>` as printed: the folder as given, or the literal `drafts`. */
function printedPath(path: string, folder = DRAFTS): RegExp {
  return new RegExp(`^(?:drafts|${escapeRe(folder)})/${escapeRe(path)}$`);
}

function summaryOf(verified: number, mismatch: number, unsupported: number): string {
  return `verified: ${String(verified)}, mismatch: ${String(mismatch)}, unsupported: ${String(unsupported)}`;
}

/** The `verification` value of a draft's sidecar. */
function verificationOf(dir: string, draft: Draft, folder = DRAFTS): Record<string, unknown> {
  const path = `${folder}/${sidecarOf(draft.path)}`;
  expect(exists(dir, path), `no sidecar at ${path}`).toBe(true);
  const sidecar = parse(readText(dir, path)) as {
    verification: Record<string, unknown>;
  };
  return sidecar.verification;
}

/** The files that are drafts or bank questions (not sidecars), as hex bytes. */
function questionFiles(dir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(dir)).filter(
      ([path]) => /\.yaml$/.test(path) && !path.endsWith('.check.yaml') && path !== RESULTS,
    ),
  );
}

const VERDICT = ['verdict', RESULTS, '--no-fetch'];

describe('verdict report', () => {
  test('AC-25: one line per result in id order with the result, the id and the draft path', () => {
    const dir = makeTempDir();
    const { first, second, third } = seed(dir);
    // The sheet follows neither the id order nor the path order.
    writeResults(dir, [
      good(second),
      good(third, { answer: ['A'] }),
      { id: first.id, answer: ['C'] },
    ]);

    const run = runCli(dir, VERDICT);

    expect(run.status).toBe(1);
    const entries = entriesOf(run);
    expect(entries.map((entry) => `${entry.result} ${entry.id}`)).toEqual([
      'unsupported d1-1.3-0001',
      'verified d1-1.3-0002',
      'mismatch d1-1.3-0003',
    ]);
    expect(entries[0]?.path).toMatch(printedPath('d1/1.3/zzz-first-id.yaml'));
    expect(entries[1]?.path).toMatch(printedPath('d1/1.3/mmm-second-id.yaml'));
    expect(entries[2]?.path).toMatch(printedPath('d1/1.3/aaa-third-id.yaml'));
  });

  test('AC-25: flagged results get at least one reason line, verified ones get none', () => {
    const dir = makeTempDir();
    const { first, second, third } = seed(dir);
    writeResults(dir, [
      good(second),
      good(third, { answer: ['A'] }),
      { id: first.id, answer: ['C'] },
    ]);

    const entries = entriesOf(runCli(dir, VERDICT));

    expect(entries.map((entry) => entry.reasons.length > 0)).toEqual([true, false, true]);
  });

  test('AC-25: ends with the summary line and exits 1 when something is flagged', () => {
    const dir = makeTempDir();
    const { first, second, third } = seed(dir);
    writeResults(dir, [
      good(second),
      good(third, { answer: ['A'] }),
      { id: first.id, answer: ['C'] },
    ]);

    const run = runCli(dir, VERDICT);

    expect(run.status).toBe(1);
    expect(lines(run.stdout).at(-1)).toBe(summaryOf(1, 1, 1));
  });

  test('AC-25: exits 0 when every result is verified', () => {
    const dir = makeTempDir();
    const { first, second, third } = seed(dir);
    writeResults(dir, [good(third), good(first), good(second)]);

    const run = runCli(dir, VERDICT);

    expect(run.status).toBe(0);
    expect(entriesOf(run).map((entry) => entry.result)).toEqual([
      'verified',
      'verified',
      'verified',
    ]);
    expect(entriesOf(run).flatMap((entry) => entry.reasons)).toEqual([]);
    expect(lines(run.stdout).at(-1)).toBe(summaryOf(3, 0, 0));
  });

  test('AC-25: lower-case answer keys are accepted', () => {
    const dir = makeTempDir();
    const { first } = seed(dir);
    writeResults(dir, [good(first, { answer: ['c'] })]);

    const run = runCli(dir, VERDICT);

    expect(run.status).toBe(0);
    expect(lines(run.stdout).at(-1)).toBe(summaryOf(1, 0, 0));
  });

  test('AC-25: drafts without a result get no sidecar', () => {
    const dir = makeTempDir();
    const { second } = seed(dir);
    writeResults(dir, [good(second)]);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(0);
    expect(entriesOf(run).map((entry) => entry.id)).toEqual(['d1-1.3-0002']);
    expect(exists(dir, `${DRAFTS}/d1/1.3/mmm-second-id.check.yaml`)).toBe(true);
    expect(exists(dir, `${DRAFTS}/d1/1.3/zzz-first-id.check.yaml`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/d1/1.3/aaa-third-id.check.yaml`)).toBe(false);
  });

  test('AC-25: without --write no file is created or changed', () => {
    const dir = makeTempDir();
    const { first, second, third } = seed(dir);
    write(dir, `${DRAFTS}/${sidecarOf(second.path)}`, 'keep: me\n');
    writeResults(dir, [good(second), good(third, { answer: ['A'] }), { id: first.id, answer: [] }]);
    const before = snapshot(dir);

    const run = runCli(dir, VERDICT);

    expect(run.status).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('verdict --write', () => {
  /** Unsupported (no quote), verified (with notes, lower-case answer) and mismatch (B, a). */
  function mixed(dir: string): Seeded {
    const seeded = seed(dir);
    writeResults(dir, [
      { id: seeded.first.id, answer: ['C'] },
      good(seeded.second, { answer: ['c'], notes: 'A remark.' }),
      good(seeded.third, { answer: ['B', 'a'] }),
    ]);
    return seeded;
  }

  test('AC-26: a verified result is written with exactly the described fields', () => {
    const dir = makeTempDir();
    const { second } = mixed(dir);

    runCli(dir, [...VERDICT, '--write']);

    expect(verificationOf(dir, second)).toEqual({
      result: 'verified',
      reasons: [],
      verifier: 'claude-opus',
      answer: ['C'],
      key: ['C'],
      quote: QUOTE,
      source: DOCS_URL,
      quote_check: 'skipped',
      notes: 'A remark.',
      digest: digestOf(second.question),
    });
  });

  test('AC-26: a mismatch has the sorted answer and key, a reason, and no notes key', () => {
    const dir = makeTempDir();
    const { third } = mixed(dir);

    runCli(dir, [...VERDICT, '--write']);

    const value = verificationOf(dir, third);
    expect(value.result).toBe('mismatch');
    expect(value.answer).toEqual(['A', 'B']);
    expect(value.key).toEqual(['C']);
    expect(value.reasons).toEqual([expect.any(String)]);
    expect(value.quote).toBe(QUOTE);
    expect(value.source).toBe(DOCS_URL);
    expect(value.digest).toBe(digestOf(third.question));
    expect(Object.keys(value).sort()).toEqual([
      'answer',
      'digest',
      'key',
      'quote',
      'quote_check',
      'reasons',
      'result',
      'source',
      'verifier',
    ]);
  });

  test('AC-26: an unsupported result has empty quote and source and a reason', () => {
    const dir = makeTempDir();
    const { first } = mixed(dir);

    runCli(dir, [...VERDICT, '--write']);

    const value = verificationOf(dir, first);
    expect(value.result).toBe('unsupported');
    expect(value.answer).toEqual(['C']);
    expect(value.key).toEqual(['C']);
    expect(value.quote).toBe('');
    expect(value.source).toBe('');
    expect(value.quote_check).toMatch(/^(?:skipped|none)$/);
    expect((value.reasons as string[]).length).toBeGreaterThan(0);
    expect(value.verifier).toBe('claude-opus');
    expect(value.digest).toBe(digestOf(first.question));
    expect('notes' in value).toBe(false);
  });

  test('AC-26: the answer and the key of a multiple-answer question are sorted', () => {
    const dir = makeTempDir();
    const options = ['A', 'B', 'C', 'D', 'E'].map((key) => ({
      key,
      text: `multi option ${key}`,
      correct: key === 'D' || key === 'A',
      why: `Because ${key}.`,
    }));
    const multiple = putDraft(dir, 'd1-1.3-0004', 'multi', 'delta', DRAFTS, {
      type: 'multiple',
      stem: 'Which two options meet the requirements of the workload? Choose two.',
      options,
    });
    writeResults(dir, [good(multiple, { answer: ['d', 'a'] })]);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(0);
    const value = verificationOf(dir, multiple);
    expect(value.result).toBe('verified');
    expect(value.answer).toEqual(['A', 'D']);
    expect(value.key).toEqual(['A', 'D']);
    expect(value.digest).toBe(digestOf(multiple.question));
  });

  test('AC-26: the verifier name comes from the results file', () => {
    const dir = makeTempDir();
    const { first } = seed(dir);
    write(dir, RESULTS, resultsYaml([good(first)], { verifier: 'claude-opus-5' }));

    runCli(dir, [...VERDICT, '--write']);

    expect(verificationOf(dir, first).verifier).toBe('claude-opus-5');
  });

  test('AC-26: a new sidecar is block style: no flow mapping', () => {
    const dir = makeTempDir();
    const { second } = mixed(dir);

    runCli(dir, [...VERDICT, '--write']);

    expect(readText(dir, `${DRAFTS}/${sidecarOf(second.path)}`)).not.toContain('{');
  });

  test('AC-26: an existing dedupe key and the comments of the sidecar stay as they were', () => {
    const dir = makeTempDir();
    const { second } = mixed(dir);
    const before =
      '# kept comment\ndedupe: { threshold: 0.5, similar: [] }   # inline note\nzeta: 1\n';
    write(dir, `${DRAFTS}/${sidecarOf(second.path)}`, before);

    runCli(dir, [...VERDICT, '--write']);

    const after = readText(dir, `${DRAFTS}/${sidecarOf(second.path)}`);
    expect(after.startsWith(before)).toBe(true);
    expect(parse(after)).toMatchObject({
      dedupe: { threshold: 0.5, similar: [] },
      zeta: 1,
      verification: { result: 'verified' },
    });
  });

  test('AC-26: an existing verification key is replaced, the other keys are kept', () => {
    const dir = makeTempDir();
    const { second } = mixed(dir);
    const before = 'a: 1\nverification:\n  result: mismatch\n  stale: true\nz: 2\n';
    write(dir, `${DRAFTS}/${sidecarOf(second.path)}`, before);

    runCli(dir, [...VERDICT, '--write']);

    const after = readText(dir, `${DRAFTS}/${sidecarOf(second.path)}`);
    expect(after.match(/^verification:/gm)).toHaveLength(1);
    const value = parse(after) as Record<string, unknown>;
    expect(value.a).toBe(1);
    expect(value.z).toBe(2);
    expect((value.verification as Record<string, unknown>).result).toBe('verified');
    expect((value.verification as Record<string, unknown>).stale).toBeUndefined();
  });

  test('AC-26: the draft files are byte for byte unchanged and keep status draft', () => {
    const dir = makeTempDir();
    const { first, second, third } = mixed(dir);
    const before = questionFiles(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(exists(dir, `${DRAFTS}/${sidecarOf(first.path)}`)).toBe(true);
    expect(questionFiles(dir)).toEqual(before);
    for (const draft of [first, second, third]) {
      const text = readText(dir, `${DRAFTS}/${draft.path}`);
      expect((parse(text) as Raw).status).toBe('draft');
      expect(text).not.toContain('verified_by');
    }
  });

  test('AC-26: only the three sidecars are added: no other file, no temporary file', () => {
    const dir = makeTempDir();
    mixed(dir);
    const before = Object.keys(snapshot(dir));

    runCli(dir, [...VERDICT, '--write']);

    const added = Object.keys(snapshot(dir)).filter((path) => !before.includes(path));
    expect(added.sort()).toEqual([
      `${DRAFTS}/d1/1.3/aaa-third-id.check.yaml`,
      `${DRAFTS}/d1/1.3/mmm-second-id.check.yaml`,
      `${DRAFTS}/d1/1.3/zzz-first-id.check.yaml`,
    ]);
  });

  test('AC-26: --write prints the same report as the run without it', () => {
    const dir = makeTempDir();
    mixed(dir);

    const plain = runCli(dir, VERDICT);
    const written = runCli(dir, [...VERDICT, '--write']);

    expect(entriesOf(plain)).toHaveLength(3);
    expect(written.status).toBe(plain.status);
    expect(entriesOf(written)).toEqual(entriesOf(plain));
  });

  test('AC-27: running --write twice with the same input gives the same sidecar bytes', () => {
    const dir = makeTempDir();
    mixed(dir);
    runCli(dir, [...VERDICT, '--write']);
    const once = snapshot(dir);
    expect(Object.keys(once).filter((path) => path.endsWith('.check.yaml'))).toHaveLength(3);

    runCli(dir, [...VERDICT, '--write']);

    expect(snapshot(dir)).toEqual(once);
  });

  test('AC-27: a second run with other results replaces the verification', () => {
    const dir = makeTempDir();
    const { second } = mixed(dir);
    runCli(dir, [...VERDICT, '--write']);
    writeResults(dir, [good(second, { answer: ['A'] })]);

    runCli(dir, [...VERDICT, '--write']);

    const text = readText(dir, `${DRAFTS}/${sidecarOf(second.path)}`);
    expect(text.match(/^verification:/gm)).toHaveLength(1);
    expect(verificationOf(dir, second).result).toBe('mismatch');
  });

  test('AC-27: a later dedupe --write still succeeds and keeps the verification', () => {
    const dir = makeTempDir();
    const { first, second, third } = mixed(dir);
    runCli(dir, [...VERDICT, '--write']);
    const verifications = [first, second, third].map((draft) => verificationOf(dir, draft));

    const run = runCli(dir, ['dedupe', '--write']);

    expect(run.status).toBe(0);
    expect([first, second, third].map((draft) => verificationOf(dir, draft))).toEqual(
      verifications,
    );
    const sidecar = parse(readText(dir, `${DRAFTS}/${sidecarOf(second.path)}`)) as Raw;
    expect(sidecar.dedupe).toEqual({ threshold: 0.5, similar: [] });
  });

  test('AC-27: a verdict --write after dedupe --write keeps the dedupe key', () => {
    const dir = makeTempDir();
    const { first, second, third } = mixed(dir);
    runCli(dir, ['dedupe', '--write']);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    for (const draft of [first, second, third]) {
      const sidecar = parse(readText(dir, `${DRAFTS}/${sidecarOf(draft.path)}`)) as Raw;
      expect(sidecar.dedupe).toEqual({ threshold: 0.5, similar: [] });
      expect(sidecar.verification).toBeDefined();
    }
  });
});

describe('verdict problems', () => {
  /** The standard drafts plus a bank-only question and a rejected draft. */
  function seedWithOthers(dir: string): Seeded {
    const seeded = seed(dir);
    put(dir, BANK, 'd1-1.3-0050', 'bank-only', { ...variant('echo', 'a') });
    put(dir, `${DRAFTS}/rejected`, 'd1-1.3-0060', 'was-rejected', {
      ...variant('foxtrot', 'a'),
      status: 'draft',
    });
    return seeded;
  }

  function problem(
    name: string,
    sheet: (seeded: Seeded) => string | undefined,
    mention: (seeded: Seeded) => string | undefined,
  ): [string, (seeded: Seeded) => string | undefined, (seeded: Seeded) => string | undefined] {
    return [name, sheet, mention];
  }

  const RESULT_PROBLEMS = [
    problem(
      'invalid YAML',
      () => 'verifier: claude-opus\nresults: [unclosed\n',
      () => undefined,
    ),
    problem(
      'a document that is not a mapping',
      () => '- one\n- two\n',
      () => undefined,
    ),
    problem(
      'a missing verifier',
      (s) => resultsYaml([good(s.first)], { verifier: undefined }),
      () => undefined,
    ),
    problem(
      'a verifier that is not a lowercase slug',
      (s) => resultsYaml([good(s.first)], { verifier: 'Claude Opus' }),
      () => undefined,
    ),
    problem(
      'an unknown top-level key',
      (s) => resultsYaml([good(s.first)], { top: { extra: 1 } }),
      () => undefined,
    ),
    problem(
      'an unknown key in a result',
      (s) => resultsYaml([good(s.first, { confidence: 'high' })]),
      () => undefined,
    ),
    problem(
      'results that is not a list',
      () => 'verifier: claude-opus\nresults: nope\n',
      () => undefined,
    ),
    problem(
      'a missing results key',
      () => 'verifier: claude-opus\n',
      () => undefined,
    ),
    problem(
      'a result without an id',
      () => resultsYaml([{ answer: ['C'], quote: QUOTE, source: DOCS_URL }]),
      () => undefined,
    ),
    problem(
      'an answer that is not a list',
      (s) => resultsYaml([good(s.first, { answer: 'C' })]),
      () => undefined,
    ),
    problem(
      'an answer that holds a number',
      (s) => resultsYaml([good(s.first, { answer: [1] })]),
      () => undefined,
    ),
    problem(
      'a result without an answer',
      (s) => resultsYaml([{ id: s.first.id, quote: QUOTE, source: DOCS_URL }]),
      () => undefined,
    ),
    problem(
      'an id that is not a draft at all',
      (s) => resultsYaml([good(s.first), { id: 'd1-1.3-0099', answer: ['C'] }]),
      () => 'd1-1.3-0099',
    ),
    problem(
      'an id that is only in the bank',
      (s) => resultsYaml([good(s.first), { id: 'd1-1.3-0050', answer: ['C'] }]),
      () => 'd1-1.3-0050',
    ),
    problem(
      'an id that is only in rejected/',
      (s) => resultsYaml([good(s.first), { id: 'd1-1.3-0060', answer: ['C'] }]),
      () => 'd1-1.3-0060',
    ),
    problem(
      'the same id twice',
      (s) => resultsYaml([good(s.first), good(s.second), good(s.first)]),
      (s) => s.first.id,
    ),
    problem(
      'an answer key the question does not have (E on four options)',
      (s) => resultsYaml([good(s.second), good(s.first, { answer: ['E'] })]),
      (s) => s.first.id,
    ),
    problem(
      'an answer key the question does not have (lower-case z)',
      (s) => resultsYaml([good(s.first, { answer: ['C', 'z'] })]),
      (s) => s.first.id,
    ),
  ];

  test.each(RESULT_PROBLEMS)(
    'AC-28: %s is printed, nothing is written even with --write, exit 1',
    (_name, sheet, mention) => {
      const dir = makeTempDir();
      const seeded = seedWithOthers(dir);
      const text = sheet(seeded);
      if (text !== undefined) write(dir, RESULTS, text);
      const before = snapshot(dir);

      const run = runCli(dir, [...VERDICT, '--write']);

      expect(run.status).toBe(1);
      const expected = mention(seeded);
      if (expected !== undefined) expect(run.output).toContain(expected);
      else expect(run.output.trim()).not.toBe('');
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test('AC-28: a results file that does not exist is printed, nothing is written, exit 1', () => {
    const dir = makeTempDir();
    seedWithOthers(dir);
    const before = snapshot(dir);

    const run = runCli(dir, ['verdict', 'no-such-results.yaml', '--no-fetch', '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain('no-such-results.yaml');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: a problem without --write also exits 1 and writes nothing', () => {
    const dir = makeTempDir();
    const { first } = seedWithOthers(dir);
    write(dir, RESULTS, resultsYaml([good(first), { id: 'd1-1.3-0099', answer: ['C'] }]));
    const before = snapshot(dir);

    const run = runCli(dir, VERDICT);

    expect(run.status).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: a folder problem in the drafts (a question that fails the schema) stops the run', () => {
    const dir = makeTempDir();
    const { first, second } = seed(dir);
    write(
      dir,
      `${DRAFTS}/d1/1.3/broken.yaml`,
      stringify({ ...makeQuestion({ id: 'd1-1.3-0009' }), stem: 'short' }),
    );
    writeResults(dir, [good(first), good(second)]);
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/d1/1.3/broken.yaml`);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: a folder problem in the bank (a question that is not reviewed) stops the run', () => {
    const dir = makeTempDir();
    const { first } = seed(dir);
    put(dir, BANK, 'd1-1.3-0050', 'still-a-draft', { ...variant('echo', 'a'), status: 'draft' });
    writeResults(dir, [good(first)]);
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${BANK}/d1/1.3/still-a-draft.yaml`);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: an id used by a draft and a bank question is a folder problem', () => {
    const dir = makeTempDir();
    const { first } = seed(dir);
    put(dir, BANK, 'd1-1.3-0001', 'same-id-in-bank', variant('echo', 'a'));
    writeResults(dir, [good(first)]);
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('verdict --write is all or nothing', () => {
  const OLD_SIDECAR = 'keep: me   # by hand\r\ndedupe:\r\n  threshold: 0.5\r\n  similar: []\r\n';

  /** The three drafts with a valid old sidecar on the first and the second. */
  function seedWithSidecars(dir: string): Seeded {
    const seeded = seed(dir);
    write(dir, `${DRAFTS}/${sidecarOf(seeded.first.path)}`, OLD_SIDECAR);
    write(dir, `${DRAFTS}/${sidecarOf(seeded.second.path)}`, OLD_SIDECAR);
    writeResults(dir, [good(seeded.first), good(seeded.second), good(seeded.third)]);
    return seeded;
  }

  test.each([
    ['invalid YAML', 'a: [unclosed\n'],
    ['a sequence', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
  ])('AC-29: a sidecar that is %s is named and nothing is written', (_name, bad) => {
    const dir = makeTempDir();
    const { second, third } = seedWithSidecars(dir);
    write(dir, `${DRAFTS}/${sidecarOf(third.path)}`, bad);
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/${sidecarOf(third.path)}`);
    expect(snapshot(dir)).toEqual(before);
    expect(read(dir, `${DRAFTS}/${sidecarOf(second.path)}`).toString('utf8')).toBe(OLD_SIDECAR);
  });

  test('AC-29: a bad sidecar on the first draft leaves the others as they were too', () => {
    const dir = makeTempDir();
    const { first } = seedWithSidecars(dir);
    write(dir, `${DRAFTS}/${sidecarOf(first.path)}`, '- not a mapping\n');
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/${sidecarOf(first.path)}`);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-29: a flow mapping sidecar is either updated correctly or rejected untouched', () => {
    const dir = makeTempDir();
    const { first, second, third } = seedWithSidecars(dir);
    write(dir, `${DRAFTS}/${sidecarOf(third.path)}`, '{ keep: me }\n');
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    if (run.status === 1) {
      expect(run.output).toContain(`${DRAFTS}/${sidecarOf(third.path)}`);
      expect(snapshot(dir)).toEqual(before);
    } else {
      expect(run.status).toBe(0);
      const sidecar = parse(readText(dir, `${DRAFTS}/${sidecarOf(third.path)}`)) as Raw;
      expect(sidecar.keep).toBe('me');
      for (const draft of [first, second, third]) {
        expect(verificationOf(dir, draft).result).toBe('verified');
      }
    }
  });

  test('AC-29: a folder at the last sidecar: exit 1, the sidecar is named, the tree is as before', () => {
    const dir = makeTempDir();
    const { third } = seedWithSidecars(dir);
    mkdirSync(join(dir, DRAFTS, 'd1', '1.3', 'aaa-third-id.check.yaml'), { recursive: true });
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/${sidecarOf(third.path)}`);
    expect(run.output).not.toContain(dir);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-29: a folder at the first sidecar: the ones after it are not left changed', () => {
    const dir = makeTempDir();
    const { first, second } = seedWithSidecars(dir);
    rmSync(join(dir, DRAFTS, ...sidecarOf(first.path).split('/')));
    mkdirSync(join(dir, DRAFTS, 'd1', '1.3', 'zzz-first-id.check.yaml'), { recursive: true });
    write(dir, `${DRAFTS}/${sidecarOf(first.path)}/inside.txt`, 'x');
    const before = snapshot(dir);
    const run = runCli(dir, [...VERDICT, '--write']);
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${DRAFTS}/${sidecarOf(first.path)}`);
    expect(read(dir, `${DRAFTS}/${sidecarOf(second.path)}`).toString('utf8')).toBe(OLD_SIDECAR);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-29: sidecars that did not exist are not created when another one fails', () => {
    const dir = makeTempDir();
    const { first, second, third } = seed(dir);
    writeResults(dir, [good(first), good(second), good(third)]);
    mkdirSync(join(dir, DRAFTS, 'd1', '1.3', 'aaa-third-id.check.yaml'), { recursive: true });
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(exists(dir, `${DRAFTS}/${sidecarOf(first.path)}`)).toBe(false);
    expect(exists(dir, `${DRAFTS}/${sidecarOf(second.path)}`)).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-29: the draft files keep their bytes after a failed write', () => {
    const dir = makeTempDir();
    seedWithSidecars(dir);
    mkdirSync(join(dir, DRAFTS, 'd1', '1.3', 'aaa-third-id.check.yaml'), { recursive: true });
    const before = questionFiles(dir);

    const run = runCli(dir, [...VERDICT, '--write']);

    expect(run.status).toBe(1);
    expect(questionFiles(dir)).toEqual(before);
  });
});

describe('verdict fetches the sources', () => {
  const PAGE_ONE = `<html><head><style>.hidden { content: "decoy" }</style></head><body>
    <script>var decoy = "nothing to see";</script>
    <p>Use <code>SSE-C</code> &amp; HTTPS to keep keys out of AWS.</p></body></html>`;
  const PAGE_TWO = '<p>A page that talks about something else entirely.</p>';
  const FOUND_QUOTE = 'Use SSE-C & HTTPS to keep keys out of AWS.';
  const BASE = 'https://docs.aws.amazon.com/test';
  const URL_ONE = `${BASE}/page-one.html`;
  const URL_TWO = `${BASE}/page-two.html`;
  const URL_THREE = `${BASE}/missing-page.html`;
  const URL_FOUR = `${BASE}/unreachable.html`;
  const OTHER_HOST = 'https://example.com/not-the-docs.html';

  function seedMany(dir: string): Draft[] {
    return ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((group, index) =>
      putDraft(dir, `d1-1.3-${String(index + 1).padStart(4, '0')}`, `question-${group}`, group),
    );
  }

  function stub(): ReturnType<typeof stubFetch> {
    return stubFetch(makeTempDir(), {
      [URL_ONE]: { status: 200, body: PAGE_ONE },
      [URL_TWO]: { status: 200, body: PAGE_TWO },
      [URL_THREE]: { status: 404, body: 'Not found' },
      [URL_FOUR]: 'network-error',
      [OTHER_HOST]: { status: 200, body: `<p>${FOUND_QUOTE}</p>` },
    });
  }

  /** The sheet: found twice on one page, not found, 404, network error, and a source not to fetch. */
  function sheetFor(drafts: Draft[]): ResultEntry[] {
    const [one, two, three, four, five, six] = drafts as [Draft, Draft, Draft, Draft, Draft, Draft];
    return [
      good(one, { quote: FOUND_QUOTE, source: URL_ONE }),
      good(two, { quote: FOUND_QUOTE, source: URL_TWO }),
      good(three, { quote: FOUND_QUOTE, source: URL_THREE }),
      good(four, { quote: FOUND_QUOTE, source: URL_FOUR }),
      good(five, { quote: FOUND_QUOTE, source: OTHER_HOST }),
      good(six, { quote: FOUND_QUOTE, source: URL_ONE }),
    ];
  }

  function qualityOf(dir: string, drafts: Draft[]): string[] {
    return drafts.map((draft) => String(verificationOf(dir, draft).quote_check));
  }

  test('AC-30: quote_check is found, not-found, fetch-failed or none per source', () => {
    const dir = makeTempDir();
    const drafts = seedMany(dir);
    writeResults(dir, sheetFor(drafts));

    const run = runCli(dir, ['verdict', RESULTS, '--write'], stub().env);

    expect(qualityOf(dir, drafts)).toEqual([
      'found',
      'not-found',
      'fetch-failed',
      'fetch-failed',
      'none',
      'found',
    ]);
    expect(run.status).toBe(1);
  });

  test('AC-30: the results follow the quote check', () => {
    const dir = makeTempDir();
    const drafts = seedMany(dir);
    writeResults(dir, sheetFor(drafts));

    const run = runCli(dir, ['verdict', RESULTS], stub().env);

    expect(entriesOf(run).map((entry) => entry.result)).toEqual([
      'verified',
      'unsupported',
      'unsupported',
      'unsupported',
      'unsupported',
      'verified',
    ]);
    expect(lines(run.stdout).at(-1)).toBe(summaryOf(2, 0, 4));
    expect(run.status).toBe(1);
  });

  test('AC-30: each distinct docs URL is fetched once, even when two results share it', () => {
    const dir = makeTempDir();
    const drafts = seedMany(dir);
    writeResults(dir, sheetFor(drafts));
    const fetchStub = stub();

    runCli(dir, ['verdict', RESULTS, '--write'], fetchStub.env);

    expect([...fetchStub.fetched()].sort()).toEqual([URL_FOUR, URL_ONE, URL_THREE, URL_TWO].sort());
  });

  test('AC-30: a source that is not on the docs site is never fetched', () => {
    const dir = makeTempDir();
    const drafts = seedMany(dir);
    writeResults(dir, sheetFor(drafts));
    const fetchStub = stub();

    runCli(dir, ['verdict', RESULTS, '--write'], fetchStub.env);

    expect(fetchStub.fetched()).toContain(URL_ONE);
    expect(fetchStub.fetched()).not.toContain(OTHER_HOST);
  });

  test('AC-30: a 404 and a network error are both fetch-failed with a reason', () => {
    const dir = makeTempDir();
    const drafts = seedMany(dir);
    writeResults(dir, sheetFor(drafts));

    runCli(dir, ['verdict', RESULTS, '--write'], stub().env);

    for (const draft of [drafts[2], drafts[3]] as Draft[]) {
      const value = verificationOf(dir, draft);
      expect(value.result).toBe('unsupported');
      expect((value.reasons as string[]).length).toBeGreaterThan(0);
    }
  });

  test('AC-30: --no-fetch fetches nothing and records skipped', () => {
    const dir = makeTempDir();
    const drafts = seedMany(dir);
    writeResults(dir, sheetFor(drafts));
    const fetchStub = stub();

    const run = runCli(dir, ['verdict', RESULTS, '--no-fetch', '--write'], fetchStub.env);

    expect(fetchStub.fetched()).toEqual([]);
    expect(String(verificationOf(dir, drafts[0] as Draft).quote_check)).toBe('skipped');
    expect(String(verificationOf(dir, drafts[1] as Draft).quote_check)).toBe('skipped');
    expect(run.status).toBe(1);
  });

  test('AC-30: a result without a quote has quote_check none', () => {
    const dir = makeTempDir();
    const [one] = seedMany(dir) as [Draft];
    writeResults(dir, [{ id: one.id, answer: ['C'], source: URL_ONE }]);
    const fetchStub = stub();

    const run = runCli(dir, ['verdict', RESULTS, '--write'], fetchStub.env);

    expect(run.status).toBe(1);
    expect(verificationOf(dir, one).result).toBe('unsupported');
    expect(String(verificationOf(dir, one).quote_check)).toBe('none');
  });
});

describe('usage and folder options', () => {
  test('AC-32: the usage text lists brief, blind and verdict', () => {
    const dir = makeTempDir();

    const run = runCli(dir, []);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toMatch(/\bquestions brief\b/);
    expect(run.output).toMatch(/\bquestions blind\b/);
    expect(run.output).toMatch(/\bquestions verdict\b/);
  });

  test('AC-32: an unknown command still prints the usage with the new commands', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['bogus']);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/\bverdict\b/);
  });

  test.each([
    ['verdict with an unknown flag', ['verdict', RESULTS, '--bogus']],
    ['verdict with -x', ['verdict', RESULTS, '-x']],
    ['verdict with a flag of another command (--pending)', ['verdict', RESULTS, '--pending']],
    ['verdict with a flag of another command (--count)', ['verdict', RESULTS, '--count', '3']],
    ['verdict --drafts with no value', ['verdict', RESULTS, '--drafts']],
    ['verdict --bank with no value', ['verdict', RESULTS, '--bank']],
    ['verdict --drafts followed by a flag', ['verdict', RESULTS, '--drafts', '--write']],
    ['verdict without a file', ['verdict']],
    ['verdict with only flags', ['verdict', '--write', '--no-fetch']],
    ['blind with an unknown flag', ['blind', '--bogus']],
    ['blind with a flag of another command (--write)', ['blind', '--write']],
    ['blind --drafts with no value', ['blind', '--pending', '--drafts']],
    ['brief with an unknown flag', ['brief', '1.3', '--bogus']],
    ['brief with a flag of another command (--write)', ['brief', '1.3', '--write']],
    ['brief with a flag of another command (--no-fetch)', ['brief', '1.3', '--no-fetch']],
    ['brief --notes with no value', ['brief', '1.3', '--notes']],
    ['brief --map with no value', ['brief', '1.3', '--map']],
    ['brief --drafts with no value', ['brief', '1.3', '--drafts']],
    ['brief --bank with no value', ['brief', '1.3', '--bank']],
    ['check with a flag of verdict (--no-fetch)', ['check', '--no-fetch']],
  ])('AC-32: %s exits 2 with the usage text and writes nothing', (_name, args) => {
    const dir = makeTempDir();
    seed(dir);
    const before = snapshot(dir);

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toMatch(/\bquestions verdict\b/);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-32: --drafts is the folder verdict reads, prints and writes to', () => {
    const dir = makeTempDir();
    const { first } = seed(dir, 'my-drafts');
    // The default folder holds a question with the same id that must not be used.
    put(dir, DRAFTS, 'd1-1.3-0001', 'default-folder-copy', variant('echo', 'a'));
    writeResults(dir, [good(first)]);

    const run = runCli(dir, [...VERDICT, '--write', '--drafts', 'my-drafts']);

    expect(run.status).toBe(0);
    expect(entriesOf(run)[0]?.path).toMatch(printedPath('d1/1.3/zzz-first-id.yaml', 'my-drafts'));
    expect(verificationOf(dir, first, 'my-drafts').result).toBe('verified');
    expect(exists(dir, `${DRAFTS}/d1/1.3/default-folder-copy.check.yaml`)).toBe(false);
  });

  test('AC-32: --bank is the folder where bank-only ids are looked up', () => {
    const dir = makeTempDir();
    const { first } = seed(dir);
    put(dir, 'my-bank', 'd1-1.3-0050', 'in-custom-bank', variant('echo', 'a'));
    // Only the question in --bank makes the id a bank-only id.
    writeResults(dir, [good(first), { id: 'd1-1.3-0050', answer: ['C'] }]);
    const before = snapshot(dir);

    const run = runCli(dir, [...VERDICT, '--write', '--bank', 'my-bank']);

    expect(run.status).toBe(1);
    expect(run.output).toContain('d1-1.3-0050');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-32: a missing drafts folder is treated as empty with the usual notice', () => {
    const dir = makeTempDir();
    write(dir, RESULTS, resultsYaml([{ id: 'd1-1.3-0001', answer: ['C'] }]));

    const run = runCli(dir, [...VERDICT, '--drafts', 'no-drafts']);

    expect(run.output).toContain('no folder at no-drafts, treated as empty');
    expect(run.status).toBe(1);
  });
});
