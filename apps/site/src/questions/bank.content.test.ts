// Contract test over the repo's real `questions/` folder (spec 026, AC-13): a broken bank fails `pnpm test`.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkQuestionFiles, loadQuestionBank } from './bank.ts';
import type { BankDirs } from './bank.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const questionsDir = join(repoRoot, 'questions');
const dirs: BankDirs = {
  diagramsDir: join(repoRoot, 'diagrams'),
  docsDir: join(repoRoot, 'apps', 'site', 'src', 'content', 'docs'),
  labsDir: join(repoRoot, 'labs'),
};

/** Every `*.yaml` file under `dir` whose name does not start with a dot. */
function countQuestionFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) count += countQuestionFiles(join(dir, entry.name));
    else if (entry.name.endsWith('.yaml')) count += 1;
  }
  return count;
}

describe('questions/ contract', () => {
  test('AC-13: every file in the repo questions/ folder is valid, unique and its links resolve', () => {
    expect(checkQuestionFiles(questionsDir, dirs)).toEqual([]);
  });

  test('AC-13: the repo bank loads with one question per question file', () => {
    const bank = loadQuestionBank(questionsDir, dirs);

    expect(bank.length).toBeGreaterThan(0);
    expect(bank).toHaveLength(countQuestionFiles(questionsDir));
  });
});
