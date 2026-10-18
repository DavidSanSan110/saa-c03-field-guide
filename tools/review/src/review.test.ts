import { formatIssues, questionSchema } from '@field-guide/schema';
import type { Question, QuestionOption } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { questionYaml } from '../../questions/src/__mocks__/fixtures.ts';
import {
  approvedValue,
  dedupe,
  draft,
  filesOf,
  flagged,
  mutated,
  replaceOnce,
  stemToStatus,
  verification,
} from './__mocks__/review-fixtures.ts';
import type { Raw } from './__mocks__/review-fixtures.ts';
import {
  approvedText,
  buildQueue,
  checkEdit,
  isCorrect,
  questionDigest,
  verificationState,
} from './review.ts';

describe('questionDigest', () => {
  const STEM = 'Which S3 encryption option keeps the keys out of AWS?';
  const TEXTS = ['SSE-S3', 'SSE-KMS', 'SSE-C', 'Client-side encryption'];

  function vector(correctIndex: number): Pick<Question, 'type' | 'stem' | 'options'> {
    const options: QuestionOption[] = TEXTS.map((text, index) => ({
      key: String.fromCharCode(65 + index),
      text,
      correct: index === correctIndex,
      why: 'Because.',
    }));
    return { type: 'single', stem: STEM, options };
  }

  test('AC-1: the first spec-022 test vector gives 6498301f85802e9c', () => {
    expect(questionDigest(vector(2))).toBe('6498301f85802e9c');
  });

  test('AC-1: the same question with only D correct gives c983a5e434db617f', () => {
    expect(questionDigest(vector(3))).toBe('c983a5e434db617f');
  });

  test('AC-1: the digest ignores the why of the options', () => {
    const changed = vector(2);
    changed.options = changed.options.map((option) => ({ ...option, why: 'Something else.' }));
    expect(questionDigest(changed)).toBe('6498301f85802e9c');
  });
});

describe('verificationState', () => {
  const d = draft({ id: 'd1-1.3-0007' });

  test('AC-2: a verified result whose digest matches the content is verified', () => {
    expect(verificationState(d.question, { verification: verification(d) })).toBe('verified');
  });

  test('AC-2: a verified result with another digest is changed', () => {
    const sidecar = { verification: verification(d, { digest: '0000000000000000' }) };
    expect(verificationState(d.question, sidecar)).toBe('changed');
  });

  test('AC-2: a question edited after the verification is changed', () => {
    const sidecar = { verification: verification(d) };
    const edited: Question = { ...d.question, stem: `${d.question.stem} Be careful.` };
    expect(verificationState(edited, sidecar)).toBe('changed');
  });

  test('AC-2: changing the key after the verification makes the state changed', () => {
    const sidecar = { verification: verification(d) };
    const options = d.question.options.map((o) => ({ ...o, correct: o.key === 'A' }));
    expect(verificationState({ ...d.question, options }, sidecar)).toBe('changed');
  });

  test.each(['mismatch', 'unsupported'] as const)('AC-2: a %s result is flagged', (result) => {
    expect(verificationState(d.question, { verification: flagged(d, result) })).toBe('flagged');
  });

  test('AC-2: a flagged result stays flagged when the digest is stale', () => {
    const sidecar = { verification: flagged(d, 'mismatch', { digest: '0000000000000000' }) };
    expect(verificationState(d.question, sidecar)).toBe('flagged');
  });

  test.each<[string, unknown]>([
    ['no sidecar', undefined],
    ['an empty sidecar', {}],
    ['a sidecar with only dedupe', { dedupe: dedupe() }],
  ])('AC-2: %s gives none', (_name, sidecar) => {
    expect(verificationState(d.question, sidecar)).toBe('none');
  });
});

describe('buildQueue', () => {
  // Ids that do not sort like the paths: alpha < beta < gamma by path, beta < alpha < gamma by id.
  const alpha = draft({ id: 'd1-1.1-0003', slug: 'alpha' });
  const beta = draft({ id: 'd1-1.1-0001', slug: 'beta', status: 'verified' });
  const gamma = draft({ id: 'd1-1.3-0002', slug: 'gamma' });
  const doneOne = draft({ id: 'd2-2.1-0001', slug: 'done-one', status: 'reviewed' });
  const doneTwo = draft({ id: 'd1-1.2-0005', slug: 'done-two', status: 'reviewed' });
  const old = draft({ id: 'd1-1.1-0009', slug: 'old' });
  const badDifficulty = draft({ id: 'd1-1.1-0008', slug: 'bad-difficulty' });

  const files = {
    ...filesOf(
      { draft: alpha, sidecar: { verification: verification(alpha) } },
      beta,
      gamma,
      doneOne,
      doneTwo,
    ),
    [`rejected/${old.path}`]: old.text,
    [badDifficulty.path]: replaceOnce(badDifficulty.text, 'difficulty: medium', 'difficulty: nope'),
    'd1/1.1/broken.yaml': 'id: [unclosed\n',
    'review-log.jsonl': '{"id":"d1-1.1-0009"}\n',
  };

  test('AC-3: keeps the non-reviewed valid drafts sorted by id, not by path', () => {
    const { items } = buildQueue(files);
    expect(items.map((item) => item.question.id)).toEqual([beta.id, alpha.id, gamma.id]);
    expect(items.map((item) => item.path)).toEqual([beta.path, alpha.path, gamma.path]);
  });

  test('AC-3: counts the reviewed drafts as waiting and does not list them', () => {
    const { items, waiting } = buildQueue(files);
    expect(waiting).toBe(2);
    expect(items.map((item) => item.question.id)).not.toContain(doneOne.id);
  });

  test('AC-3: leaves out rejected/ everywhere, even as a problem', () => {
    const { items, problems } = buildQueue(files);
    expect(items.map((item) => item.question.id)).not.toContain(old.id);
    expect(problems.map((problem) => problem.file)).not.toContain(`rejected/${old.path}`);
  });

  test('AC-3: returns the files with problems as problems and not as items', () => {
    const { items, problems } = buildQueue(files);
    expect([...new Set(problems.map((problem) => problem.file))].sort()).toEqual([
      badDifficulty.path,
      'd1/1.1/broken.yaml',
    ]);
    expect(problems.every((problem) => problem.message.trim() !== '')).toBe(true);
    expect(items.map((item) => item.question.id)).not.toContain(badDifficulty.id);
  });

  test('AC-3: sidecars and the review log are not read as questions', () => {
    const { items, problems } = buildQueue(files);
    expect(items).toHaveLength(3);
    expect(problems.map((problem) => problem.file)).not.toContain(alpha.sidecar);
    expect(problems.map((problem) => problem.file)).not.toContain('review-log.jsonl');
  });

  test('AC-3: an empty folder gives an empty queue', () => {
    expect(buildQueue({})).toEqual({ items: [], waiting: 0, problems: [] });
  });

  test('AC-3: the items hold the file text for the edit and approve steps', () => {
    const { items } = buildQueue(files);
    expect(items[0]?.text).toBe(beta.text);
  });
});

describe('isCorrect', () => {
  const single = draft({ id: 'd1-1.3-0001' }).question; // key C
  const multiple = draft({ id: 'd1-1.3-0002', type: 'multiple' }).question; // keys B and D

  test.each<[string, Question, string[], boolean]>([
    ['the right single option', single, ['C'], true],
    ['another single option', single, ['A'], false],
    ['no pick on a single question', single, [], false],
    ['two picks on a single question', single, ['C', 'A'], false],
    ['both right options of a multiple question', multiple, ['B', 'D'], true],
    ['the right options in another order', multiple, ['D', 'B'], true],
    ['the right options in lower case', multiple, ['d', 'b'], true],
    ['a subset of a multiple question', multiple, ['B'], false],
    ['a superset of a multiple question', multiple, ['B', 'D', 'E'], false],
    ['one right and one wrong option', multiple, ['B', 'E'], false],
    ['no pick on a multiple question', multiple, [], false],
  ])('AC-4: %s', (_name, question, answer, expected) => {
    expect(isCorrect(question, answer)).toBe(expected);
  });
});

describe('approvedText', () => {
  test('AC-5: sets the status, reviewed_by and verified_by and keeps every other value', () => {
    const d = draft({ id: 'd1-1.3-0007' });
    const out = approvedText(d.text, { reviewer: 'review-user', verifier: 'claude-opus' });
    expect(parse(out)).toEqual(approvedValue(d, 'claude-opus', 'review-user'));
  });

  test('AC-5: overwrites an old verified_by', () => {
    const d = draft({ id: 'd1-1.3-0007', status: 'verified', verifiedBy: 'old-verifier' });
    const out = approvedText(d.text, { reviewer: 'review-user', verifier: 'claude-opus' });
    expect(parse(out)).toEqual(approvedValue(d, 'claude-opus', 'review-user'));
    expect(out).not.toContain('old-verifier');
  });

  test('AC-5: overwrites an old reviewed_by', () => {
    const d = draft({ id: 'd1-1.3-0007', status: 'reviewed', reviewedBy: 'old-reviewer' });
    const out = approvedText(d.text, { reviewer: 'review-user', verifier: 'claude-opus' });
    expect(parse(out)).toEqual(approvedValue(d, 'claude-opus', 'review-user'));
    expect(out).not.toContain('old-reviewer');
  });

  test('AC-5: keeps the comments', () => {
    const d = draft({ id: 'd1-1.3-0007' });
    const out = approvedText(d.text, { reviewer: 'review-user', verifier: 'claude-opus' });
    expect(out).toContain(
      '# Draft written by the question-writer; keep the options in this order.',
    );
    expect(out).toContain('# keep this distractor');
    expect(out).toContain('# written by the generator');
  });

  test('AC-5: keeps the text of the stem, options, cue and references byte for byte', () => {
    const d = draft({ id: 'd1-1.3-0007', type: 'multiple' });
    const out = approvedText(d.text, { reviewer: 'review-user', verifier: 'claude-opus' });
    expect(out).toContain(stemToStatus(d.text));
  });

  test('AC-5: works on a draft written as a plain YAML dump', () => {
    const text = questionYaml({ id: 'd1-1.3-0007', status: 'draft' });
    const out = approvedText(text, { reviewer: 'review-user', verifier: 'claude-opus' });
    expect(parse(out)).toEqual({
      ...(parse(text) as Raw),
      status: 'reviewed',
      provenance: {
        generated_by: 'claude',
        verified_by: 'claude-opus',
        reviewed_by: 'review-user',
      },
    });
  });
});

describe('approvedText with unsafe text', () => {
  const by = { reviewer: 'review-user', verifier: 'claude-opus' };

  test.each<[string, string]>([
    ['invalid YAML', 'id: [unclosed\n'],
    ['an empty text', ''],
    ['only comments', '# nothing here\n'],
    ['a list', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
    ['two documents', 'id: a\n---\nid: b\n'],
  ])('AC-6: throws for %s', (_name, text) => {
    let thrown: unknown;
    try {
      approvedText(text, by);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // A real refusal, not the body of the stub.
    expect((thrown as Error).message).not.toMatch(/not implemented/);
  });

  test('AC-6: does not throw for a valid draft (control)', () => {
    expect(() => approvedText(draft({ id: 'd1-1.3-0007' }).text, by)).not.toThrow();
  });
});

describe('checkEdit', () => {
  const d = draft({ id: 'd1-1.3-0007' });
  const errorsOf = (result: ReturnType<typeof checkEdit>): string[] =>
    result.ok ? [] : result.errors;

  test('AC-7: accepts a changed stem', () => {
    const text = mutated(d, (q) => {
      q['stem'] = 'A company must keep the encryption keys outside AWS. Which option works?';
    });
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.question.stem).toBe(
      'A company must keep the encryption keys outside AWS. Which option works?',
    );
  });

  test('AC-7: accepts a changed option text', () => {
    const text = replaceOnce(d.text, 'text: SSE-S3', 'text: SSE-S3 with a bucket key');
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.question.options[0]?.text).toBe('SSE-S3 with a bucket key');
  });

  test('AC-7: accepts a changed why', () => {
    const text = replaceOnce(d.text, 'owns the keys.', 'owns and rotates the keys.');
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.question.options[0]?.why).toContain('owns and rotates the keys.');
  });

  test('AC-7: refuses invalid YAML', () => {
    const result = checkEdit(d.question, 'id: [unclosed\n');
    expect(result.ok).toBe(false);
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  test('AC-7: refuses a YAML document that is not a mapping', () => {
    const result = checkEdit(d.question, '- a\n- b\n');
    expect(result.ok).toBe(false);
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  test('AC-7: refuses a schema failure with the formatIssues messages', () => {
    const change = (q: Raw): void => {
      q['stem'] = 'too short';
      q['difficulty'] = 'nightmare';
    };
    const broken = parse(d.text) as Raw;
    change(broken);
    const schemaResult = questionSchema.safeParse(broken);
    const expected = schemaResult.success ? [] : formatIssues(schemaResult.error.issues);
    expect(expected.length).toBeGreaterThanOrEqual(2);

    const result = checkEdit(d.question, mutated(d, change));
    expect(result.ok).toBe(false);
    for (const message of expected) {
      expect(errorsOf(result)).toContain(message);
    }
  });

  test('AC-7: refuses a changed id and names it', () => {
    const text = mutated(d, (q) => {
      q['id'] = 'd1-1.3-0099';
    });
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/\bid\b/);
  });

  test('AC-7: refuses a changed domain, task and id together and names each', () => {
    const text = mutated(d, (q) => {
      q['id'] = 'd2-2.1-0007';
      q['domain'] = 2;
      q['task'] = '2.1';
    });
    expect(questionSchema.safeParse(parse(text)).success).toBe(true);
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    const errors = errorsOf(result).join('\n');
    expect(errors).toMatch(/\bid\b/);
    expect(errors).toMatch(/\bdomain\b/);
    expect(errors).toMatch(/\btask\b/);
  });

  test('AC-7: refuses a changed task and names it', () => {
    const text = mutated(d, (q) => {
      q['task'] = '1.2';
    });
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/\btask\b/);
  });

  test('AC-7: refuses a changed domain and names it', () => {
    const text = mutated(d, (q) => {
      q['domain'] = 2;
    });
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/\bdomain\b/);
  });

  test('AC-7: refuses a changed status and names it', () => {
    const text = mutated(d, (q) => {
      q['status'] = 'verified';
      q['provenance'] = { generated_by: 'claude-sonnet', verified_by: 'claude-opus' };
    });
    expect(questionSchema.safeParse(parse(text)).success).toBe(true);
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/\bstatus\b/);
  });

  test('AC-7: refuses a changed provenance and names it', () => {
    const text = mutated(d, (q) => {
      q['provenance'] = { generated_by: 'someone-else' };
    });
    expect(questionSchema.safeParse(parse(text)).success).toBe(true);
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/\bprovenance\b/);
  });

  test('AC-7: an added verified_by is a change of the provenance', () => {
    const text = replaceOnce(
      d.text,
      '  generated_by: claude-sonnet # written by the generator',
      '  generated_by: claude-sonnet\n  verified_by: me',
    );
    const result = checkEdit(d.question, text);
    expect(result.ok).toBe(false);
    expect(errorsOf(result).join('\n')).toMatch(/\bprovenance\b/);
  });
});
