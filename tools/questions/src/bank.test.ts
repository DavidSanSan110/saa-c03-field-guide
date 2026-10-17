import { validateQuestion } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { fileFor, makeEntry, makeQuestion, questionYaml } from './__mocks__/fixtures.ts';
import { collectIds, nextId, planPromote, questionPath, readBank, sidecarPath } from './bank.ts';
import type { BankEntry, FileMap } from './bank.ts';

/** The only item of a list; fails the test when there are zero or several. */
function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

/** The schema's `path: message` strings for a question that must be invalid. */
function schemaErrors(question: Record<string, unknown>): string[] {
  const result = validateQuestion(question);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe('readBank', () => {
  test('AC-1: a valid file gives one entry with path, slug, parsed question and the original text', () => {
    const text = questionYaml({ id: 'd1-1.3-0001' });
    const result = readBank({ 'd1/1.3/sse-c.yaml': text }, { publicOnly: false });

    expect(result.problems).toEqual([]);
    const entry = only(result.entries);
    expect(entry.path).toBe('d1/1.3/sse-c.yaml');
    expect(entry.slug).toBe('sse-c');
    expect(entry.question).toEqual(makeQuestion({ id: 'd1-1.3-0001' }));
    expect(entry.text).toBe(text);
  });

  test('AC-1: the text is kept as written, comments and spacing included', () => {
    const text = `# keep me  \n\n${questionYaml()}\n# trailing comment\n\n`;
    const result = readBank({ 'd1/1.3/sse-c.yaml': text }, { publicOnly: false });

    expect(result.problems).toEqual([]);
    expect(only(result.entries).text).toBe(text);
  });

  test('AC-2: entries are sorted by path whatever the key order of the FileMap', () => {
    // Inserted in reverse path order.
    const files: FileMap = {};
    for (const [id, slug] of [
      ['d3-3.4-0003', 'b'],
      ['d2-2.1-0002', 'a'],
      ['d1-1.3-0004', 'c'],
      ['d1-1.2-0001', 'z'],
    ] as const) {
      const file = fileFor(id, slug);
      files[file.path] = file.text;
    }

    const result = readBank(files, { publicOnly: false });

    expect(result.problems).toEqual([]);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      'd1/1.2/z.yaml',
      'd1/1.3/c.yaml',
      'd2/2.1/a.yaml',
      'd3/3.4/b.yaml',
    ]);
  });

  test('AC-2: paths are compared by code unit, so a hyphen sorts before a dot', () => {
    const files: FileMap = {};
    for (const [id, slug] of [
      ['d1-1.3-0001', 'x'],
      ['d1-1.3-0002', 'x-y'],
    ] as const) {
      const file = fileFor(id, slug);
      files[file.path] = file.text;
    }

    const result = readBank(files, { publicOnly: false });

    expect(result.entries.map((entry) => entry.path)).toEqual(['d1/1.3/x-y.yaml', 'd1/1.3/x.yaml']);
  });

  test('AC-3: .gitkeep, non-YAML files, sidecars and top-level rejected/ are skipped silently', () => {
    const real = fileFor('d1-1.3-0001', 'real');
    const files: FileMap = {
      '.gitkeep': '',
      'd1/.gitkeep': '',
      'README.md': '# not a question',
      'd1/1.3/notes.txt': 'free text',
      'd1/1.3/data.json': '{"id":"d1-1.3-0001"}',
      // Sidecars hold a question-shaped document, but they are never read as questions.
      'd1/1.3/real.check.yaml': real.text,
      'd1/1.3/other.check.yaml': ': : not yaml [',
      // The reserved folder repeats the id of a real question: reading it would be a duplicate.
      'rejected/d1/1.3/old.yaml': real.text,
      'rejected/loose.yaml': 'not: a question',
      [real.path]: real.text,
    };

    const result = readBank(files, { publicOnly: false });

    expect(result.problems).toEqual([]);
    expect(result.entries.map((entry) => entry.path)).toEqual([real.path]);
  });

  test('AC-3: a rejected/ folder below the top level is not reserved and is read as a question path', () => {
    const result = readBank(
      { 'd1/rejected/x.yaml': questionYaml({ id: 'd1-1.3-0001' }) },
      { publicOnly: false },
    );

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.file).toBe('d1/rejected/x.yaml');
    expect(problem.message).toContain('d1/1.3/x.yaml');
  });

  test('AC-4: a .yml file gives a problem about the .yaml extension and no entry', () => {
    const result = readBank({ 'd1/1.3/x.yml': questionYaml() }, { publicOnly: false });

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.file).toBe('d1/1.3/x.yml');
    expect(problem.message).toContain('.yaml');
  });

  test('AC-5: invalid YAML gives one problem starting with "invalid YAML" and no entry', () => {
    const result = readBank({ 'd1/1.3/bad.yaml': 'id: [unclosed\n' }, { publicOnly: false });

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.file).toBe('d1/1.3/bad.yaml');
    expect(problem.message.startsWith('invalid YAML')).toBe(true);
  });

  test.each([
    ['a list', '- one\n- two\n'],
    ['a scalar', 'just some text\n'],
    ['an empty file', ''],
  ])('AC-5: a YAML file whose top level is %s gives a problem and no entry', (_name, text) => {
    const result = readBank({ 'd1/1.3/flat.yaml': text }, { publicOnly: false });

    expect(result.entries).toEqual([]);
    expect(only(result.problems).file).toBe('d1/1.3/flat.yaml');
  });

  test('AC-6: a schema failure gives one problem per issue in the formatIssues form', () => {
    const invalid = { stem: 'short', difficulty: 'impossible' };
    const expected = schemaErrors(makeQuestion(invalid));
    expect(expected).toHaveLength(2);

    const result = readBank({ 'd1/1.3/bad.yaml': questionYaml(invalid) }, { publicOnly: false });

    expect(result.entries).toEqual([]);
    expect(result.problems.map((problem) => problem.file)).toEqual([
      'd1/1.3/bad.yaml',
      'd1/1.3/bad.yaml',
    ]);
    expect(result.problems.map((problem) => problem.message)).toEqual(expected);
    expect(result.problems.some((problem) => problem.message.startsWith('stem: '))).toBe(true);
    expect(result.problems.some((problem) => problem.message.startsWith('difficulty: '))).toBe(
      true,
    );
  });

  test('AC-6: a single schema issue gives exactly one problem', () => {
    const result = readBank(
      { 'd1/1.3/bad.yaml': questionYaml({ difficulty: 'impossible' }) },
      { publicOnly: false },
    );

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.message.startsWith('difficulty: ')).toBe(true);
  });

  test.each(['draft', 'verified'])(
    'AC-7: with publicOnly a schema-valid %s question gives a problem and no entry',
    (status) => {
      const file = fileFor('d1-1.3-0001', 'pending', { status });

      const result = readBank({ [file.path]: file.text }, { publicOnly: true });

      expect(result.entries).toEqual([]);
      expect(only(result.problems).file).toBe(file.path);
    },
  );

  test.each(['draft', 'verified'])(
    'AC-7: without publicOnly a %s question is an entry',
    (status) => {
      const file = fileFor('d1-1.3-0001', 'pending', { status });

      const result = readBank({ [file.path]: file.text }, { publicOnly: false });

      expect(result.problems).toEqual([]);
      expect(only(result.entries).question.status).toBe(status);
    },
  );

  test('AC-7: with publicOnly a reviewed question is still an entry', () => {
    const file = fileFor('d1-1.3-0001', 'done');

    const result = readBank({ [file.path]: file.text }, { publicOnly: true });

    expect(result.problems).toEqual([]);
    expect(only(result.entries).path).toBe(file.path);
  });

  test.each(['Sse_C', 'sse--c', '-sse', 'sse-', 'sse.c', 'SSE'])(
    'AC-8: the slug %s does not match the slug pattern: a problem and no entry',
    (slug) => {
      const result = readBank(
        { [`d1/1.3/${slug}.yaml`]: questionYaml({ id: 'd1-1.3-0001' }) },
        { publicOnly: false },
      );

      expect(result.entries).toEqual([]);
      expect(only(result.problems).file).toBe(`d1/1.3/${slug}.yaml`);
    },
  );

  test.each([
    ['the wrong domain folder', 'd2/1.3/x.yaml'],
    ['the wrong task folder', 'd1/1.2/x.yaml'],
    ['an extra folder level', 'd1/1.3/sub/x.yaml'],
    ['a missing folder level', 'd1/x.yaml'],
    ['no folder at all', 'x.yaml'],
  ])('AC-9: a valid question under %s gives a problem naming the expected path', (_name, path) => {
    const result = readBank({ [path]: questionYaml({ id: 'd1-1.3-0001' }) }, { publicOnly: false });

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.file).toBe(path);
    expect(problem.message).toContain('d1/1.3/x.yaml');
  });

  test('AC-10: with the same id twice, the first by path is the entry and the later one a problem', () => {
    const first = fileFor('d1-1.3-0005', 'a-first');
    const second = fileFor('d1-1.3-0005', 'b-second');
    // The later file is inserted first.
    const files: FileMap = { [second.path]: second.text, [first.path]: first.text };

    const result = readBank(files, { publicOnly: false });

    expect(result.entries.map((entry) => entry.path)).toEqual([first.path]);
    const problem = only(result.problems);
    expect(problem.file).toBe(second.path);
    expect(problem.message).toContain('d1-1.3-0005');
    expect(problem.message).toContain(first.path);
  });

  test('AC-10: every later file with the same id names the first file', () => {
    const files: FileMap = {};
    for (const slug of ['c-third', 'b-second', 'a-first']) {
      const file = fileFor('d1-1.3-0005', slug);
      files[file.path] = file.text;
    }

    const result = readBank(files, { publicOnly: false });

    expect(result.entries.map((entry) => entry.path)).toEqual(['d1/1.3/a-first.yaml']);
    expect(result.problems.map((problem) => problem.file)).toEqual([
      'd1/1.3/b-second.yaml',
      'd1/1.3/c-third.yaml',
    ]);
    for (const problem of result.problems) {
      expect(problem.message).toContain('d1-1.3-0005');
      expect(problem.message).toContain('d1/1.3/a-first.yaml');
    }
  });

  test('AC-10: different ids never collide', () => {
    const a = fileFor('d1-1.3-0005', 'a');
    const b = fileFor('d1-1.3-0006', 'b');

    const result = readBank({ [b.path]: b.text, [a.path]: a.text }, { publicOnly: false });

    expect(result.problems).toEqual([]);
    expect(result.entries).toHaveLength(2);
  });

  test('AC-11: problems are sorted by file, then in the order found within the file', () => {
    const invalid = { id: 'd1-1.3-0002', stem: 'short', difficulty: 'impossible' };
    const expectedSchema = schemaErrors(makeQuestion(invalid));
    // Inserted in reverse file order, so that a wrong order cannot pass by accident.
    const files: FileMap = {
      'd1/1.3/z.yml': questionYaml({ id: 'd1-1.3-0003' }),
      'd1/1.3/m.yaml': questionYaml(invalid),
      'd1/1.3/a.yaml': 'id: [unclosed\n',
    };

    const result = readBank(files, { publicOnly: false });

    expect(result.problems.map((problem) => problem.file)).toEqual([
      'd1/1.3/a.yaml',
      ...expectedSchema.map(() => 'd1/1.3/m.yaml'),
      'd1/1.3/z.yml',
    ]);
    const inM = result.problems
      .filter((problem) => problem.file === 'd1/1.3/m.yaml')
      .map((problem) => problem.message);
    expect(inM).toEqual(expectedSchema);
  });

  test('AC-11: a duplicate-id problem is placed by its file, not by when it was found', () => {
    const first = fileFor('d1-1.3-0005', 'm-first');
    const second = fileFor('d1-1.3-0005', 'n-second');
    const files: FileMap = {
      [second.path]: second.text,
      'd1/1.3/z.yml': questionYaml({ id: 'd1-1.3-0009' }),
      [first.path]: first.text,
      'd1/1.3/a.yaml': 'id: [unclosed\n',
    };

    const result = readBank(files, { publicOnly: false });

    expect(result.problems.map((problem) => problem.file)).toEqual([
      'd1/1.3/a.yaml',
      second.path,
      'd1/1.3/z.yml',
    ]);
  });
});

describe('paths and ids', () => {
  test('AC-12: questionPath builds d<domain>/<task>/<slug>.yaml', () => {
    expect(questionPath({ domain: 3, task: '3.4' }, 'cf-oac')).toBe('d3/3.4/cf-oac.yaml');
    expect(questionPath({ domain: 1, task: '1.3' }, 's3-sse-c-keys')).toBe(
      'd1/1.3/s3-sse-c-keys.yaml',
    );
  });

  test('AC-12: sidecarPath puts .check.yaml in place of .yaml', () => {
    expect(sidecarPath('d3/3.4/cf-oac.yaml')).toBe('d3/3.4/cf-oac.check.yaml');
    expect(sidecarPath('d1/1.3/a-b.yaml')).toBe('d1/1.3/a-b.check.yaml');
  });

  test('AC-13: collectIds returns the ids of every parseable mapping, rejected and invalid files included', () => {
    const files: FileMap = {
      'd1/1.3/valid.yaml': questionYaml({ id: 'd1-1.3-0001' }),
      'd1/1.3/draft.yaml': questionYaml({ id: 'd1-1.3-0002', status: 'draft' }),
      'rejected/d1/1.3/old.yaml': questionYaml({ id: 'd1-1.3-0003', status: 'draft' }),
      'd1/1.3/invalid.yaml': 'id: d1-1.3-0004\nstem: x\n',
      'd2/2.1/other.yaml': questionYaml({ id: 'd2-2.1-0001' }),
    };

    expect(collectIds(files).toSorted()).toEqual([
      'd1-1.3-0001',
      'd1-1.3-0002',
      'd1-1.3-0003',
      'd1-1.3-0004',
      'd2-2.1-0001',
    ]);
  });

  test('AC-13: collectIds leaves out sidecars and non-YAML files', () => {
    const files: FileMap = {
      'd1/1.3/valid.yaml': questionYaml({ id: 'd1-1.3-0001' }),
      'd1/1.3/valid.check.yaml': 'id: d1-1.3-0090\n',
      'notes.txt': 'id: d1-1.3-0091\n',
      'd1/1.3/data.json': '{"id":"d1-1.3-0092"}',
      '.gitkeep': '',
    };

    expect(collectIds(files)).toEqual(['d1-1.3-0001']);
  });

  test('AC-13: collectIds ignores non-string ids, unparseable files and non-mappings', () => {
    const files: FileMap = {
      'd1/1.3/valid.yaml': questionYaml({ id: 'd1-1.3-0001' }),
      'a.yaml': 'id: 12\n',
      'b.yaml': 'id: null\n',
      'c.yaml': 'id: [d1-1.3-0093]\n',
      'd.yaml': 'id: [unclosed\n',
      'e.yaml': '- id: d1-1.3-0094\n',
      'f.yaml': 'just text\n',
      'g.yaml': '',
      'h.yaml': 'stem: no id here\n',
      'i.yaml': 'wrapper:\n  id: d1-1.3-0095\n',
    };

    expect(collectIds(files)).toEqual(['d1-1.3-0001']);
  });

  test('AC-13: collectIds returns an id string as it is, even when it is not a question id', () => {
    expect(collectIds({ 'weird.yaml': 'id: not-an-id\n' })).toEqual(['not-an-id']);
  });

  test('AC-14: the first id of a task is 0001', () => {
    expect(nextId('1.3', [])).toBe('d1-1.3-0001');
    expect(nextId('3.4', [])).toBe('d3-3.4-0001');
  });

  test('AC-15: nextId is the highest number plus one, zero-padded to 4 digits, gaps not reused', () => {
    expect(nextId('1.3', ['d1-1.3-0001', 'd1-1.3-0007'])).toBe('d1-1.3-0008');
    expect(nextId('1.3', ['d1-1.3-0007', 'd1-1.3-0001', 'd1-1.3-0003'])).toBe('d1-1.3-0008');
    expect(nextId('2.2', ['d2-2.2-0099'])).toBe('d2-2.2-0100');
    expect(nextId('1.3', ['d1-1.3-0009'])).toBe('d1-1.3-0010');
  });

  test('AC-15: nextId accepts any iterable of ids', () => {
    expect(nextId('1.3', new Set(['d1-1.3-0002', 'd1-1.3-0004']))).toBe('d1-1.3-0005');
    expect(
      nextId(
        '1.3',
        (function* () {
          yield 'd1-1.3-0006';
        })(),
      ),
    ).toBe('d1-1.3-0007');
  });

  test('AC-16: ids of other tasks are ignored', () => {
    expect(nextId('1.3', ['d1-1.2-0050', 'd3-3.1-0009'])).toBe('d1-1.3-0001');
    expect(nextId('1.3', ['d1-1.2-0050', 'd1-1.3-0002', 'd3-3.1-0009'])).toBe('d1-1.3-0003');
    expect(nextId('3.1', ['d1-1.2-0050', 'd3-3.1-0009'])).toBe('d3-3.1-0010');
  });

  test('AC-16: strings that are not question ids are ignored', () => {
    const noise = [
      'junk',
      '',
      'd1-1.3-500',
      'd1-1.3-99999',
      'xd1-1.3-0050',
      'd1-1.3-0050x',
      ' d1-1.3-0050',
      'd1-1x3-0090',
      'D1-1.3-0080',
    ];
    expect(nextId('1.3', ['d1-1.3-0002', ...noise])).toBe('d1-1.3-0003');
  });

  test('AC-16: numbers are compared numerically (0010 beats 0009)', () => {
    expect(nextId('1.3', ['d1-1.3-0010', 'd1-1.3-0009'])).toBe('d1-1.3-0011');
    expect(nextId('1.3', ['d1-1.3-0009', 'd1-1.3-0010'])).toBe('d1-1.3-0011');
    expect(nextId('1.3', ['d1-1.3-0100', 'd1-1.3-0099'])).toBe('d1-1.3-0101');
  });

  test('AC-17: nextId throws an error naming the task when 9999 is used', () => {
    expect(() => nextId('1.3', ['d1-1.3-9999'])).toThrow(/1\.3/);
    expect(() => nextId('3.4', ['d3-3.4-0001', 'd3-3.4-9999', 'd3-3.4-0002'])).toThrow(/3\.4/);
  });

  test('AC-17: 9998 still has a next id (9999)', () => {
    expect(nextId('1.3', ['d1-1.3-9998'])).toBe('d1-1.3-9999');
  });

  test('AC-17: 9999 in another task does not block this task', () => {
    expect(nextId('1.3', ['d1-1.2-9999'])).toBe('d1-1.3-0001');
  });
});

describe('planPromote', () => {
  const bankOther = (): BankEntry => makeEntry('d2-2.1-0001', 'unrelated');

  test('AC-18: with no ids, every reviewed draft becomes a move to the same path in the bank', () => {
    const reviewed = makeEntry('d1-1.3-0001', 'done');

    const plan = planPromote([reviewed], [bankOther()]);

    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.moves).toEqual([
      { id: 'd1-1.3-0001', from: 'd1/1.3/done.yaml', to: 'd1/1.3/done.yaml' },
    ]);
  });

  test('AC-18: drafts with another status are skipped with a reason naming the status, not errors', () => {
    const drafts = [
      makeEntry('d1-1.3-0001', 'done'),
      makeEntry('d1-1.3-0002', 'first', { status: 'draft' }),
      makeEntry('d1-1.3-0003', 'second', { status: 'verified' }),
    ];

    const plan = planPromote(drafts, []);

    expect(plan.errors).toEqual([]);
    expect(plan.moves.map((move) => move.id)).toEqual(['d1-1.3-0001']);
    expect(plan.skipped).toHaveLength(2);
    const first = plan.skipped.find((problem) => problem.file === 'd1/1.3/first.yaml');
    const second = plan.skipped.find((problem) => problem.file === 'd1/1.3/second.yaml');
    expect(first?.message).toContain('draft');
    expect(second?.message).toContain('verified');
  });

  test('AC-18: no drafts, or only non-reviewed ones, give no moves', () => {
    expect(planPromote([], [])).toEqual({ moves: [], skipped: [], errors: [] });
    const plan = planPromote([makeEntry('d1-1.3-0002', 'first', { status: 'draft' })], []);
    expect(plan.moves).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  test('AC-19: moves are sorted by id, not by draft order or path', () => {
    // Path order is z(d1-1.2-0005), a(d1-1.3-0009), b(d1-1.3-0002), c(d2-2.1-0001); the ids sort
    // differently, and the drafts come in yet another order.
    const drafts = [
      makeEntry('d1-1.3-0009', 'a'),
      makeEntry('d2-2.1-0001', 'c'),
      makeEntry('d1-1.2-0005', 'z'),
      makeEntry('d1-1.3-0002', 'b'),
    ];

    const plan = planPromote(drafts, []);

    expect(plan.moves.map((move) => move.id)).toEqual([
      'd1-1.2-0005',
      'd1-1.3-0002',
      'd1-1.3-0009',
      'd2-2.1-0001',
    ]);
    expect(plan.moves.map((move) => move.from)).toEqual([
      'd1/1.2/z.yaml',
      'd1/1.3/b.yaml',
      'd1/1.3/a.yaml',
      'd2/2.1/c.yaml',
    ]);
  });

  test('AC-20: a reviewed draft whose id is already in the bank is an error naming the bank file', () => {
    const draft = makeEntry('d1-1.3-0001', 'mine');
    const inBank = makeEntry('d1-1.3-0001', 'theirs');

    const plan = planPromote([draft], [inBank]);

    const error = only(plan.errors);
    expect(error.message).toContain('d1/1.3/theirs.yaml');
  });

  test('AC-20: only the colliding draft is an error, and it is not skipped', () => {
    const plan = planPromote(
      [makeEntry('d1-1.3-0001', 'mine'), makeEntry('d1-1.3-0002', 'fine')],
      [makeEntry('d1-1.3-0001', 'theirs')],
    );

    expect(plan.errors).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  test('AC-20: a draft that is not reviewed is skipped, not checked against the bank', () => {
    const plan = planPromote(
      [makeEntry('d1-1.3-0001', 'mine', { status: 'draft' })],
      [makeEntry('d1-1.3-0001', 'theirs')],
    );

    expect(plan.errors).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  test('AC-21: a reviewed draft whose target path exists in the bank is an error', () => {
    const draft = makeEntry('d1-1.3-0002', 'same');
    const inBank = makeEntry('d1-1.3-0001', 'same');
    expect(draft.path).toBe(inBank.path);

    const plan = planPromote([draft], [inBank]);

    expect(plan.errors).toHaveLength(1);
    expect(plan.moves).toEqual([]);
  });

  test('AC-21: the same slug in another task is not a path collision', () => {
    const plan = planPromote(
      [makeEntry('d1-1.3-0002', 'same')],
      [makeEntry('d1-1.2-0001', 'same')],
    );

    expect(plan.errors).toEqual([]);
    expect(plan.moves).toHaveLength(1);
  });

  test('AC-22: with ids, only those drafts are planned', () => {
    const drafts = [
      makeEntry('d1-1.3-0001', 'one'),
      makeEntry('d1-1.3-0002', 'two'),
      makeEntry('d1-1.3-0003', 'three'),
    ];

    const plan = planPromote(drafts, [], { ids: ['d1-1.3-0003', 'd1-1.3-0001'] });

    expect(plan.errors).toEqual([]);
    expect(plan.moves.map((move) => move.id)).toEqual(['d1-1.3-0001', 'd1-1.3-0003']);
  });

  test('AC-22: a draft that is not requested is not checked against the bank', () => {
    const drafts = [makeEntry('d1-1.3-0001', 'clash'), makeEntry('d1-1.3-0002', 'fine')];
    const bank = [makeEntry('d1-1.3-0001', 'theirs')];

    const plan = planPromote(drafts, bank, { ids: ['d1-1.3-0002'] });

    expect(plan.errors).toEqual([]);
    expect(plan.moves.map((move) => move.id)).toEqual(['d1-1.3-0002']);
  });

  test('AC-22: an id that matches no draft is an error', () => {
    const plan = planPromote([makeEntry('d1-1.3-0001', 'one')], [], { ids: ['d1-1.3-0099'] });

    const error = only(plan.errors);
    expect(JSON.stringify(error)).toContain('d1-1.3-0099');
    expect(plan.moves).toEqual([]);
  });

  test('AC-22: a requested draft that is not reviewed is an error, not a skip', () => {
    const drafts = [
      makeEntry('d1-1.3-0001', 'one'),
      makeEntry('d1-1.3-0002', 'wip', { status: 'verified' }),
    ];

    const plan = planPromote(drafts, [], { ids: ['d1-1.3-0002'] });

    expect(plan.errors).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
    expect(plan.moves).toEqual([]);
  });

  test('AC-23: any error empties moves and errors lists every error found', () => {
    const drafts = [
      makeEntry('d1-1.3-0001', 'fine'),
      makeEntry('d1-1.3-0002', 'id-clash'),
      makeEntry('d1-1.3-0003', 'path-clash'),
    ];
    const bank = [makeEntry('d1-1.3-0002', 'theirs'), makeEntry('d1-1.3-0050', 'path-clash')];

    const plan = planPromote(drafts, bank);

    expect(plan.moves).toEqual([]);
    expect(plan.errors).toHaveLength(2);
  });

  test('AC-23: errors of the ids option also empty moves', () => {
    const drafts = [makeEntry('d1-1.3-0001', 'one'), makeEntry('d1-1.3-0002', 'two')];

    const plan = planPromote(drafts, [], { ids: ['d1-1.3-0001', 'd1-1.3-0098', 'd1-1.3-0099'] });

    expect(plan.moves).toEqual([]);
    expect(plan.errors).toHaveLength(2);
  });

  test('AC-23: without errors the moves are kept', () => {
    const plan = planPromote([makeEntry('d1-1.3-0001', 'one')], [makeEntry('d1-1.3-0002', 'two')]);

    expect(plan.errors).toEqual([]);
    expect(plan.moves).toHaveLength(1);
  });
});

describe('review round 1 regressions', () => {
  test('AC-41: collectIds also reads .yml files', () => {
    expect(collectIds({ 'd1/1.3/misnamed.yml': questionYaml({ id: 'd1-1.3-0007' }) })).toEqual([
      'd1-1.3-0007',
    ]);
  });

  test('AC-41: an id held only by a .yml file is never handed out again', () => {
    const ids = collectIds({
      'd1/1.3/a.yaml': questionYaml({ id: 'd1-1.3-0001' }),
      'd1/1.3/misnamed.yml': questionYaml({ id: 'd1-1.3-0004' }),
    });

    expect(nextId('1.3', ids)).toBe('d1-1.3-0005');
  });

  test('AC-41: readBank still reports the .yml file as a problem', () => {
    const result = readBank({ 'd1/1.3/misnamed.yml': questionYaml() }, { publicOnly: false });

    expect(result.entries).toEqual([]);
    expect(only(result.problems).file).toBe('d1/1.3/misnamed.yml');
  });

  test('AC-42: a rejected-old/ folder is read as question paths, unlike rejected/', () => {
    const files: FileMap = {
      'rejected-old/d1/1.3/x.yaml': questionYaml({ id: 'd1-1.3-0001' }),
      'rejected/d1/1.3/y.yaml': questionYaml({ id: 'd1-1.3-0002' }),
    };

    const result = readBank(files, { publicOnly: false });

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.file).toBe('rejected-old/d1/1.3/x.yaml');
    expect(problem.message).toContain('d1/1.3/x.yaml');
  });

  test('AC-42: a top-level file rejectedfoo.yaml is read as a question path', () => {
    const result = readBank(
      { 'rejectedfoo.yaml': questionYaml({ id: 'd1-1.3-0001' }) },
      { publicOnly: false },
    );

    expect(result.entries).toEqual([]);
    const problem = only(result.problems);
    expect(problem.file).toBe('rejectedfoo.yaml');
    expect(problem.message).toContain('d1/1.3/rejectedfoo.yaml');
  });

  test.each([
    ['fails the schema', 'd1/1.3/a-bad.yaml', { stem: 'short' }],
    ['is in the wrong place', 'd1/1.2/a-bad.yaml', {}],
    ['has an invalid slug', 'd1/1.3/A_bad.yaml', {}],
  ])(
    'AC-43: a first file that %s does not make the valid file with the same id a duplicate',
    (_name, badPath, overrides) => {
      const good = fileFor('d1-1.3-0005', 'b-good');
      const files: FileMap = {
        [good.path]: good.text,
        [badPath]: questionYaml({ id: 'd1-1.3-0005', ...overrides }),
      };
      // The invalid file sorts first.
      expect(badPath < good.path).toBe(true);

      const result = readBank(files, { publicOnly: false });

      expect(result.entries.map((entry) => entry.path)).toEqual([good.path]);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems.every((problem) => problem.file === badPath)).toBe(true);
    },
  );

  test('AC-43: collectIds still counts the id of the invalid file', () => {
    const ids = collectIds({
      'd1/1.3/a-bad.yaml': questionYaml({ id: 'd1-1.3-0009', stem: 'short' }),
    });

    expect(ids).toEqual(['d1-1.3-0009']);
  });

  test('AC-43: two valid files with the same id are still a duplicate', () => {
    const first = fileFor('d1-1.3-0005', 'a-first');
    const second = fileFor('d1-1.3-0005', 'b-second');

    const result = readBank(
      { [first.path]: first.text, [second.path]: second.text },
      {
        publicOnly: false,
      },
    );

    expect(result.entries.map((entry) => entry.path)).toEqual([first.path]);
    expect(only(result.problems).file).toBe(second.path);
  });
});
