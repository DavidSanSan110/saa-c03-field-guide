import { describe, expect, test } from 'vitest';
import { hasAiDraftLine, notesStatus, renderBrief } from './brief.ts';
import type { BriefInput } from './brief.ts';
import {
  AI_DRAFT_LINE,
  PARAGRAPH,
  aiDraftHeading,
  aiDraftNotes,
  aiDraftNotesNoDateLine,
  studiedAiDraftNotes,
} from './__mocks__/ai-draft-fixtures.ts';
import { notesText, unfinishedNotes } from './__mocks__/brief-fixtures.ts';
import { sectionOf } from './__mocks__/cli-harness.ts';

describe('hasAiDraftLine', () => {
  test.each([
    ['a date and a sentence after the marker', '**AI draft:** 2026-10-28 — text'],
    ['nothing after the marker', '**AI draft:**'],
    ['nothing after the marker and a newline', '**AI draft:**\n'],
    ['CRLF, marker not on the first line', '# N\r\n**Date completed:**\r\n**AI draft:** x\r\n'],
    ['a lone CR as line break', '# N\r**AI draft:** x\r'],
    [
      'LF, marker on a late line',
      '# N\n\n**Date completed:**\n\nsome text\n**AI draft:** x\nmore\n',
    ],
    ['the fixture marker line in made-up notes', aiDraftNotes('alpha')],
  ])('AC-1: true for %s', (_name, notes) => {
    expect(hasAiDraftLine(notes)).toBe(true);
  });

  test.each([
    ['a text without the line', '# N\n\n**Date completed:**\n\nsome text\n'],
    ['an empty text', ''],
    ['an indented marker', '  **AI draft:** x'],
    ['an indented marker after a line', '# N\n  **AI draft:** x\n'],
    ['a lower-case marker', '**ai draft:** x'],
    ['a marker without the colon', '**AI draft** x'],
    ['a marker that is not at the line start', 'text **AI draft:** x'],
    ['the per-lecture marker alone', '> 🤖 AI draft — not studied yet'],
    ['finished notes', notesText('alpha')],
    ['unfinished notes', unfinishedNotes('alpha')],
  ])('AC-1: false for %s', (_name, notes) => {
    expect(hasAiDraftLine(notes)).toBe(false);
  });
});

describe('notesStatus', () => {
  test('AC-2: studied for a real Date completed and no AI-draft line', () => {
    expect(notesStatus(notesText('alpha'))).toBe('studied');
  });

  test.each([
    [
      'the AI-draft line after the date',
      '# N\n\n**Date completed:** 07/09/2026\n**AI draft:** 2026-10-28 — x\n\ntext\n',
    ],
    [
      'the AI-draft line before the date',
      '# N\n\n**AI draft:** 2026-10-28 — x\n**Date completed:** 07/09/2026\n\ntext\n',
    ],
    ['the fixture of a studied section that kept the marker', studiedAiDraftNotes('alpha')],
  ])('AC-2: studied for a real Date completed and an AI-draft line (%s)', (_name, notes) => {
    expect(notesStatus(notes)).toBe('studied');
  });

  test.each([
    ['an empty Date completed line', '# N\n\n**Date completed:**\n**AI draft:** 2026-10-28 — x\n'],
    ['an impossible date', '# N\n\n**Date completed:** 31/02/2026\n**AI draft:** x\n'],
    ['no Date completed line at all', '# N\n\n**AI draft:** 2026-10-28 — x\n\ntext\n'],
    ['a marker with nothing after it', '# N\n\n**Date completed:**\n**AI draft:**\n'],
    ['CRLF line breaks', '# N\r\n\r\n**Date completed:**\r\n**AI draft:** x\r\n'],
    ['the fixture with an empty date', aiDraftNotes('alpha')],
    ['the fixture without a date line', aiDraftNotesNoDateLine('alpha')],
  ])('AC-2: ai-draft for %s (with an AI-draft line)', (_name, notes) => {
    expect(notesStatus(notes)).toBe('ai-draft');
  });

  test.each([
    ['an empty date and no AI-draft line', '# N\n\n**Date completed:**\n\ntext\n'],
    ['no Date completed line and no AI-draft line', unfinishedNotes('alpha')],
    ['an impossible date and no AI-draft line', '**Date completed:** 31/02/2026\n'],
    [
      'the per-lecture marker alone',
      '# N\n\n**Date completed:**\n\n> 🤖 AI draft — not studied yet\n',
    ],
    ['an indented AI-draft line', '# N\n\n**Date completed:**\n  **AI draft:** x\n'],
    ['an empty text', ''],
  ] as [string, string][])('AC-2: not-finished for %s', (_name, notes) => {
    expect(notesStatus(notes)).toBe('not-finished');
  });
});

const DRAFTS_DIR = 'private/questions-drafts';

const A = notesText('alphasprocket');
const B = notesText('bravosprocket');

function briefInput(notes: BriefInput['notes']): BriefInput {
  return {
    task: '1.3',
    ids: ['d1-1.3-0005', 'd1-1.3-0006'],
    draftsDir: DRAFTS_DIR,
    existing: [],
    notes,
  };
}

const HEADINGS = [
  '## Ids',
  '## Write to',
  '## Format',
  '## Rules',
  '## Existing questions for this task',
  '## Study notes',
];

/** Everything after the `## Study notes` line (that section is the last one of the brief). */
function afterStudyNotes(brief: string): string {
  const marker = '\n## Study notes';
  const at = brief.indexOf(marker);
  return at < 0 ? '' : brief.slice(at + marker.length);
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('renderBrief with AI-draft notes', () => {
  test('AC-3: a labelled note and the paragraph, exactly, in the order given', () => {
    const brief = renderBrief(
      briefInput([
        { folder: '05-a', text: A },
        { folder: '01-b', text: B, aiDraft: true },
      ]),
    );

    expect(afterStudyNotes(brief)).toBe(
      `\n\n${PARAGRAPH}\n\n### 05-a\n\n${A.trimEnd()}\n\n${aiDraftHeading('01-b')}\n\n${B.trimEnd()}\n`,
    );
  });

  test('AC-3: the six headings appear once each, in spec 022 order, and the title line stays', () => {
    const brief = renderBrief(
      briefInput([
        { folder: '05-a', text: A },
        { folder: '01-b', text: B, aiDraft: true },
      ]),
    );

    const rows = brief.split(/\r?\n/);
    const positions = HEADINGS.map((heading) => rows.indexOf(heading));
    expect(HEADINGS.map((heading) => rows.filter((row) => row === heading).length)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(rows[0]).toMatch(/^# Brief: task 1\.3 · .+ \(domain 1\)$/);
  });

  test('AC-3: the Rules section is byte-equal to the one of the same input without aiDraft', () => {
    const withLabel = renderBrief(
      briefInput([
        { folder: '05-a', text: A },
        { folder: '01-b', text: B, aiDraft: true },
      ]),
    );
    const without = renderBrief(
      briefInput([
        { folder: '05-a', text: A },
        { folder: '01-b', text: B },
      ]),
    );

    const rules = sectionOf(withLabel, '## Rules');
    expect(rules).not.toBe('');
    expect(rules).toBe(sectionOf(without, '## Rules'));
  });

  test('AC-3: everything before the study notes is the same as without aiDraft', () => {
    const notes = [{ folder: '01-b', text: B }];
    const withLabel = renderBrief(briefInput([{ folder: '01-b', text: B, aiDraft: true }]));
    const without = renderBrief(briefInput(notes));

    const head = (brief: string): string => brief.slice(0, brief.indexOf('\n## Study notes'));
    expect(head(withLabel)).not.toBe('');
    expect(head(withLabel)).toBe(head(without));
  });

  test('AC-3: the paragraph comes once even when several notes are AI drafts', () => {
    const brief = renderBrief(
      briefInput([
        { folder: '09-x', text: A, aiDraft: true },
        { folder: '02-y', text: B, aiDraft: true },
      ]),
    );

    expect(count(brief, PARAGRAPH)).toBe(1);
    expect(afterStudyNotes(brief)).toBe(
      `\n\n${PARAGRAPH}\n\n${aiDraftHeading('09-x')}\n\n${A.trimEnd()}\n\n${aiDraftHeading('02-y')}\n\n${B.trimEnd()}\n`,
    );
  });

  test('AC-3: a labelled note first, then a plain one, keeps the order and the paragraph on top', () => {
    const brief = renderBrief(
      briefInput([
        { folder: '09-x', text: A, aiDraft: true },
        { folder: '02-y', text: B },
      ]),
    );

    expect(afterStudyNotes(brief)).toBe(
      `\n\n${PARAGRAPH}\n\n${aiDraftHeading('09-x')}\n\n${A.trimEnd()}\n\n### 02-y\n\n${B.trimEnd()}\n`,
    );
  });

  test('AC-3: a note whose text holds the AI-draft marker line is printed in full', () => {
    const text = aiDraftNotes('gammasprocket');

    const brief = renderBrief(briefInput([{ folder: '03-c', text, aiDraft: true }]));

    expect(afterStudyNotes(brief)).toBe(
      `\n\n${PARAGRAPH}\n\n${aiDraftHeading('03-c')}\n\n${text.trimEnd()}\n`,
    );
    expect(text).toContain(AI_DRAFT_LINE);
  });
});

describe('renderBrief without AI-draft notes', () => {
  const plain = `\n\n### 05-a\n\n${A.trimEnd()}\n\n### 01-b\n\n${B.trimEnd()}\n`;

  test('AC-4: aiDraft absent gives the spec 022 section, no paragraph, no AI draft anywhere', () => {
    const brief = renderBrief(
      briefInput([
        { folder: '05-a', text: A },
        { folder: '01-b', text: B },
      ]),
    );

    expect(afterStudyNotes(brief)).toBe(plain);
    expect(brief).not.toContain('AI draft');
  });

  test('AC-4: aiDraft false gives the same section, no paragraph, no AI draft anywhere', () => {
    const brief = renderBrief(
      briefInput([
        { folder: '05-a', text: A, aiDraft: false },
        { folder: '01-b', text: B, aiDraft: false },
      ]),
    );

    expect(afterStudyNotes(brief)).toBe(plain);
    expect(brief).not.toContain('AI draft');
  });

  test('AC-4: an empty notes list has no paragraph either', () => {
    const brief = renderBrief(briefInput([]));

    expect(brief).not.toContain(PARAGRAPH);
    expect(brief).not.toContain('AI draft');
  });
});
