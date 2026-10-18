// Review round 1 (regression ACs) of spec 022, verdict CLI: AC-34, AC-35, AC-36 and AC-39.
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cleanTempDirs,
  lines,
  makeTempDir,
  runCli,
  snapshot,
  write,
} from './__mocks__/cli-harness.ts';
import { recordFetch } from './__mocks__/fetch-record-env.ts';
import type { RecordedAnswer } from './__mocks__/fetch-record-env.ts';
import {
  QUOTE,
  RESULTS,
  good,
  putDraft,
  verificationOf,
  writeResults,
} from './__mocks__/verdict-fixtures.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

const SOURCE = 'https://docs.aws.amazon.com/test/page.html';
const PAGE = `<html><body><p>${QUOTE}</p></body></html>`;

/** One draft with a result that has a quote and the given source; returns what the tests need. */
function setup(source: string, answer: RecordedAnswer) {
  const dir = makeTempDir();
  const draft = putDraft(dir, 'd1-1.3-0001', 'only-one', 'alpha');
  writeResults(dir, [good(draft, { source })]);
  const recorder = recordFetch(makeTempDir(), { [source]: answer });
  return { dir, draft, recorder };
}

describe('verdict fetch options and final URL', () => {
  test('AC-34: fetch is called with redirect follow and an AbortSignal', () => {
    const { dir, recorder } = setup(SOURCE, { status: 200, body: PAGE });

    runCli(dir, ['verdict', RESULTS, '--write'], recorder.env);

    const calls = recorder.calls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.redirect).toBe('follow');
      expect(call.signal).toBe(true);
    }
  });

  test('AC-34: a page that stays on the docs site and holds the quote is found', () => {
    const { dir, draft, recorder } = setup(SOURCE, { status: 200, body: PAGE });

    const run = runCli(dir, ['verdict', RESULTS, '--write'], recorder.env);

    expect(run.status).toBe(0);
    expect(verificationOf(dir, draft).quote_check).toBe('found');
  });

  test('AC-34: a redirect to another page of the docs site is fine', () => {
    const { dir, draft, recorder } = setup(SOURCE, {
      status: 200,
      body: PAGE,
      finalUrl: 'https://docs.aws.amazon.com/moved/elsewhere.html',
    });

    const run = runCli(dir, ['verdict', RESULTS, '--write'], recorder.env);

    expect(run.status).toBe(0);
    expect(verificationOf(dir, draft).quote_check).toBe('found');
  });

  test.each([
    ['another host', 'https://example.com/landing.html'],
    [
      'a host that only starts like the docs host',
      'https://docs.aws.amazon.com.evil.example/x.html',
    ],
    ['plain http on the docs host', 'http://docs.aws.amazon.com/test/page.html'],
    ['a sign-in page of another AWS host', 'https://signin.aws.amazon.com/signin'],
  ])(
    'AC-34: a final URL on %s is fetch-failed even when the body holds the quote',
    (_name, finalUrl) => {
      const { dir, draft, recorder } = setup(SOURCE, { status: 200, body: PAGE, finalUrl });

      const run = runCli(dir, ['verdict', RESULTS, '--write'], recorder.env);

      expect(run.status).toBe(1);
      const value = verificationOf(dir, draft);
      expect(value.quote_check).toBe('fetch-failed');
      expect(value.result).toBe('unsupported');
      expect((value.reasons as string[]).length).toBeGreaterThan(0);
    },
  );
});

describe('verdict: results sheet problems', () => {
  test('AC-35: results: [] exits 1 and writes nothing, even with --write', () => {
    const dir = makeTempDir();
    putDraft(dir, 'd1-1.3-0001', 'only-one', 'alpha');
    write(dir, RESULTS, 'verifier: claude-opus\nresults: []\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['verdict', RESULTS, '--no-fetch', '--write']);

    expect(run.status).toBe(1);
    expect(run.output.trim()).not.toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test.each([
    [
      'a verifier that is not a slug',
      'verifier: Claude Opus\nresults:\n  - { id: d1-1.3-0001, answer: [C] }\n',
    ],
    [
      'a quote that is not a string',
      'verifier: claude-opus\nresults:\n  - { id: d1-1.3-0001, answer: [C], quote: 5 }\n',
    ],
    [
      'a source that is not a string',
      'verifier: claude-opus\nresults:\n  - { id: d1-1.3-0001, answer: [C], source: [x] }\n',
    ],
    [
      'notes that are not a string',
      'verifier: claude-opus\nresults:\n  - { id: d1-1.3-0001, answer: [C], notes: 7 }\n',
    ],
    [
      'an unknown key in a result',
      'verifier: claude-opus\nresults:\n  - { id: d1-1.3-0001, answer: [C], extra: 1 }\n',
    ],
  ])('AC-35: %s exits 1 and writes nothing, even with --write', (_name, text) => {
    const dir = makeTempDir();
    putDraft(dir, 'd1-1.3-0001', 'only-one', 'alpha');
    write(dir, RESULTS, text);
    const before = snapshot(dir);

    const run = runCli(dir, ['verdict', RESULTS, '--no-fetch', '--write']);

    expect(run.status).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('verdict: sources that are not https docs URLs', () => {
  const HTTP_SOURCE = 'http://docs.aws.amazon.com/test/page.html';

  test('AC-36: an http:// docs source is never fetched, quote_check none, result unsupported', () => {
    const { dir, draft, recorder } = setup(HTTP_SOURCE, { status: 200, body: PAGE });

    const run = runCli(dir, ['verdict', RESULTS, '--write'], recorder.env);

    expect(run.status).toBe(1);
    expect(recorder.calls()).toEqual([]);
    const value = verificationOf(dir, draft);
    expect(value.quote_check).toBe('none');
    expect(value.result).toBe('unsupported');
  });
});

describe('verdict: the folder notice goes to stderr', () => {
  test('AC-39: the no folder notice is on stderr and not on stdout', () => {
    const dir = makeTempDir();
    const draft = putDraft(dir, 'd1-1.3-0001', 'only-one', 'alpha');
    writeResults(dir, [good(draft)]);

    // There is no bank folder, so the notice names the default bank.
    const run = runCli(dir, ['verdict', RESULTS, '--no-fetch']);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('no folder at questions, treated as empty');
    expect(run.stdout).not.toContain('no folder at');
  });

  test('AC-39: stdout holds only the report: result lines and the summary', () => {
    const dir = makeTempDir();
    const draft = putDraft(dir, 'd1-1.3-0001', 'only-one', 'alpha');
    writeResults(dir, [good(draft)]);

    const run = runCli(dir, ['verdict', RESULTS, '--no-fetch']);

    const rows = lines(run.stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^verified d1-1\.3-0001 \S+$/);
    expect(rows[1]).toBe('verified: 1, mismatch: 0, unsupported: 0');
  });

  test('AC-39: the notice for a custom drafts folder is on stderr too', () => {
    const dir = makeTempDir();
    write(dir, RESULTS, 'verifier: claude-opus\nresults:\n  - { id: d1-1.3-0001, answer: [C] }\n');

    const run = runCli(dir, ['verdict', RESULTS, '--no-fetch', '--drafts', 'no-drafts']);

    expect(run.stderr).toContain('no folder at no-drafts, treated as empty');
    expect(run.stdout).not.toContain('no folder at');
    expect(run.status).toBe(1);
  });
});
