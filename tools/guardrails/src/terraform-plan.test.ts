import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  PlanFormatError,
  changeSet,
  planDigest,
  planSummary,
  runTfPlan,
  type PlanChange,
} from './terraform-plan.ts';

// Spec 033, section 3: change-set digest and summary of `terraform show -json` output.
// The fixtures are hand-written in the shape of `terraform show -json <planfile>`.

type Json = Record<string, unknown>;

/** SHA-256 of the canonical form of an empty change set (`[]`). */
const EMPTY_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

/** One resource_changes entry; `entry` and `inner` override or add keys. */
function resource(
  address: string,
  actions: string[],
  overrides: { entry?: Json; inner?: Json } = {},
): Json {
  return {
    address,
    mode: 'managed',
    type: address.split('.')[0] ?? 'x',
    name: 'n',
    provider_name: 'registry.terraform.io/hashicorp/example',
    ...overrides.entry,
    change: {
      actions,
      before: null,
      after: {},
      after_unknown: {},
      before_sensitive: false,
      after_sensitive: {},
      ...overrides.inner,
    },
  };
}

function plan(resourceChanges: Json[], extra: Json = {}): Json {
  return {
    format_version: '1.2',
    terraform_version: '1.14.9',
    resource_changes: resourceChanges,
    ...extra,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---- Empty change set and the canonical form ----------------------------------------------------

describe('changeSet and planDigest: empty change sets', () => {
  test('AC-9: a plan without resource_changes has the empty digest and an empty change set', () => {
    const empty = { format_version: '1.2' };
    expect(planDigest(empty)).toBe(EMPTY_DIGEST);
    expect(changeSet(empty)).toEqual([]);
  });

  test('AC-9: a plan whose only changes are plain no-ops has the same digest and change set', () => {
    const noop = plan([resource('a.x', ['no-op']), resource('b.y', ['no-op'])]);
    expect(planDigest(noop)).toBe(EMPTY_DIGEST);
    expect(changeSet(noop)).toEqual([]);
  });

  test('AC-9: an empty resource_changes array digests the same', () => {
    expect(planDigest(plan([]))).toBe(EMPTY_DIGEST);
  });

  test('AC-9: the empty digest is the SHA-256 of the two characters []', () => {
    expect(sha256('[]')).toBe(EMPTY_DIGEST);
  });
});

describe('planDigest: canonical form', () => {
  test('AC-10: the digest of a one-create plan is the SHA-256 of the canonical string', () => {
    const create = plan([
      resource('terraform_data.smoke', ['create'], {
        inner: {
          before: null,
          after: { input: 'x' },
          after_unknown: { output: true },
          before_sensitive: false,
          after_sensitive: {},
        },
      }),
    ]);
    const canonical =
      '[{"actions":["create"],"address":"terraform_data.smoke","after":{"input":"x"},' +
      '"after_sensitive":{},"after_unknown":{"output":true},"before":null,' +
      '"before_sensitive":false,"importing":null,"previous_address":null,"replace_paths":null}]';
    expect(planDigest(create)).toBe(sha256(canonical));
  });

  test('AC-10: previous_address, replace_paths and importing enter the canonical string', () => {
    const moved = plan([
      resource('b.new', ['delete', 'create'], {
        entry: { previous_address: 'b.old' },
        inner: {
          before: { size: 1 },
          after: { size: 2 },
          after_unknown: {},
          replace_paths: [['size']],
          importing: { id: 'i-123' },
        },
      }),
    ]);
    const canonical =
      '[{"actions":["delete","create"],"address":"b.new","after":{"size":2},' +
      '"after_sensitive":{},"after_unknown":{},"before":{"size":1},"before_sensitive":false,' +
      '"importing":{"id":"i-123"},"previous_address":"b.old","replace_paths":[["size"]]}]';
    expect(planDigest(moved)).toBe(sha256(canonical));
  });

  test('AC-10: nested object keys are sorted recursively and arrays keep their order', () => {
    const nested = plan([
      resource('c.z', ['update'], {
        inner: {
          before: { b: 1, a: { y: [3, 1, 2], x: null } },
          after: { b: 2, a: { y: [3, 1, 2], x: 'text' } },
        },
      }),
    ]);
    const canonical =
      '[{"actions":["update"],"address":"c.z","after":{"a":{"x":"text","y":[3,1,2]},"b":2},' +
      '"after_sensitive":{},"after_unknown":{},"before":{"a":{"x":null,"y":[3,1,2]},"b":1},' +
      '"before_sensitive":false,"importing":null,"previous_address":null,"replace_paths":null}]';
    expect(planDigest(nested)).toBe(sha256(canonical));
  });

  test('AC-10: the digest is 64 lowercase hex characters', () => {
    expect(planDigest(plan([resource('a.x', ['create'])]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('planDigest: what does not change it', () => {
  const entryOne = {
    address: 'a.one',
    change: {
      actions: ['create'],
      before: null,
      after: { x: 1, nested: { p: 1, q: [1, 2] } },
      after_unknown: { y: true },
      before_sensitive: false,
      after_sensitive: {},
    },
  };
  const entryTwo = {
    address: 'b.two',
    change: {
      actions: ['update'],
      before: { k: '1', j: '2' },
      after: { k: '2', j: '2' },
      after_unknown: {},
      before_sensitive: {},
      after_sensitive: {},
    },
  };
  // The same data as entryOne / entryTwo, with every object's keys in another order.
  const entryOneShuffled = {
    change: {
      after_sensitive: {},
      before_sensitive: false,
      after_unknown: { y: true },
      after: { nested: { q: [1, 2], p: 1 }, x: 1 },
      before: null,
      actions: ['create'],
    },
    address: 'a.one',
  };
  const entryTwoShuffled = {
    change: {
      after_sensitive: {},
      after: { j: '2', k: '2' },
      before_sensitive: {},
      before: { j: '2', k: '1' },
      after_unknown: {},
      actions: ['update'],
    },
    address: 'b.two',
  };

  const base = { format_version: '1.2', resource_changes: [entryOne, entryTwo] };
  const baseDigest = (): string => planDigest(base);

  test('AC-11: reordering keys at every level does not change the digest', () => {
    const shuffled = {
      resource_changes: [entryOneShuffled, entryTwoShuffled],
      format_version: '1.2',
    };
    expect(planDigest(shuffled)).toBe(baseDigest());
  });

  test('AC-11: reordering the resource_changes entries does not change the digest', () => {
    const reversed = { format_version: '1.2', resource_changes: [entryTwo, entryOne] };
    expect(planDigest(reversed)).toBe(baseDigest());
  });

  test('AC-11: adding a no-op entry does not change the digest', () => {
    const withNoop = {
      format_version: '1.2',
      resource_changes: [entryOne, resource('c.noop', ['no-op']), entryTwo],
    };
    expect(planDigest(withNoop)).toBe(baseDigest());
  });

  test.each([
    ['resource_drift', { resource_drift: [resource('d.drift', ['update'])] }],
    [
      'output_changes',
      { output_changes: { arn: { actions: ['create'], after: 'arn:x', after_unknown: false } } },
    ],
    ['prior_state', { prior_state: { format_version: '1.0', values: { root_module: {} } } }],
    ['configuration', { configuration: { root_module: { resources: [{ address: 'a.one' }] } } }],
    ['another format_version', { format_version: '1.3' }],
    ['another terraform_version', { terraform_version: '9.9.9' }],
  ])('AC-11: adding or changing %s does not change the digest', (_name, extra) => {
    expect(planDigest({ ...base, ...extra })).toBe(baseDigest());
  });
});

describe('planDigest: what changes it', () => {
  const baseEntry = (inner: Json = {}, entry: Json = {}): Json =>
    resource('aws_x.y', ['create'], {
      entry,
      inner: {
        before: null,
        after: { tags: { a: '1' }, size: 1 },
        after_unknown: { id: true },
        after_sensitive: {},
        ...inner,
      },
    });
  const baseDigest = (): string => planDigest(plan([baseEntry()]));

  const mutations: [string, Json][] = [
    ['a different nested after value', baseEntry({ after: { tags: { a: '2' }, size: 1 } })],
    ['actions update instead of create', baseEntry({ actions: ['update'] })],
    [
      'a different address',
      resource('aws_x.z', ['create'], { inner: baseEntry()['change'] as Json }),
    ],
    ['an added previous_address', baseEntry({}, { previous_address: 'aws_x.old' })],
    ['after_unknown true replaced by false', baseEntry({ after_unknown: { id: false } })],
    ['a changed after_sensitive', baseEntry({ after_sensitive: { size: true } })],
    ['an added replace_paths', baseEntry({ replace_paths: [['size']] })],
    ['an added importing object', baseEntry({ importing: { id: 'abc' } })],
    ['a changed before_sensitive', baseEntry({ before_sensitive: true })],
    ['a changed before', baseEntry({ before: { size: 0 } })],
  ];

  test.each(mutations)('AC-12: %s changes the digest', (_name, mutated) => {
    expect(planDigest(plan([mutated]))).not.toBe(baseDigest());
  });

  test('AC-12: ["delete","create"] and ["create","delete"] digest differently', () => {
    const deleteFirst = planDigest(plan([baseEntry({ actions: ['delete', 'create'] })]));
    const createFirst = planDigest(plan([baseEntry({ actions: ['create', 'delete'] })]));
    expect(deleteFirst).not.toBe(createFirst);
  });

  test('AC-12: a second changed resource changes the digest', () => {
    const two = plan([baseEntry(), resource('aws_x.other', ['create'])]);
    expect(planDigest(two)).not.toBe(baseDigest());
  });

  test('AC-12: a different value in a second resource changes the digest', () => {
    const one = plan([
      baseEntry(),
      resource('aws_x.other', ['create'], { inner: { after: { n: 1 } } }),
    ]);
    const other = plan([
      baseEntry(),
      resource('aws_x.other', ['create'], { inner: { after: { n: 2 } } }),
    ]);
    expect(planDigest(one)).not.toBe(planDigest(other));
  });
});

// ---- changeSet ----------------------------------------------------------------------------------

describe('changeSet', () => {
  test('AC-13: a no-op entry with previous_address is a move and belongs to the change set', () => {
    const moved = plan([resource('a.new', ['no-op'], { entry: { previous_address: 'a.old' } })]);
    expect(changeSet(moved)).toEqual<PlanChange[]>([
      { address: 'a.new', actions: ['no-op'], previousAddress: 'a.old', importing: false },
    ]);
  });

  test('AC-13: a no-op entry with change.importing is an import and belongs to the change set', () => {
    const imported = plan([resource('a.imp', ['no-op'], { inner: { importing: { id: 'i-1' } } })]);
    expect(changeSet(imported)).toEqual<PlanChange[]>([
      { address: 'a.imp', actions: ['no-op'], previousAddress: null, importing: true },
    ]);
  });

  test('AC-13: plain no-ops are excluded', () => {
    expect(changeSet(plan([resource('a.x', ['no-op']), resource('b.y', ['no-op'])]))).toEqual([]);
  });

  test('AC-13: other actions are included with their actions, not moved and not importing', () => {
    const mixed = plan([
      resource('a.create', ['create']),
      resource('b.read', ['read']),
      resource('c.forget', ['forget']),
      resource('d.replace', ['create', 'delete']),
    ]);
    expect(changeSet(mixed)).toEqual<PlanChange[]>([
      { address: 'a.create', actions: ['create'], previousAddress: null, importing: false },
      { address: 'b.read', actions: ['read'], previousAddress: null, importing: false },
      { address: 'c.forget', actions: ['forget'], previousAddress: null, importing: false },
      {
        address: 'd.replace',
        actions: ['create', 'delete'],
        previousAddress: null,
        importing: false,
      },
    ]);
  });

  test('AC-13: an update that also moved keeps both facts', () => {
    const both = plan([resource('a.new', ['update'], { entry: { previous_address: 'a.old' } })]);
    expect(changeSet(both)).toEqual<PlanChange[]>([
      { address: 'a.new', actions: ['update'], previousAddress: 'a.old', importing: false },
    ]);
  });

  test('AC-13: the change set is sorted by address in UTF-16 code unit order (b, a, B -> B, a, b)', () => {
    const unsorted = plan([
      resource('b.x', ['create']),
      resource('a.x', ['create']),
      resource('B.x', ['create']),
    ]);
    expect(changeSet(unsorted).map((entry) => entry.address)).toEqual(['B.x', 'a.x', 'b.x']);
  });

  test('AC-13: resource_drift and output_changes are not part of the change set', () => {
    const noisy = plan([], {
      resource_drift: [resource('d.drift', ['update'])],
      output_changes: { arn: { actions: ['update'], before: 'a', after: 'b' } },
    });
    expect(changeSet(noisy)).toEqual([]);
  });
});

// ---- planSummary --------------------------------------------------------------------------------

describe('planSummary: exact Markdown', () => {
  const mixedPlan = plan([
    resource('f_moved.new', ['no-op'], { entry: { previous_address: 'f_moved.old' } }),
    resource('d_replace.x', ['delete', 'create']),
    resource('b_update.x', ['update']),
    resource('data.e_read.x', ['read']),
    resource('c_delete.x', ['delete']),
    resource('a_create.x', ['create']),
    resource('g_untouched.x', ['no-op']),
  ]);

  test('AC-14: a create, update, delete, replace, read and moved no-op give the exact Markdown', () => {
    const digest = planDigest(mixedPlan);
    expect(planSummary(mixedPlan, 'labs/00-x')).toBe(
      [
        '### <code>labs/00-x</code>',
        '',
        'Plan: 1 to add, 1 to change, 1 to destroy, 1 to replace.',
        '',
        '| Action | Resource |',
        '|---|---|',
        '| create | <code>a_create.x</code> |',
        '| update | <code>b_update.x</code> |',
        '| delete | <code>c_delete.x</code> |',
        '| replace | <code>d_replace.x</code> |',
        '| read | <code>data.e_read.x</code> |',
        '| no-op, moved from <code>f_moved.old</code> | <code>f_moved.new</code> |',
        '',
        `Change set digest: <code>${digest}</code>`,
        '',
      ].join('\n'),
    );
  });

  test('AC-14: the digest line carries the digest of the plan', () => {
    expect(planSummary(mixedPlan, 'labs/00-x')).toContain(
      `Change set digest: <code>${planDigest(mixedPlan)}</code>`,
    );
  });

  test('AC-14: ["create","delete"] is a replace as well, counted once under replace', () => {
    const replaced = plan([resource('a.x', ['create', 'delete'])]);
    const summary = planSummary(replaced, 'labs/00-x');
    expect(summary).toContain('Plan: 0 to add, 0 to change, 0 to destroy, 1 to replace.');
    expect(summary).toContain('| replace | <code>a.x</code> |');
  });

  test('AC-14: forget gets its label and no count', () => {
    const forgotten = plan([resource('a.x', ['forget'])]);
    const summary = planSummary(forgotten, 'labs/00-x');
    expect(summary).toContain('Plan: 0 to add, 0 to change, 0 to destroy, 0 to replace.');
    expect(summary).toContain('| forget | <code>a.x</code> |');
  });

  test('AC-14: an import is labelled ", import" and a no-op import is "no-op, import"', () => {
    const imported = plan([
      resource('a.created', ['create'], { inner: { importing: { id: '1' } } }),
      resource('b.noop', ['no-op'], { inner: { importing: { id: '2' } } }),
    ]);
    const summary = planSummary(imported, 'labs/00-x');
    expect(summary).toContain('| create, import | <code>a.created</code> |');
    expect(summary).toContain('| no-op, import | <code>b.noop</code> |');
  });

  test('AC-14: an update that moved is labelled "update, moved from <code>...</code>"', () => {
    const moved = plan([resource('a.new', ['update'], { entry: { previous_address: 'a.old' } })]);
    expect(planSummary(moved, 'labs/00-x')).toContain(
      '| update, moved from <code>a.old</code> | <code>a.new</code> |',
    );
  });

  test('AC-14: an import that also moved lists import before the move', () => {
    const both = plan([
      resource('a.new', ['create'], {
        entry: { previous_address: 'a.old' },
        inner: { importing: { id: '1' } },
      }),
    ]);
    expect(planSummary(both, 'labs/00-x')).toContain(
      '| create, import, moved from <code>a.old</code> | <code>a.new</code> |',
    );
  });

  test('AC-14: a change set of only moves still has a counts line of zeros', () => {
    const onlyMove = plan([resource('a.new', ['no-op'], { entry: { previous_address: 'a.old' } })]);
    expect(planSummary(onlyMove, 'labs/00-x')).toContain(
      'Plan: 0 to add, 0 to change, 0 to destroy, 0 to replace.',
    );
  });

  test('AC-14: the previous address of a move is escaped like any code span', () => {
    const moved = plan([
      resource('a.new', ['no-op'], { entry: { previous_address: 'a.old["x|y"]' } }),
    ]);
    expect(planSummary(moved, 'labs/00-x')).toContain(
      'moved from <code>a.old[&quot;x&#124;y&quot;]</code>',
    );
  });

  test('AC-14: the stack in the heading is a code span too', () => {
    expect(planSummary(plan([resource('a.x', ['create'])]), 'labs/00-x')).toMatch(
      /^### <code>labs\/00-x<\/code>\n\n/,
    );
  });
});

describe('planSummary: no changes', () => {
  const expected =
    '### <code>labs/00-x</code>\n\nNo changes.\n\n' +
    `Change set digest: <code>${EMPTY_DIGEST}</code>\n`;

  test('AC-15: an empty change set gives exactly the heading, No changes. and the digest', () => {
    expect(planSummary({ format_version: '1.2' }, 'labs/00-x')).toBe(expected);
  });

  test('AC-15: a plan with only plain no-ops gives the same text', () => {
    expect(planSummary(plan([resource('a.x', ['no-op'])]), 'labs/00-x')).toBe(expected);
  });

  test('AC-15: every summary ends with exactly one newline', () => {
    const many = plan(Array.from({ length: 55 }, (_, i) => resource(`r_${i}.x`, ['create'])));
    const summaries = [
      planSummary({ format_version: '1.2' }, 'labs/00-x'),
      planSummary(plan([resource('a.x', ['create']), resource('b.y', ['delete'])]), 'labs/00-x'),
      planSummary(many, 'labs/00-x'),
    ];
    for (const summary of summaries) {
      expect(summary.endsWith('\n')).toBe(true);
      expect(summary.endsWith('\n\n')).toBe(false);
    }
  });
});

describe('planSummary: escaping', () => {
  test('AC-16: & < > " and | in an address are HTML-escaped inside the code span', () => {
    const address = 'aws_x.y["a|b<c>&"d"]';
    const summary = planSummary(plan([resource(address, ['create'])]), 'labs/00-x');
    expect(summary).toContain('<code>aws_x.y[&quot;a&#124;b&lt;c&gt;&amp;&quot;d&quot;]</code>');
  });

  test('AC-16: the row of such an address still has exactly two columns', () => {
    const address = 'aws_x.y["a|b<c>&"d"]';
    const summary = planSummary(plan([resource(address, ['create'])]), 'labs/00-x');
    const row = summary.split('\n').find((line) => line.includes('&#124;'));
    expect(row).toBeDefined();
    expect((row as string).split('|')).toHaveLength(4); // before the first, between and after the last
  });

  test('AC-16: the raw address never appears unescaped in the summary', () => {
    const address = 'aws_x.y["a|b<c>&"d"]';
    expect(planSummary(plan([resource(address, ['create'])]), 'labs/00-x')).not.toContain(address);
  });

  test('AC-16: the stack in the heading is escaped as well', () => {
    expect(planSummary({ format_version: '1.2' }, 'labs/00-x<b>')).toContain(
      '### <code>labs/00-x&lt;b&gt;</code>',
    );
  });
});

describe('planSummary: row limit', () => {
  /** n resources named so that address order is creation order. */
  const created = (n: number): Json =>
    plan(
      Array.from({ length: n }, (_, i) =>
        resource(`r_${String(i).padStart(3, '0')}.x`, ['create']),
      ),
    );
  const rowsOf = (summary: string): string[] =>
    summary.split('\n').filter((l) => /^\| [a-z]/.test(l));
  const MORE = /^…and \d+ more \(see the job log\)\.$/m;

  test('AC-17: 53 changed resources give 50 rows and the line "...and 3 more (see the job log)."', () => {
    const summary = planSummary(created(53), 'labs/00-x');
    expect(rowsOf(summary)).toHaveLength(50);
    expect(summary.split('\n')).toContain(
      `${String.fromCharCode(0x2026)}and 3 more (see the job log).`,
    );
  });

  test('AC-17: the 50 rows are the first 50 in address order', () => {
    const rows = rowsOf(planSummary(created(53), 'labs/00-x'));
    expect(rows[0]).toBe('| create | <code>r_000.x</code> |');
    expect(rows[49]).toBe('| create | <code>r_049.x</code> |');
  });

  test('AC-17: the counts line still counts every change, not only the listed ones', () => {
    expect(planSummary(created(53), 'labs/00-x')).toContain(
      'Plan: 53 to add, 0 to change, 0 to destroy, 0 to replace.',
    );
  });

  test('AC-17: the "more" line comes after the table and before the digest line', () => {
    const lines = planSummary(created(53), 'labs/00-x').split('\n');
    const more = lines.findIndex((line) => line.includes('more (see the job log)'));
    const lastRow = lines.map((l) => /^\| [a-z]/.test(l)).lastIndexOf(true);
    const digest = lines.findIndex((line) => line.startsWith('Change set digest:'));
    expect(more).toBeGreaterThan(lastRow);
    expect(digest).toBeGreaterThan(more);
  });

  test('AC-17: exactly 50 changed resources give 50 rows and no "more" line', () => {
    const summary = planSummary(created(50), 'labs/00-x');
    expect(rowsOf(summary)).toHaveLength(50);
    expect(summary).not.toMatch(MORE);
    expect(summary).not.toContain('more (see the job log)');
  });

  test('AC-17: 51 changed resources give 50 rows and "and 1 more"', () => {
    const summary = planSummary(created(51), 'labs/00-x');
    expect(rowsOf(summary)).toHaveLength(50);
    expect(summary).toMatch(MORE);
    expect(summary).toContain('and 1 more (see the job log).');
  });
});

describe('planSummary: secrets', () => {
  const SECRET = 's3cr3t-value-123';

  test('AC-18: no before, after or output_changes value reaches the summary', () => {
    const leaky = plan(
      [
        resource('aws_db.main', ['update'], {
          inner: {
            before: { password: SECRET, nested: { token: SECRET } },
            after: { password: `${SECRET}-new`, nested: { token: SECRET }, note: SECRET },
            before_sensitive: { password: true },
            after_sensitive: { password: true, nested: { token: true } },
          },
        }),
        resource('aws_db.other', ['create'], { inner: { after: { user: SECRET } } }),
      ],
      {
        output_changes: {
          db_password: {
            actions: ['create'],
            before: null,
            after: SECRET,
            after_unknown: false,
            before_sensitive: true,
            after_sensitive: true,
          },
        },
      },
    );
    const summary = planSummary(leaky, 'labs/00-x');
    expect(summary).toContain('aws_db.main');
    expect(summary).not.toContain('s3cr3t');
  });
});

// ---- Input validation ---------------------------------------------------------------------------

describe('PlanFormatError', () => {
  const invalid: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a string', 'plan'],
    ['a number', 7],
    ['{} (no format_version)', {}],
    ['a numeric format_version', { format_version: 1.2 }],
    ['resource_changes that is not an array', { format_version: '1.2', resource_changes: {} }],
    ['an entry that is null', { format_version: '1.2', resource_changes: [null] }],
    [
      'an entry without address',
      { format_version: '1.2', resource_changes: [{ change: { actions: ['create'] } }] },
    ],
    ['an entry without change', { format_version: '1.2', resource_changes: [{ address: 'a.x' }] }],
    [
      'an entry whose change.actions is a string',
      {
        format_version: '1.2',
        resource_changes: [{ address: 'a.x', change: { actions: 'create' } }],
      },
    ],
    [
      'an entry whose change.actions holds a non-string',
      { format_version: '1.2', resource_changes: [{ address: 'a.x', change: { actions: [1] } }] },
    ],
    [
      'an entry whose change.actions is missing',
      { format_version: '1.2', resource_changes: [{ address: 'a.x', change: {} }] },
    ],
    ['errored: true', { format_version: '1.2', errored: true }],
  ];

  test.each(invalid)(
    'AC-19: %s is rejected by planDigest, changeSet and planSummary',
    (_name, input) => {
      expect(() => planDigest(input)).toThrow(PlanFormatError);
      expect(() => changeSet(input)).toThrow(PlanFormatError);
      expect(() => planSummary(input, 'labs/00-x')).toThrow(PlanFormatError);
    },
  );

  test('AC-19: an errored plan says so in the message', () => {
    expect(() => planDigest({ format_version: '1.2', errored: true })).toThrow(
      'terraform reported an errored plan',
    );
  });

  test('AC-19: a valid plan is accepted (errored: false, no resource_changes, extra keys)', () => {
    expect(() =>
      planDigest({ format_version: '1.2', errored: false, anything: [1] }),
    ).not.toThrow();
    expect(() => planDigest(plan([resource('a.x', ['create'])]))).not.toThrow();
  });

  test('AC-19: PlanFormatError is an Error subclass', () => {
    expect(new PlanFormatError('x')).toBeInstanceOf(Error);
  });
});

// ---- runTfPlan (the CLI dispatcher, with injected I/O) ------------------------------------------

describe('runTfPlan', () => {
  const createdPlan = plan([resource('terraform_data.smoke', ['create'])]);
  const files: Record<string, string> = {
    'created.json': JSON.stringify(createdPlan),
    'empty.json': JSON.stringify({ format_version: '1.2' }),
    'invalid.json': '{ not json',
    'wrong.json': JSON.stringify({}),
    'errored.json': JSON.stringify({ format_version: '1.2', errored: true }),
  };

  function run(argv: string[]): { code: number; stdout: string; stderr: string } {
    let stdout = '';
    let stderr = '';
    const code = runTfPlan(argv, {
      readFile(path: string): string {
        const content = files[path];
        if (content === undefined)
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        return content;
      },
      stdout(text: string): void {
        stdout += text;
      },
      stderr(text: string): void {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }

  test('AC-20: digest prints the digest and a newline', () => {
    expect(run(['digest', 'created.json'])).toEqual({
      code: 0,
      stdout: `${planDigest(createdPlan)}\n`,
      stderr: '',
    });
  });

  test('AC-20: changed prints false for an empty change set', () => {
    expect(run(['changed', 'empty.json'])).toEqual({ code: 0, stdout: 'false\n', stderr: '' });
  });

  test('AC-20: changed prints true for a non-empty change set', () => {
    expect(run(['changed', 'created.json'])).toEqual({ code: 0, stdout: 'true\n', stderr: '' });
  });

  test('AC-20: summary prints the summary exactly', () => {
    expect(run(['summary', 'created.json', 'labs/00-x'])).toEqual({
      code: 0,
      stdout: planSummary(createdPlan, 'labs/00-x'),
      stderr: '',
    });
  });

  test.each([
    ['a missing file', ['digest', 'missing.json']],
    ['invalid JSON', ['digest', 'invalid.json']],
    ['a plan without format_version', ['changed', 'wrong.json']],
    ['an errored plan', ['summary', 'errored.json', 'labs/00-x']],
  ])('AC-20: %s exits 1 with a message on stderr and nothing on stdout', (_name, argv) => {
    // Precondition: the command works on a valid file.
    expect(run(['digest', 'created.json']).code).toBe(0);
    const result = run(argv);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });

  test.each([
    ['no command', []],
    ['an unknown command', ['frobnicate', 'created.json']],
    ['digest without a file', ['digest']],
    ['digest with an extra argument', ['digest', 'created.json', 'extra']],
    ['changed without a file', ['changed']],
    ['summary without a stack', ['summary', 'created.json']],
    ['summary without anything', ['summary']],
    ['summary with an extra argument', ['summary', 'created.json', 'labs/00-x', 'extra']],
  ])('AC-20: %s exits 2 with usage on stderr and nothing on stdout', (_name, argv) => {
    expect(run(['digest', 'created.json']).code).toBe(0);
    const result = run(argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });
});
