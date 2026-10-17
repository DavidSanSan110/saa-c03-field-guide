import { domains, publicQuestionSchema, questionSchema, tasksByDomain } from '@field-guide/schema';
import type { Question } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { correctKeys, deepFreeze, makeBank, makeQuestion, wrongKeys } from './questions.ts';

const statuses = ['draft', 'verified', 'reviewed'] as const;
const types = ['single', 'multiple'] as const;

function schemaFor(status: Question['status']) {
  return status === 'reviewed' ? publicQuestionSchema : questionSchema;
}

describe('question fixtures (spec 016 test plan)', () => {
  test('every domain, task, type and status combination passes the question schema', () => {
    const made: Question[] = [];
    for (const domain of domains) {
      for (const task of tasksByDomain(domain.id)) {
        for (const type of types) {
          for (const status of statuses) {
            const question = makeQuestion({ domain: domain.id, task: task.id, type, status });
            made.push(question);
            const result = schemaFor(status).safeParse(question);
            expect(result.success, `${question.id} (${type}, ${status})`).toBe(true);
          }
        }
      }
    }
    expect(new Set(made.map((question) => question.id)).size).toBe(made.length);
  });

  test('defaults make a reviewed single question with 4 options and 1 correct', () => {
    const question = makeQuestion();
    expect(publicQuestionSchema.safeParse(question).success).toBe(true);
    expect(question.status).toBe('reviewed');
    expect(question.options).toHaveLength(4);
    expect(correctKeys(question)).toEqual(['A']);
    expect(wrongKeys(question)).toEqual(['B', 'C', 'D']);
  });

  test('a custom correct set, option count and id are honoured and still valid', () => {
    const question = makeQuestion({
      id: 'd2-2.2-0042',
      task: '2.2',
      type: 'multiple',
      optionCount: 6,
      correct: ['A', 'C', 'F'],
    });
    expect(question.id).toBe('d2-2.2-0042');
    expect(question.domain).toBe(2);
    expect(correctKeys(question)).toEqual(['A', 'C', 'F']);
    expect(publicQuestionSchema.safeParse(question).success).toBe(true);
  });

  test('makeBank builds the requested number per domain, valid and with unique ids', () => {
    const bank = makeBank({ 1: 5, 2: 4, 3: 3, 4: 2 });
    expect(bank).toHaveLength(14);
    for (const question of bank) {
      expect(publicQuestionSchema.safeParse(question).success, question.id).toBe(true);
    }
    expect(new Set(bank.map((question) => question.id)).size).toBe(14);
    expect(bank.filter((question) => question.domain === 3)).toHaveLength(3);
  });

  test('makeBank lets the caller change the spec of each question', () => {
    const bank = makeBank({ 1: 3 }, (_domain, index) => ({
      status: index === 0 ? 'draft' : 'reviewed',
    }));
    expect(bank.map((question) => question.status)).toEqual(['draft', 'reviewed', 'reviewed']);
  });

  test('a task from another domain is refused', () => {
    expect(() => makeQuestion({ domain: 1, task: '4.1' })).toThrow();
  });

  test('deepFreeze freezes nested objects and returns the same object', () => {
    const question = makeQuestion();
    expect(deepFreeze(question)).toBe(question);
    expect(Object.isFrozen(question.options[0])).toBe(true);
    expect(Object.isFrozen(question.provenance)).toBe(true);
  });
});
