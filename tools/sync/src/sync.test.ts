import { describe, expect, test } from 'vitest';
import { backupPath, planSync } from './sync.ts';
import type { FileMap } from './sync.ts';

function files(entries: Record<string, string>): FileMap {
  return new Map(Object.entries(entries).map(([path, content]) => [path, Buffer.from(content)]));
}

describe('backupPath', () => {
  test.each([
    ['.claude/agents/a.md', 'agents/a.md'],
    ['.claude/settings.json', 'settings.json'],
    ['.claude\\skills\\x\\SKILL.md', 'skills/x/SKILL.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['PLAN.md', 'PLAN.md'],
    ['.claude/hooks/deep/er/run.sh', 'hooks/deep/er/run.sh'],
  ])('AC-1: maps %s to %s', (source, expected) => {
    expect(backupPath(source)).toBe(expected);
  });

  test.each([
    ['.claude/worktrees/t/a.ts'],
    ['.claude/hooks/node_modules/x/i.js'],
    ['README.md'],
    ['docs/PLAN.md'],
    ['src/.claude/a.md'],
    ['.claude\\worktrees\\t\\a.ts'],
    ['.claude/skills/x/node_modules/y.js'],
  ])('AC-1: returns null for %s', (source) => {
    expect(backupPath(source)).toBeNull();
  });

  test.each([
    ['.claude/worktreesx/a.md', 'worktreesx/a.md'],
    ['.claude/my_node_modules/a.md', 'my_node_modules/a.md'],
  ])('AC-1: only whole directory names are excluded, so %s is kept', (source, expected) => {
    expect(backupPath(source)).toBe(expected);
  });
});

describe('planSync', () => {
  test('AC-2: new files go to write, sorted, whatever the insertion order', () => {
    const source = files({ 'z/last.md': 'z', 'a.md': 'a', 'm/mid.md': 'm' });
    expect(planSync(source, new Map())).toEqual({
      write: ['a.md', 'm/mid.md', 'z/last.md'],
      remove: [],
      unchanged: 0,
    });
  });

  test('AC-2: a file whose content changed goes to write', () => {
    const plan = planSync(files({ 'a.md': 'new' }), files({ 'a.md': 'old' }));
    expect(plan).toEqual({ write: ['a.md'], remove: [], unchanged: 0 });
  });

  test('AC-2: a change of a single byte at the same length counts as changed', () => {
    const plan = planSync(files({ 'a.bin': 'abcd' }), files({ 'a.bin': 'abce' }));
    expect(plan.write).toEqual(['a.bin']);
    expect(plan.unchanged).toBe(0);
  });

  test('AC-2: identical content in separate buffers counts as unchanged', () => {
    const source: FileMap = new Map([['a.md', Buffer.from([0, 255, 13, 10, 7])]]);
    const backup: FileMap = new Map([['a.md', Buffer.from([0, 255, 13, 10, 7])]]);
    expect(planSync(source, backup)).toEqual({ write: [], remove: [], unchanged: 1 });
  });

  test('AC-2: backup files without a source go to remove, sorted', () => {
    const backup = files({ 'z.md': '1', 'b/c.md': '2', 'a.md': '3' });
    expect(planSync(new Map(), backup)).toEqual({
      write: [],
      remove: ['a.md', 'b/c.md', 'z.md'],
      unchanged: 0,
    });
  });

  test('AC-2: .gitkeep is never removed, at the top level or at any depth', () => {
    const backup = files({
      '.gitkeep': '',
      'sub/.gitkeep': '',
      'a/b/c/.gitkeep': '',
      'old.md': 'x',
    });
    expect(planSync(new Map(), backup).remove).toEqual(['old.md']);
  });

  test('AC-2: only files named exactly .gitkeep are protected', () => {
    const backup = files({ 'sub/.gitkeep.bak': 'x', 'sub/not.gitkeep': 'y' });
    expect(planSync(new Map(), backup).remove).toEqual(['sub/.gitkeep.bak', 'sub/not.gitkeep']);
  });

  test('AC-2: identical maps give an empty plan with every file counted as unchanged', () => {
    const entries = { 'a.md': 'a', 'b/c.md': 'c', CLAUDE: 'x' };
    expect(planSync(files(entries), files(entries))).toEqual({
      write: [],
      remove: [],
      unchanged: 3,
    });
  });

  test('AC-2: two empty maps give an empty plan', () => {
    expect(planSync(new Map(), new Map())).toEqual({ write: [], remove: [], unchanged: 0 });
  });

  test('AC-2: a mixed run splits new, changed, stale and identical files', () => {
    const source = files({
      'same.md': 's',
      'changed.md': 'new',
      'fresh.md': 'f',
      'deep/new.md': 'd',
    });
    const backup = files({
      'same.md': 's',
      'changed.md': 'old',
      'stale.md': 'x',
      'deep/stale.md': 'y',
      '.gitkeep': '',
    });
    expect(planSync(source, backup)).toEqual({
      write: ['changed.md', 'deep/new.md', 'fresh.md'],
      remove: ['deep/stale.md', 'stale.md'],
      unchanged: 1,
    });
  });
});
