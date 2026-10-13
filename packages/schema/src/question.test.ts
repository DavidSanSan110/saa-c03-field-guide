import { describe, expect, test } from 'vitest';
import { publicQuestionSchema, questionSchema, validateQuestion } from './question.ts';

type Raw = Record<string, unknown>;

// The example question from PLAN.md section 5.2, as a JS object (YAML folded stem keeps one trailing newline).
const exampleQuestion: Raw = {
  id: 'd1-1.3-0007',
  domain: 1,
  task: '1.3',
  services: ['s3', 'kms'],
  difficulty: 'medium',
  type: 'single',
  stem:
    'A company must encrypt objects in Amazon S3 at rest. Its security policy says ' +
    'encryption keys must be generated and kept on-premises and must never be stored ' +
    'in AWS. Encryption must still happen in S3. Which option meets these requirements?\n',
  options: [
    { key: 'A', text: 'SSE-S3', correct: false, why: 'AWS creates, owns and stores the keys.' },
    {
      key: 'B',
      text: 'SSE-KMS with a customer managed key',
      correct: false,
      why: 'The KMS key is stored in AWS KMS.',
    },
    {
      key: 'C',
      text: 'SSE-C',
      correct: true,
      why: 'The key is sent with each request over HTTPS; S3 uses it and then discards it.',
    },
    {
      key: 'D',
      text: 'Client-side encryption',
      correct: false,
      why: 'Encryption would happen before the upload, not in S3.',
    },
  ],
  cue: 'Encryption in S3 + keys never stored in AWS → SSE-C',
  references: [
    'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html',
  ],
  links: {
    guide: '/d1/1-3-data-security/s3-encryption',
    diagram: 's3-sse-kms-upload',
    lab: '02-s3-kms-encryption',
  },
  status: 'reviewed',
  provenance: { generated_by: 'claude', verified_by: 'claude', reviewed_by: 'DavidSanSan110' },
};

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** Builds `count` options with keys A, B, C... (or `keys`), marking the given indexes as correct. */
function buildOptions(count: number, correctIndexes: number[], keys: string[] = KEYS): Raw[] {
  return Array.from({ length: count }, (_, i) => ({
    key: keys[i] ?? `K${String(i)}`,
    text: `Option number ${String(i)}`,
    correct: correctIndexes.includes(i),
    why: `Reason for option ${String(i)}.`,
  }));
}

/** A valid question: the PLAN example with one or more top-level fields replaced. */
function make(overrides: Raw = {}): Raw {
  return { ...structuredClone(exampleQuestion), ...overrides };
}

/** A valid question with `key` removed. */
function without(key: string): Raw {
  const copy = make();
  delete copy[key];
  return copy;
}

/** A valid `multiple` question: 5 options, 2 correct. */
function makeMultiple(overrides: Raw = {}): Raw {
  return make({
    type: 'multiple',
    stem: 'Which TWO actions encrypt the objects with keys that stay outside AWS? (Select TWO.)',
    options: buildOptions(5, [1, 3]),
    ...overrides,
  });
}

const draftProvenance = { generated_by: 'claude' };
const verifiedProvenance = { generated_by: 'claude', verified_by: 'claude' };

function expectAccepted(data: unknown): void {
  const result = validateQuestion(data);
  expect(result.ok).toBe(true);
  expect(questionSchema.safeParse(data).success).toBe(true);
}

/** Rejected by validateQuestion and by questionSchema, with at least one error naming `field`. */
function expectRejected(data: unknown, field: string): void {
  const result = validateQuestion(data);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes(field))).toBe(true);
  }
  expect(questionSchema.safeParse(data).success).toBe(false);
}

describe('AC-1: PLAN.md example question', () => {
  test('AC-1: validates under questionSchema', () => {
    expect(questionSchema.safeParse(exampleQuestion).success).toBe(true);
  });

  test('AC-1: validates under publicQuestionSchema', () => {
    expect(publicQuestionSchema.safeParse(exampleQuestion).success).toBe(true);
  });

  test('AC-1: validateQuestion returns ok with the question, with and without publicOnly', () => {
    for (const opts of [undefined, { publicOnly: false }, { publicOnly: true }]) {
      const result = validateQuestion(exampleQuestion, opts);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.question).toMatchObject({
          id: 'd1-1.3-0007',
          domain: 1,
          task: '1.3',
          services: ['s3', 'kms'],
          difficulty: 'medium',
          type: 'single',
          cue: 'Encryption in S3 + keys never stored in AWS → SSE-C',
          status: 'reviewed',
          links: { guide: '/d1/1-3-data-security/s3-encryption' },
        });
        expect(result.question.options).toHaveLength(4);
      }
    }
  });

  test('AC-1: optional fields (cue, links) may be omitted', () => {
    const data = without('cue');
    delete data['links'];
    expectAccepted(data);
  });
});

describe('AC-2: id pattern and consistency with domain/task', () => {
  test.each([
    ['too few digits', 'd1-1.3-007'],
    ['too many digits', 'd1-1.3-00007'],
    ['uppercase prefix', 'D1-1.3-0007'],
    ['wrong shape', 'q-0007'],
    ['empty', ''],
    ['trailing whitespace', 'd1-1.3-0007 '],
    ['non-digit counter', 'd1-1.3-00a7'],
    ['domain out of range', 'd5-1.3-0007'],
  ])('AC-2: rejects a malformed id (%s)', (_label, id) => {
    expectRejected(make({ id }), 'id');
  });

  test('AC-2: rejects an id that is not a string', () => {
    expectRejected(make({ id: 1 }), 'id');
  });

  test('AC-2: rejects an id whose domain part differs from domain', () => {
    expectRejected(make({ id: 'd2-1.3-0007' }), 'id');
  });

  test('AC-2: rejects an id whose task part differs from task', () => {
    expectRejected(make({ id: 'd1-1.2-0007' }), 'id');
  });

  test('AC-2: accepts a consistent id for another domain and task', () => {
    expectAccepted(make({ id: 'd3-3.5-0001', domain: 3, task: '3.5' }));
  });

  test('AC-2: rejects a missing id', () => {
    expectRejected(without('id'), 'id');
  });
});

describe('AC-3: domain and task against the catalog', () => {
  test('AC-3: rejects a task that is not in the catalog', () => {
    expectRejected(make({ id: 'd3-3.6-0001', domain: 3, task: '3.6' }), 'task');
  });

  test('AC-3: rejects a task that belongs to another domain', () => {
    expectRejected(make({ id: 'd2-1.3-0007', domain: 2, task: '1.3' }), 'task');
  });

  test('AC-3: rejects a task given as a number instead of a string', () => {
    expectRejected(make({ task: 1.3 }), 'task');
  });

  test('AC-3: rejects a missing task', () => {
    expectRejected(without('task'), 'task');
  });

  test.each([
    ['zero', 0],
    ['five', 5],
    ['fractional', 1.5],
    ['string', '1'],
    ['null', null],
  ])('AC-3: rejects a domain outside the integers 1 to 4 (%s)', (_label, domain) => {
    expectRejected(make({ domain }), 'domain');
  });

  test('AC-3: accepts every domain 1 to 4 with a task of its own', () => {
    const pairs: [number, string][] = [
      [1, '1.1'],
      [2, '2.2'],
      [3, '3.4'],
      [4, '4.4'],
    ];
    for (const [domain, task] of pairs) {
      expectAccepted(make({ id: `d${String(domain)}-${task}-0001`, domain, task }));
    }
  });
});

describe('AC-4: services', () => {
  test('AC-4: rejects an empty services array', () => {
    expectRejected(make({ services: [] }), 'services');
  });

  test('AC-4: rejects duplicate services', () => {
    expectRejected(make({ services: ['s3', 's3'] }), 'services');
  });

  test.each([
    ['uppercase', 'S3'],
    ['trailing space', 's3 '],
    ['leading space', ' s3'],
    ['underscore', 'kms_key'],
    ['trailing hyphen', 's3-'],
    ['leading hyphen', '-s3'],
    ['double hyphen', 'step--functions'],
    ['empty', ''],
  ])('AC-4: rejects a non-slug service (%s)', (_label, slug) => {
    expectRejected(make({ services: ['kms', slug] }), 'services');
  });

  test('AC-4: rejects a missing services field', () => {
    expectRejected(without('services'), 'services');
  });

  test('AC-4: accepts lowercase slugs with digits and single hyphens', () => {
    expectAccepted(make({ services: ['s3', 'step-functions', 'ec2', 'route-53'] }));
  });
});

describe('AC-5: option count and correct count per type', () => {
  test.each([
    ['3 options, 1 correct', buildOptions(3, [0])],
    ['5 options, 1 correct', buildOptions(5, [0])],
    ['4 options, 0 correct', buildOptions(4, [])],
    ['4 options, 2 correct', buildOptions(4, [0, 1])],
  ])('AC-5: rejects a single question with %s', (_label, options) => {
    expectRejected(make({ type: 'single', options }), 'options');
  });

  test('AC-5: names the correct-count problem for a single question with 2 correct', () => {
    const result = validateQuestion(make({ options: buildOptions(4, [0, 1]) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('options');
      expect(result.errors.join('\n')).toContain('1 correct');
    }
  });

  test('AC-5: accepts a valid multiple question (5 options, 2 correct)', () => {
    expectAccepted(makeMultiple());
  });

  test.each([
    ['5 options, 3 correct', buildOptions(5, [0, 1, 2])],
    ['6 options, 2 correct', buildOptions(6, [0, 5])],
    ['6 options, 3 correct', buildOptions(6, [1, 2, 4])],
  ])('AC-5: accepts a multiple question with %s', (_label, options) => {
    expectAccepted(makeMultiple({ options }));
  });

  test.each([
    ['4 options, 2 correct', buildOptions(4, [0, 1])],
    ['7 options, 2 correct', buildOptions(7, [0, 1])],
    ['5 options, 1 correct', buildOptions(5, [2])],
    ['5 options, 0 correct', buildOptions(5, [])],
    ['6 options, 4 correct', buildOptions(6, [0, 1, 2, 3])],
    ['5 options, 4 correct', buildOptions(5, [0, 1, 2, 3])],
  ])('AC-5: rejects a multiple question with %s', (_label, options) => {
    expectRejected(makeMultiple({ options }), 'options');
  });

  test('AC-5: rejects a single-answer option set declared as multiple', () => {
    expectRejected(make({ type: 'multiple' }), 'options');
  });

  test('AC-5: rejects options that are not an array', () => {
    expectRejected(make({ options: 'A, B, C, D' }), 'options');
  });
});

describe('AC-6: option keys, text and why', () => {
  test.each([
    ['out of order (A, C, B, D)', ['A', 'C', 'B', 'D']],
    ['with a gap (A, B, D, E)', ['A', 'B', 'D', 'E']],
    ['duplicated (A, B, B, D)', ['A', 'B', 'B', 'D']],
    ['not starting at A (B, C, D, E)', ['B', 'C', 'D', 'E']],
    ['lowercase (a, b, c, d)', ['a', 'b', 'c', 'd']],
  ])('AC-6: rejects option keys %s', (_label, keys) => {
    expectRejected(make({ options: buildOptions(4, [2], keys) }), 'options');
  });

  test('AC-6: rejects out-of-order keys on a multiple question', () => {
    expectRejected(
      makeMultiple({ options: buildOptions(5, [1, 3], ['A', 'B', 'D', 'C', 'E']) }),
      'options',
    );
  });

  test('AC-6: accepts keys A to F in order on a 6-option multiple question', () => {
    expectAccepted(makeMultiple({ options: buildOptions(6, [0, 4]) }));
  });

  test('AC-6: rejects an option with empty text', () => {
    const options = buildOptions(4, [2]);
    options[1] = { ...options[1], text: '' };
    expectRejected(make({ options }), 'options');
  });

  test('AC-6: rejects an option with empty why', () => {
    const options = buildOptions(4, [2]);
    options[3] = { ...options[3], why: '' };
    expectRejected(make({ options }), 'options');
  });

  test('AC-6: rejects an option with a missing correct flag', () => {
    const options = buildOptions(4, [2]);
    const incomplete: Raw = { ...options[0] };
    delete incomplete['correct'];
    options[0] = incomplete;
    expectRejected(make({ options }), 'options');
  });
});

describe('AC-7: references', () => {
  const docs = 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html';

  test('AC-7: rejects an empty references array', () => {
    expectRejected(make({ references: [] }), 'references');
  });

  test('AC-7: rejects a missing references field', () => {
    expectRejected(without('references'), 'references');
  });

  test('AC-7: rejects an http:// reference', () => {
    expectRejected(
      make({ references: ['http://docs.aws.amazon.com/AmazonS3/latest/userguide/x.html'] }),
      'references',
    );
  });

  test('AC-7: rejects a list where one reference is http:// even if another is a valid docs URL', () => {
    expectRejected(make({ references: [docs, 'http://example.com/article'] }), 'references');
  });

  test('AC-7: rejects references with no docs.aws.amazon.com URL', () => {
    expectRejected(make({ references: ['https://example.com/s3-encryption'] }), 'references');
  });

  test('AC-7: rejects a lookalike host that only starts with docs.aws.amazon.com', () => {
    expectRejected(
      make({ references: ['https://docs.aws.amazon.com.evil.example/page'] }),
      'references',
    );
  });

  test('AC-7: rejects a reference that is not a URL', () => {
    expectRejected(make({ references: [docs, 'not a url'] }), 'references');
  });

  test('AC-7: accepts a docs.aws.amazon.com URL plus other https URLs', () => {
    expectAccepted(make({ references: [docs, 'https://aws.amazon.com/s3/faqs/'] }));
  });
});

describe('AC-8: provenance required by status', () => {
  test('AC-8: rejects status verified without verified_by', () => {
    expectRejected(make({ status: 'verified', provenance: draftProvenance }), 'provenance');
  });

  test('AC-8: rejects status reviewed without reviewed_by', () => {
    expectRejected(make({ status: 'reviewed', provenance: verifiedProvenance }), 'provenance');
  });

  test('AC-8: rejects status reviewed with reviewed_by but without verified_by', () => {
    expectRejected(
      make({
        status: 'reviewed',
        provenance: { generated_by: 'claude', reviewed_by: 'DavidSanSan110' },
      }),
      'provenance',
    );
  });

  test('AC-8: rejects an empty verified_by on a verified question', () => {
    expectRejected(
      make({ status: 'verified', provenance: { generated_by: 'claude', verified_by: '' } }),
      'provenance',
    );
  });

  test('AC-8: rejects a missing generated_by', () => {
    expectRejected(make({ provenance: { verified_by: 'claude' } }), 'provenance');
  });

  test('AC-8: accepts a draft with only generated_by', () => {
    expectAccepted(make({ status: 'draft', provenance: draftProvenance }));
  });

  test('AC-8: accepts a verified question with verified_by', () => {
    expectAccepted(make({ status: 'verified', provenance: verifiedProvenance }));
  });

  test('AC-8: rejects a status outside draft, verified and reviewed', () => {
    expectRejected(make({ status: 'published' }), 'status');
  });
});

describe('AC-9: public schema accepts only reviewed', () => {
  const draft = make({ status: 'draft', provenance: draftProvenance });
  const verified = make({ status: 'verified', provenance: verifiedProvenance });

  test('AC-9: publicQuestionSchema rejects a draft question', () => {
    expect(questionSchema.safeParse(draft).success).toBe(true);
    expect(publicQuestionSchema.safeParse(draft).success).toBe(false);
  });

  test('AC-9: publicQuestionSchema rejects a verified question', () => {
    expect(questionSchema.safeParse(verified).success).toBe(true);
    expect(publicQuestionSchema.safeParse(verified).success).toBe(false);
  });

  test.each([
    ['draft', draft],
    ['verified', verified],
  ])('AC-9: validateQuestion with publicOnly rejects a %s question, naming status', (_s, data) => {
    const result = validateQuestion(data, { publicOnly: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('status'))).toBe(true);
    }
  });

  test.each([
    ['draft', draft],
    ['verified', verified],
  ])('AC-9: validateQuestion accepts a %s question without publicOnly', (_s, data) => {
    expect(validateQuestion(data).ok).toBe(true);
    expect(validateQuestion(data, { publicOnly: false }).ok).toBe(true);
  });

  test('AC-9: validateQuestion with publicOnly accepts a reviewed question', () => {
    expect(validateQuestion(exampleQuestion, { publicOnly: true }).ok).toBe(true);
  });
});

describe('AC-10: strict keys, stem length, links, other field rules', () => {
  test('AC-10: rejects an unknown top-level key (answer)', () => {
    expectRejected(make({ answer: 'C' }), 'answer');
  });

  test('AC-10: rejects an unknown top-level key under publicQuestionSchema too', () => {
    const data = make({ answer: 'C' });
    expect(publicQuestionSchema.safeParse(data).success).toBe(false);
    expect(validateQuestion(data, { publicOnly: true }).ok).toBe(false);
  });

  test('AC-10: rejects a stem shorter than 20 characters', () => {
    expectRejected(make({ stem: 'a'.repeat(19) }), 'stem');
  });

  test('AC-10: counts the stem length after trimming', () => {
    expectRejected(make({ stem: `   ${'a'.repeat(19)}   ` }), 'stem');
  });

  test('AC-10: accepts a stem of exactly 20 characters after trimming', () => {
    expectAccepted(make({ stem: `  ${'a'.repeat(20)}\n` }));
  });

  test('AC-10: rejects a missing stem', () => {
    expectRejected(without('stem'), 'stem');
  });

  test.each([
    ['relative path', 'd1/1-3-data-security/s3-encryption'],
    ['full URL', 'https://example.com/d1/guide'],
    ['empty', ''],
  ])('AC-10: rejects links.guide that does not start with / (%s)', (_label, guide) => {
    expectRejected(make({ links: { guide } }), 'links');
  });

  test('AC-10: rejects an empty links.diagram or links.lab', () => {
    expectRejected(make({ links: { diagram: '' } }), 'links');
    expectRejected(make({ links: { lab: '' } }), 'links');
  });

  test('AC-10: accepts an empty links object and partial links', () => {
    expectAccepted(make({ links: {} }));
    expectAccepted(make({ links: { lab: '02-s3-kms-encryption' } }));
  });

  test('AC-10: rejects an empty cue', () => {
    expectRejected(make({ cue: '' }), 'cue');
  });

  test('AC-10: rejects a difficulty outside easy, medium and hard', () => {
    expectRejected(make({ difficulty: 'trivial' }), 'difficulty');
  });

  test('AC-10: rejects a type outside single and multiple', () => {
    expectRejected(make({ type: 'multi' }), 'type');
  });
});

describe('AC-11: validateQuestion never throws on bad input', () => {
  test.each([
    ['null', null],
    ['a string', 'd1-1.3-0007'],
    ['an empty object', {}],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', []],
  ])('AC-11: returns ok: false with errors for %s without throwing', (_label, data) => {
    expect(() => validateQuestion(data)).not.toThrow();
    const result = validateQuestion(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(typeof error).toBe('string');
        expect(error.length).toBeGreaterThan(0);
      }
    }
  });

  test('AC-11: does not throw with publicOnly either', () => {
    expect(() => validateQuestion(null, { publicOnly: true })).not.toThrow();
    expect(validateQuestion('nope', { publicOnly: true }).ok).toBe(false);
  });

  test('AC-11: an empty object reports every required field by path', () => {
    const result = validateQuestion({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const field of [
        'id',
        'domain',
        'task',
        'services',
        'difficulty',
        'type',
        'stem',
        'options',
        'references',
        'status',
        'provenance',
      ]) {
        expect(result.errors.some((error) => error.includes(field))).toBe(true);
      }
    }
  });

  test('AC-11: every error string for an invalid field contains the failing path', () => {
    const result = validateQuestion(make({ stem: 'short' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(error).toContain('stem');
      }
    }
  });

  test('AC-11: a nested failure names the parent field and the nested path', () => {
    const result = validateQuestion(make({ provenance: { generated_by: '' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('provenance'))).toBe(true);
      expect(result.errors.some((error) => error.includes('generated_by'))).toBe(true);
    }
  });
});
