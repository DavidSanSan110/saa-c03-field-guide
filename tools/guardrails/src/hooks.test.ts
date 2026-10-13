import lint from '@commitlint/lint';
import load from '@commitlint/load';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';

// Loading the commitlint config resolves the conventional preset from disk, which can be slow when cold.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

describe('commitlint config', () => {
  async function check(message: string): Promise<boolean> {
    const config = await load(
      {},
      { file: join(REPO_ROOT, 'commitlint.config.js'), cwd: REPO_ROOT },
    );
    const parserOpts = config.parserPreset?.parserOpts;
    const report = await lint(
      message,
      config.rules,
      typeof parserOpts === 'object' && parserOpts !== null ? { parserOpts } : {},
    );
    return report.valid;
  }

  test.each([
    'feat(schema): add x',
    'content(d1): add s3 page',
    'fix: y',
    'test: add regression tests for guardrails and question schema review findings',
  ])('AC-22: accepts "%s"', async (message) => {
    expect(await check(message)).toBe(true);
  });

  test.each([
    ['a message without a type', 'updated stuff'],
    ['a capitalised type and a trailing period', 'Feat: X.'],
    ['an unknown type', 'wip: add x'],
    ['an empty subject', 'feat: '],
    ['an empty subject with a scope', 'feat(schema): '],
  ])('AC-22: rejects %s', async (_label, message) => {
    expect(await check(message)).toBe(false);
  });
});

interface Job {
  name?: string;
  run?: string;
  use_stdin?: boolean;
}

interface Lefthook {
  [hook: string]: { jobs?: Job[] } | undefined;
}

const lefthook = parse(readFileSync(join(REPO_ROOT, 'lefthook.yml'), 'utf8')) as Lefthook;

function jobsOf(hook: string): Job[] {
  return lefthook[hook]?.jobs ?? [];
}

function namesOf(hook: string): string[] {
  return jobsOf(hook).map((job) => job.name ?? '');
}

describe('lefthook.yml', () => {
  test('AC-23: pre-commit defines the gitleaks, guardrails, eslint, prettier and terraform-fmt jobs', () => {
    expect(namesOf('pre-commit')).toEqual(
      expect.arrayContaining(['gitleaks', 'guardrails', 'eslint', 'prettier', 'terraform-fmt']),
    );
  });

  test('AC-23: commit-msg defines the commitlint and guardrails jobs', () => {
    expect(namesOf('commit-msg')).toEqual(expect.arrayContaining(['commitlint', 'guardrails']));
  });

  test('AC-23: pre-push defines the no-push-to-main, typecheck and unit-tests jobs', () => {
    expect(namesOf('pre-push')).toEqual(
      expect.arrayContaining(['no-push-to-main', 'typecheck', 'unit-tests']),
    );
  });

  test('AC-23: the no-push-to-main job reads the refs from stdin', () => {
    const job = jobsOf('pre-push').find((candidate) => candidate.name === 'no-push-to-main');
    expect(job?.use_stdin).toBe(true);
  });

  test('AC-23: every job has a run command', () => {
    for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
      for (const job of jobsOf(hook)) {
        expect(typeof job.run, `${hook}/${job.name ?? '?'}`).toBe('string');
      }
    }
  });

  test('AC-23: no run command has braces other than Lefthook placeholders', () => {
    const placeholders = /\{(staged_files|1)\}/g;
    for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
      for (const job of jobsOf(hook)) {
        const stripped = (job.run ?? '').replace(placeholders, '');
        expect(stripped, `${hook}/${job.name ?? '?'}`).not.toMatch(/[{}]/);
      }
    }
  });
});
