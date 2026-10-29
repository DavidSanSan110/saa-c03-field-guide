// Spec 039, review round 1: regression tests for AC-18, AC-19 and AC-20 (new file, append-only).
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

function heading(tagName: string, value: string): HastElement {
  return el(tagName, [text(value)]);
}

function table(): HastElement {
  return el('table', [el('tbody', [el('tr', [el('td', [text('cell')])])])]);
}

/** A JSX element in an `.mdx` tree: not an `element` node, but it has children. */
function jsx(name: string, children: HastNode[]): HastNode {
  return { type: 'mdxJsxFlowElement', name, attributes: [], children };
}

function root(...children: HastNode[]): HastRoot {
  return { type: 'root', children };
}

function names(tree: HastRoot): (string | undefined)[] {
  return planTableLabels(tree).map((plan) => plan.ariaLabel);
}

describe('AC-18: the walk descends into every node with children', () => {
  test('AC-18: a table inside an mdxJsxFlowElement is planned and named', () => {
    const inside = table();
    const plans = planTableLabels(root(heading('h2', 'Before the wrapper'), jsx('div', [inside])));

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(inside);
    expect(plans[0]).toMatchObject({ tabIndex: 0, ariaLabel: 'Before the wrapper' });
  });

  test('AC-18: tables inside JSX wrappers and top-level tables come in document order', () => {
    const first = table();
    const second = table();
    const third = table();
    const plans = planTableLabels(root(heading('h2', 'Group'), first, jsx('div', [second]), third));

    expect(plans.map((plan) => plan.table)).toEqual([first, second, third]);
    expect(plans[0]?.table).toBe(first);
    expect(plans[1]?.table).toBe(second);
    expect(plans[2]?.table).toBe(third);
    expect(plans.map((plan) => plan.ariaLabel)).toEqual([
      'Group',
      'Group (table 2)',
      'Group (table 3)',
    ]);
  });

  test('AC-18: a table nested two levels deep in JSX wrappers is planned', () => {
    const deep = table();
    const plans = planTableLabels(
      root(heading('h2', 'Deep'), jsx('div', [jsx('section', [deep])])),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(deep);
    expect(plans[0]?.ariaLabel).toBe('Deep');
  });

  test('AC-18: a table inside a JSX wrapper nested in an element is planned', () => {
    const inside = table();
    const plans = planTableLabels(
      root(heading('h2', 'Mixed'), el('div', [jsx('div', [el('figure', [inside])])])),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(inside);
  });

  test('AC-18: a heading inside a JSX wrapper names the table after it', () => {
    const outside = table();
    const plans = planTableLabels(
      root(heading('h2', 'Outer'), jsx('div', [heading('h3', 'Inner tab')]), outside),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(outside);
    expect(plans[0]?.ariaLabel).toBe('Inner tab');
  });

  test('AC-18: a heading and its table both inside a JSX wrapper are named together', () => {
    const inside = table();
    const plans = planTableLabels(
      root(
        heading('h2', 'Outer'),
        jsx('div', [jsx('section', [heading('h3', 'Tab one'), inside])]),
      ),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(inside);
    expect(plans[0]?.ariaLabel).toBe('Tab one');
  });

  test('AC-18: a table nested in a table is not planned', () => {
    const outer = el('table', [el('tbody', [el('tr', [el('td', [table()])])])]);
    const plans = planTableLabels(root(heading('h2', 'Nested'), outer));

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(outer);
    expect(plans[0]?.ariaLabel).toBe('Nested');
  });

  test('AC-18: a table nested in a table inside a JSX wrapper is not planned either', () => {
    const outer = el('table', [el('tbody', [el('tr', [el('td', [table()])])])]);
    const plans = planTableLabels(root(heading('h2', 'Nested'), jsx('div', [outer])));

    expect(plans).toHaveLength(1);
    expect(plans[0]?.table).toBe(outer);
  });
});

describe('AC-19: sl-anchor-link as a class string', () => {
  function wrapperWithAnchor(properties: Record<string, unknown>): HastElement {
    return el(
      'div',
      [
        heading('h2', 'Cross-account access'),
        el('a', [text('Section titled "Cross-account access"')], properties),
      ],
      { className: ['sl-heading-wrapper'] },
    );
  }

  test.each([
    ['class: "sl-anchor-link"', { class: 'sl-anchor-link' }],
    ['class: "foo sl-anchor-link"', { class: 'foo sl-anchor-link' }],
    ['class: "sl-anchor-link foo"', { class: 'sl-anchor-link foo' }],
    ['className: "sl-anchor-link"', { className: 'sl-anchor-link' }],
    ['className: "foo sl-anchor-link"', { className: 'foo sl-anchor-link' }],
  ])('AC-19: a sibling anchor with %s is not part of the name', (_label, properties) => {
    expect(names(root(wrapperWithAnchor(properties), table()))).toEqual(['Cross-account access']);
  });

  test.each([
    ['class: "sl-anchor-link"', { class: 'sl-anchor-link' }],
    ['class: "foo sl-anchor-link"', { class: 'foo sl-anchor-link' }],
    ['className: "sl-anchor-link"', { className: 'sl-anchor-link' }],
  ])(
    'AC-19: an anchor inside the heading with %s is not part of the name',
    (_label, properties) => {
      const tree = root(
        el('h2', [
          text('Cross-account access'),
          el('a', [text('Section titled "Cross-account access"')], properties),
        ]),
        table(),
      );

      expect(names(tree)).toEqual(['Cross-account access']);
    },
  );
});

describe('AC-20: an empty heading name falls back to Table', () => {
  test('AC-20: a heading with only whitespace names its table Table', () => {
    expect(names(root(heading('h2', '  \n  '), table()))).toEqual([TABLE_FALLBACK_NAME]);
  });

  test('AC-20: a heading with no children names its table Table', () => {
    expect(names(root(el('h2'), table()))).toEqual(['Table']);
  });

  test('AC-20: a heading with only anchor text names its table Table', () => {
    const tree = root(
      el('h2', [el('a', [text('Section titled "x"')], { className: ['sl-anchor-link'] })]),
      table(),
    );

    expect(names(tree)).toEqual(['Table']);
  });

  test('AC-20: a wrapper whose heading is empty and anchor is a sibling names its table Table', () => {
    const wrapper = el(
      'div',
      [el('h2'), el('a', [text('Section titled ""')], { class: 'sl-anchor-link' })],
      { className: ['sl-heading-wrapper'] },
    );

    expect(names(root(wrapper, table()))).toEqual(['Table']);
  });

  test('AC-20: the usual counting applies after an empty heading', () => {
    const tree = root(heading('h2', '   '), table(), table(), table());

    expect(names(tree)).toEqual(['Table', 'Table (table 2)', 'Table (table 3)']);
  });

  test('AC-20: an empty heading restarts the count of the tables before it', () => {
    const tree = root(table(), table(), heading('h2', ''), table(), table());

    expect(names(tree)).toEqual(['Table', 'Table (table 2)', 'Table', 'Table (table 2)']);
  });

  test('AC-20: no aria-label is ever empty', () => {
    const tree = root(heading('h2', ' '), table(), heading('h3', 'Real'), table());

    for (const plan of planTableLabels(tree)) {
      expect(plan.ariaLabel?.trim()).not.toBe('');
      expect(plan.ariaLabel).toBeDefined();
    }
  });
});
