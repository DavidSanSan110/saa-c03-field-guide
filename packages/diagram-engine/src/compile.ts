// Layout compiler (spec 010): turns a valid diagram into a laid-out graph. Build-time only.
import type { Diagram } from '@field-guide/schema';
import type { CompiledDiagram, LayoutDirection } from './graph.ts';

export interface CompileOptions {
  /** Default 'right'; 'down' for the narrow-screen layout. */
  direction?: LayoutDirection;
  /** Default 136 (the B' card). */
  nodeWidth?: number;
  /** Default 104. */
  nodeHeight?: number;
  /** Default 24: space between a group's border and its children. */
  groupPadding?: number;
  /** Default 32: header band at the top of each group (icon + label). */
  groupHeader?: number;
  /** Default 48: between siblings in the same layer. */
  nodeSpacing?: number;
  /** Default 72: between layers. */
  layerSpacing?: number;
}

// Interface stub: the implementation comes after the tests.
export const COMPILE_DEFAULTS = Object.freeze({}) as Readonly<Required<CompileOptions>>;

export function compile(diagram: Diagram, options?: CompileOptions): Promise<CompiledDiagram> {
  void diagram;
  void options;
  return Promise.reject(new Error('not implemented'));
}
