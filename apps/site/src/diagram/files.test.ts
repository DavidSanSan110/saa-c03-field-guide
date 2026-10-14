// Unit tests of the diagram files loader (spec 013, AC-1…AC-11), on temporary folders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkDiagramFiles, MAX_FILE_CAPTION_LENGTH, readDiagramFile } from './files.ts';

// The checks compile the layout with elkjs, which loads lazily and can be slow on a cold machine.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh `<root>/diagrams` folder; `root` is where files outside the folder can be planted. */
function makeFolder(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'diagram-files-'));
  roots.push(root);
  const dir = join(root, 'diagrams');
  mkdirSync(dir);
  return { root, dir };
}

function write(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text, 'utf8');
}

/** The icon files of `public/` that exist for the fake `iconExists`. */
const BASE_ICONS = ['diagram-icons/user.svg', 'diagram-icons/simple-storage-service.svg'];

function iconsOf(...present: string[]): { iconExists: (publicPath: string) => boolean } {
  const files = new Set([...BASE_ICONS, ...present]);
  return { iconExists: (publicPath) => files.has(publicPath) };
}

interface YamlOptions {
  /** Icon of the `client` node. */
  icon?: string;
  /** The edge named by the first step of `main`. */
  firstEdge?: string;
  /** Captions of the steps of `main` (the first step is an edge step, the others node steps). */
  captions?: string[];
  /** Captions of a second scenario `second` (node steps), when given. */
  second?: string[];
}

/** A small valid diagram as YAML text: two nodes, one edge, one scenario (two when `second` is given). */
function diagramYaml(id: string, options: YamlOptions = {}): string {
  const captions = options.captions ?? ['The client sends the object.', 'The bucket stores it.'];
  const steps = captions.map((caption, index) =>
    index === 0
      ? `      - edge: ${options.firstEdge ?? 'put'}\n        caption: "${caption}"`
      : `      - node: bucket\n        caption: "${caption}"`,
  );
  const second =
    options.second === undefined
      ? ''
      : [
          '  - id: second',
          '    label: Second',
          '    steps:',
          ...options.second.map((caption) => `      - node: client\n        caption: "${caption}"`),
        ].join('\n') + '\n';
  return [
    `id: ${id}`,
    'title: A small diagram',
    'nodes:',
    '  - id: client',
    `    icon: ${options.icon ?? 'user'}`,
    '    label: Client',
    '  - id: bucket',
    '    icon: simple-storage-service',
    '    label: Bucket',
    'edges:',
    '  - id: put',
    '    from: client',
    '    to: bucket',
    'scenarios:',
    '  - id: main',
    '    label: Main',
    '    steps:',
    ...steps,
    '',
  ]
    .join('\n')
    .concat(second);
}

/** A valid diagram whose bucket sits in a `region` group (needs `groups/region.svg`). */
function groupedYaml(id: string): string {
  return [
    `id: ${id}`,
    'title: A grouped diagram',
    'groups:',
    '  - id: area',
    '    label: eu-west-1',
    '    kind: region',
    'nodes:',
    '  - id: bucket',
    '    icon: simple-storage-service',
    '    label: Bucket',
    '    group: area',
    'scenarios:',
    '  - id: main',
    '    label: Main',
    '    steps:',
    '      - node: bucket',
    '        caption: "The bucket lives in a region."',
    '',
  ].join('\n');
}

/** The message of the error `action` throws; fails when it does not throw. */
function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

const ONLY_YAML = 'only <id>.yaml files belong in diagrams/';

// ---------------------------------------------------------------------------
// readDiagramFile
// ---------------------------------------------------------------------------

describe('readDiagramFile: reading', () => {
  const data = { id: 'ok', title: 'Fine', nodes: [{ id: 'a', icon: 'user', label: 'A' }] };
  const lines = ['id: ok', 'title: Fine', 'nodes:', '  - id: a', '    icon: user', '    label: A'];

  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('AC-1: returns the parsed data of ok.yaml with %s line endings', (_name, newline) => {
    const { dir } = makeFolder();
    write(dir, 'ok.yaml', lines.join(newline) + newline);

    expect(readDiagramFile(dir, 'ok')).toEqual(data);
  });

  test('AC-1: reads the file of the given id among several files', () => {
    const { dir } = makeFolder();
    write(dir, 'ok.yaml', lines.join('\n') + '\n');
    write(dir, 'other.yaml', 'id: other\ntitle: Other\n');

    expect(readDiagramFile(dir, 'other')).toEqual({ id: 'other', title: 'Other' });
  });
});

describe('readDiagramFile: ids that are not slugs', () => {
  test.each(['../x', 'a/b', 'Ok', 'ok.yaml', ''])(
    "AC-2: throws 'not a lowercase slug' for the id %j",
    (id) => {
      const { dir } = makeFolder();
      write(dir, 'ok.yaml', 'id: ok\n');
      write(dir, 'Ok.yaml', 'id: Ok\n');

      expect(messageOf(() => readDiagramFile(dir, id))).toContain(
        `Diagram id '${id}' is not a lowercase slug`,
      );
    },
  );

  test.each(['a--b', 'a_b', '-a', 'a-'])('AC-2: also rejects the malformed slug %j', (id) => {
    const { dir } = makeFolder();

    expect(messageOf(() => readDiagramFile(dir, id))).toContain('not a lowercase slug');
  });

  test('AC-2: does not read a file outside the folder through "../x"', () => {
    const { root, dir } = makeFolder();
    write(root, 'x.yaml', 'id: x\ntitle: Outside\n');

    expect(messageOf(() => readDiagramFile(dir, '../x'))).toContain('not a lowercase slug');
  });
});

describe('readDiagramFile: missing and invalid files', () => {
  test('AC-3: a missing file throws a message with the file name and "not found"', () => {
    const { dir } = makeFolder();

    const message = messageOf(() => readDiagramFile(dir, 'missing'));

    expect(message).toContain('missing.yaml');
    expect(message).toContain('not found');
  });

  test.each([
    ['a syntax error', 'syntax', 'title: [unclosed\n'],
    ['a duplicate key', 'duplicate', 'id: duplicate\ntitle: One\ntitle: Two\n'],
    ['two YAML documents', 'multi', 'id: multi\ntitle: One\n---\nid: multi\ntitle: Two\n'],
  ])('AC-4: %s throws a message with the file name and "not valid YAML"', (_name, id, text) => {
    const { dir } = makeFolder();
    write(dir, `${id}.yaml`, text);

    const message = messageOf(() => readDiagramFile(dir, id));

    expect(message).toContain(`${id}.yaml`);
    expect(message).toContain('not valid YAML');
  });
});

describe('readDiagramFile: the id inside the file', () => {
  test("AC-5: an id different from the file name throws a message with both names ('a.yaml', 'b')", () => {
    const { dir } = makeFolder();
    write(dir, 'a.yaml', 'id: b\ntitle: Mismatch\n');

    const message = messageOf(() => readDiagramFile(dir, 'a'));

    expect(message).toContain('a.yaml');
    expect(message).toContain("'b'");
  });

  test('AC-5: data without an id field is returned as is', () => {
    const { dir } = makeFolder();
    write(dir, 'a.yaml', 'title: No id\n');

    expect(readDiagramFile(dir, 'a')).toEqual({ title: 'No id' });
  });

  test.each([
    ['a number', 'id: 5', 5],
    ['null', 'id:', null],
    ['a list', 'id: [a]', ['a']],
  ])('AC-5: data whose id is %s is returned as is', (_name, line, id) => {
    const { dir } = makeFolder();
    write(dir, 'a.yaml', `${line}\ntitle: Odd id\n`);

    expect(readDiagramFile(dir, 'a')).toEqual({ id, title: 'Odd id' });
  });

  test('AC-5: data whose id equals the file name is returned', () => {
    const { dir } = makeFolder();
    write(dir, 'a.yaml', 'id: a\ntitle: Same\n');

    expect(readDiagramFile(dir, 'a')).toEqual({ id: 'a', title: 'Same' });
  });

  test('AC-5: the schema is not validated: any parsed value is returned', () => {
    const { dir } = makeFolder();
    write(dir, 'a.yaml', '- just\n- a list\n');

    expect(readDiagramFile(dir, 'a')).toEqual(['just', 'a list']);
  });
});

// ---------------------------------------------------------------------------
// checkDiagramFiles
// ---------------------------------------------------------------------------

describe('checkDiagramFiles: a healthy folder', () => {
  test('AC-6: one valid diagram whose icons exist, plus a .gitkeep, has no problems', async () => {
    const { dir } = makeFolder();
    write(dir, 'ok.yaml', diagramYaml('ok'));
    write(dir, '.gitkeep', '');

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([]);
  });

  test('AC-6: an empty folder has no problems', async () => {
    const { dir } = makeFolder();

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([]);
  });

  test('AC-6: a valid diagram with a group, whose group icon exists, has no problems', async () => {
    const { dir } = makeFolder();
    write(dir, 'grouped.yaml', groupedYaml('grouped'));

    expect(await checkDiagramFiles(dir, iconsOf('diagram-icons/groups/region.svg'))).toEqual([]);
  });

  test('AC-6: every entry whose name starts with a dot is ignored, directories included', async () => {
    const { dir } = makeFolder();
    write(dir, '.hidden.yaml', 'not: [valid');
    mkdirSync(join(dir, '.cache'));

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([]);
  });
});

describe('checkDiagramFiles: entries that do not belong', () => {
  test('AC-7: a.yml, notes.md, Bad.yaml and a subdirectory are reported, each with its name', async () => {
    const { dir } = makeFolder();
    write(dir, 'ok.yaml', diagramYaml('ok'));
    write(dir, 'a.yml', diagramYaml('a'));
    write(dir, 'notes.md', '# Notes\n');
    write(dir, 'Bad.yaml', diagramYaml('Bad'));
    mkdirSync(join(dir, 'sub'));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect([...problems].sort()).toEqual(
      ['Bad.yaml', 'a.yml', 'notes.md', 'sub'].map((name) => `${name}: ${ONLY_YAML}`).sort(),
    );
  });

  test('AC-7: a directory named like a diagram file is reported too', async () => {
    const { dir } = makeFolder();
    mkdirSync(join(dir, 'folder.yaml'));

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([`folder.yaml: ${ONLY_YAML}`]);
  });

  test('AC-7: the check is not recursive: a broken file inside a subdirectory is not reported', async () => {
    const { dir } = makeFolder();
    mkdirSync(join(dir, 'sub'));
    write(join(dir, 'sub'), 'inner.yaml', 'not: [valid');

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([`sub: ${ONLY_YAML}`]);
  });

  test('AC-7: a name that is not a lowercase slug is reported even when its YAML is fine', async () => {
    const { dir } = makeFolder();
    write(dir, 'two--dashes.yaml', diagramYaml('two--dashes'));

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([`two--dashes.yaml: ${ONLY_YAML}`]);
  });
});

describe('checkDiagramFiles: files the loader rejects', () => {
  test('AC-8: bad YAML and an id mismatch are both reported with the loader message, each on its own line', async () => {
    const { dir } = makeFolder();
    write(dir, 'broken.yaml', 'title: [unclosed\n');
    write(dir, 'mismatch.yaml', diagramYaml('other'));
    write(dir, 'ok.yaml', diagramYaml('ok'));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems).toHaveLength(2);
    const [brokenLine, mismatchLine] = problems as [string, string];
    expect(brokenLine.startsWith('broken.yaml: ')).toBe(true);
    expect(brokenLine).toContain(messageOf(() => readDiagramFile(dir, 'broken')));
    expect(brokenLine).toContain('not valid YAML');
    expect(mismatchLine.startsWith('mismatch.yaml: ')).toBe(true);
    expect(mismatchLine).toContain(messageOf(() => readDiagramFile(dir, 'mismatch')));
    expect(mismatchLine).toContain("'other'");
  });

  test('AC-8: a file that cannot be read does not stop the check of the others', async () => {
    const { dir } = makeFolder();
    write(dir, 'a-broken.yaml', 'title: [unclosed\n');
    write(dir, 'b-schema.yaml', diagramYaml('b-schema', { firstEdge: 'nope' }));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems.some((line) => line.startsWith('a-broken.yaml: '))).toBe(true);
    expect(problems.some((line) => line.startsWith('b-schema.yaml: '))).toBe(true);
  });

  test('AC-8: the files are checked in name order', async () => {
    const { dir } = makeFolder();
    write(dir, 'c.yaml', 'title: [unclosed\n');
    write(dir, 'a.yaml', 'title: [unclosed\n');
    write(dir, 'b.yaml', 'title: [unclosed\n');

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems.map((line) => line.slice(0, 'a.yaml'.length))).toEqual([
      'a.yaml',
      'b.yaml',
      'c.yaml',
    ]);
  });
});

describe('checkDiagramFiles: the diagram itself', () => {
  test('AC-9: a step with an unknown edge is reported with its schema path, prefixed with the file name', async () => {
    const { dir } = makeFolder();
    write(dir, 'bad.yaml', diagramYaml('bad', { firstEdge: 'nope' }));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith('bad.yaml: ')).toBe(true);
    expect(problems[0]).toContain('scenarios.0.steps.0.edge');
  });

  test('AC-9: a node icon that does not exist is reported with the icon name', async () => {
    const { dir } = makeFolder();
    write(dir, 'bad.yaml', diagramYaml('bad', { icon: 'ghost-service' }));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith('bad.yaml: ')).toBe(true);
    expect(problems[0]).toContain('ghost-service');
  });

  test('AC-9: a group icon that does not exist is reported with the group kind', async () => {
    const { dir } = makeFolder();
    write(dir, 'grouped.yaml', groupedYaml('grouped'));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith('grouped.yaml: ')).toBe(true);
    expect(problems[0]).toContain('region');
  });

  test('AC-9: the icons are looked up through the iconExists of the options', async () => {
    const { dir } = makeFolder();
    write(dir, 'ok.yaml', diagramYaml('ok'));
    const asked: string[] = [];

    await checkDiagramFiles(dir, {
      iconExists: (publicPath) => {
        asked.push(publicPath);
        return true;
      },
    });

    expect(asked).toContain('diagram-icons/user.svg');
    expect(asked).toContain('diagram-icons/simple-storage-service.svg');
  });
});

describe('checkDiagramFiles: caption length', () => {
  const caption = (length: number): string => 'a'.repeat(length);

  test('AC-10: MAX_FILE_CAPTION_LENGTH is 140', () => {
    expect(MAX_FILE_CAPTION_LENGTH).toBe(140);
  });

  test('AC-10: a 141-character caption is reported with its scenario, its 1-based step and its length', async () => {
    const { dir } = makeFolder();
    write(dir, 'long.yaml', diagramYaml('long', { captions: ['Short.', caption(141)] }));

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems).toEqual([
      "long.yaml: scenario 'main' step 2: caption has 141 characters (max 140)",
    ]);
  });

  test('AC-10: a 140-character caption passes', async () => {
    const { dir } = makeFolder();
    write(dir, 'edge.yaml', diagramYaml('edge', { captions: [caption(140), caption(140)] }));

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([]);
  });

  test('AC-10: every long caption is reported, in scenario and step order', async () => {
    const { dir } = makeFolder();
    write(
      dir,
      'long.yaml',
      diagramYaml('long', {
        captions: [caption(150), 'Short.', caption(141)],
        second: ['Short.', 'Short.', caption(200)],
      }),
    );

    expect(await checkDiagramFiles(dir, iconsOf())).toEqual([
      "long.yaml: scenario 'main' step 1: caption has 150 characters (max 140)",
      "long.yaml: scenario 'main' step 3: caption has 141 characters (max 140)",
      "long.yaml: scenario 'second' step 3: caption has 200 characters (max 140)",
    ]);
  });

  test('AC-10: the caption length is only checked once the schema passes', async () => {
    const { dir } = makeFolder();
    write(
      dir,
      'bad.yaml',
      diagramYaml('bad', { firstEdge: 'nope', captions: [caption(141), caption(141)] }),
    );

    const problems = await checkDiagramFiles(dir, iconsOf());

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((line) => line.includes('caption has'))).toBe(false);
  });
});

describe('checkDiagramFiles: a folder that does not exist', () => {
  test('AC-11: resolves to one line naming the folder', async () => {
    const { root } = makeFolder();
    const missing = join(root, 'no-such-diagrams');

    const problems = await checkDiagramFiles(missing, iconsOf());

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no-such-diagrams');
  });

  test('AC-11: never rejects when the folder does not exist', async () => {
    const { root } = makeFolder();

    await expect(
      checkDiagramFiles(join(root, 'no-such-diagrams'), iconsOf()),
    ).resolves.toBeInstanceOf(Array);
  });
});
