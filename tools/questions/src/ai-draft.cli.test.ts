// Spec 044, AC-3 to AC-15: the `questions ai-draft` command, run as a real process in temp folders.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import {
  aiDraftNotes,
  aiDraftNotesNoDateLine,
  studiedAiDraftNotes,
} from './__mocks__/ai-draft-fixtures.ts';
import { notesText, sectionsYaml, unfinishedNotes } from './__mocks__/brief-fixtures.ts';
import {
  BANK,
  DRAFTS,
  NOTES,
  cleanTempDirs,
  exists,
  lines,
  makeTempDir,
  put,
  readText,
  readYaml,
  runCli,
  sidecarOf,
  snapshot,
  write,
} from './__mocks__/cli-harness.ts';
import type { Run } from './__mocks__/cli-harness.ts';
import { questionYaml } from './__mocks__/fixtures.ts';
import { withSidecarKey } from './sidecar.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

interface Section {
  tasks: string[];
  /** The text of notes.md; `undefined` writes the map entry only (no folder at all). */
  notes: string | undefined;
}

/** Writes `<notes>/sections.yaml` and one `notes.md` per section folder. */
function setupNotes(dir: string, sections: Record<string, Section>, notes = NOTES): void {
  const map: Record<string, string[]> = {};
  for (const [folder, section] of Object.entries(sections)) {
    map[folder] = section.tasks;
    if (section.notes !== undefined) write(dir, `${notes}/${folder}/notes.md`, section.notes);
  }
  write(dir, `${notes}/sections.yaml`, sectionsYaml(map));
}

const ID = 'd1-1.3-0007';
const SLUG = 'sse-keys';
const PATH = `d1/1.3/${SLUG}.yaml`;
const SIDECAR_PATH = sidecarOf(PATH);

/** Feed order for 1.3: 02-draft-a and 05-studied (main), then 01-draft-b (also). */
const SCENE_SECTIONS: Record<string, Section> = {
  '02-draft-a': { tasks: ['1.3'], notes: aiDraftNotes('draftasprocket') },
  '05-studied': { tasks: ['1.3'], notes: notesText('studiedsprocket') },
  '01-draft-b': { tasks: ['2.2', '1.3'], notes: aiDraftNotes('draftbsprocket') },
};
const SCENE_FOLDERS = ['02-draft-a', '01-draft-b'];

/** The notes, a bank question (so that no "treated as empty" notice is printed) and one draft. */
function scene(): string {
  const dir = makeTempDir();
  setupNotes(dir, SCENE_SECTIONS);
  put(dir, BANK, 'd1-1.3-0500', 'in-bank');
  put(dir, DRAFTS, ID, SLUG, { status: 'draft' });
  return dir;
}

/** Another draft of the same task. */
function putDraft(dir: string, id: string, slug: string): string {
  return put(dir, DRAFTS, id, slug, { status: 'draft' });
}

/** The stdout line of one draft. */
function markLine(id: string, path: string, folders: string[], drafts = DRAFTS): string {
  return `${id} ${drafts}/${path}: AI-draft notes from ${folders.join(', ')}`;
}

const TO_MARK = (n: number): string => `to mark: ${String(n)} (add --write to record it)`;
const MARKED = (n: number): string => `marked: ${String(n)}`;

/** The text that `withSidecarKey` refuses a sidecar with. */
function refusal(existing: string): string {
  try {
    withSidecarKey(existing, 'ai_draft', { sections: ['x'] });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('withSidecarKey accepted this sidecar');
}

/** The whole stderr with LF line ends and no trailing line break (messages may span lines). */
function stderrText(run: Run): string {
  return run.stderr.replace(/\r\n/g, '\n').trimEnd();
}

/** The files and bytes under the temp folder that are not in `before`, or differ from it. */
function changedSince(before: Record<string, string>, dir: string): string[] {
  const after = snapshot(dir);
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

const USAGE_COMMAND = 'questions ai-draft <id>... [--write] [--notes <dir>] [--map <file>]';
const USAGE_DESCRIPTION = "record in each draft's check file that AI-draft notes fed its brief";

/** Asserts exit 2, an empty stdout, the usage text on stderr and the ai-draft entry in it. */
function expectUsageWithAiDraft(run: Run): void {
  expect(run.status).toBe(2);
  expect(run.stdout).toBe('');
  const trimmed = run.stderr.split(/\r?\n/).map((line) => line.trim());
  expect(trimmed[0]).toBe('Usage:');
  const at = trimmed.indexOf(USAGE_COMMAND);
  expect(at).toBeGreaterThan(0);
  expect(trimmed[at + 1]).toBe(USAGE_DESCRIPTION);
}

describe('ai-draft --write', () => {
  test('AC-3: prints the draft line and marked: 1, exits 0 and prints nothing on stderr', () => {
    const dir = scene();

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, SCENE_FOLDERS), MARKED(1)]);
    expect(run.stderr).toBe('');
  });

  test('AC-3: the new sidecar holds exactly ai_draft.sections with the AI-draft folders, in feed order', () => {
    const dir = scene();

    runCli(dir, ['ai-draft', ID, '--write']);

    expect(readYaml(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toEqual({
      ai_draft: { sections: SCENE_FOLDERS },
    });
  });

  test('AC-3: the only change in the tree is the new sidecar; the draft keeps its bytes', () => {
    const dir = scene();
    const before = snapshot(dir);

    runCli(dir, ['ai-draft', ID, '--write']);

    expect(changedSince(before, dir)).toEqual([`${DRAFTS}/${SIDECAR_PATH}`]);
  });

  test('AC-3: a studied section that kept the AI-draft line, a not-finished one and a missing one are left out', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '01-both': { tasks: ['1.3'], notes: studiedAiDraftNotes('bothsprocket') },
      '02-nodate': { tasks: ['1.3'], notes: aiDraftNotesNoDateLine('nodatesprocket') },
      '03-unfinished': { tasks: ['1.3'], notes: unfinishedNotes('ghostsprocket') },
      '04-gone': { tasks: ['1.3'], notes: undefined },
      '05-other-task': { tasks: ['2.2'], notes: aiDraftNotes('othersprocket') },
    });
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    putDraft(dir, ID, SLUG);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, ['02-nodate']), MARKED(1)]);
    expect(readYaml(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toEqual({
      ai_draft: { sections: ['02-nodate'] },
    });
  });

  test('AC-3: each draft gets the sections of its own task', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '01-draft-first': { tasks: ['1.1'], notes: aiDraftNotes('firstsprocket') },
      '02-draft-third': { tasks: ['1.3'], notes: aiDraftNotes('thirdsprocket') },
    });
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    const first = putDraft(dir, 'd1-1.1-0002', 'first-task');
    const third = putDraft(dir, ID, SLUG);

    const run = runCli(dir, ['ai-draft', 'd1-1.1-0002', ID, '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([
      markLine('d1-1.1-0002', first, ['01-draft-first']),
      markLine(ID, third, ['02-draft-third']),
      MARKED(2),
    ]);
    expect(readYaml(dir, `${DRAFTS}/${sidecarOf(first)}`)).toEqual({
      ai_draft: { sections: ['01-draft-first'] },
    });
    expect(readYaml(dir, `${DRAFTS}/${sidecarOf(third)}`)).toEqual({
      ai_draft: { sections: ['02-draft-third'] },
    });
  });

  test('AC-3: several ids give one line each, in the order given, and marked: n', () => {
    const dir = scene();
    const second = putDraft(dir, 'd1-1.3-0003', 'aaa-second');
    const third = putDraft(dir, 'd1-1.3-0009', 'zzz-third');

    const run = runCli(dir, ['ai-draft', 'd1-1.3-0009', ID, 'd1-1.3-0003', '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([
      markLine('d1-1.3-0009', third, SCENE_FOLDERS),
      markLine(ID, PATH, SCENE_FOLDERS),
      markLine('d1-1.3-0003', second, SCENE_FOLDERS),
      MARKED(3),
    ]);
    for (const path of [PATH, second, third]) {
      expect(readYaml(dir, `${DRAFTS}/${sidecarOf(path)}`)).toEqual({
        ai_draft: { sections: SCENE_FOLDERS },
      });
    }
  });

  test('AC-3: the options may come before, between and after the ids', () => {
    const dir = scene();
    const second = putDraft(dir, 'd1-1.3-0003', 'aaa-second');

    const run = runCli(dir, ['ai-draft', '--write', ID, '--notes', NOTES, 'd1-1.3-0003']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([
      markLine(ID, PATH, SCENE_FOLDERS),
      markLine('d1-1.3-0003', second, SCENE_FOLDERS),
      MARKED(2),
    ]);
  });

  test('AC-3: --drafts, --bank, --notes and --map move every path', () => {
    const dir = makeTempDir();
    setupNotes(dir, SCENE_SECTIONS, 'my-notes');
    write(dir, 'maps/other.yaml', sectionsYaml({ '09-only-this': ['1.3'] }));
    write(dir, 'my-notes/09-only-this/notes.md', aiDraftNotes('onlysprocket'));
    put(dir, 'my-bank', 'd1-1.3-0500', 'in-bank');
    put(dir, 'my-drafts', ID, SLUG, { status: 'draft' });

    const withNotes = runCli(dir, [
      'ai-draft',
      ID,
      '--drafts',
      'my-drafts',
      '--bank',
      'my-bank',
      '--notes',
      'my-notes',
      '--write',
    ]);
    const withMap = runCli(dir, [
      'ai-draft',
      ID,
      '--drafts',
      'my-drafts',
      '--bank',
      'my-bank',
      '--notes',
      'my-notes',
      '--map',
      'maps/other.yaml',
      '--write',
    ]);

    expect(withNotes.status).toBe(0);
    expect(lines(withNotes.stdout)).toEqual([
      markLine(ID, PATH, SCENE_FOLDERS, 'my-drafts'),
      MARKED(1),
    ]);
    expect(withMap.status).toBe(0);
    expect(lines(withMap.stdout)).toEqual([
      markLine(ID, PATH, ['09-only-this'], 'my-drafts'),
      MARKED(1),
    ]);
    expect(readYaml(dir, `my-drafts/${SIDECAR_PATH}`)).toEqual({
      ai_draft: { sections: ['09-only-this'] },
    });
    expect(exists(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toBe(false);
  });

  test('AC-3: a sidecar that is an empty file is filled in', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, '');

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(0);
    expect(readYaml(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toEqual({
      ai_draft: { sections: SCENE_FOLDERS },
    });
  });
});

describe('ai-draft keeps the other keys of an existing sidecar', () => {
  const OLD = [
    '# check file, written by the tools',
    'verification:',
    '  result: verified   # the verifier agreed',
    '  verifier: claude-opus',
    '  reasons: []',
    'dedupe:',
    '  threshold: 0.5',
    '  similar:',
    '    - id: d1-1.3-0042',
    '      score: 0.62',
    '',
  ].join('\n');

  test('AC-4: verification and dedupe keep their values and ai_draft is added', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, OLD);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(0);
    const after = readYaml(dir, `${DRAFTS}/${SIDECAR_PATH}`) as Record<string, unknown>;
    expect(after).toEqual({ ...(parse(OLD) as object), ai_draft: { sections: SCENE_FOLDERS } });
    expect(Object.keys(after)).toEqual(['verification', 'dedupe', 'ai_draft']);
  });

  test('AC-4: the comment and the text lines of the other keys are unchanged', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, OLD);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(0);
    const text = readText(dir, `${DRAFTS}/${SIDECAR_PATH}`);
    expect(text).toContain('ai_draft:');
    expect(text.startsWith(OLD)).toBe(true);
    expect(text.split('\n')[0]).toBe('# check file, written by the tools');
    expect(text).toContain('  result: verified   # the verifier agreed\n');
  });

  test('AC-4: only that sidecar changes', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, OLD);
    const before = snapshot(dir);

    runCli(dir, ['ai-draft', ID, '--write']);

    expect(changedSince(before, dir)).toEqual([`${DRAFTS}/${SIDECAR_PATH}`]);
  });
});

describe('ai-draft without --write', () => {
  test('AC-5: prints the draft line and the to-mark line, and exits 0', () => {
    const dir = scene();

    const run = runCli(dir, ['ai-draft', ID]);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, SCENE_FOLDERS), TO_MARK(1)]);
    expect(run.stderr).toBe('');
  });

  test('AC-5: no file is created, changed or deleted (bytes and file list)', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID]);

    expect(run.status).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-5: an existing sidecar keeps its bytes', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, 'keep: me   # by hand\r\nverification:\r\n  a: 1\r\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID]);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, SCENE_FOLDERS), TO_MARK(1)]);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-5: the count is the number of drafts', () => {
    const dir = scene();
    putDraft(dir, 'd1-1.3-0003', 'aaa-second');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0003']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toHaveLength(3);
    expect(lines(run.stdout).at(-1)).toBe(TO_MARK(2));
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('ai-draft with an id that is not a draft', () => {
  test('AC-6: an unknown id is reported, nothing is written, also for the good id', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0099', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.3-0099: no draft has this id']);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-6: the same when the unknown id comes first', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', 'd1-1.3-0099', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.3-0099: no draft has this id']);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-6: the existing sidecar of the good id is not changed either', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, 'verification:\n  result: verified\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0099', '--write']);

    expect(run.status).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-6: every unknown id is reported, in the order given', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', 'd1-1.3-0098', ID, 'd1-1.3-0099', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([
      'd1-1.3-0098: no draft has this id',
      'd1-1.3-0099: no draft has this id',
    ]);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-6: without --write the unknown id is reported just the same', () => {
    const dir = scene();

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0099']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.3-0099: no draft has this id']);
    expect(run.stdout).toBe('');
  });

  test('AC-8: the id of a bank question is not a draft', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', 'd1-1.3-0500', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.3-0500: no draft has this id']);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-8: a bank id next to a good draft id still marks nothing', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0500', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.3-0500: no draft has this id']);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('ai-draft for a draft that no AI-draft notes feed', () => {
  /** The notes setups under which task 1.3 has no AI-draft section. */
  const SETUPS: [string, Record<string, Section>][] = [
    [
      'only studied sections feed the task',
      { '01-studied': { tasks: ['1.3'], notes: notesText('studiedsprocket') } },
    ],
    [
      'a studied section that kept the AI-draft line',
      { '01-both': { tasks: ['1.3'], notes: studiedAiDraftNotes('bothsprocket') } },
    ],
    [
      'only not-finished sections feed the task',
      { '01-unfinished': { tasks: ['1.3'], notes: unfinishedNotes('ghostsprocket') } },
    ],
    ['the feeding section has no notes.md', { '01-gone': { tasks: ['1.3'], notes: undefined } }],
    [
      'the AI-draft section feeds another task',
      { '01-draft-other': { tasks: ['2.2'], notes: aiDraftNotes('othersprocket') } },
    ],
  ];

  describe.each([[[] as string[]], [['--write']]])('with %j', (extra) => {
    test.each(SETUPS)('AC-7: %s: reported, exit 1, nothing written', (_name, sections) => {
      const dir = makeTempDir();
      setupNotes(dir, sections);
      put(dir, BANK, 'd1-1.3-0500', 'in-bank');
      putDraft(dir, ID, SLUG);
      const before = snapshot(dir);

      const run = runCli(dir, ['ai-draft', ID, ...extra]);

      expect(run.status).toBe(1);
      expect(lines(run.stderr)).toEqual([`${ID}: no AI-draft notes feed task 1.3`]);
      expect(run.stdout).toBe('');
      expect(snapshot(dir)).toEqual(before);
    });
  });

  test('AC-7: the message names the task of the draft', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '01-draft-other': { tasks: ['1.3'], notes: aiDraftNotes('othersprocket') } });
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    putDraft(dir, 'd1-1.1-0002', 'first-task');

    const run = runCli(dir, ['ai-draft', 'd1-1.1-0002', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.1-0002: no AI-draft notes feed task 1.1']);
  });

  test('AC-7: a good draft next to it is not marked either', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '01-draft-first': { tasks: ['1.1'], notes: aiDraftNotes('firstsprocket') } });
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    putDraft(dir, 'd1-1.1-0002', 'first-task');
    putDraft(dir, ID, SLUG);
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', 'd1-1.1-0002', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([`${ID}: no AI-draft notes feed task 1.3`]);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-7: an unknown id and a draft without AI-draft notes are both reported', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '01-draft-first': { tasks: ['1.1'], notes: aiDraftNotes('firstsprocket') } });
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    putDraft(dir, ID, SLUG);
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0099', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr).sort()).toEqual(
      [`${ID}: no AI-draft notes feed task 1.3`, 'd1-1.3-0099: no draft has this id'].sort(),
    );
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('ai-draft with a sidecar that cannot be updated', () => {
  const BAD: [string, string][] = [
    ['a flow mapping', '{a: 1}\n'],
    ['a list', '- a\n- b\n'],
    ['invalid YAML', 'a: [unclosed\n'],
  ];
  const GOOD_OLD = 'keep: me   # by hand\nverification:\n  result: verified\n';

  /** Three drafts in path order; aaa has no sidecar, mmm a good one. */
  function three(): string {
    const dir = scene();
    putDraft(dir, 'd1-1.3-0011', 'aaa-first');
    putDraft(dir, 'd1-1.3-0012', 'mmm-middle');
    putDraft(dir, 'd1-1.3-0013', 'zzz-last');
    write(dir, `${DRAFTS}/d1/1.3/mmm-middle.check.yaml`, GOOD_OLD);
    return dir;
  }
  const IDS = ['d1-1.3-0011', 'd1-1.3-0012', 'd1-1.3-0013'];

  test.each(BAD)(
    'AC-9: %s: stderr names the sidecar with its folder and the message, exit 1, nothing changes (last draft)',
    (_name, content) => {
      const dir = three();
      write(dir, `${DRAFTS}/d1/1.3/zzz-last.check.yaml`, content);
      const before = snapshot(dir);

      const run = runCli(dir, ['ai-draft', ...IDS, '--write']);

      expect(run.status).toBe(1);
      expect(stderrText(run)).toBe(
        `${DRAFTS}/d1/1.3/zzz-last.check.yaml: ${refusal(content)}`.trimEnd(),
      );
      expect(run.stdout).toBe('');
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test.each(BAD)(
    'AC-9: %s: nothing changes either when the bad sidecar belongs to the first draft',
    (_name, content) => {
      const dir = three();
      write(dir, `${DRAFTS}/d1/1.3/aaa-first.check.yaml`, content);
      const before = snapshot(dir);

      const run = runCli(dir, ['ai-draft', ...IDS, '--write']);

      expect(run.status).toBe(1);
      expect(stderrText(run)).toBe(
        `${DRAFTS}/d1/1.3/aaa-first.check.yaml: ${refusal(content)}`.trimEnd(),
      );
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test('AC-9: every bad sidecar is reported', () => {
    const dir = three();
    write(dir, `${DRAFTS}/d1/1.3/aaa-first.check.yaml`, '{a: 1}\n');
    write(dir, `${DRAFTS}/d1/1.3/zzz-last.check.yaml`, '- a\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ...IDS, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr).sort()).toEqual(
      [
        `${DRAFTS}/d1/1.3/aaa-first.check.yaml: ${refusal('{a: 1}\n')}`,
        `${DRAFTS}/d1/1.3/zzz-last.check.yaml: ${refusal('- a\n')}`,
      ].sort(),
    );
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-9: the folder in the message is the one given with --drafts', () => {
    const dir = makeTempDir();
    setupNotes(dir, SCENE_SECTIONS);
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    put(dir, 'my-drafts', ID, SLUG, { status: 'draft' });
    write(dir, `my-drafts/${SIDECAR_PATH}`, '{a: 1}\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--drafts', 'my-drafts', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([`my-drafts/${SIDECAR_PATH}: ${refusal('{a: 1}\n')}`]);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-9: a write that fails reports it, exit 1, and puts every sidecar back', () => {
    const dir = scene();
    putDraft(dir, 'd1-1.3-0003', 'aaa-first');
    putDraft(dir, 'd1-1.3-0004', 'zzz-last');
    write(dir, `${DRAFTS}/d1/1.3/aaa-first.check.yaml`, GOOD_OLD);
    mkdirSync(join(dir, DRAFTS, 'd1', '1.3', 'zzz-last.check.yaml'), { recursive: true });
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', 'd1-1.3-0003', 'd1-1.3-0004', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toHaveLength(1);
    expect(lines(run.stderr)[0]).toMatch(
      /^questions: could not write private\/questions-drafts\/d1\/1\.3\/zzz-last\.check\.yaml \([A-Z]+\); no sidecar was changed$/,
    );
    expect(run.stdout).not.toContain('marked:');
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('ai-draft with a missing notes folder or section map', () => {
  /** A bank question and a draft, no notes at all. */
  function noNotes(): string {
    const dir = makeTempDir();
    put(dir, BANK, 'd1-1.3-0500', 'in-bank');
    putDraft(dir, ID, SLUG);
    return dir;
  }

  test('AC-10: no notes folder: the default folder is named, exit 1, nothing written', () => {
    const dir = noNotes();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['no notes folder at private/notes-import']);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-10: no notes folder: the folder given with --notes is named', () => {
    const dir = noNotes();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--notes', 'my-notes', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['no notes folder at my-notes']);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-10: no notes folder, without --write: the same message and exit 1', () => {
    const dir = noNotes();

    const run = runCli(dir, ['ai-draft', ID]);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['no notes folder at private/notes-import']);
    expect(run.stdout).toBe('');
  });

  test('AC-10: no section map: the default file is named, exit 1, nothing written', () => {
    const dir = noNotes();
    write(dir, `${NOTES}/01-draft/notes.md`, aiDraftNotes('draftsprocket'));
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([`no section map at ${NOTES}/sections.yaml`]);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-10: no section map: the default file lives in the folder given with --notes', () => {
    const dir = noNotes();
    write(dir, 'my-notes/01-draft/notes.md', aiDraftNotes('draftsprocket'));
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--notes', 'my-notes', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['no section map at my-notes/sections.yaml']);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-10: no section map: the file given with --map is named', () => {
    const dir = noNotes();
    write(dir, `${NOTES}/sections.yaml`, sectionsYaml({ '01-draft': ['1.3'] }));
    write(dir, `${NOTES}/01-draft/notes.md`, aiDraftNotes('draftsprocket'));
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--map', 'maps/missing.yaml', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['no section map at maps/missing.yaml']);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  const BAD_MAPS: [string, string, string][] = [
    [
      'a map that is not a mapping',
      '- a\n- b\n',
      'the section map must be a mapping from folder name to task ids',
    ],
    ['an empty list', '05-main: []\n', '05-main: must be a non-empty list of task ids'],
    [
      'a task that is not in the catalog',
      '05-main: ["9.9"]\n',
      '05-main: 9.9 is not a task id of the catalog (quote it)',
    ],
    ['a duplicate task', '05-main: ["1.3", "1.3"]\n', '05-main: task 1.3 is listed twice'],
  ];

  test.each(BAD_MAPS)(
    'AC-10: a map with %s: the problem is printed as brief prints it, exit 1, nothing written',
    (_name, map, problem) => {
      const dir = noNotes();
      write(dir, `${NOTES}/sections.yaml`, map);
      const before = snapshot(dir);

      const run = runCli(dir, ['ai-draft', ID, '--write']);

      expect(run.status).toBe(1);
      expect(lines(run.stderr)).toEqual([`${NOTES}/sections.yaml: ${problem}`]);
      expect(run.stdout).toBe('');
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test('AC-10: a map with invalid YAML is reported with the map file in front, exit 1', () => {
    const dir = noNotes();
    write(dir, `${NOTES}/sections.yaml`, 'a: [unclosed\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)[0]).toMatch(/^private\/notes-import\/sections\.yaml: invalid YAML: /);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('ai-draft with repeated ids', () => {
  test('AC-11: an id given twice is marked once', () => {
    const dir = scene();

    const run = runCli(dir, ['ai-draft', ID, ID, '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, SCENE_FOLDERS), MARKED(1)]);
    expect(readYaml(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toEqual({
      ai_draft: { sections: SCENE_FOLDERS },
    });
  });

  test('AC-11: an id given twice around another one keeps the first position, one line each', () => {
    const dir = scene();
    const second = putDraft(dir, 'd1-1.3-0003', 'aaa-second');

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0003', ID, '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([
      markLine(ID, PATH, SCENE_FOLDERS),
      markLine('d1-1.3-0003', second, SCENE_FOLDERS),
      MARKED(2),
    ]);
  });

  test('AC-11: without --write the count is also one', () => {
    const dir = scene();

    const run = runCli(dir, ['ai-draft', ID, ID]);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, SCENE_FOLDERS), TO_MARK(1)]);
  });

  test('AC-11: an unknown id given twice is reported once', () => {
    const dir = scene();

    const run = runCli(dir, ['ai-draft', ID, 'd1-1.3-0099', 'd1-1.3-0099', '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual(['d1-1.3-0099: no draft has this id']);
  });
});

describe('ai-draft run again', () => {
  test('AC-12: the second --write gives the same sidecar bytes', () => {
    const dir = scene();

    runCli(dir, ['ai-draft', ID, '--write']);
    const first = readText(dir, `${DRAFTS}/${SIDECAR_PATH}`);
    const second = runCli(dir, ['ai-draft', ID, '--write']);

    expect(second.status).toBe(0);
    expect(lines(second.stdout)).toEqual([markLine(ID, PATH, SCENE_FOLDERS), MARKED(1)]);
    expect(readText(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toBe(first);
  });

  test('AC-12: the second --write leaves the whole tree as it was after the first', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, '# kept\nverification:\n  result: verified\n');

    runCli(dir, ['ai-draft', ID, '--write']);
    const afterFirst = snapshot(dir);
    const second = runCli(dir, ['ai-draft', ID, '--write']);

    expect(second.status).toBe(0);
    expect(readText(dir, `${DRAFTS}/${SIDECAR_PATH}`)).toContain('ai_draft:');
    expect(snapshot(dir)).toEqual(afterFirst);
  });

  test('AC-12: a run replaces the key with the current sections and keeps the rest', () => {
    const dir = scene();
    const old = '# kept\nverification:\n  result: verified\n';
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, old);
    runCli(dir, ['ai-draft', ID, '--write']);
    // 02-draft-a gets studied: only 01-draft-b is still AI draft.
    write(dir, `${NOTES}/02-draft-a/notes.md`, notesText('studiednowsprocket'));

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toEqual([markLine(ID, PATH, ['01-draft-b']), MARKED(1)]);
    const text = readText(dir, `${DRAFTS}/${SIDECAR_PATH}`);
    expect(parse(text)).toEqual({
      verification: { result: 'verified' },
      ai_draft: { sections: ['01-draft-b'] },
    });
    expect(text.match(/^ai_draft:/gm)).toHaveLength(1);
    expect(text.startsWith(old)).toBe(true);
  });
});

describe('ai-draft usage errors', () => {
  test('AC-13: no id exits 2 with the usage text, which lists the ai-draft entry', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft']);

    expectUsageWithAiDraft(run);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-13: --write without an id exits 2 with the usage text and writes nothing', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', '--write']);

    expectUsageWithAiDraft(run);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-13: --threshold is not a flag of ai-draft: exit 2 with the usage text', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', '--threshold', '1', ID]);

    expectUsageWithAiDraft(run);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-13: --studied-only is not a flag of ai-draft: exit 2 with the usage text', () => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', '--studied-only', ID]);

    expectUsageWithAiDraft(run);
    expect(snapshot(dir)).toEqual(before);
  });

  test.each([
    ['an unknown flag', ['ai-draft', ID, '--bogus']],
    ['an unknown flag with --write', ['ai-draft', ID, '--write', '--bogus']],
    ['--dry-run', ['ai-draft', ID, '--dry-run']],
    ['--count', ['ai-draft', ID, '--count', '3']],
    ['--notes without a value', ['ai-draft', ID, '--notes']],
    ['--map followed by a flag', ['ai-draft', ID, '--map', '--write']],
  ])('AC-13: %s exits 2 with the usage text and writes nothing', (_name, args) => {
    const dir = scene();
    const before = snapshot(dir);

    const run = runCli(dir, args);

    expectUsageWithAiDraft(run);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-13: the usage text lists the ai-draft entry on any usage error, here for check', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['check', '--bogus']);

    expectUsageWithAiDraft(run);
  });

  test('AC-13: the usage text still lists the other commands', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['ai-draft']);

    for (const command of ['check', 'next-id', 'promote', 'dedupe', 'brief', 'blind', 'verdict']) {
      expect(run.stderr).toMatch(new RegExp(`^ {2}questions ${command}\\b`, 'm'));
    }
  });
});

describe('--write is still refused by the other commands', () => {
  const REFUSED: [string, string[]][] = [
    ['check', ['check', '--write']],
    ['brief', ['brief', '1.3', '--write']],
    ['blind', ['blind', '--pending', '--write']],
    ['next-id', ['next-id', '1.3', '--write']],
    ['promote', ['promote', '--write']],
  ];

  test.each(REFUSED)(
    'AC-14: %s --write exits 2 with the usage text and writes nothing',
    (_name, args) => {
      const dir = scene();
      const before = snapshot(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr.startsWith('Usage:')).toBe(true);
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test.each(REFUSED)(
    'AC-14: %s --write is refused with the ai-draft entry in the usage text',
    (_name, args) => {
      const dir = scene();

      const run = runCli(dir, args);

      expectUsageWithAiDraft(run);
    },
  );

  test.each([
    ['--notes', ['check', '--notes', NOTES]],
    ['--map', ['check', '--map', 'x.yaml']],
  ])('AC-14: check %s is still refused', (_name, args) => {
    const dir = scene();

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.stderr.startsWith('Usage:')).toBe(true);
  });
});

describe('ai-draft reads both folders like dedupe', () => {
  test('AC-15: an invalid draft is printed with its folder, exit 1, nothing written, also for the good draft', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/d2/misplaced.yaml`, questionYaml({ id: 'd1-1.3-0009', status: 'draft' }));
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([
      `${DRAFTS}/d2/misplaced.yaml: wrong location, expected d1/1.3/misplaced.yaml`,
    ]);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-15: the same without --write', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/d2/misplaced.yaml`, questionYaml({ id: 'd1-1.3-0009', status: 'draft' }));

    const run = runCli(dir, ['ai-draft', ID]);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([
      `${DRAFTS}/d2/misplaced.yaml: wrong location, expected d1/1.3/misplaced.yaml`,
    ]);
    expect(run.stdout).toBe('');
  });

  test('AC-15: a draft that is not YAML is a problem too, nothing written', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/d1/1.3/broken.yaml`, 'id: [unclosed\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    // The YAML error message may run over several lines; the problem is one entry that starts here.
    expect(run.stderr).toMatch(
      /^private\/questions-drafts\/d1\/1\.3\/broken\.yaml: invalid YAML: /,
    );
    expect(run.stderr.match(/^\S+\.yaml: /gm)).toHaveLength(1);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-15: an invalid bank file is printed with the bank folder, exit 1, nothing written', () => {
    const dir = scene();
    write(dir, `${BANK}/d1/1.3/broken.yaml`, 'id: [unclosed\n');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^questions\/d1\/1\.3\/broken\.yaml: invalid YAML: /);
    expect(run.stderr.match(/^\S+\.yaml: /gm)).toHaveLength(1);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-15: a draft whose id is already in the bank is a problem, nothing written', () => {
    const dir = scene();
    put(dir, BANK, 'd1-1.3-0004', 'taken');
    putDraft(dir, 'd1-1.3-0004', 'copy');
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(lines(run.stderr)).toEqual([
      `${DRAFTS}/d1/1.3/copy.yaml: id d1-1.3-0004 is already used in the bank by ${BANK}/d1/1.3/taken.yaml`,
    ]);
    expect(run.stdout).toBe('');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-15: an existing sidecar of the good draft keeps its bytes when a draft is invalid', () => {
    const dir = scene();
    write(dir, `${DRAFTS}/${SIDECAR_PATH}`, 'verification:\r\n  result: verified\r\n');
    write(dir, `${DRAFTS}/d2/misplaced.yaml`, questionYaml({ id: 'd1-1.3-0009', status: 'draft' }));
    const before = snapshot(dir);

    const run = runCli(dir, ['ai-draft', ID, '--write']);

    expect(run.status).toBe(1);
    expect(snapshot(dir)).toEqual(before);
  });
});
