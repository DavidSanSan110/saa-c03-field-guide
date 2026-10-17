import { describe, expect, test } from 'vitest';
import { makeQuestion } from './__mocks__/questions.ts';
import { gradeQuestion } from './grade.ts';

describe('gradeQuestion: single answer', () => {
  const question = makeQuestion({ type: 'single', correct: ['C'] });

  test('AC-6: the correct key is true', () => {
    expect(gradeQuestion(question, ['C'])).toBe(true);
  });

  test('AC-6: a wrong key is false', () => {
    expect(gradeQuestion(question, ['A'])).toBe(false);
  });

  test('AC-6: an empty selection is false', () => {
    expect(gradeQuestion(question, [])).toBe(false);
  });

  test('AC-6: the correct key plus an extra key is false', () => {
    expect(gradeQuestion(question, ['A', 'C'])).toBe(false);
  });

  test('AC-6: a key that is not an option is false', () => {
    expect(gradeQuestion(question, ['E'])).toBe(false);
  });

  test('AC-6: keys are case sensitive', () => {
    expect(gradeQuestion(question, ['c'])).toBe(false);
  });

  test('AC-6: a repeated key counts once', () => {
    expect(gradeQuestion(question, ['C', 'C'])).toBe(true);
  });
});

describe('gradeQuestion: multiple answer', () => {
  const question = makeQuestion({ type: 'multiple', optionCount: 5, correct: ['B', 'E'] });

  test('AC-7: both correct keys are true', () => {
    expect(gradeQuestion(question, ['B', 'E'])).toBe(true);
  });

  test('AC-7: the order of the selected keys does not matter', () => {
    expect(gradeQuestion(question, ['E', 'B'])).toBe(true);
  });

  test('AC-7: a missing correct key is false (no partial credit)', () => {
    expect(gradeQuestion(question, ['B'])).toBe(false);
  });

  test('AC-7: an extra key is false', () => {
    expect(gradeQuestion(question, ['B', 'E', 'A'])).toBe(false);
  });

  test('AC-7: two wrong keys are false', () => {
    expect(gradeQuestion(question, ['A', 'D'])).toBe(false);
  });

  test('AC-7: an empty selection is false', () => {
    expect(gradeQuestion(question, [])).toBe(false);
  });

  test('AC-7: a correct key and a wrong key is false', () => {
    expect(gradeQuestion(question, ['B', 'A'])).toBe(false);
  });

  test('AC-7: repeated keys count once', () => {
    expect(gradeQuestion(question, ['B', 'B', 'E'])).toBe(true);
    expect(gradeQuestion(question, ['B', 'B'])).toBe(false);
  });

  test('AC-7: does not change the selection it is given', () => {
    const selected = Object.freeze(['E', 'B']);
    expect(gradeQuestion(question, selected)).toBe(true);
    expect(selected).toEqual(['E', 'B']);
  });
});
