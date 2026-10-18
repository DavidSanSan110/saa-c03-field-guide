import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';
import { notesText, sectionsYaml, unfinishedNotes } from './__mocks__/brief-fixtures.ts';
import {
  BANK,
  DRAFTS,
  NOTES,
  cleanTempDirs,
  lines,
  makeTempDir,
  put,
  runCli,
  sectionOf,
  tailAfter,
  snapshot,
  write,
} from './__mocks__/cli-harness.ts';
import { makeQuestion } from './__mocks__/fixtures.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

interface Section {
  tasks: string[];
  /** The text of notes.md; `undefined` means the folder exists without notes.md, `null` no folder. */
  notes: string | null | undefined;
}

/** Writes `<notes>/sections.yaml` and the section folders; returns nothing, the CLI reads them. */
function setupNotes(dir: string, sections: Record<string, Section>, notesDir = NOTES): void {
  const map: Record<string, string[]> = {};
  for (const [folder, section] of Object.entries(sections)) {
    map[folder] = section.tasks;
    if (section.notes === null) continue;
    if (section.notes === undefined) write(dir, `${notesDir}/${folder}/.gitkeep`, '');
    else write(dir, `${notesDir}/${folder}/notes.md`, section.notes);
  }
  write(dir, `${notesDir}/sections.yaml`, sectionsYaml(map));
}

/** One finished section feeding 1.3, for the tests that are about something else. */
function simpleNotes(dir: string, notesDir = NOTES): void {
  setupNotes(dir, { '05-main': { tasks: ['1.3'], notes: notesText('mainsprocket') } }, notesDir);
}

/** The non-blank lines of a section of the brief on stdout. */
function sectionLines(run: { stdout: string }, heading: string): string[] {
  return lines(sectionOf(run.stdout, heading));
}

const IDS = '## Ids';
const EXISTING = '## Existing questions for this task';
const WRITE_TO = '## Write to';

describe('brief: study notes and the studied gate', () => {
  test('AC-9: prints the finished notes in full under folder headings in feed order, skips the unfinished one', () => {
    const dir = makeTempDir();
    const alsoNotes = notesText('alsosprocket');
    const mainNotes = notesText('mainsprocket');
    setupNotes(dir, {
      '01-also-finished': { tasks: ['1.2', '1.3'], notes: alsoNotes },
      '05-main-finished': { tasks: ['1.3', '1.1'], notes: mainNotes },
      '03-unfinished': { tasks: ['1.3'], notes: unfinishedNotes('ghostsprocket') },
      '07-other-task': { tasks: ['2.1'], notes: unfinishedNotes('elsewhere') },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    const study = tailAfter(run.stdout, '## Study notes');
    expect(study).toContain(mainNotes.trimEnd());
    expect(study).toContain(alsoNotes.trimEnd());
    // The main section comes first although its folder name sorts later.
    const headings = study.split('\n').filter((row) => row.startsWith('### '));
    expect(headings).toEqual(['### 05-main-finished', '### 01-also-finished']);
    expect(study.indexOf('### 05-main-finished')).toBeLessThan(study.indexOf(mainNotes.trimEnd()));
    expect(study.indexOf(mainNotes.trimEnd())).toBeLessThan(study.indexOf('### 01-also-finished'));
    expect(study.indexOf('### 01-also-finished')).toBeLessThan(study.indexOf(alsoNotes.trimEnd()));
  });

  test('AC-9: the unfinished section is not printed and is reported on stderr', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main-finished': { tasks: ['1.3'], notes: notesText('mainsprocket') },
      '03-unfinished': { tasks: ['1.3'], notes: unfinishedNotes('ghostsprocket') },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('ghostsprocket');
    expect(run.stdout).not.toContain('03-unfinished');
    expect(lines(run.stderr)).toContain('skipped 03-unfinished: not finished');
  });

  test('AC-9: an impossible date or an empty date means not finished', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main-finished': { tasks: ['1.3'], notes: notesText('mainsprocket') },
      '03-impossible': { tasks: ['1.3'], notes: notesText('impossiblesprocket', '31/02/2026') },
      '04-empty': { tasks: ['1.3'], notes: notesText('emptysprocket', '') },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(lines(run.stderr)).toContain('skipped 03-impossible: not finished');
    expect(lines(run.stderr)).toContain('skipped 04-empty: not finished');
    expect(run.stdout).not.toContain('impossiblesprocket');
    expect(run.stdout).not.toContain('emptysprocket');
  });

  test('AC-9: an unfinished section that does not map to the task is not mentioned', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main-finished': { tasks: ['1.3'], notes: notesText('mainsprocket') },
      '07-other-task': { tasks: ['2.1'], notes: unfinishedNotes('elsewhere') },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('mainsprocket');
    expect(run.stderr).not.toContain('07-other-task');
  });

  test('AC-9: a finished section that does not map to the task is not printed', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main-finished': { tasks: ['1.3'], notes: notesText('mainsprocket') },
      '07-other-task': { tasks: ['2.1'], notes: notesText('elsewheresprocket') },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('mainsprocket');
    expect(run.stdout).not.toContain('elsewheresprocket');
    expect(run.stdout).not.toContain('07-other-task');
  });

  test('AC-9: the brief starts with the title of the task and has the six sections in order', () => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    const rows = run.stdout.split(/\r?\n/);
    expect(rows[0]).toMatch(/^# Brief: task 1\.3 · .+ \(domain 1\)$/);
    const positions = [IDS, WRITE_TO, '## Format', '## Rules', EXISTING, '## Study notes'].map(
      (heading) => rows.indexOf(heading),
    );
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('AC-9: --notes and --map override the defaults', () => {
    const dir = makeTempDir();
    setupNotes(
      dir,
      { '05-main': { tasks: ['1.3'], notes: notesText('customsprocket') } },
      'my-notes',
    );
    write(dir, 'elsewhere/my-map.yaml', sectionsYaml({ '05-main': ['1.3'] }));

    const withNotes = runCli(dir, ['brief', '1.3', '--notes', 'my-notes']);
    const withMap = runCli(dir, [
      'brief',
      '1.3',
      '--notes',
      'my-notes',
      '--map',
      'elsewhere/my-map.yaml',
    ]);

    expect(withNotes.status).toBe(0);
    expect(withNotes.stdout).toContain('customsprocket');
    expect(withMap.status).toBe(0);
    expect(withMap.stdout).toContain('customsprocket');
  });

  test('AC-9: --map picks a different map than <notes>/sections.yaml', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main': { tasks: ['2.1'], notes: notesText('mainsprocket') },
      '06-second': { tasks: ['2.1'], notes: notesText('secondsprocket') },
    });
    write(dir, 'other-map.yaml', sectionsYaml({ '06-second': ['1.3'] }));

    const run = runCli(dir, ['brief', '1.3', '--map', 'other-map.yaml']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('secondsprocket');
    expect(run.stdout).not.toContain('mainsprocket');
  });

  test('AC-9: brief writes nothing', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    put(dir, DRAFTS, 'd1-1.3-0001', 'one', { status: 'draft' });
    const before = snapshot(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-10: a mapped folder without notes.md is reported and otherwise ignored', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main-finished': { tasks: ['1.3'], notes: notesText('mainsprocket') },
      '03-empty-folder': { tasks: ['1.3'], notes: undefined },
      '04-no-folder': { tasks: ['1.3', '1.1'], notes: null },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(lines(run.stderr)).toContain('skipped 03-empty-folder: no notes.md');
    expect(lines(run.stderr)).toContain('skipped 04-no-folder: no notes.md');
    expect(run.stdout).not.toContain('03-empty-folder');
    expect(run.stdout).not.toContain('04-no-folder');
    expect(run.stdout).toContain('mainsprocket');
  });

  test('AC-10: a folder without notes.md is not also reported as not finished', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-main-finished': { tasks: ['1.3'], notes: notesText('mainsprocket') },
      '03-empty-folder': { tasks: ['1.3'], notes: undefined },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(lines(run.stderr)).toContain('skipped 03-empty-folder: no notes.md');
    expect(run.stderr).not.toContain('skipped 03-empty-folder: not finished');
  });

  test('AC-11: when no section is mapped to the task, stdout is empty, stderr says why, exit 1', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '05-main': { tasks: ['2.1'], notes: notesText('mainsprocket') } });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(lines(run.stderr)).toContain('no finished section feeds task 1.3 (studied gate)');
  });

  test('AC-11: when every section that feeds the task is unfinished, exit 1 and nothing on stdout', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '03-unfinished': { tasks: ['1.3'], notes: unfinishedNotes('ghostsprocket') },
      '04-impossible': { tasks: ['1.1', '1.3'], notes: notesText('x', '31/02/2026') },
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(lines(run.stderr)).toContain('skipped 03-unfinished: not finished');
    expect(lines(run.stderr)).toContain('skipped 04-impossible: not finished');
    expect(lines(run.stderr)).toContain('no finished section feeds task 1.3 (studied gate)');
  });

  test('AC-11: when the only mapped folders have no notes.md, exit 1 as well', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '03-empty-folder': { tasks: ['1.3'], notes: undefined } });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(lines(run.stderr)).toContain('skipped 03-empty-folder: no notes.md');
    expect(lines(run.stderr)).toContain('no finished section feeds task 1.3 (studied gate)');
  });
});

describe('brief: ids', () => {
  const idsFrom = (first: number, count: number): string[] =>
    Array.from(
      { length: count },
      (_unused, index) => `d1-1.3-${String(first + index).padStart(4, '0')}`,
    );

  test('AC-12: ten ids by default, consecutive from the next id of both folders, rejected and invalid files included', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    put(dir, BANK, 'd1-1.3-0003', 'in-bank');
    put(dir, DRAFTS, 'd1-1.3-0002', 'in-drafts', { status: 'draft' });
    put(dir, `${DRAFTS}/rejected`, 'd1-1.3-0010', 'was-rejected', { status: 'draft' });
    // A file that fails the schema still holds its id.
    write(
      dir,
      `${DRAFTS}/d1/1.3/broken.yaml`,
      stringify({ ...makeQuestion({ id: 'd1-1.3-0014' }), stem: 'short' }),
    );
    // Ids of other tasks do not count.
    put(dir, DRAFTS, 'd1-1.2-0099', 'other-task', { status: 'draft' });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(sectionLines(run, IDS)).toEqual(idsFrom(15, 10));
  });

  test('AC-12: --count gives exactly that many ids', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    put(dir, BANK, 'd1-1.3-0007', 'in-bank');

    const run = runCli(dir, ['brief', '1.3', '--count', '3']);

    expect(run.status).toBe(0);
    expect(sectionLines(run, IDS)).toEqual(idsFrom(8, 3));
  });

  test('AC-12: with empty folders the ids start at 0001', () => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3', '--count', '2']);

    expect(sectionLines(run, IDS)).toEqual(idsFrom(1, 2));
  });

  test.each([1, 50])('AC-12: --count %i is allowed', (count) => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3', '--count', String(count)]);

    expect(run.status).toBe(0);
    expect(sectionLines(run, IDS)).toEqual(idsFrom(1, count));
  });

  test('AC-12: ids are for the task of the brief, in its domain', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '03-ec2': { tasks: ['3.2', '1.2'], notes: notesText('ec2sprocket') } });
    put(dir, BANK, 'd3-3.2-0004', 'in-bank');

    const run = runCli(dir, ['brief', '3.2', '--count', '2']);

    expect(run.status).toBe(0);
    expect(sectionLines(run, IDS)).toEqual(['d3-3.2-0005', 'd3-3.2-0006']);
    expect(run.stdout.split(/\r?\n/)[0]).toMatch(/\(domain 3\)$/);
  });
});

describe('brief: existing questions', () => {
  test('AC-13: lists every question of the task from bank, drafts and rejected, sorted by id, stems on one line', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    // Ids and paths sort differently.
    put(dir, BANK, 'd1-1.3-0020', 'aaa-bank', { stem: 'The stem of the bank question is here.' });
    put(dir, DRAFTS, 'd1-1.3-0005', 'zzz-draft', {
      status: 'draft',
      stem: 'First half of the draft stem.\nSecond half of the draft stem.',
    });
    put(dir, DRAFTS, 'd1-1.3-0012', 'mmm-verified', {
      status: 'verified',
      stem: 'The stem of the verified draft.',
    });
    put(dir, `${DRAFTS}/rejected`, 'd1-1.3-0003', 'bbb-rejected', {
      status: 'draft',
      stem: 'The stem of the rejected draft.',
    });
    // Other tasks are not listed.
    put(dir, BANK, 'd1-1.2-0001', 'other-bank', { stem: 'OTHERBANKSTEM is another task.' });
    put(dir, DRAFTS, 'd2-2.1-0001', 'other-draft', {
      status: 'draft',
      stem: 'OTHERDRAFTSTEM is another task.',
    });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(sectionLines(run, EXISTING)).toEqual([
      '- d1-1.3-0003 (rejected) The stem of the rejected draft.',
      '- d1-1.3-0005 (draft) First half of the draft stem. Second half of the draft stem.',
      '- d1-1.3-0012 (draft) The stem of the verified draft.',
      '- d1-1.3-0020 (bank) The stem of the bank question is here.',
    ]);
    expect(run.stdout).not.toContain('OTHERBANKSTEM');
    expect(run.stdout).not.toContain('OTHERDRAFTSTEM');
  });

  test('AC-13: (none) when the task has no question, even if other tasks have some', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    put(dir, BANK, 'd1-1.2-0001', 'other-bank', { stem: 'OTHERBANKSTEM is another task.' });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(sectionLines(run, EXISTING)).toEqual(['(none)']);
  });

  test('AC-13: (none) with no folders at all', () => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(sectionLines(run, EXISTING)).toEqual(['(none)']);
  });
});

describe('brief: problems and usage errors', () => {
  test('AC-14: a map file that does not exist exits 1, names it, prints nothing on stdout', () => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3', '--map', 'no-such-map.yaml']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no-such-map.yaml');
  });

  test('AC-14: the default map missing in the notes folder exits 1', () => {
    const dir = makeTempDir();
    write(dir, `${NOTES}/05-main/notes.md`, notesText('mainsprocket'));

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toBe('');
  });

  test.each([
    ['invalid YAML', 'a: [unclosed\n'],
    ['a map that is not a mapping', '- a\n- b\n'],
    ['a task that is not in the catalog', '05-main: ["9.9"]\n'],
    ['an empty list', '05-main: []\n'],
    ['a duplicate task', '05-main: ["1.3", "1.3"]\n'],
  ])(
    'AC-14: a map with %s exits 1, prints the problem on stderr and nothing on stdout',
    (_name, map) => {
      const dir = makeTempDir();
      write(dir, `${NOTES}/05-main/notes.md`, notesText('mainsprocket'));
      write(dir, `${NOTES}/sections.yaml`, map);

      const run = runCli(dir, ['brief', '1.3']);

      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toBe('');
    },
  );

  test('AC-14: a notes folder that does not exist exits 1, names it, prints nothing on stdout', () => {
    const dir = makeTempDir();
    write(dir, 'map.yaml', sectionsYaml({ '05-main': ['1.3'] }));

    const run = runCli(dir, ['brief', '1.3', '--notes', 'no-such-notes', '--map', 'map.yaml']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no-such-notes');
  });

  test('AC-14: the default notes folder missing exits 1', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toBe('');
  });

  test.each([
    ['no task', ['brief']],
    ['a task that is not in the catalog', ['brief', '9.9']],
    ['a task that is not a task id', ['brief', 'abc']],
    ['--count 0', ['brief', '1.3', '--count', '0']],
    ['--count 51', ['brief', '1.3', '--count', '51']],
    ['--count abc', ['brief', '1.3', '--count', 'abc']],
    ['--count 2.5', ['brief', '1.3', '--count', '2.5']],
    ['--count -3', ['brief', '1.3', '--count', '-3']],
    ['--count with no value', ['brief', '1.3', '--count']],
    ['two tasks', ['brief', '1.3', '1.2']],
  ])('AC-14: %s exits 2 with the usage text', (_name, args) => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toMatch(/\bquestions brief\b/);
    expect(run.stdout).not.toContain('# Brief');
  });
});

describe('brief: write-to and folder options', () => {
  test('AC-15: Write to shows the default drafts folder, the domain and the task', () => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(sectionOf(run.stdout, WRITE_TO)).toContain(`${DRAFTS}/d1/1.3/<slug>.yaml`);
  });

  test('AC-15: Write to shows the drafts folder as given', () => {
    const dir = makeTempDir();
    simpleNotes(dir);

    const run = runCli(dir, ['brief', '1.3', '--drafts', 'my-drafts']);

    expect(sectionOf(run.stdout, WRITE_TO)).toContain('my-drafts/d1/1.3/<slug>.yaml');
    expect(sectionOf(run.stdout, WRITE_TO)).not.toContain(DRAFTS);
  });

  test('AC-15: Write to follows the domain and the task of the brief', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '03-ec2': { tasks: ['3.2', '4.2'], notes: notesText('ec2sprocket') } });

    const run = runCli(dir, ['brief', '4.2']);

    expect(run.status).toBe(0);
    expect(sectionOf(run.stdout, WRITE_TO)).toContain(`${DRAFTS}/d4/4.2/<slug>.yaml`);
  });

  test('AC-32: --drafts and --bank are the folders for ids and existing questions', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    put(dir, 'my-bank', 'd1-1.3-0030', 'in-custom-bank', { stem: 'The stem in the custom bank.' });
    put(dir, 'my-drafts', 'd1-1.3-0040', 'in-custom-drafts', {
      status: 'draft',
      stem: 'The stem in the custom drafts.',
    });
    // The default folders hold other questions that must not be read.
    put(dir, BANK, 'd1-1.3-0099', 'default-bank', { stem: 'DEFAULTBANKSTEM is not read.' });
    put(dir, DRAFTS, 'd1-1.3-0098', 'default-drafts', {
      status: 'draft',
      stem: 'DEFAULTDRAFTSTEM is not read.',
    });

    const run = runCli(dir, [
      'brief',
      '1.3',
      '--count',
      '2',
      '--drafts',
      'my-drafts',
      '--bank',
      'my-bank',
    ]);

    expect(run.status).toBe(0);
    expect(sectionLines(run, IDS)).toEqual(['d1-1.3-0041', 'd1-1.3-0042']);
    expect(sectionLines(run, EXISTING)).toEqual([
      '- d1-1.3-0030 (bank) The stem in the custom bank.',
      '- d1-1.3-0040 (draft) The stem in the custom drafts.',
    ]);
    expect(run.stdout).not.toContain('DEFAULT');
  });

  test('AC-32: a missing drafts or bank folder is treated as empty with the usual notice', () => {
    const dir = makeTempDir();
    simpleNotes(dir);
    mkdirSync(join(dir, 'my-bank'));

    const run = runCli(dir, ['brief', '1.3', '--drafts', 'no-drafts', '--bank', 'my-bank']);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('no folder at no-drafts, treated as empty');
    expect(sectionLines(run, IDS)).toHaveLength(10);
  });
});
