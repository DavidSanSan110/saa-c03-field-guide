// Spec 039, AC-1…AC-9: the pure planner that names and focuses content tables. Hast trees are built by
// hand; the Sätteri adapter and the built pages are covered by the e2e specs (e2e/site/tables.spec.ts).
import { describe, expect, test } from 'vitest';
import {
  planTableLabels,
  TABLE_FALLBACK_NAME,
  type HastElement,
  type HastNode,
  type HastRoot,
} from './focusable-tables.ts';

function text(value: string): HastNode {
  return { type: 'text', value };
}

function el(
  tagName: string,
  children: HastNode[] = [],
  properties: Record<string, unknown> = {},
): HastElement {
  return { type: 'element', tagName, properties, children };
}

/** A heading whose only child is a text node. */
function heading(tagName: string, value: string): HastElement {
  return el(tagName, [text(value)]);
}

/** A small table; `properties` lets a test pre-set tabindex / aria attributes. */
function table(properties: Record<string, unknown> = {}): HastElement {
  return el('table', [el('tbody', [el('tr', [el('td', [text('cell')])])])], properties);
}

function root(...children: HastNode[]): HastRoot {
  return { type: 'root', children };
}

function names(tree: HastRoot): (string | undefined)[] {
  return planTableLabels(tree).map((plan) => plan.ariaLabel);
}

describe('planTableLabels: one plan per table', () => {
  test('AC-1: a table after an h2 gets tabIndex 0 and the heading text as its name', () => {
    const wide = table();
    const plans = planTableLabels(root(heading('h2', 'Wide table'), wide));

    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({ table: wide, tabIndex: 0, ariaLabel: 'Wide table' });
    expect(plans[0]?.table).toBe(wide);
  });

  test('AC-2: tables nested in div, figure and section are planned in document order', () => {
    const inDiv = table();
    const inFigure = table();
    const inSection = table();
    const topLevel = table();
    const tree = root(
      heading('h2', 'First'),
      el('div', [inDiv]),
      el('figure', [el('div', [inFigure])]),
      el('section', [heading('h3', 'Second'), el('div', [inSection])]),
      topLevel,
    );

    const plans = planTableLabels(tree);

    expect(plans.map((plan) => plan.table)).toEqual([inDiv, inFigure, inSection, topLevel]);
    expect(plans[0]?.table).toBe(inDiv);
    expect(plans[1]?.table).toBe(inFigure);
    expect(plans[2]?.table).toBe(inSection);
    expect(plans[3]?.table).toBe(topLevel);
    expect(plans.map((plan) => plan.ariaLabel)).toEqual([
      'First',
      'First (table 2)',
      'Second',
      'Second (table 2)',
    ]);
  });
});

describe('planTableLabels: counting tables under a heading', () => {
  test('AC-3: the second and third table after a heading get (table 2) and (table 3)', () => {
    const tree = root(heading('h2', 'Roles'), table(), table(), table());

    expect(names(tree)).toEqual(['Roles', 'Roles (table 2)', 'Roles (table 3)']);
  });

  test('AC-3: a new heading restarts the count', () => {
    const tree = root(
      heading('h2', 'Roles'),
      table(),
      table(),
      heading('h2', 'Policies'),
      table(),
      table(),
    );

    expect(names(tree)).toEqual(['Roles', 'Roles (table 2)', 'Policies', 'Policies (table 2)']);
  });

  test('AC-3: a new heading with the same text still restarts the count', () => {
    const tree = root(heading('h2', 'Same'), table(), heading('h3', 'Same'), table());

    expect(names(tree)).toEqual(['Same', 'Same']);
  });

  test('AC-4: tables before any heading are named Table, then Table (table 2)', () => {
    const tree = root(table(), table());

    expect(TABLE_FALLBACK_NAME).toBe('Table');
    expect(names(tree)).toEqual(['Table', 'Table (table 2)']);
  });

  test('AC-4: the fallback count stops at the first heading', () => {
    const tree = root(table(), table(), heading('h2', 'After'), table());

    expect(names(tree)).toEqual(['Table', 'Table (table 2)', 'After']);
  });
});

describe('planTableLabels: the heading text', () => {
  test('AC-5: inline code, em, strong and a children contribute their text', () => {
    const tree = root(
      el('h2', [
        text('The '),
        el('code', [text('aws:PrincipalOrgID')]),
        text(' '),
        el('em', [text('condition')]),
        text(' and '),
        el('strong', [text('its')]),
        text(' '),
        el('a', [text('key')], { href: '/somewhere/' }),
      ]),
      table(),
    );

    expect(names(tree)).toEqual(['The aws:PrincipalOrgID condition and its key']);
  });

  test('AC-5: a heading with an inline code span gives the plain text of the span', () => {
    const tree = root(
      el('h2', [text('The '), el('code', [text('aws:PrincipalOrgID')]), text(' key')]),
      table(),
    );

    expect(names(tree)).toEqual(['The aws:PrincipalOrgID key']);
  });

  test('AC-5: whitespace is collapsed and trimmed', () => {
    const tree = root(heading('h2', '  Cross-\n  account  '), table());

    expect(names(tree)).toEqual(['Cross- account']);
  });

  test('AC-6: the text of a sibling anchor link in div.sl-heading-wrapper is not part of the name', () => {
    const wrapper = el(
      'div',
      [
        heading('h2', 'Cross-account access'),
        el('a', [el('span', [text('Section titled "Cross-account access"')])], {
          className: ['sl-anchor-link'],
          href: '#cross-account-access',
        }),
      ],
      { className: ['sl-heading-wrapper', 'level-h2'] },
    );

    expect(names(root(wrapper, table()))).toEqual(['Cross-account access']);
  });

  test('AC-6: the text of an anchor link inside the heading is not part of the name', () => {
    const tree = root(
      el('h2', [
        text('Cross-account access'),
        el('a', [text('Section titled "Cross-account access"')], {
          className: ['icon', 'sl-anchor-link'],
          href: '#cross-account-access',
        }),
      ]),
      table(),
    );

    expect(names(tree)).toEqual(['Cross-account access']);
  });

  test('AC-6: tables after an h3 wrapped like Starlight does are named after that h3', () => {
    const wrapped = (tag: string, value: string): HastElement =>
      el(
        'div',
        [
          heading(tag, value),
          el('a', [text(`Section titled "${value}"`)], { className: ['sl-anchor-link'] }),
        ],
        { className: ['sl-heading-wrapper'] },
      );
    const tree = root(wrapped('h2', 'Outer'), table(), wrapped('h3', 'Inner'), table(), table());

    expect(names(tree)).toEqual(['Outer', 'Inner', 'Inner (table 2)']);
  });

  test.each(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])(
    'AC-7: a %s heading names the table that follows it',
    (tagName) => {
      expect(names(root(heading(tagName, 'Heading text'), table()))).toEqual(['Heading text']);
    },
  );

  test('AC-7: tables after an h3 that follows an h2 take the h3 text', () => {
    const tree = root(heading('h2', 'Parent'), table(), heading('h3', 'Child'), table());

    expect(names(tree)).toEqual(['Parent', 'Child']);
  });

  test('AC-7: the nearest heading wins even when it is a higher level than the previous one', () => {
    const tree = root(heading('h3', 'Deep'), table(), heading('h2', 'Shallow'), table());

    expect(names(tree)).toEqual(['Deep', 'Shallow']);
  });
});

describe('planTableLabels: tables that are already set up', () => {
  test.each([
    ['tabIndex', { tabIndex: 0 }],
    ['tabindex', { tabindex: 0 }],
    ['tabIndex -1', { tabIndex: -1 }],
  ])(
    'AC-8: a table with %s already set gets no tabIndex but still gets a name',
    (_label, props) => {
      const own = table(props);
      const plans = planTableLabels(root(heading('h2', 'Named'), own));

      expect(plans).toHaveLength(1);
      expect(plans[0]?.table).toBe(own);
      expect(plans[0]).not.toHaveProperty('tabIndex');
      expect(plans[0]?.ariaLabel).toBe('Named');
    },
  );

  test.each([
    ['ariaLabel', { ariaLabel: 'Mine' }],
    ['aria-label', { 'aria-label': 'Mine' }],
    ['ariaLabelledBy', { ariaLabelledBy: 'some-id' }],
    ['aria-labelledby', { 'aria-labelledby': 'some-id' }],
  ])(
    'AC-8: a table with %s already set gets no ariaLabel but still gets tabIndex',
    (_label, props) => {
      const own = table(props);
      const plans = planTableLabels(root(heading('h2', 'Named'), own));

      expect(plans).toHaveLength(1);
      expect(plans[0]?.table).toBe(own);
      expect(plans[0]).not.toHaveProperty('ariaLabel');
      expect(plans[0]?.tabIndex).toBe(0);
    },
  );

  test('AC-8: a table that needs neither still gets a plan entry, with neither key', () => {
    const own = table({ tabindex: 0, 'aria-label': 'Mine' });
    const plans = planTableLabels(root(heading('h2', 'Named'), own, table()));

    expect(plans).toHaveLength(2);
    expect(plans[0]?.table).toBe(own);
    expect(plans[0]).not.toHaveProperty('tabIndex');
    expect(plans[0]).not.toHaveProperty('ariaLabel');
  });

  test('AC-8: a named table still counts toward (table n) of the tables after it', () => {
    const tree = root(heading('h2', 'Group'), table({ 'aria-label': 'Mine' }), table());

    expect(names(tree)).toEqual([undefined, 'Group (table 2)']);
  });
});

describe('planTableLabels: purity', () => {
  test('AC-9: the input tree is not mutated', () => {
    const tree = root(
      el('div', [heading('h2', 'Roles'), el('a', [text('x')], { className: ['sl-anchor-link'] })], {
        className: ['sl-heading-wrapper'],
      }),
      table(),
      table({ 'aria-label': 'Mine' }),
      el('figure', [table()]),
    );
    const before = structuredClone(tree);

    const plans = planTableLabels(tree);

    expect(plans).toHaveLength(3);
    expect(tree).toEqual(before);
  });

  test('AC-9: a root with no table returns an empty array', () => {
    const tree = root(heading('h2', 'No tables here'), el('p', [text('Just prose.')]));

    expect(planTableLabels(tree)).toEqual([]);
  });

  test('AC-9: an empty root returns an empty array', () => {
    expect(planTableLabels(root())).toEqual([]);
  });
});
