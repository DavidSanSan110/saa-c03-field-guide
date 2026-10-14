/* eslint-disable @typescript-eslint/no-unused-vars -- interface stubs: the implementation comes after the tests (spec 012) */
// Pure view model of the diagram island (spec 012). Interface stub: no behaviour yet.
import type { Diagram, ElementState, GroupKind } from '@field-guide/schema';
import type { Box, CompiledDiagram, Point } from './graph.ts';
import type { PlayerView } from './player.ts';

export const STEP_DURATION_MS = 0;
export const COMPACT_BELOW_PX = 0;
export type ViewLayout = 'wide' | 'compact';

export function layoutFor(width: number): ViewLayout {
  throw new Error('not implemented');
}

export function absoluteBoxes(g: CompiledDiagram): Record<string, Box> {
  throw new Error('not implemented');
}

export function directLine(from: Box, to: Box): [Point, Point] {
  throw new Error('not implemented');
}

export function edgePath(points: Point[], radius?: number): string {
  throw new Error('not implemented');
}

export function pathMidpoint(points: Point[]): Point {
  throw new Error('not implemented');
}

export function effectiveStates(
  d: Diagram,
  states: Record<string, ElementState>,
): Record<string, ElementState> {
  throw new Error('not implemented');
}

export type EdgeStatus = 'idle' | 'active' | 'done';

export interface FlowGroup {
  id: string;
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  kind: GroupKind;
  depth: number;
  state: ElementState;
  active: boolean;
}

export interface FlowNode {
  id: string;
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  sub?: string;
  icon: string;
  state: ElementState;
  active: boolean;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  points: Point[];
  status: EdgeStatus;
  state: ElementState;
  packet?: { label?: string; reverse: boolean; run: number };
}

export interface FlowModel {
  groups: FlowGroup[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

export function toFlowModel(g: CompiledDiagram, view: PlayerView): FlowModel {
  throw new Error('not implemented');
}

export interface LogLine {
  n: number;
  total: number;
  route: string;
  detail?: string;
}

export function logLines(d: Diagram, scenarioId: string, step: number): LogLine[] {
  throw new Error('not implemented');
}

export interface FallbackScenario {
  id: string;
  label: string;
  steps: { caption: string; metrics?: string }[];
}

export function textFallback(d: Diagram): FallbackScenario[] {
  throw new Error('not implemented');
}
