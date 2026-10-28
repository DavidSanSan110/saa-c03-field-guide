import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BRIEF_USAGE_FIRST_LINE,
  BRIEF_USAGE_NOTE_LINES,
  PARAGRAPH,
  aiDraftHeading,
  aiDraftNotes,
  studiedAiDraftNotes,
} from './__mocks__/ai-draft-fixtures.ts';
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
  write,
} from './__mocks__/cli-harness.ts';
import type { Run } from './__mocks__/cli-harness.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanTempDirs);

/** Writes `<notes>/sections.yaml` and one `notes.md` per section folder. */
function setupNotes(
  dir: string,
  sections: Record<string, { tasks: string[]; notes: string }>,
): void {
  const map: Record<string, string[]> = {};
  for (const [folder, section] of Object.entries(sections)) {
    map[folder] = section.tasks;
    write(dir, `${NOTES}/${folder}/notes.md`, section.notes);
  }
  write(dir, `${NOTES}/sections.yaml`, sectionsYaml(map));
}

const DRAFT_MAIN = aiDraftNotes('draftmainsprocket');
const STUDIED_MAIN = notesText('studiedmainsprocket');
const BOTH_ALSO = studiedAiDraftNotes('bothalsosprocket');

/** The map of AC-5: names that sort differently from the feed order. */
function setupMixed(dir: string): void {
  setupNotes(dir, {
    '02-draft-main': { tasks: ['1.3'], notes: DRAFT_MAIN },
    '05-studied-main': { tasks: ['1.3'], notes: STUDIED_MAIN },
    '01-both-also': { tasks: ['2.2', '1.3'], notes: BOTH_ALSO },
  });
}

/** The `###` heading lines of the study notes, in order. */
function noteHeadings(run: Run): string[] {
  return tailAfter(run.stdout, '## Study notes')
    .split('\n')
    .filter((row) => row.startsWith('### '));
}

/** The stderr lines that report what happened to a section, in order. */
function sectionReports(run: Run): string[] {
  return lines(run.stderr).filter((line) => /^(included|skipped) /.test(line));
}

/** The stdout with the full texts of the given notes taken out. */
function withoutNotes(stdout: string, texts: string[]): string {
  return texts.reduce((rest, text) => rest.split(text.trimEnd()).join(''), stdout);
}

describe('brief: AI-draft sections feed the brief, labelled', () => {
  test('AC-5: headings, labels and feed order of AI-draft, studied and both-kinds sections', () => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(noteHeadings(run)).toEqual([
      aiDraftHeading('02-draft-main'),
      '### 05-studied-main',
      '### 01-both-also',
    ]);
  });

  test('AC-5: each notes text is there in full under its heading', () => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    const study = tailAfter(run.stdout, '## Study notes');
    const spots = [
      [aiDraftHeading('02-draft-main'), DRAFT_MAIN],
      ['### 05-studied-main', STUDIED_MAIN],
      ['### 01-both-also', BOTH_ALSO],
    ] as [string, string][];
    let from = 0;
    for (const [heading, text] of spots) {
      const headingAt = study.indexOf(heading, from);
      const textAt = study.indexOf(text.trimEnd(), from);
      expect(headingAt).toBeGreaterThanOrEqual(from);
      expect(textAt).toBeGreaterThan(headingAt);
      from = textAt + text.trimEnd().length;
    }
  });

  test('AC-5: the paragraph is printed, once, on top of the study notes', () => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      `## Study notes\n\n${PARAGRAPH}\n\n${aiDraftHeading('02-draft-main')}\n\n`,
    );
    expect(run.stdout.split(PARAGRAPH).length - 1).toBe(1);
  });

  test('AC-5: stderr reports only the AI-draft section as included, and skips nothing', () => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(sectionReports(run)).toEqual(['included 02-draft-main: AI draft']);
  });

  test('AC-5: a studied section that kept the AI-draft line has no label and no stderr line', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '01-both-also': { tasks: ['1.3'], notes: BOTH_ALSO } });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(noteHeadings(run)).toEqual(['### 01-both-also']);
    expect(run.stdout).not.toContain(PARAGRAPH);
    expect(run.stdout).not.toContain('(AI draft, not studied yet)');
    expect(sectionReports(run)).toEqual([]);
  });

  test('AC-5: studied sections only give the spec 022 brief: plain headings and no paragraph', () => {
    const dir = makeTempDir();
    setupNotes(dir, { '05-studied-main': { tasks: ['1.3'], notes: STUDIED_MAIN } });

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(noteHeadings(run)).toEqual(['### 05-studied-main']);
    expect(run.stdout).not.toContain(PARAGRAPH);
    expect(run.stdout).not.toContain('AI draft');
    expect(sectionReports(run)).toEqual([]);
  });

  test('AC-6: with only AI-draft and not-finished sections, the drafts are in, the rest is skipped', () => {
    const dir = makeTempDir();
    // Feed order: 03-draft-main, 04-unfinished-main, 01-draft-also, 02-unfinished-also.
    setupNotes(dir, {
      '03-draft-main': { tasks: ['1.3'], notes: aiDraftNotes('draftmainsprocket') },
      '04-unfinished-main': { tasks: ['1.3'], notes: unfinishedNotes('ghostmainsprocket') },
      '01-draft-also': { tasks: ['2.2', '1.3'], notes: aiDraftNotes('draftalsosprocket') },
      '02-unfinished-also': { tasks: ['1.1', '1.3'], notes: unfinishedNotes('ghostalsosprocket') },
    });
    put(dir, BANK, 'd1-1.3-0004', 'in-bank');

    const run = runCli(dir, ['brief', '1.3', '--count', '3']);

    expect(run.status).toBe(0);
    expect(noteHeadings(run)).toEqual([
      aiDraftHeading('03-draft-main'),
      aiDraftHeading('01-draft-also'),
    ]);
    expect(run.stdout).toContain(aiDraftNotes('draftmainsprocket').trimEnd());
    expect(run.stdout).toContain(aiDraftNotes('draftalsosprocket').trimEnd());
    expect(run.stdout).toContain(`## Study notes\n\n${PARAGRAPH}\n\n`);
    expect(run.stdout).not.toContain('ghostmainsprocket');
    expect(run.stdout).not.toContain('ghostalsosprocket');
    expect(run.stdout).not.toContain('04-unfinished-main');
    expect(run.stdout).not.toContain('02-unfinished-also');
  });

  test('AC-6: stderr has one line per section, in feed order', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '03-draft-main': { tasks: ['1.3'], notes: aiDraftNotes('draftmainsprocket') },
      '04-unfinished-main': { tasks: ['1.3'], notes: unfinishedNotes('ghostmainsprocket') },
      '01-draft-also': { tasks: ['2.2', '1.3'], notes: aiDraftNotes('draftalsosprocket') },
      '02-unfinished-also': { tasks: ['1.1', '1.3'], notes: unfinishedNotes('ghostalsosprocket') },
    });

    const run = runCli(dir, ['brief', '1.3', '--count', '3']);

    expect(run.status).toBe(0);
    expect(sectionReports(run)).toEqual([
      'included 03-draft-main: AI draft',
      'skipped 04-unfinished-main: not finished',
      'included 01-draft-also: AI draft',
      'skipped 02-unfinished-also: not finished',
    ]);
  });

  test('AC-6: the ids are the next three after the bank question', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '03-draft-main': { tasks: ['1.3'], notes: aiDraftNotes('draftmainsprocket') },
      '04-unfinished-main': { tasks: ['1.3'], notes: unfinishedNotes('ghostmainsprocket') },
    });
    put(dir, BANK, 'd1-1.3-0004', 'in-bank');

    const run = runCli(dir, ['brief', '1.3', '--count', '3']);

    expect(run.status).toBe(0);
    expect(lines(sectionOf(run.stdout, '## Ids'))).toEqual([
      'd1-1.3-0005',
      'd1-1.3-0006',
      'd1-1.3-0007',
    ]);
  });

  test('AC-6: an AI-draft section with a missing notes.md is still reported as such', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '03-draft-main': { tasks: ['1.3'], notes: aiDraftNotes('draftmainsprocket') },
    });
    write(
      dir,
      `${NOTES}/sections.yaml`,
      sectionsYaml({ '03-draft-main': ['1.3'], '04-gone': ['1.3'] }),
    );

    const run = runCli(dir, ['brief', '1.3']);

    expect(run.status).toBe(0);
    expect(sectionReports(run)).toEqual([
      'included 03-draft-main: AI draft',
      'skipped 04-gone: no notes.md',
    ]);
  });
});

describe('brief --studied-only', () => {
  test.each([
    ['before the task', ['brief', '--studied-only', '1.3']],
    ['after the task', ['brief', '1.3', '--studied-only']],
  ])('AC-7: the flag %s leaves the AI-draft section out, with plain headings', (_where, args) => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, args);

    expect(run.status).toBe(0);
    expect(noteHeadings(run)).toEqual(['### 05-studied-main', '### 01-both-also']);
    expect(run.stdout).toContain(STUDIED_MAIN.trimEnd());
    expect(run.stdout).toContain(BOTH_ALSO.trimEnd());
    expect(run.stdout).not.toContain('draftmainsprocket');
    expect(run.stdout).not.toContain('02-draft-main');
  });

  test.each([
    ['before the task', ['brief', '--studied-only', '1.3']],
    ['after the task', ['brief', '1.3', '--studied-only']],
  ])('AC-7: the flag %s gives a brief with no label and no paragraph', (_where, args) => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, args);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(PARAGRAPH);
    expect(run.stdout).not.toContain('(AI draft, not studied yet)');
    // The notes of 01-both-also are printed in full, so their marker line is there; nothing else
    // of the brief says `AI draft`.
    expect(withoutNotes(run.stdout, [STUDIED_MAIN, BOTH_ALSO])).not.toContain('AI draft');
  });

  test.each([
    ['before the task', ['brief', '--studied-only', '1.3']],
    ['after the task', ['brief', '1.3', '--studied-only']],
  ])(
    'AC-7: the flag %s skips the AI-draft section on stderr, with no included line',
    (_where, args) => {
      const dir = makeTempDir();
      setupMixed(dir);

      const run = runCli(dir, args);

      expect(run.status).toBe(0);
      expect(lines(run.stderr)).toContain('skipped 02-draft-main: AI draft (--studied-only)');
      expect(run.stderr).not.toMatch(/^included /m);
      expect(sectionReports(run)).toEqual(['skipped 02-draft-main: AI draft (--studied-only)']);
    },
  );

  test('AC-7: the flag still reports a not-finished section as not finished', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '05-studied-main': { tasks: ['1.3'], notes: STUDIED_MAIN },
      '03-draft-main': { tasks: ['1.3'], notes: DRAFT_MAIN },
      '04-unfinished-main': { tasks: ['1.3'], notes: unfinishedNotes('ghostmainsprocket') },
    });

    const run = runCli(dir, ['brief', '1.3', '--studied-only']);

    expect(run.status).toBe(0);
    expect(sectionReports(run)).toEqual([
      'skipped 03-draft-main: AI draft (--studied-only)',
      'skipped 04-unfinished-main: not finished',
    ]);
  });

  test('AC-7: the flag in the middle of the other options and repeated is accepted', () => {
    const dir = makeTempDir();
    setupMixed(dir);

    const run = runCli(dir, [
      'brief',
      '--count',
      '2',
      '--studied-only',
      '1.3',
      '--studied-only',
      '--notes',
      NOTES,
    ]);

    expect(run.status).toBe(0);
    expect(noteHeadings(run)).toEqual(['### 05-studied-main', '### 01-both-also']);
    expect(lines(sectionOf(run.stdout, '## Ids'))).toHaveLength(2);
  });

  test('AC-7: without the flag the same map still includes the AI-draft section', () => {
    const dir = makeTempDir();
    setupMixed(dir);

    const withFlag = runCli(dir, ['brief', '1.3', '--studied-only']);
    const without = runCli(dir, ['brief', '1.3']);

    expect(withFlag.status).toBe(0);
    expect(without.status).toBe(0);
    expect(without.stdout).not.toBe(withFlag.stdout);
    expect(without.stdout).toContain('draftmainsprocket');
  });

  test('AC-8: only AI-draft sections feed the task: stderr says why, stdout is empty, exit 1', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '02-draft-main': { tasks: ['1.3'], notes: DRAFT_MAIN },
      '01-draft-also': { tasks: ['2.2', '1.3'], notes: aiDraftNotes('draftalsosprocket') },
    });

    const run = runCli(dir, ['brief', '1.3', '--studied-only']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(lines(run.stderr)).toContain('no finished section feeds task 1.3 (studied gate)');
  });

  test('AC-8: the skipped AI-draft sections are reported first, in feed order', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '02-draft-main': { tasks: ['1.3'], notes: DRAFT_MAIN },
      '01-draft-also': { tasks: ['2.2', '1.3'], notes: aiDraftNotes('draftalsosprocket') },
    });

    const run = runCli(dir, ['brief', '1.3', '--studied-only']);

    expect(run.status).toBe(1);
    expect(
      lines(run.stderr).filter((line) => /^(included|skipped|no finished) /.test(line)),
    ).toEqual([
      'skipped 02-draft-main: AI draft (--studied-only)',
      'skipped 01-draft-also: AI draft (--studied-only)',
      'no finished section feeds task 1.3 (studied gate)',
    ]);
  });

  test('AC-8: AI-draft and not-finished sections together, with the flag, exit 1 as well', () => {
    const dir = makeTempDir();
    setupNotes(dir, {
      '02-draft-main': { tasks: ['1.3'], notes: DRAFT_MAIN },
      '03-unfinished-main': { tasks: ['1.3'], notes: unfinishedNotes('ghostmainsprocket') },
    });

    const run = runCli(dir, ['brief', '1.3', '--studied-only']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(lines(run.stderr)).toContain('no finished section feeds task 1.3 (studied gate)');
  });
});

describe('--studied-only is a brief flag only', () => {
  const RESULTS = [
    'verifier: claude-opus',
    'results:',
    '  - id: d1-1.3-0007',
    '    answer: [C]',
    '',
  ].join('\n');

  /** A temp dir where every command line below is valid without the flag. */
  function setupAll(): string {
    const dir = makeTempDir();
    setupNotes(dir, { '05-studied-main': { tasks: ['1.3'], notes: STUDIED_MAIN } });
    put(dir, DRAFTS, 'd1-1.3-0007', 'one-draft', { status: 'draft' });
    write(dir, 'results.yaml', RESULTS);
    return dir;
  }

  const WITH_FLAG: [string, string[]][] = [
    ['check', ['check', '--studied-only']],
    ['next-id', ['next-id', '1.3', '--studied-only']],
    ['promote', ['promote', '--studied-only']],
    ['dedupe', ['dedupe', '--studied-only']],
    ['blind --pending', ['blind', '--pending', '--studied-only']],
    ['verdict', ['verdict', 'results.yaml', '--studied-only']],
    ['brief with a value', ['brief', '1.3', '--studied-only=yes']],
  ];

  test.each(WITH_FLAG)('AC-9: %s with the flag exits 2 with the usage text', (_name, args) => {
    const dir = setupAll();

    const run = runCli(dir, args);

    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^Usage:/m);
    expect(run.stderr).toMatch(/\bquestions brief\b/);
    expect(run.stdout).toBe('');
  });

  const WITHOUT_FLAG: [string, string[]][] = [
    ['check', ['check']],
    ['next-id', ['next-id', '1.3']],
    ['promote', ['promote']],
    ['dedupe', ['dedupe']],
    ['blind --pending', ['blind', '--pending']],
    ['verdict', ['verdict', 'results.yaml', '--no-fetch']],
    ['brief', ['brief', '1.3']],
  ];

  test.each(WITHOUT_FLAG)(
    'AC-9: control, %s without the flag is a valid command line (exit 0 or 1)',
    (_name, args) => {
      const dir = setupAll();

      const run = runCli(dir, args);

      expect([0, 1]).toContain(run.status);
      expect(run.stderr).not.toContain('Usage:');
    },
  );
});

describe('usage text of brief', () => {
  /** The usage text, printed on exit 2 (here by `brief` without a task). */
  function usageLines(): string[] {
    const dir = makeTempDir();
    const run = runCli(dir, ['brief']);
    expect(run.status).toBe(2);
    return run.stderr.split(/\r?\n/);
  }

  test('AC-10: the brief entry has the three new lines, consecutive, compared after trimming', () => {
    const trimmed = usageLines().map((line) => line.trim());

    const first = trimmed.indexOf(BRIEF_USAGE_FIRST_LINE);

    expect(first).toBeGreaterThanOrEqual(0);
    expect(trimmed.slice(first + 1, first + 1 + BRIEF_USAGE_NOTE_LINES.length)).toEqual(
      BRIEF_USAGE_NOTE_LINES,
    );
  });

  test('AC-10: the old note is gone', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['brief']);

    expect(run.status).toBe(2);
    expect(run.output).not.toContain('(studied sections only)');
  });

  test('AC-10: the first line has the usual two-space indent, the note lines the 49-space one', () => {
    const rows = usageLines();
    const first = rows.findIndex((line) => line.trim() === BRIEF_USAGE_FIRST_LINE);

    expect(first).toBeGreaterThanOrEqual(0);
    expect(rows[first]).toBe(`  ${BRIEF_USAGE_FIRST_LINE}`);
    BRIEF_USAGE_NOTE_LINES.forEach((note, index) => {
      expect(rows[first + 1 + index]).toBe(`${' '.repeat(49)}${note}`);
    });
  });

  test('AC-10: the text is the same on any usage error, here for another command', () => {
    const dir = makeTempDir();

    const run = runCli(dir, ['check', '--studied-only']);

    expect(run.status).toBe(2);
    const trimmed = run.stderr.split(/\r?\n/).map((line) => line.trim());
    const first = trimmed.indexOf(BRIEF_USAGE_FIRST_LINE);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(trimmed.slice(first + 1, first + 4)).toEqual(BRIEF_USAGE_NOTE_LINES);
  });
});
