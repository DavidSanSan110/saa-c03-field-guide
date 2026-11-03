// Spec 044, AC-1 and AC-2: the pure helpers of the `ai-draft` command.
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { aiDraftSections, withAiDraft } from './ai-draft.ts';
import {
  aiDraftNotes,
  aiDraftNotesNoDateLine,
  studiedAiDraftNotes,
} from './__mocks__/ai-draft-fixtures.ts';
import { notesText, unfinishedNotes } from './__mocks__/brief-fixtures.ts';
import type { TaskId } from '@field-guide/schema';
import type { SectionMap } from './brief.ts';
import { withSidecarKey } from './sidecar.ts';

type Mapping = Record<string, unknown>;

const SIDECAR = [
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

describe('withAiDraft', () => {
  test('AC-1: no sidecar gives a mapping with the sections under ai_draft', () => {
    const text = withAiDraft(undefined, ['a', 'b']);

    expect(parse(text)).toEqual({ ai_draft: { sections: ['a', 'b'] } });
  });

  test('AC-1: the sections keep the order they were given in', () => {
    const text = withAiDraft(undefined, ['zz-last-name', 'aa-first-name', 'mm-middle']);

    expect(parse(text)).toEqual({
      ai_draft: { sections: ['zz-last-name', 'aa-first-name', 'mm-middle'] },
    });
  });

  test('AC-1: an empty sidecar text is the same as no sidecar', () => {
    expect(parse(withAiDraft('', ['a']))).toEqual({ ai_draft: { sections: ['a'] } });
  });

  test('AC-1: it adds ai_draft last and keeps the values of the other keys', () => {
    const text = withAiDraft(SIDECAR, ['a', 'b']);

    const before = parse(SIDECAR) as Mapping;
    const after = parse(text) as Mapping;
    expect(after).toEqual({ ...before, ai_draft: { sections: ['a', 'b'] } });
    expect(Object.keys(after)).toEqual(['verification', 'dedupe', 'ai_draft']);
    expect(after['verification']).toEqual(before['verification']);
    expect(after['dedupe']).toEqual(before['dedupe']);
  });

  test('AC-1: it keeps the comment line and every text line of the other keys', () => {
    const text = withAiDraft(SIDECAR, ['a', 'b']);

    expect(text.startsWith(SIDECAR)).toBe(true);
    expect(text.split('\n')[0]).toBe('# check file, written by the tools');
    expect(text).toContain('  result: verified   # the verifier agreed\n');
  });

  test('AC-1: it adds exactly one ai_draft key', () => {
    const text = withAiDraft(SIDECAR, ['a']);

    expect(text.match(/^ai_draft:/gm)).toHaveLength(1);
  });

  test('AC-1: an existing ai_draft is replaced in place, not moved to the end', () => {
    const existing = [
      '# check file',
      'verification:',
      '  result: verified',
      'ai_draft:',
      '  sections:',
      '    - old-one',
      '    - old-two',
      'dedupe:',
      '  threshold: 0.5',
      '  similar: []',
      '',
    ].join('\n');

    const text = withAiDraft(existing, ['new-one', 'new-two', 'new-three']);

    const after = parse(text) as Mapping;
    expect(Object.keys(after)).toEqual(['verification', 'ai_draft', 'dedupe']);
    expect(after['ai_draft']).toEqual({ sections: ['new-one', 'new-two', 'new-three'] });
    expect(after['verification']).toEqual({ result: 'verified' });
    expect(after['dedupe']).toEqual({ threshold: 0.5, similar: [] });
    expect(text.match(/^ai_draft:/gm)).toHaveLength(1);
    expect(text).not.toContain('old-one');
    expect(text).not.toContain('old-two');
    expect(text.startsWith('# check file\nverification:\n  result: verified\nai_draft:\n')).toBe(
      true,
    );
    expect(text.endsWith('dedupe:\n  threshold: 0.5\n  similar: []\n')).toBe(true);
  });

  test('AC-1: an existing ai_draft of another shape (true) is replaced by the sections', () => {
    const text = withAiDraft('verification:\n  result: verified\nai_draft: true\n', ['a']);

    expect(parse(text)).toEqual({
      verification: { result: 'verified' },
      ai_draft: { sections: ['a'] },
    });
  });

  test('AC-1: it gives the same text as withSidecarKey for the same key and value', () => {
    expect(withAiDraft(SIDECAR, ['a', 'b'])).toBe(
      withSidecarKey(SIDECAR, 'ai_draft', { sections: ['a', 'b'] }),
    );
  });

  test.each([
    ['a flow mapping', '{a: 1}\n'],
    ['a list', '- a\n- b\n'],
    ['invalid YAML', 'a: [unclosed\n'],
  ])('AC-1: it throws the message of withSidecarKey for %s', (_name, existing) => {
    let expected = '';
    try {
      withSidecarKey(existing, 'ai_draft', { sections: ['a'] });
    } catch (error) {
      expected = (error as Error).message;
    }
    expect(expected).not.toBe('');

    expect(() => withAiDraft(existing, ['a'])).toThrow(expected);
  });
});

const sections = (...entries: [string, string[]][]): SectionMap => ({
  sections: entries.map(([folder, tasks]) => ({ folder, tasks: tasks as TaskId[] })),
});

/** A `readNotes` over a table; a folder that is not in it has no notes (`undefined`). */
function notesOf(table: Record<string, string>): (folder: string) => string | undefined {
  return (folder) => table[folder];
}

describe('aiDraftSections', () => {
  test('AC-2: it returns the AI-draft folders in feed order: main sections first, each by name', () => {
    // Map order, alphabetical order and feed order all differ.
    const map = sections(
      ['02-draft-also-b', ['1.1', '1.3']],
      ['08-draft-main-b', ['1.3']],
      ['01-draft-also-a', ['2.2', '1.3']],
      ['07-draft-main-a', ['1.3', '2.2']],
    );
    const readNotes = notesOf({
      '02-draft-also-b': aiDraftNotes('alsob'),
      '08-draft-main-b': aiDraftNotes('mainb'),
      '01-draft-also-a': aiDraftNotes('alsoa'),
      '07-draft-main-a': aiDraftNotes('maina'),
    });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual([
      '07-draft-main-a',
      '08-draft-main-b',
      '01-draft-also-a',
      '02-draft-also-b',
    ]);
  });

  test('AC-2: it leaves out studied, not-finished and missing notes, and keeps the AI-draft ones', () => {
    const map = sections(
      ['02-draft-main', ['1.3']],
      ['03-studied-main', ['1.3']],
      ['04-unfinished-main', ['1.3']],
      ['05-missing-main', ['1.3']],
      ['01-draft-also', ['2.2', '1.3']],
      ['06-studied-also', ['2.2', '1.3']],
      ['07-missing-also', ['2.2', '1.3']],
    );
    const readNotes = notesOf({
      '02-draft-main': aiDraftNotes('draftmain'),
      '03-studied-main': notesText('studiedmain'),
      '04-unfinished-main': unfinishedNotes('unfinishedmain'),
      '01-draft-also': aiDraftNotes('draftalso'),
      '06-studied-also': notesText('studiedalso'),
    });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual(['02-draft-main', '01-draft-also']);
  });

  test('AC-2: notes with a real completion date are studied even when they keep the AI-draft line', () => {
    const map = sections(['01-both', ['1.3']], ['02-draft', ['1.3']]);
    const readNotes = notesOf({
      '01-both': studiedAiDraftNotes('both'),
      '02-draft': aiDraftNotes('draft'),
    });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual(['02-draft']);
  });

  test('AC-2: AI-draft notes without any Date completed line count as AI draft', () => {
    const map = sections(['01-nodate', ['1.3']]);
    const readNotes = notesOf({ '01-nodate': aiDraftNotesNoDateLine('nodate') });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual(['01-nodate']);
  });

  test('AC-2: an impossible date with the AI-draft line is still AI draft', () => {
    const map = sections(['01-impossible', ['1.3']]);
    const readNotes = notesOf({ '01-impossible': aiDraftNotes('impossible', '31/02/2026') });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual(['01-impossible']);
  });

  test('AC-2: it returns an empty list when none is AI draft', () => {
    const map = sections(
      ['01-studied', ['1.3']],
      ['02-unfinished', ['1.3']],
      ['03-missing', ['2.2', '1.3']],
    );
    const readNotes = notesOf({
      '01-studied': notesText('studied'),
      '02-unfinished': unfinishedNotes('unfinished'),
    });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual([]);
  });

  test('AC-2: it returns an empty list when no section feeds the task', () => {
    const map = sections(['01-draft-other', ['2.2']]);
    const readNotes = notesOf({ '01-draft-other': aiDraftNotes('other') });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual([]);
  });

  test('AC-2: it ignores AI-draft sections that feed another task', () => {
    const map = sections(['01-draft-main', ['1.3']], ['02-draft-elsewhere', ['2.2', '3.1']]);
    const readNotes = notesOf({
      '01-draft-main': aiDraftNotes('main'),
      '02-draft-elsewhere': aiDraftNotes('elsewhere'),
    });

    expect(aiDraftSections(map, '1.3', readNotes)).toEqual(['01-draft-main']);
  });

  test('AC-2: it reads the notes of a folder through readNotes, by the folder name', () => {
    const readNotes = vi.fn<(folder: string) => string | undefined>(() => aiDraftNotes('x'));
    const map = sections(['01-draft-main', ['1.3']]);

    aiDraftSections(map, '1.3', readNotes);

    expect(readNotes).toHaveBeenCalledWith('01-draft-main');
  });
});
