import { describe, expect, test } from 'vitest';
import { LAB_STACK_PATTERN, LabStackError, labId, labStacks, labStateKey } from './lab-stacks.ts';

// Spec 033, section 1: lab stacks (pure).

describe('labStacks', () => {
  test('AC-1: keeps only the lab stacks, sorted (bootstrap/ and modules/ are never labs)', () => {
    expect(
      labStacks(['bootstrap/workload', 'labs/00-site-hosting', 'labs/99-ci-smoke', 'modules/tags']),
    ).toEqual(['labs/00-site-hosting', 'labs/99-ci-smoke']);
  });

  test('AC-1: input order does not matter', () => {
    expect(labStacks(['labs/99-ci-smoke', 'modules/tags', 'labs/00-site-hosting'])).toEqual([
      'labs/00-site-hosting',
      'labs/99-ci-smoke',
    ]);
  });

  test('AC-1: duplicates are removed', () => {
    expect(labStacks(['labs/01-b', 'labs/00-a', 'labs/01-b', 'labs/00-a'])).toEqual([
      'labs/00-a',
      'labs/01-b',
    ]);
  });

  test('AC-1: an empty list gives an empty list', () => {
    expect(labStacks([])).toEqual([]);
  });

  test('AC-1: a list without any lab gives an empty list', () => {
    expect(labStacks(['bootstrap/management', 'bootstrap/workload', 'modules/tags'])).toEqual([]);
  });

  test('AC-1: oddly named stacks outside labs/ are ignored, not rejected', () => {
    expect(labStacks(['bootstrap/Odd_Name', 'modules/x_y', 'labs/00-a'])).toEqual(['labs/00-a']);
  });

  test('AC-1: the input array is not modified', () => {
    const input = ['labs/01-b', 'modules/tags', 'labs/00-a'];
    labStacks(input);
    expect(input).toEqual(['labs/01-b', 'modules/tags', 'labs/00-a']);
  });
});

describe('labStacks: invalid lab names', () => {
  const bad = ['labs/foo', 'labs/0-x', 'labs/00_x', 'labs/00-X', 'labs/00-x-'];

  test.each(bad)('AC-2: %s throws LabStackError', (stack) => {
    expect(() => labStacks(['labs/00-a', stack])).toThrow(LabStackError);
  });

  test('AC-2: the message names the offending stack', () => {
    expect(() => labStacks(['labs/00-a', 'labs/foo'])).toThrow(/labs\/foo/);
  });

  test('AC-2: with two bad stacks the message names both', () => {
    let message = '';
    try {
      labStacks(['labs/0-x', 'labs/00-a', 'labs/00_x']);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('labs/0-x');
    expect(message).toContain('labs/00_x');
  });

  test('AC-2: a list holding all five bad names names every one of them', () => {
    let message = '';
    try {
      labStacks(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(LabStackError);
      message = error instanceof Error ? error.message : '';
    }
    for (const stack of bad) expect(message).toContain(stack);
  });
});

describe('labId and labStateKey', () => {
  test('AC-3: labId strips the labs/ prefix', () => {
    expect(labId('labs/00-site-hosting')).toBe('00-site-hosting');
  });

  test('AC-3: labStateKey is labs/<id>.tfstate', () => {
    expect(labStateKey('labs/99-ci-smoke')).toBe('labs/99-ci-smoke.tfstate');
  });

  test('AC-3: labStateKey of a two-word lab', () => {
    expect(labStateKey('labs/12-two-words')).toBe('labs/12-two-words.tfstate');
  });

  const notLabs = ['modules/tags', 'labs/foo', 'labs/00-x/sub', ''];

  test.each(notLabs)('AC-3: labId(%j) throws LabStackError', (stack) => {
    expect(() => labId(stack)).toThrow(LabStackError);
  });

  test.each(notLabs)('AC-3: labStateKey(%j) throws LabStackError', (stack) => {
    expect(() => labStateKey(stack)).toThrow(LabStackError);
  });
});

describe('LAB_STACK_PATTERN', () => {
  test.each(['labs/00-a', 'labs/12-two-words', 'labs/99-ci-smoke'])('AC-4: accepts %s', (stack) => {
    expect(LAB_STACK_PATTERN.test(stack)).toBe(true);
  });

  test.each([
    'labs/00-a/',
    'xlabs/00-a',
    'labs/00-a/b',
    'labs/000-a',
    'labs/00--a',
    'bootstrap/00-a',
  ])('AC-4: rejects %s', (stack) => {
    expect(LAB_STACK_PATTERN.test(stack)).toBe(false);
  });

  test('AC-4: testing twice gives the same answer (no sticky or global state)', () => {
    expect(LAB_STACK_PATTERN.test('labs/00-a')).toBe(true);
    expect(LAB_STACK_PATTERN.test('labs/00-a')).toBe(true);
  });
});

describe('LabStackError', () => {
  test('AC-2: is an Error subclass', () => {
    expect(new LabStackError('x')).toBeInstanceOf(Error);
  });
});
