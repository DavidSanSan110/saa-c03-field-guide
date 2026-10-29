// Keyboard-reachable content tables (spec 039): gives every Markdown table a tab stop and an accessible name.

/** Minimal local hast shapes (no @types/hast: it is not resolvable from apps/site). */
export interface HastText {
  type: 'text';
  value: string;
}
export interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
export interface HastRoot {
  type: 'root';
  children: HastNode[];
}
export type HastNode = HastRoot | HastElement | HastText | { type: string; [key: string]: unknown };

export const TABLE_FALLBACK_NAME = 'Table';

/** What to set on one `table` element: a tab stop and/or an accessible name (absent when already set). */
export interface TablePlan {
  table: HastElement;
  tabIndex?: 0;
  ariaLabel?: string;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element';
}

function hasClass(element: HastElement, name: string): boolean {
  const value = element.properties?.['className'] ?? element.properties?.['class'];
  if (Array.isArray(value)) return value.includes(name);
  return typeof value === 'string' && value.split(/\s+/).includes(name);
}

function hasAny(element: HastElement, keys: string[]): boolean {
  return keys.some((key) => element.properties !== undefined && key in element.properties);
}

/** The text of `node`, leaving out Starlight's heading anchor links. */
function textOf(node: HastNode): string {
  if (node.type === 'text') return String((node as HastText).value);
  if (!isElement(node) || hasClass(node, 'sl-anchor-link')) return '';
  return node.children.map(textOf).join('');
}

/** What to set on each `table` element of `root`, in document order. Never mutates `root`. */
export function planTableLabels(root: HastRoot): TablePlan[] {
  const plans: TablePlan[] = [];
  let heading = TABLE_FALLBACK_NAME;
  let count = 0;

  const visit = (node: HastNode): void => {
    if (!isElement(node)) {
      // Any node with children (root, mdxJsxFlowElement...) can wrap a table.
      const { children } = node as { children?: unknown };
      if (Array.isArray(children)) (children as HastNode[]).forEach(visit);
      return;
    }
    if (HEADINGS.has(node.tagName)) {
      heading = textOf(node).replace(/\s+/g, ' ').trim() || TABLE_FALLBACK_NAME;
      count = 0;
      return;
    }
    if (node.tagName === 'table') {
      count += 1;
      const plan: TablePlan = { table: node };
      if (!hasAny(node, ['tabIndex', 'tabindex'])) plan.tabIndex = 0;
      if (!hasAny(node, ['ariaLabel', 'aria-label', 'ariaLabelledBy', 'aria-labelledby'])) {
        plan.ariaLabel = count === 1 ? heading : `${heading} (table ${count})`;
      }
      plans.push(plan);
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
  return plans;
}

interface SatteriContext {
  setProperty(node: unknown, name: string, value: unknown): void;
}

/** A Sätteri hast plugin: applies `planTableLabels` to every table of the page. */
export function focusableTablesPlugin(): {
  name: string;
  before(root: unknown, ctx: unknown): void;
} {
  return {
    name: 'focusable-tables',
    before(root, ctx) {
      for (const { table, tabIndex, ariaLabel } of planTableLabels(root as HastRoot)) {
        if (tabIndex !== undefined)
          (ctx as SatteriContext).setProperty(table, 'tabIndex', tabIndex);
        if (ariaLabel !== undefined)
          (ctx as SatteriContext).setProperty(table, 'ariaLabel', ariaLabel);
      }
    },
  };
}
