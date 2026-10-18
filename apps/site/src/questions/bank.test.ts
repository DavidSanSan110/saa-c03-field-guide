// Tests for spec 026 (AC-1 to AC-12): the question bank checks and loader, on temp folders.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateQuestion } from '@field-guide/schema';
import type { DomainId, Question, QuestionLinks, TaskId } from '@field-guide/schema';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { checkQuestionFiles, loadQuestionBank } from './bank.ts';
import type { BankDirs } from './bank.ts';

/** A valid reviewed question; the id fixes domain and task. Each test changes one thing through `overrides`. */
function question(id: string, overrides: Partial<Question> = {}): Question {
  const domain = Number(id.charAt(1)) as DomainId;
  const task = id.slice(3, 6) as TaskId;
  const multiple = overrides.type === 'multiple';
  const keys = multiple ? ['A', 'B', 'C', 'D', 'E'] : ['A', 'B', 'C', 'D'];
  const correctKeys = multiple ? ['A', 'B'] : ['A'];
  return {
    id,
    domain,
    task,
    services: ['s3', 'kms'],
    difficulty: 'medium',
    type: 'single',
    stem: `A company needs to protect its data at rest (${id}). Which solution meets the requirement?`,
    options: keys.map((key) => ({
      key,
      text: `Option ${key} of ${id}`,
      correct: correctKeys.includes(key),
      why: `Because of the reason for option ${key}.`,
    })),
    references: ['https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html'],
    status: 'reviewed',
    provenance: { generated_by: 'test-writer', verified_by: 'test-verifier', reviewed_by: 'owner' },
    ...overrides,
  };
}

// The helper itself must build questions the real schema accepts, or every test would be wrong.
for (const candidate of [
  question('d1-1.1-0001'),
  question('d2-2.1-0001', { type: 'multiple' }),
  question('d1-1.2-0001', { cue: 'a cue', links: { guide: '/d1/a', diagram: 'x', lab: '01-x' } }),
]) {
  const sanity = validateQuestion(candidate, { publicOnly: true });
  if (!sanity.ok)
    throw new Error(`test helper builds an invalid question: ${sanity.errors.join('; ')}`);
}

let root: string;
let questionsDir: string;
let dirs: BankDirs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-guide-bank-'));
  questionsDir = join(root, 'questions');
  mkdirSync(questionsDir);
  dirs = {
    diagramsDir: join(root, 'diagrams'),
    docsDir: join(root, 'docs'),
    labsDir: join(root, 'labs'),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a file (and its folders) under `base`, `rel` in POSIX form. */
function put(rel: string, text: string, base: string = questionsDir): string {
  const path = join(base, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function putQuestion(rel: string, data: Question): void {
  put(rel, stringify(data));
}

function check(): string[] {
  return checkQuestionFiles(questionsDir, dirs);
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the call to throw, but it returned');
}

function codeUnitSorted(lines: string[]): string[] {
  return [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Creates a symlink; false when the OS refuses (Windows without the privilege), so the test can skip. */
function makeSymlink(target: string, path: string, type: 'file' | 'dir'): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

const LINK_PATH = 'd1/1.1/linked.yaml';

/** A valid bank question at `d1/1.1/linked.yaml` with the given links. */
function putLinked(links: QuestionLinks): void {
  putQuestion(LINK_PATH, question('d1-1.1-0001', { links }));
}

describe('loading a valid bank', () => {
  test('AC-1: two valid questions give no problems', () => {
    putQuestion('d1/1.1/first.yaml', question('d1-1.1-0001'));
    putQuestion('d2/2.1/second.yaml', question('d2-2.1-0001', { type: 'multiple' }));

    expect(check()).toEqual([]);
  });

  test('AC-1: the bank returns every question with all its fields, sorted by id whatever the file names', () => {
    const first = question('d1-1.1-0001', { cue: 'a cue for the first question' });
    const second = question('d1-1.1-0002', { difficulty: 'hard' });
    // Files named in the reverse order of the ids, so sorting by path would give [second, first].
    putQuestion('d1/1.1/aaa.yaml', second);
    putQuestion('d1/1.1/zzz.yaml', first);

    expect(loadQuestionBank(questionsDir, dirs)).toEqual([first, second]);
  });

  test('AC-1: ids sort across task and domain folders, not by file path', () => {
    const d1t1a = question('d1-1.1-0002');
    const d1t1b = question('d1-1.1-0010');
    const d1t2 = question('d1-1.2-0001');
    const d2 = question('d2-2.1-0001', { type: 'multiple' });
    putQuestion('d2/2.1/aaa.yaml', d2);
    putQuestion('d1/1.2/aaa.yaml', d1t2);
    putQuestion('d1/1.1/bbb.yaml', d1t1b);
    putQuestion('d1/1.1/zzz.yaml', d1t1a);

    const ids = loadQuestionBank(questionsDir, dirs).map((entry) => entry.id);

    expect(ids).toEqual(['d1-1.1-0002', 'd1-1.1-0010', 'd1-1.2-0001', 'd2-2.1-0001']);
  });

  test('AC-1: the bank keeps optional fields and a multiple-answer question as written', () => {
    const multiple = question('d2-2.1-0003', { type: 'multiple', cue: 'two answers needed' });
    putQuestion('d2/2.1/multi.yaml', multiple);

    expect(loadQuestionBank(questionsDir, dirs)).toEqual([multiple]);
  });
});

describe('empty and missing folders', () => {
  test('AC-2: an empty folder gives no problems and an empty bank', () => {
    expect(check()).toEqual([]);
    expect(loadQuestionBank(questionsDir, dirs)).toEqual([]);
  });

  test('AC-2: a folder holding only .gitkeep gives no problems and an empty bank', () => {
    put('.gitkeep', '');

    expect(check()).toEqual([]);
    expect(loadQuestionBank(questionsDir, dirs)).toEqual([]);
  });

  test('AC-3: a missing folder gives exactly one "Questions folder" problem', () => {
    const missing = join(root, 'does-not-exist');

    const problems = checkQuestionFiles(missing, dirs);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Questions folder '/);
    expect(problems[0]).toContain(`'${missing}' cannot be read: `);
  });

  test('AC-3: a path that is a file, not a folder, gives exactly one "Questions folder" problem', () => {
    const notAFolder = put('a-file.txt', 'not a folder', root);

    const problems = checkQuestionFiles(notAFolder, dirs);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Questions folder '/);
    expect(problems[0]).toContain('cannot be read');
  });

  test('AC-3: loading a missing folder throws an Error that contains that line', () => {
    const missing = join(root, 'does-not-exist');
    const [line] = checkQuestionFiles(missing, dirs);

    const error = thrownBy(() => loadQuestionBank(missing, dirs));

    expect(line).toBeDefined();
    expect(error.message).toContain(line ?? 'no problem line');
    expect(error.message).toContain('cannot be read');
  });
});

describe('invalid question files', () => {
  test('AC-4: a draft question gives a problem line that starts with its path and mentions status', () => {
    putQuestion('d1/1.1/draft-one.yaml', question('d1-1.1-0001', { status: 'draft' }));

    const problems = check();

    expect(problems.length).toBeGreaterThan(0);
    for (const line of problems) expect(line.startsWith('d1/1.1/draft-one.yaml: ')).toBe(true);
    expect(problems.some((line) => line.includes('status'))).toBe(true);
  });

  test('AC-4: a verified (not yet reviewed) question is not public either', () => {
    putQuestion('d1/1.1/verified-one.yaml', question('d1-1.1-0001', { status: 'verified' }));

    const problems = check();

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((line) => line.startsWith('d1/1.1/verified-one.yaml: '))).toBe(true);
    expect(problems.some((line) => line.includes('status'))).toBe(true);
  });

  test('AC-4: loading a bank with a draft throws, even when other questions are valid', () => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    putQuestion('d1/1.1/draft-one.yaml', question('d1-1.1-0002', { status: 'draft' }));

    const error = thrownBy(() => loadQuestionBank(questionsDir, dirs));

    expect(error.message).toContain('d1/1.1/draft-one.yaml: ');
  });

  test('AC-5: a question in the wrong task folder gives a problem line for that path only', () => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    putQuestion('d2/2.1/wrong-place.yaml', question('d1-1.1-0002'));

    const problems = check();

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((line) => line.startsWith('d2/2.1/wrong-place.yaml: '))).toBe(true);
  });

  test('AC-5: invalid YAML gives a problem line for that path only', () => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    put('d1/1.1/broken.yaml', 'id: [unclosed\nstem: "never closed\n');

    const problems = check();

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((line) => line.startsWith('d1/1.1/broken.yaml: '))).toBe(true);
  });

  test('AC-5: a file that is valid YAML but not a question gives a problem line for that path', () => {
    put('d1/1.1/not-a-question.yaml', 'hello: world\n');

    const problems = check();

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((line) => line.startsWith('d1/1.1/not-a-question.yaml: '))).toBe(true);
  });

  test('AC-6: two files with the same id give a problem for the second path only, naming the id', () => {
    // Created in the reverse order of the paths. In code-unit order 'a-b.yaml' comes before 'a.yaml'
    // ('-' < '.'), which differs from the order of the slugs ('a' < 'a-b').
    putQuestion('d1/1.1/a.yaml', question('d1-1.1-0001'));
    putQuestion('d1/1.1/a-b.yaml', question('d1-1.1-0001'));

    const problems = check();

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith('d1/1.1/a.yaml: ')).toBe(true);
    expect(problems[0]).toContain('d1-1.1-0001');
  });

  test('AC-6: three files with one id report the second and the third, never the first', () => {
    putQuestion('d1/1.1/ccc.yaml', question('d1-1.1-0001'));
    putQuestion('d1/1.1/bbb.yaml', question('d1-1.1-0001'));
    putQuestion('d1/1.1/aaa.yaml', question('d1-1.1-0001'));

    const problems = check();

    expect(problems.some((line) => line.startsWith('d1/1.1/aaa.yaml'))).toBe(false);
    expect(problems.some((line) => line.startsWith('d1/1.1/bbb.yaml: '))).toBe(true);
    expect(problems.some((line) => line.startsWith('d1/1.1/ccc.yaml: '))).toBe(true);
  });
});

describe('files that do not belong in questions/', () => {
  const only = (path: string): string =>
    `${path}: only question files (d<domain>/<task>/<slug>.yaml) belong in questions/`;

  test.each([
    { name: 'check sidecar', path: 'd1/1.1/x.check.yaml', content: 'result: ok\n' },
    {
      name: 'file under rejected/',
      path: 'rejected/d1/1.1/x.yaml',
      content: stringify(question('d1-1.1-0001')),
    },
    { name: 'non-YAML file at the top level', path: 'notes.txt', content: 'some notes\n' },
    {
      name: 'question file directly in a domain folder',
      path: 'd1/x.yaml',
      content: stringify(question('d1-1.1-0001')),
    },
    {
      name: 'question file nested one level too deep',
      path: 'd1/1.1/sub/x.yaml',
      content: stringify(question('d1-1.1-0001')),
    },
  ])('AC-7: a $name gives exactly one "only question files" line', ({ path, content }) => {
    put(path, content);

    expect(check()).toEqual([only(path)]);
  });

  test('AC-7: a .yml file gives a problem line that starts with its path', () => {
    put('d1/1.1/x.yml', stringify(question('d1-1.1-0001')));

    const problems = check();

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((line) => line.startsWith('d1/1.1/x.yml'))).toBe(true);
  });

  test('AC-7: a stray file does not hide the valid questions, but loading the bank still throws', () => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    put('notes.txt', 'some notes\n');

    expect(check()).toEqual([only('notes.txt')]);
    expect(thrownBy(() => loadQuestionBank(questionsDir, dirs)).message).toContain(
      only('notes.txt'),
    );
  });

  test('AC-7: .gitkeep files at any depth give no problem and are not questions', () => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    put('.gitkeep', '');
    put('d1/.gitkeep', '');
    put('d1/1.1/.gitkeep', '');
    put('d2/2.1/.gitkeep', '');
    put('rejected/.gitkeep', '');

    expect(check()).toEqual([]);
    expect(loadQuestionBank(questionsDir, dirs).map((entry) => entry.id)).toEqual(['d1-1.1-0001']);
  });

  test('AC-7: any entry whose name starts with a dot is skipped, folders included', () => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    put('.DS_Store', 'binary');
    put('d1/1.1/.hidden.yaml', 'not: a question');
    put('.cache/stuff.txt', 'cache');

    expect(check()).toEqual([]);
  });
});

describe('symbolic links', () => {
  const symlinkLine = (path: string): string => `${path}: symbolic links are not allowed`;

  test('AC-8: a symlink to a valid question file is a problem and its target is not read', (ctx) => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    // The target lives outside the folder, so only following the link could bring its question in.
    const target = put('outside/target.yaml', stringify(question('d1-1.1-0002')), root);
    if (!makeSymlink(target, join(questionsDir, 'd1', '1.1', 'link.yaml'), 'file')) ctx.skip();

    expect(check()).toEqual([symlinkLine('d1/1.1/link.yaml')]);
  });

  test('AC-8: a symlink to a folder is a problem and the folder is not walked', (ctx) => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    put('outside/d1/1.1/inner.yaml', stringify(question('d1-1.1-0002')), root);
    put('outside/stray.txt', 'stray', root);
    if (!makeSymlink(join(root, 'outside'), join(questionsDir, 'linked-dir'), 'dir')) ctx.skip();

    expect(check()).toEqual([symlinkLine('linked-dir')]);
  });

  test('AC-8: a symlink to a folder inside a task folder is reported with its path', (ctx) => {
    put('outside/inner.yaml', stringify(question('d1-1.1-0002')), root);
    if (!makeSymlink(join(root, 'outside'), join(questionsDir, 'd1', '1.1', 'sub'), 'dir')) {
      ctx.skip();
    }

    expect(check()).toEqual([symlinkLine('d1/1.1/sub')]);
  });

  test('AC-8: a dangling symlink is a problem too', (ctx) => {
    if (
      !makeSymlink(
        join(root, 'outside', 'gone.yaml'),
        join(questionsDir, 'd1', '1.1', 'gone.yaml'),
        'file',
      )
    ) {
      ctx.skip();
    }

    expect(check()).toEqual([symlinkLine('d1/1.1/gone.yaml')]);
  });

  test('AC-8: loading a bank with a symlink throws and names it', (ctx) => {
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0001'));
    const target = put('outside/target.yaml', stringify(question('d1-1.1-0002')), root);
    if (!makeSymlink(target, join(questionsDir, 'd1', '1.1', 'link.yaml'), 'file')) ctx.skip();

    const error = thrownBy(() => loadQuestionBank(questionsDir, dirs));

    expect(error.message).toContain(symlinkLine('d1/1.1/link.yaml'));
  });
});

describe('links.diagram', () => {
  test('AC-9: an existing diagrams/<id>.yaml gives no problem and the link is kept in the bank', () => {
    put('s3-sse-kms-upload.yaml', 'title: S3 upload\n', dirs.diagramsDir);
    putLinked({ diagram: 's3-sse-kms-upload' });

    expect(check()).toEqual([]);
    expect(loadQuestionBank(questionsDir, dirs)[0]?.links).toEqual({
      diagram: 's3-sse-kms-upload',
    });
  });

  test('AC-9: a diagram id with no file gives the "has no diagrams/" line', () => {
    put('s3-sse-kms-upload.yaml', 'title: S3 upload\n', dirs.diagramsDir);
    putLinked({ diagram: 'missing-one' });

    expect(check()).toEqual([
      `${LINK_PATH}: links.diagram 'missing-one' has no diagrams/missing-one.yaml`,
    ]);
  });

  test('AC-9: a diagram link is a problem when the diagrams folder does not exist', () => {
    putLinked({ diagram: 'missing-one' });

    expect(check()).toEqual([
      `${LINK_PATH}: links.diagram 'missing-one' has no diagrams/missing-one.yaml`,
    ]);
  });

  test('AC-9: a diagram id that climbs out of the folder is a problem even if the file exists', () => {
    put('s3-sse-kms-upload.yaml', 'title: outside the diagrams folder\n', root);
    putLinked({ diagram: '../s3-sse-kms-upload' });

    const problems = check();

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith(`${LINK_PATH}: links.diagram`)).toBe(true);
  });

  test('AC-9: a diagram id that is not a lowercase slug is a problem even if the file exists', () => {
    put('Upper_Case.yaml', 'title: not a slug\n', dirs.diagramsDir);
    putLinked({ diagram: 'Upper_Case' });

    const problems = check();

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith(`${LINK_PATH}: links.diagram`)).toBe(true);
  });
});

describe('links.guide', () => {
  const notAPage = (link: string): string =>
    `${LINK_PATH}: links.guide '${link}' is not a guide page`;

  function putDocs(): void {
    put('d1/a/b.mdx', '# b\n', dirs.docsDir);
    put('d1/a/index.md', '# a\n', dirs.docsDir);
    put('d1/p.md', '# p\n', dirs.docsDir);
    put('d1/q/index.mdx', '# q\n', dirs.docsDir);
    put('d1/c/deep.md', '# deep\n', dirs.docsDir);
  }

  test.each([
    '/d1/a/b',
    '/d1/a/b/',
    '/d1/a/b#part',
    '/d1/a/b/#part',
    '/d1/a/',
    '/d1/a',
    '/d1/p',
    '/d1/q',
    '/d1/q/',
  ])('AC-10: the guide link %s points to an existing page', (link) => {
    putDocs();
    putLinked({ guide: link });

    expect(check()).toEqual([]);
  });

  test('AC-10: a guide link to a page that does not exist gives the "is not a guide page" line', () => {
    putDocs();
    putLinked({ guide: '/d1/a/nope' });

    expect(check()).toEqual([notAPage('/d1/a/nope')]);
  });

  test('AC-10: a guide link to a folder without index page is not a page', () => {
    putDocs();
    putLinked({ guide: '/d1/c' });

    expect(check()).toEqual([notAPage('/d1/c')]);
  });

  test('AC-10: a guide link is a problem when the docs folder does not exist', () => {
    putLinked({ guide: '/d1/a/b' });

    expect(check()).toEqual([notAPage('/d1/a/b')]);
  });

  test.each(['/d1/../secret', '/../secret', '/d1/a/../../secret'])(
    'AC-10: the guide link %s with ".." is a problem even if the target exists',
    (link) => {
      putDocs();
      put('secret.md', '# secret\n', dirs.docsDir);
      put('secret.md', '# secret outside the docs\n', root);
      putLinked({ guide: link });

      const problems = check();

      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith(`${LINK_PATH}: `)).toBe(true);
    },
  );

  test('AC-10: a guide link with a backslash is a problem even if the target exists', () => {
    putDocs();
    putLinked({ guide: '/d1\\a\\b' });

    const problems = check();

    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith(`${LINK_PATH}: `)).toBe(true);
  });
});

describe('links.lab', () => {
  const noLab = `${LINK_PATH}: links.lab '01-x' has no labs/01-x/`;

  test('AC-11: a lab id that is a folder in labs/ gives no problem', () => {
    mkdirSync(join(dirs.labsDir, '01-x'), { recursive: true });
    putLinked({ lab: '01-x' });

    expect(check()).toEqual([]);
  });

  test('AC-11: a lab folder that is missing gives the "has no labs/" line', () => {
    mkdirSync(join(dirs.labsDir, '02-other'), { recursive: true });
    putLinked({ lab: '01-x' });

    expect(check()).toEqual([noLab]);
  });

  test('AC-11: a lab id that is a file, not a folder, gives the "has no labs/" line', () => {
    put('01-x', 'a file, not a lab folder', dirs.labsDir);
    putLinked({ lab: '01-x' });

    expect(check()).toEqual([noLab]);
  });

  test('AC-11: every lab link is a problem when labs/ does not exist', () => {
    putLinked({ lab: '01-x' });

    expect(check()).toEqual([noLab]);
  });
});

describe('several problems at once', () => {
  function putSeveralProblems(): void {
    // Written in a different order from the sorted result.
    put('notes.txt', 'some notes\n');
    put('d2/2.1/c-broken.yaml', 'id: [unclosed\n');
    putQuestion('d1/1.1/b-draft.yaml', question('d1-1.1-0002', { status: 'draft' }));
    putQuestion(
      'd1/1.1/a-link.yaml',
      question('d1-1.1-0001', { links: { diagram: 'missing-one' } }),
    );
    putQuestion('d1/1.1/ok.yaml', question('d1-1.1-0003'));
  }

  const paths = ['d1/1.1/a-link.yaml', 'd1/1.1/b-draft.yaml', 'd2/2.1/c-broken.yaml', 'notes.txt'];

  test('AC-12: problem lines from several files come back sorted, link problems among them', () => {
    putSeveralProblems();

    const problems = check();

    expect(problems.map((line) => line.slice(0, line.indexOf(': ')))).toEqual(paths);
    expect(problems).toEqual(codeUnitSorted(problems));
  });

  test('AC-12: loading throws an Error whose message contains every problem line', () => {
    putSeveralProblems();
    const problems = check();

    const error = thrownBy(() => loadQuestionBank(questionsDir, dirs));

    expect(problems).toHaveLength(paths.length);
    for (const line of problems) expect(error.message).toContain(line);
  });

  test('AC-12: loading never returns a partial bank when only one file is bad', () => {
    putQuestion('d1/1.1/ok-one.yaml', question('d1-1.1-0001'));
    putQuestion('d1/1.1/ok-two.yaml', question('d1-1.1-0002'));
    putQuestion('d1/1.1/bad.yaml', question('d1-1.1-0003', { status: 'draft' }));

    const error = thrownBy(() => loadQuestionBank(questionsDir, dirs));

    expect(error.message).toContain('d1/1.1/bad.yaml: ');
  });
});
