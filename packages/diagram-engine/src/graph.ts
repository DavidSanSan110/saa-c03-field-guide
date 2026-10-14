// Compiled diagram graph: the plain-JSON result of the layout compiler (spec 010). Types only.
import type { Diagram, GroupKind } from '@field-guide/schema';

export type LayoutDirection = 'right' | 'down';
export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompiledGroup extends Box {
  id: string;
  label: string;
  kind: GroupKind;
  /** Id of the enclosing group; absent at the top level. */
  parent?: string;
  /** 0 at the top level, +1 per enclosing group. */
  depth: number;
  /** True when a `pos` override made it larger than the layout did. */
  grown: boolean;
}

export interface CompiledNode extends Box {
  id: string;
  icon: string;
  label: string;
  sub?: string;
  /** The node's `group`; absent at the top level. */
  parent?: string;
  /** True when the node has `pos`. */
  overridden: boolean;
}

export interface CompiledEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Orthogonal route in ABSOLUTE canvas coordinates; absent when the view must route it. */
  points?: Point[];
}

export interface CompiledDiagram {
  /** The input, unchanged (the island also needs it for the player). */
  diagram: Diagram;
  direction: LayoutDirection;
  /** Canvas size: every box and point lies inside [0, width] x [0, height]. */
  width: number;
  height: number;
  /** Parents before children; siblings in source order. */
  groups: CompiledGroup[];
  /** Source order. */
  nodes: CompiledNode[];
  /** Source order. */
  edges: CompiledEdge[];
}
