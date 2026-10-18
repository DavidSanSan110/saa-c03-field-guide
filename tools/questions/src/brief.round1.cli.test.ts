// Review round 1 (regression ACs) of spec 022, brief CLI: AC-37.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { notesText } from './__mocks__/brief-fixtures.ts';
import { NOTES, cleanTempDirs, makeTempDir, runCli, write } from './__mocks__/cli-harness.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

const DEFAULT_MAP = `${NOTES}/sections.yaml`;
const CUSTOM_MAP = 'config/my-map.yaml';

const BACKSLASH = String.fromCharCode(92);

/** [name, map text, what the message must name besides the map path] */
const PROBLEMS: [string, string, string[]][] = [
  [
    'a task that is not in the catalog',
    '05-main: ["1.3"]\n06-bad: ["1.1", "9.9"]\n',
    ['06-bad', '9.9'],
  ],
  [
    'a duplicate task in one list',
    '05-main: ["1.3"]\n06-dup: ["1.1", "1.2", "1.1"]\n',
    ['06-dup', '1.1'],
  ],
  ['an empty list', '05-main: ["1.3"]\n06-empty: []\n', ['06-empty']],
  ['an empty value', '05-main: ["1.3"]\n06-null:\n', ['06-null']],
  ['a string instead of a list', '05-main: ["1.3"]\n06-text: "1.1"\n', ['06-text']],
  ['a folder name with a slash', '05-main: ["1.3"]\n"a/b": ["1.1"]\n', ['a/b']],
  [
    'a folder name with a backslash',
    `05-main: ["1.3"]\n"c${BACKSLASH}${BACKSLASH}d": ["1.1"]\n`,
    [`c${BACKSLASH}d`],
  ],
  ['a folder named ..', '05-main: ["1.3"]\n"..": ["1.1"]\n', ['..']],
  ['invalid YAML', 'a: [unclosed\n', []],
  ['a map that is not a mapping', '- a\n- b\n', []],
];

describe('brief names the map file and the offending entry', () => {
  test.each(PROBLEMS)('AC-37: %s: stderr names the default map path', (_name, map, names) => {
    const dir = makeTempDir();
    write(dir, `${NOTES}/05-main/notes.md`, notesText('mainsprocket'));
    write(dir, DEFAULT_MAP, map);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(DEFAULT_MAP);
    for (const name of names) expect(run.stderr).toContain(name);
  });

  test.each(PROBLEMS)('AC-37: %s: stderr names the map given with --map', (_name, map, names) => {
    const dir = makeTempDir();
    write(dir, `${NOTES}/05-main/notes.md`, notesText('mainsprocket'));
    write(dir, CUSTOM_MAP, map);

    const run = runCli(dir, ['brief', '1.3', '--map', CUSTOM_MAP]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(CUSTOM_MAP);
    for (const name of names) expect(run.stderr).toContain(name);
  });

  test('AC-37: every problem of a map with several is named, each with its entry', () => {
    const dir = makeTempDir();
    write(dir, `${NOTES}/05-main/notes.md`, notesText('mainsprocket'));
    write(dir, DEFAULT_MAP, '05-main: ["9.9"]\n06-empty: []\n');

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('9.9');
    expect(run.stderr).toContain('06-empty');
  });
});
