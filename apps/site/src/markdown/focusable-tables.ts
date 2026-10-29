// Keyboard-reachable content tables (spec 039). Interface stub: the implementation comes after the tests.

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

/** What to set on each `table` element of `root`, in document order. Never mutates `root`. */
export interface TablePlan {
  table: HastElement;
  tabIndex?: 0;
  ariaLabel?: string;
}

export function planTableLabels(root: HastRoot): TablePlan[] {
  void root;
  return [];
}

/** A Sätteri hast plugin: `{ name: 'focusable-tables', before(root, ctx) }`. */
export function focusableTablesPlugin(): {
  name: string;
  before(root: unknown, ctx: unknown): void;
} {
  return {
    name: 'focusable-tables',
    before() {
      // not implemented
    },
  };
}
