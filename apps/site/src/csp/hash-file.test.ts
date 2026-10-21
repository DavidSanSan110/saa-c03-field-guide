import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadInlineHashes } from './hash-file.ts';

// Spec 034, sections 2 and 3: the pinned inline-script hashes file and its loader.
const HASH_FILE = resolve(import.meta.dirname, '..', '..', 'csp-inline-hashes.json');
const PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

// SHA-256 of '' and of 'alert(1)' (spec AC-8): two valid entries in ascending order.
const H_EMPTY = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
const H_ALERT = 'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=';
// Same length, only the first character differs: 'Z' (0x5A) sorts before 'a' (0x61) in plain order.
const H_UPPER = `sha256-${'Z'.repeat(43)}=`;
const H_LOWER = `sha256-${'a'.repeat(43)}=`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csp-hash-file-'));
  tempDirs.push(dir);
  return dir;
}

/** Writes `content` to a temp file and returns its path. */
function fileWith(content: string): string {
  const path = join(tempDir(), 'csp-inline-hashes.json');
  writeFileSync(path, content);
  return path;
}

function fileWithHashes(scriptHashes: unknown): string {
  return fileWith(JSON.stringify({ scriptHashes }, null, 2) + '\n');
}

/** Asserts the loader throws an Error whose message names the path. */
function expectRejected(path: string): void {
  let thrown: unknown;
  try {
    loadInlineHashes(path);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `loadInlineHashes(${path}) should throw`).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(path);
}

describe('the committed apps/site/csp-inline-hashes.json', () => {
  function readRaw(): string {
    return readFileSync(HASH_FILE, 'utf8');
  }

  function readEntries(): unknown[] {
    const parsed = JSON.parse(readRaw()) as { scriptHashes: unknown[] };
    return parsed.scriptHashes;
  }

  test('AC-6: has only the scriptHashes key', () => {
    const parsed: unknown = JSON.parse(readRaw());

    expect(Object.keys(parsed as object)).toEqual(['scriptHashes']);
  });

  test('AC-6: every entry matches the sha256 pattern', () => {
    const entries = readEntries();

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.filter((entry) => typeof entry !== 'string' || !PATTERN.test(entry))).toEqual(
      [],
    );
  });

  test('AC-6: the entries are sorted ascending and unique', () => {
    const entries = readEntries() as string[];

    expect(entries).toEqual([...new Set(entries)].sort());
  });

  test('AC-6: the file is JSON.stringify(value, null, 2) plus a newline', () => {
    const raw = readRaw();

    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
  });

  test('AC-6: loadInlineHashes returns exactly the entries of the file', () => {
    expect(loadInlineHashes(HASH_FILE)).toEqual(readEntries());
  });
});

describe('loadInlineHashes', () => {
  test('AC-6b: returns the entries of a valid file', () => {
    const path = fileWithHashes([H_EMPTY, H_ALERT]);

    expect(loadInlineHashes(path)).toEqual([H_EMPTY, H_ALERT]);
  });

  test('AC-6b: {"scriptHashes": []} is valid and returns []', () => {
    const path = fileWithHashes([]);

    expect(loadInlineHashes(path)).toEqual([]);
  });

  test('AC-6b: sorting is plain string order (uppercase before lowercase)', () => {
    const path = fileWithHashes([H_UPPER, H_LOWER]);

    expect(loadInlineHashes(path)).toEqual([H_UPPER, H_LOWER]);
  });

  test('AC-6b: rejects a missing file', () => {
    expectRejected(join(tempDir(), 'does-not-exist.json'));
  });

  test('AC-6b: rejects invalid JSON', () => {
    expectRejected(fileWith('{ "scriptHashes": [ '));
  });

  test('AC-6b: rejects an empty file', () => {
    expectRejected(fileWith(''));
  });

  test.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"scriptHashes"'],
    ['a number', '42'],
  ])('AC-6b: rejects a JSON value that is not an object (%s)', (_name, json) => {
    expectRejected(fileWith(json));
  });

  test('AC-6b: rejects an object without scriptHashes', () => {
    expectRejected(fileWith('{}\n'));
  });

  test('AC-6b: rejects an extra key', () => {
    expectRejected(fileWith(JSON.stringify({ scriptHashes: [H_EMPTY], styleHashes: [] })));
  });

  test.each([
    ['a string', H_EMPTY],
    ['an object', { 0: H_EMPTY }],
    ['null', null],
    ['a number', 1],
  ])('AC-6b: rejects scriptHashes that is not an array (%s)', (_name, value) => {
    expectRejected(fileWithHashes(value));
  });

  test.each([
    ['quoted', `'${H_EMPTY}'`],
    ['sha384', `sha384-${'A'.repeat(64)}`],
    ['too short (42 chars)', `sha256-${'A'.repeat(42)}=`],
    ['too long (44 chars)', `sha256-${'A'.repeat(44)}=`],
    ['without the padding =', `sha256-${'A'.repeat(43)}A`],
    ['URL-safe alphabet', `sha256-${'A'.repeat(42)}-=`],
    ['without the sha256- prefix', `${'A'.repeat(43)}=`],
    ['not a string', 123],
    ['empty', ''],
  ])('AC-6b: rejects an entry that does not match the pattern (%s)', (_name, entry) => {
    expectRejected(fileWithHashes([entry]));
  });

  test('AC-6b: rejects a bad entry among valid ones', () => {
    expectRejected(fileWithHashes([H_EMPTY, 'sha256-nope']));
  });

  test('AC-6b: rejects unsorted entries', () => {
    expectRejected(fileWithHashes([H_ALERT, H_EMPTY]));
  });

  test('AC-6b: rejects entries sorted case-insensitively but not in plain order', () => {
    expectRejected(fileWithHashes([H_LOWER, H_UPPER]));
  });

  test('AC-6b: rejects duplicates', () => {
    expectRejected(fileWithHashes([H_EMPTY, H_EMPTY]));
  });
});
