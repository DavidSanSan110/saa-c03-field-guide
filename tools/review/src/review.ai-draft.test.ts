// Spec 044, AC-16: the pure mapping from a parsed check file to the AI-draft marker of the reveal.
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { aiDraftOf } from './review.ts';

describe('aiDraftOf: no marker', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty mapping', {}],
    ['a mapping with only verification', { verification: { result: 'verified' } }],
    ['a mapping with verification and dedupe', { verification: {}, dedupe: { similar: [] } }],
    ['a key that only looks like it (aiDraft)', { aiDraft: { sections: ['a'] } }],
    ['a nested ai_draft key', { verification: { ai_draft: { sections: ['a'] } } }],
    ['a string', 'ai_draft'],
    ['a number', 5],
    ['a list', ['ai_draft']],
    ['a list of mappings', [{ ai_draft: { sections: ['a'] } }]],
  ])('AC-16: %s gives null', (_name, sidecar) => {
    expect(aiDraftOf(sidecar)).toBeNull();
  });
});

describe('aiDraftOf: the section folders', () => {
  test('AC-16: a list of strings is returned as it is', () => {
    expect(aiDraftOf({ ai_draft: { sections: ['a', 'b'] } })).toEqual(['a', 'b']);
  });

  test('AC-16: the order of the list is kept', () => {
    expect(aiDraftOf({ ai_draft: { sections: ['zz', 'aa', 'mm'] } })).toEqual(['zz', 'aa', 'mm']);
  });

  test('AC-16: one folder', () => {
    expect(aiDraftOf({ ai_draft: { sections: ['02-some-notes'] } })).toEqual(['02-some-notes']);
  });

  test('AC-16: other keys next to ai_draft, and next to sections, do not matter', () => {
    const sidecar = {
      verification: { result: 'verified' },
      ai_draft: { sections: ['a', 'b'], note: 'extra' },
      dedupe: { similar: [] },
    };

    expect(aiDraftOf(sidecar)).toEqual(['a', 'b']);
  });

  test('AC-16: an empty list is a marker without names', () => {
    expect(aiDraftOf({ ai_draft: { sections: [] } })).toEqual([]);
  });

  test('AC-16: the result is what the YAML of the sidecar says', () => {
    const sidecar: unknown = parse(
      '# c\nverification:\n  result: verified\nai_draft:\n  sections:\n    - 01-a\n    - 02-b\n',
    );

    expect(aiDraftOf(sidecar)).toEqual(['01-a', '02-b']);
  });
});

describe('aiDraftOf: marked, with any other shape', () => {
  test.each([
    ['true', { ai_draft: true }],
    ['false', { ai_draft: false }],
    ['null', { ai_draft: null }],
    ['a number', { ai_draft: 0 }],
    ['a string', { ai_draft: 'yes' }],
    ['a list', { ai_draft: ['a', 'b'] }],
    ['an empty mapping', { ai_draft: {} }],
    ['a mapping without sections', { ai_draft: { other: ['a'] } }],
    ['sections as a string', { ai_draft: { sections: 'a' } }],
    ['sections as null', { ai_draft: { sections: null } }],
    ['sections as a mapping', { ai_draft: { sections: { a: 1 } } }],
    ['sections with a number', { ai_draft: { sections: ['a', 1] } }],
    ['sections with a null', { ai_draft: { sections: ['a', null] } }],
    ['sections with a nested list', { ai_draft: { sections: [['a']] } }],
  ])('AC-16: ai_draft as %s gives an empty list, not null', (_name, sidecar) => {
    const result = aiDraftOf(sidecar);

    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });

  test('AC-16: an empty ai_draft key in YAML (ai_draft:) is marked, with no names', () => {
    const sidecar: unknown = parse('verification:\n  result: verified\nai_draft:\n');

    expect(aiDraftOf(sidecar)).toEqual([]);
  });

  test('AC-16: ai_draft: true in YAML is marked, with no names', () => {
    expect(aiDraftOf(parse('ai_draft: true\n'))).toEqual([]);
  });
});
