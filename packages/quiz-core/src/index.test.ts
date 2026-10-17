import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import * as quizCore from './index.ts';
import type {
  Answers,
  AttemptScore,
  DomainPlan,
  Exam,
  ExamItem,
  QuestionResult,
  Rng,
  ScoreBucket,
} from './index.ts';

const srcDir = import.meta.dirname;

/** Non-test source files of `src/`, not counting `__mocks__/`. */
function sourceFiles(): string[] {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(?:ts|tsx|js|mjs)$/.test(name) && !/\.test\.[^.]+$/.test(name))
    .sort();
}

function readSource(name: string): string {
  return readFileSync(join(srcDir, name), 'utf8');
}

/** Source without comments, so a comment cannot trigger the identifier checks. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function importSpecifiers(source: string): string[] {
  const code = withoutComments(source);
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from 'x', export ... from 'x'
    /\bimport\s*['"]([^'"]+)['"]/g, // import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  ];
  return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1] ?? ''));
}

describe('package surface', () => {
  test('AC-28: every function and constant in the interface is exported from the index', () => {
    expect(typeof quizCore.createRng).toBe('function');
    expect(typeof quizCore.shuffle).toBe('function');
    expect(typeof quizCore.gradeQuestion).toBe('function');
    expect(typeof quizCore.estimateScore).toBe('function');
    expect(typeof quizCore.scoreAttempt).toBe('function');
    expect(typeof quizCore.domainQuotas).toBe('function');
    expect(typeof quizCore.buildExam).toBe('function');
    expect(quizCore.PASS_MARK).toBe(720);
    expect(quizCore.EXAM_SIZE).toBe(65);
  });

  test('AC-28: every type in the interface is exported from the index', () => {
    // Checked by the typecheck: the imports above fail to compile if a type is missing.
    expectTypeOf<Rng>().toEqualTypeOf<() => number>();
    expectTypeOf<Answers>().toMatchTypeOf<Readonly<Record<string, readonly string[]>>>();
    expectTypeOf<ScoreBucket>().toHaveProperty('raw').toEqualTypeOf<number | null>();
    expectTypeOf<QuestionResult>().toHaveProperty('answered').toEqualTypeOf<boolean>();
    expectTypeOf<AttemptScore>().toHaveProperty('estimated').toEqualTypeOf<number | null>();
    expectTypeOf<AttemptScore>().toHaveProperty('results').toEqualTypeOf<QuestionResult[]>();
    expectTypeOf<ExamItem>().toHaveProperty('optionOrder').toEqualTypeOf<string[]>();
    expectTypeOf<DomainPlan>().toHaveProperty('short').toEqualTypeOf<number>();
    expectTypeOf<Exam>().toHaveProperty('complete').toEqualTypeOf<boolean>();
    expect(true).toBe(true);
  });

  test('AC-28: the package entry point is src/index.ts', () => {
    const manifest = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, string>;
    };
    expect(manifest.name).toBe('@field-guide/quiz-core');
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });
});

describe('package purity', () => {
  test('AC-28: src has the four modules and the index', () => {
    expect(sourceFiles()).toEqual(
      expect.arrayContaining(['build.ts', 'grade.ts', 'index.ts', 'random.ts', 'score.ts']),
    );
  });

  test('AC-28: src imports nothing but @field-guide/schema and its own files', () => {
    for (const name of sourceFiles()) {
      for (const specifier of importSpecifiers(readSource(name))) {
        const allowed = specifier === '@field-guide/schema' || specifier.startsWith('./');
        expect(allowed, `${name} imports "${specifier}"`).toBe(true);
      }
    }
  });

  test('AC-28: src does not use node: modules, Math.random or Date', () => {
    for (const name of sourceFiles()) {
      const code = withoutComments(readSource(name));
      expect(code, `${name} uses node:`).not.toMatch(/node:/);
      expect(code, `${name} uses Math.random`).not.toMatch(/Math\s*\.\s*random/);
      expect(code, `${name} uses Date`).not.toMatch(/\bDate\b/);
    }
  });

  test('AC-28: the import scan sees imports in all their forms (self-check)', () => {
    const sample = [
      "import { a } from '@field-guide/schema';",
      "import type { B } from './b.ts';",
      "export * from './c.ts';",
      "import 'side-effect';",
      "const lazy = await import('node:fs');",
      "// import { z } from 'commented-out';",
    ].join('\n');
    expect(importSpecifiers(sample)).toEqual(
      expect.arrayContaining(['@field-guide/schema', './b.ts', './c.ts', 'side-effect', 'node:fs']),
    );
    expect(importSpecifiers(sample)).not.toContain('commented-out');
  });
});
