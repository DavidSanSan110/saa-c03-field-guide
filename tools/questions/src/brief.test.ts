import { getTask, questionSchema } from '@field-guide/schema';
import type { TaskId } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { completedDate, feedingSections, nextIds, parseSectionMap, renderBrief } from './brief.ts';
import type { BriefInput, SectionMap } from './brief.ts';
import { notesText, sectionsYaml } from './__mocks__/brief-fixtures.ts';
import { sectionOf, tailAfter } from './__mocks__/cli-harness.ts';
import { makeQuestion } from './__mocks__/fixtures.ts';

/** Any error message but the one of an unimplemented stub: a real error. */
const NOT_A_STUB = /^(?!not implemented)/;

const BACKSLASH = String.fromCharCode(92);

describe('completedDate', () => {
  test('AC-1: reads DD/MM/YYYY as YYYY-MM-DD', () => {
    expect(completedDate('# Notes\n\n**Date completed:** 07/09/2026\n\ntext\n')).toBe('2026-09-07');
  });

  test('AC-1: extra spaces around the date are allowed', () => {
    expect(completedDate('**Date completed:**     07/09/2026   \n')).toBe('2026-09-07');
  });

  test('AC-1: the line can sit anywhere in the text and the file can use CRLF', () => {
    const notes = '# Notes\r\n\r\ntext\r\n**Date completed:** 25/12/2025\r\nmore text\r\n';

    expect(completedDate(notes)).toBe('2025-12-25');
  });

  test('AC-1: 29/02 of a leap year is a real date', () => {
    expect(completedDate('**Date completed:** 29/02/2028\n')).toBe('2028-02-29');
  });

  test.each([
    ['an empty value', '# Notes\n**Date completed:**\n'],
    ['a blank value', '# Notes\n**Date completed:**    \n'],
    ['no such line', '# Notes\n\nSome text about completing things.\n'],
    ['an empty text', ''],
    ['31/02/2026', '**Date completed:** 31/02/2026\n'],
    ['29/02 of a year that is not a leap year', '**Date completed:** 29/02/2027\n'],
    ['month 13', '**Date completed:** 07/13/2026\n'],
    ['day 0', '**Date completed:** 00/09/2026\n'],
    ['7/9/2026 (no zero padding)', '**Date completed:** 7/9/2026\n'],
    ['2026-09-07 (ISO format)', '**Date completed:** 2026-09-07\n'],
  ])('AC-2: %s means not finished', (_name, notes) => {
    expect(completedDate(notes)).toBeUndefined();
  });

  test('AC-2: only the first line counts when it is empty and the second is valid', () => {
    const notes = '**Date completed:**\n\n**Date completed:** 07/09/2026\n';

    expect(completedDate(notes)).toBeUndefined();
  });

  test('AC-2: only the first line counts when it is impossible and the second is valid', () => {
    const notes = '**Date completed:** 31/02/2026\n**Date completed:** 07/09/2026\n';

    expect(completedDate(notes)).toBeUndefined();
  });

  test('AC-2: only the first line counts when it is valid and the second is not', () => {
    const notes = '**Date completed:** 07/09/2026\n**Date completed:** 31/02/2026\n';

    expect(completedDate(notes)).toBe('2026-09-07');
  });
});

describe('parseSectionMap', () => {
  test('AC-3: accepts a block mapping, main task first, and keeps each list as written', () => {
    const text = [
      '02-iam-and-aws-cli: ["1.1"]',
      '03-ec2-fundamentals: ["3.2", "4.2", "1.2"]',
      '',
    ].join('\n');

    const { map, problems } = parseSectionMap(text);

    expect(problems).toEqual([]);
    expect(map).toEqual({
      sections: [
        { folder: '02-iam-and-aws-cli', tasks: ['1.1'] },
        { folder: '03-ec2-fundamentals', tasks: ['3.2', '4.2', '1.2'] },
      ],
    });
  });

  test('AC-3: accepts a block mapping with block lists', () => {
    const text = '02-iam:\n  - "1.1"\n  - "1.2"\n';

    const { map, problems } = parseSectionMap(text);

    expect(problems).toEqual([]);
    expect(map).toEqual({ sections: [{ folder: '02-iam', tasks: ['1.1', '1.2'] }] });
  });

  test('AC-3: accepts a flow mapping', () => {
    const text = '{ "b-two": ["1.1", "1.2"], "a-one": ["1.3"] }\n';

    const { map, problems } = parseSectionMap(text);

    expect(problems).toEqual([]);
    expect(map).toEqual({
      sections: [
        { folder: 'a-one', tasks: ['1.3'] },
        { folder: 'b-two', tasks: ['1.1', '1.2'] },
      ],
    });
  });

  test('AC-3: sections come in folder-name order (code units), not in file order', () => {
    const text = sectionsYaml({
      'b-last': ['1.1'],
      'B-upper': ['1.1'],
      '2-two': ['1.1'],
      'a-first': ['1.1'],
      '10-ten': ['1.1'],
    });

    const { map } = parseSectionMap(text);

    expect(map?.sections.map((section) => section.folder)).toEqual([
      '10-ten',
      '2-two',
      'B-upper',
      'a-first',
      'b-last',
    ]);
  });

  test('AC-3: a dot inside a folder name is fine', () => {
    const { map, problems } = parseSectionMap('v1.2-notes: ["1.1"]\n');

    expect(problems).toEqual([]);
    expect(map?.sections).toEqual([{ folder: 'v1.2-notes', tasks: ['1.1'] }]);
  });

  const GOOD = '01-good: ["1.1"]\n';

  test.each([
    ['invalid YAML', 'a: [unclosed\n'],
    ['a sequence', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
    ['an empty file', ''],
    ['an empty value', `${GOOD}02-bad:\n`],
    ['an empty list', `${GOOD}02-bad: []\n`],
    ['a string instead of a list', `${GOOD}02-bad: "1.1"\n`],
    ['a mapping instead of a list', `${GOOD}02-bad: { task: "1.1" }\n`],
    ['a task that is not in the catalog', `${GOOD}02-bad: ["9.9"]\n`],
    ['a catalog task and one that is not', `${GOOD}02-bad: ["1.2", "5.1"]\n`],
    ['a duplicate task in one list', `${GOOD}02-bad: ["1.1", "1.2", "1.1"]\n`],
    ['a folder name with a slash', `${GOOD}"a/b": ["1.1"]\n`],
    ['a folder name with a backslash', `${GOOD}"a${BACKSLASH}${BACKSLASH}b": ["1.1"]\n`],
    ['a folder named "."', `${GOOD}".": ["1.1"]\n`],
    ['a folder named ".."', `${GOOD}"..": ["1.1"]\n`],
  ])('AC-3: %s is a problem and gives no map', (_name, text) => {
    const { map, problems } = parseSectionMap(text);

    expect(problems.length).toBeGreaterThan(0);
    expect(map).toBeUndefined();
  });

  test('AC-3: the backslash case really holds a backslash', () => {
    const text = `"a${BACKSLASH}${BACKSLASH}b": ["1.1"]\n`;

    expect(Object.keys(parse(text) as object)).toEqual([`a${BACKSLASH}b`]);
  });
});

describe('feedingSections', () => {
  const map: SectionMap = {
    sections: [
      { folder: '09-z-main', tasks: ['1.3'] },
      { folder: '01-a-also', tasks: ['1.1', '1.3'] },
      { folder: '05-m-main', tasks: ['1.3', '1.2'] },
      { folder: '02-b-also', tasks: ['2.1', '1.2', '1.3'] },
      { folder: '03-other', tasks: ['2.2'] },
    ],
  };

  test('AC-4: main sections first, then the others, each group in folder-name order', () => {
    expect(feedingSections(map, '1.3')).toEqual([
      '05-m-main',
      '09-z-main',
      '01-a-also',
      '02-b-also',
    ]);
  });

  test('AC-4: a task that only appears later in lists gives the sections in name order', () => {
    expect(feedingSections(map, '1.2')).toEqual(['02-b-also', '05-m-main']);
  });

  test('AC-4: a task that no section lists gives an empty list', () => {
    expect(feedingSections(map, '4.4')).toEqual([]);
  });

  test('AC-4: folder names are compared by code units, not by locale', () => {
    const upperAndLower: SectionMap = {
      sections: [
        { folder: 'a-notes', tasks: ['1.1'] },
        { folder: 'B-notes', tasks: ['1.1'] },
      ],
    };

    expect(feedingSections(upperAndLower, '1.1')).toEqual(['B-notes', 'a-notes']);
  });
});

describe('nextIds', () => {
  test('AC-5: consecutive ids from the highest used number plus one', () => {
    expect(nextIds('1.3', ['d1-1.3-0004'], 3)).toEqual([
      'd1-1.3-0005',
      'd1-1.3-0006',
      'd1-1.3-0007',
    ]);
  });

  test('AC-5: starts at 0001 when the task has no id', () => {
    expect(nextIds('1.3', [], 2)).toEqual(['d1-1.3-0001', 'd1-1.3-0002']);
  });

  test('AC-5: ids of other tasks and strings that are not ids are ignored', () => {
    const ids = ['d1-1.2-0050', 'd3-3.1-0009', 'not-an-id', 'd1-1.3-0003'];

    expect(nextIds('1.3', ids, 1)).toEqual(['d1-1.3-0004']);
  });

  test('AC-5: numbers are compared numerically, and gaps are not reused', () => {
    expect(nextIds('1.3', ['d1-1.3-0009', 'd1-1.3-0010', 'd1-1.3-0002'], 1)).toEqual([
      'd1-1.3-0011',
    ]);
  });

  test('AC-5: any iterable of ids works', () => {
    expect(nextIds('3.2', new Set(['d3-3.2-0001']), 2)).toEqual(['d3-3.2-0002', 'd3-3.2-0003']);
  });

  test('AC-5: the last id 9999 can still be handed out', () => {
    expect(nextIds('1.3', ['d1-1.3-9998'], 1)).toEqual(['d1-1.3-9999']);
  });

  test('AC-5: throws when the ids would pass 9999', () => {
    expect(() => nextIds('1.3', ['d1-1.3-9998'], 3)).toThrow(NOT_A_STUB);
  });

  test('AC-5: throws when 9999 is already used', () => {
    expect(() => nextIds('1.3', ['d1-1.3-9999'], 1)).toThrow(NOT_A_STUB);
  });
});

const DRAFTS_DIR = 'private/questions-drafts';

function briefInput(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    task: '1.3',
    ids: ['d1-1.3-0005', 'd1-1.3-0006'],
    draftsDir: DRAFTS_DIR,
    existing: [],
    notes: [{ folder: '05-storage', text: notesText('storage') }],
    ...overrides,
  };
}

/** The line index of each heading of the brief, in the order they must appear. */
const HEADINGS = [
  '## Ids',
  '## Write to',
  '## Format',
  '## Rules',
  '## Existing questions for this task',
  '## Study notes',
];

function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

describe('renderBrief structure', () => {
  test('AC-6: the first line is the title with the task title and the domain from the catalog', () => {
    const task = getTask('1.3');

    const brief = renderBrief(briefInput());

    expect(task).toBeDefined();
    expect(linesOf(brief)[0]).toBe(`# Brief: task 1.3 · ${task?.title ?? ''} (domain 1)`);
  });

  test('AC-6: the title follows the catalog for another task and domain', () => {
    const task = getTask('3.2');

    const brief = renderBrief(
      briefInput({ task: '3.2', ids: ['d3-3.2-0001'], notes: [{ folder: 'x', text: 'notes' }] }),
    );

    expect(linesOf(brief)[0]).toBe(`# Brief: task 3.2 · ${task?.title ?? ''} (domain 3)`);
  });

  test('AC-6: the six section headings are there, each on its own line, in order', () => {
    const rows = linesOf(renderBrief(briefInput()));

    const positions = HEADINGS.map((heading) => rows.indexOf(heading));

    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('AC-6: each heading appears once', () => {
    const rows = linesOf(renderBrief(briefInput()));

    for (const heading of HEADINGS) {
      expect(rows.filter((row) => row === heading)).toHaveLength(1);
    }
  });

  test('AC-12: the Ids section holds the given ids, one per line', () => {
    const ids = ['d1-1.3-0005', 'd1-1.3-0006', 'd1-1.3-0007'];

    const section = sectionOf(renderBrief(briefInput({ ids })), '## Ids');

    expect(section.split('\n').filter((row) => row.trim() !== '')).toEqual(ids);
  });

  test('AC-13: each existing question is a line "- <id> (<where>) <stem>"', () => {
    const existing: BriefInput['existing'] = [
      { id: 'd1-1.3-0001', where: 'bank', stem: 'Stem of the bank question.' },
      { id: 'd1-1.3-0002', where: 'draft', stem: 'Stem of the draft.' },
      { id: 'd1-1.3-0003', where: 'rejected', stem: 'Stem of the rejected one.' },
    ];

    const section = sectionOf(
      renderBrief(briefInput({ existing })),
      '## Existing questions for this task',
    );

    expect(section.split('\n').filter((row) => row.trim() !== '')).toEqual([
      '- d1-1.3-0001 (bank) Stem of the bank question.',
      '- d1-1.3-0002 (draft) Stem of the draft.',
      '- d1-1.3-0003 (rejected) Stem of the rejected one.',
    ]);
  });

  test('AC-13: with no existing question the section says (none)', () => {
    const section = sectionOf(renderBrief(briefInput()), '## Existing questions for this task');

    expect(section.split('\n').filter((row) => row.trim() !== '')).toEqual(['(none)']);
  });

  test('AC-15: the Write to section shows the drafts folder, the domain and the task', () => {
    const section = sectionOf(
      renderBrief(briefInput({ task: '3.2', draftsDir: 'my-drafts', ids: ['d3-3.2-0001'] })),
      '## Write to',
    );

    expect(section).toContain('my-drafts/d3/3.2/<slug>.yaml');
  });

  test('AC-9: the Study notes section holds each notes text in full under its folder heading, in order', () => {
    const first = notesText('storage');
    const second = notesText('networking');

    const section = tailAfter(
      renderBrief(
        briefInput({
          notes: [
            { folder: '05-storage', text: first },
            { folder: '01-networking', text: second },
          ],
        }),
      ),
      '## Study notes',
    );

    const at = (needle: string): number => section.indexOf(needle);
    expect(at('### 05-storage')).toBeGreaterThanOrEqual(0);
    expect(at('### 05-storage')).toBeLessThan(at(first.trimEnd()));
    expect(section).toContain(first.trimEnd());
    expect(at('### 01-networking')).toBeGreaterThan(at(first.trimEnd()));
    expect(section).toContain(second.trimEnd());
  });
});

/** The text of the `## Format` section and the YAML inside it (fenced or not). */
function formatYaml(brief: string): { section: string; yaml: string } {
  const section = sectionOf(brief, '## Format');
  const fenced = /```[a-z]*\r?\n([\s\S]*?)```/.exec(section);
  return { section, yaml: fenced?.[1] ?? section };
}

describe('renderBrief format template', () => {
  test('AC-7: with its placeholders filled the template passes the question schema', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));
    const template = parse(yaml) as Record<string, unknown>;
    // The test fills every placeholder; status and provenance must already be final.
    const filled = {
      ...template,
      ...makeQuestion({ id: 'd1-1.3-0005', cue: 'a cue' }),
      status: template.status,
      provenance: template.provenance,
    };

    const result = questionSchema.safeParse(filled);

    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  test('AC-7: the template has every schema field except links', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));

    const template = parse(yaml) as Record<string, unknown>;

    expect(Object.keys(template).sort()).toEqual(
      [
        'cue',
        'difficulty',
        'domain',
        'id',
        'options',
        'provenance',
        'references',
        'services',
        'status',
        'stem',
        'task',
        'type',
      ].sort(),
    );
  });

  test('AC-7: the template has status draft', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));

    expect((parse(yaml) as Record<string, unknown>).status).toBe('draft');
  });

  test('AC-7: the provenance is generated_by claude-sonnet and nothing else', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));

    expect((parse(yaml) as Record<string, unknown>).provenance).toEqual({
      generated_by: 'claude-sonnet',
    });
  });

  test('AC-7: the provenance is written in block style', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));

    expect(yaml).toMatch(/^provenance:[ \t]*(#.*)?\r?\n[ \t]+generated_by: claude-sonnet[ \t]*$/m);
    expect(yaml).not.toMatch(/provenance:[ \t]*\{/);
  });

  test('AC-7: there is no links key', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));

    expect(yaml).not.toMatch(/^\s*links\s*:/m);
  });

  test('AC-7: every option of the template has key, text, correct and why', () => {
    const { yaml } = formatYaml(renderBrief(briefInput()));

    const options = (parse(yaml) as { options?: unknown }).options;

    expect(Array.isArray(options)).toBe(true);
    for (const option of options as Record<string, unknown>[]) {
      expect(Object.keys(option).sort()).toEqual(['correct', 'key', 'text', 'why']);
    }
  });
});

describe('renderBrief rules', () => {
  const rules = (): string => sectionOf(renderBrief(briefInput()), '## Rules').toLowerCase();

  test('AC-8: single-answer questions have 4 options and 1 correct', () => {
    expect(rules()).toMatch(/single/);
    expect(rules()).toMatch(/4 options/);
    expect(rules()).toMatch(/1 correct/);
  });

  test('AC-8: multiple-answer questions have 5 to 6 options and 2 to 3 correct', () => {
    expect(rules()).toMatch(/multiple/);
    expect(rules()).toMatch(/5\s*(?:–|-|to|or)\s*6 options/);
    expect(rules()).toMatch(/2\s*(?:–|-|to|or)\s*3 correct/);
  });

  test('AC-8: the stem of a multiple-answer question says Choose two. or Choose three.', () => {
    const text = sectionOf(renderBrief(briefInput()), '## Rules');

    expect(text).toContain('Choose two.');
    expect(text).toContain('Choose three.');
  });

  test('AC-8: every option has a why', () => {
    expect(rules()).toMatch(/\bwhy\b/);
    expect(rules()).toMatch(/every option|each option|all options/);
  });

  test('AC-8: at least one reference on docs.aws.amazon.com', () => {
    expect(rules()).toContain('docs.aws.amazon.com');
    expect(rules()).toMatch(/reference/);
  });

  test('AC-8: own words, never reusing wording from courses, practice exams or exam dumps', () => {
    expect(rules()).toMatch(/own words/);
    expect(rules()).toMatch(/course/);
    expect(rules()).toMatch(/practice exam/);
    expect(rules()).toMatch(/exam dump/);
  });

  test('AC-8: never copying sentences from the notes', () => {
    expect(rules()).toMatch(/cop(?:y|ying)[^.\n]*sentences?[^.\n]*notes/);
  });

  test('AC-8: scenario-style stems, status draft and no repeat of an existing question', () => {
    expect(rules()).toMatch(/scenario/);
    expect(rules()).toContain('status: draft');
    expect(rules()).toMatch(/repeat|duplicate/);
  });
});

describe('renderBrief for every task of the catalog', () => {
  test.each(['1.1', '2.2', '3.5', '4.4'] as TaskId[])('AC-6: task %s names its title', (task) => {
    const domain = getTask(task)?.domain ?? 0;

    const brief = renderBrief(briefInput({ task, ids: [`d${String(domain)}-${task}-0001`] }));

    expect(linesOf(brief)[0]).toBe(
      `# Brief: task ${task} · ${getTask(task)?.title ?? ''} (domain ${String(domain)})`,
    );
  });
});
