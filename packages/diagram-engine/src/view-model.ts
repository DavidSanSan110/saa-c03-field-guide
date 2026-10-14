// Pure view model of the diagram island (spec 012): geometry, flow model, log and text fallback.
import type {
  Diagram,
  DiagramScenario,
  DiagramStep,
  ElementState,
  GroupKind,
} from '@field-guide/schema';
import type { Box, CompiledDiagram, Point } from './graph.ts';
import type { PlayerView } from './player.ts';

/** The view's timer: one `tick` per step while playing. */
export const STEP_DURATION_MS = 3600;
/** An island narrower than this uses the compact layout. */
export const COMPACT_BELOW_PX = 560;
export type ViewLayout = 'wide' | 'compact';

/** `compact` below the breakpoint; an unmeasured width (0, NaN) is `wide`. */
export function layoutFor(width: number): ViewLayout {
  return width > 0 && width < COMPACT_BELOW_PX ? 'compact' : 'wide';
}

/** Every group and node id → its box in canvas coordinates (compiled boxes are parent-relative). */
export function absoluteBoxes(g: CompiledDiagram): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  for (const element of [...g.groups, ...g.nodes]) {
    const parent = element.parent === undefined ? undefined : boxes[element.parent];
    boxes[element.id] = {
      x: element.x + (parent?.x ?? 0),
      y: element.y + (parent?.y ?? 0),
      width: element.width,
      height: element.height,
    };
  }
  return boxes;
}

function centreOf(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function contains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/** Distance along a ray from a box centre (direction dx, dy) to the box border. */
function borderDistance(box: Box, dx: number, dy: number): number {
  return Math.min(box.width / 2 / Math.abs(dx), box.height / 2 / Math.abs(dy));
}

/** A straight line between two boxes for an edge the layout did not route. */
export function directLine(from: Box, to: Box): [Point, Point] {
  const fromCentre = centreOf(from);
  const toCentre = centreOf(to);
  const fromIsOuter = contains(from, toCentre);
  if (fromIsOuter || contains(to, fromCentre)) {
    const inner = fromIsOuter ? to : from;
    const outer = fromIsOuter ? from : to;
    const x = inner.x + inner.width / 2;
    const innerEnd = { x, y: inner.y + inner.height };
    const outerEnd = { x, y: outer.y + outer.height };
    return fromIsOuter ? [outerEnd, innerEnd] : [innerEnd, outerEnd];
  }
  const dx = toCentre.x - fromCentre.x;
  const dy = toCentre.y - fromCentre.y;
  const start = borderDistance(from, dx, dy);
  const end = borderDistance(to, dx, dy);
  return [
    { x: fromCentre.x + dx * start, y: fromCentre.y + dy * start },
    { x: toCentre.x - dx * end, y: toCentre.y - dy * end },
  ];
}

/** Rounds to 3 decimals so paths stay short. */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function pt(point: Point): string {
  return `${fmt(point.x)} ${fmt(point.y)}`;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point `length` away from `from` towards `to`. */
function towards(from: Point, to: Point, length: number): Point {
  const total = distance(from, to);
  if (total === 0) return from;
  return {
    x: from.x + ((to.x - from.x) * length) / total,
    y: from.y + ((to.y - from.y) * length) / total,
  };
}

/** SVG `d` of a polyline with rounded corners (quadratic curves, radius at most half a segment). */
export function edgePath(points: Point[], radius = 12): string {
  const [first, ...rest] = points;
  if (first === undefined) return '';
  const commands = [`M ${pt(first)}`];
  rest.forEach((current, index) => {
    const previous = points[index] as Point;
    const next = points[index + 2];
    if (next === undefined) {
      commands.push(`L ${pt(current)}`);
      return;
    }
    const r = Math.min(radius, distance(previous, current) / 2, distance(current, next) / 2);
    commands.push(
      `L ${pt(towards(current, previous, r))}`,
      `Q ${pt(current)} ${pt(towards(current, next, r))}`,
    );
  });
  return commands.join(' ');
}

/** The point at half the polyline length. */
export function pathMidpoint(points: Point[]): Point {
  let remaining = 0;
  for (let i = 1; i < points.length; i += 1) {
    remaining += distance(points[i - 1] as Point, points[i] as Point);
  }
  remaining /= 2;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const length = distance(a, b);
    if (remaining <= length) return towards(a, b, remaining);
    remaining -= length;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/** The states with `hidden` cascaded: into a hidden group's contents and onto every edge touching a hidden element. */
export function effectiveStates(
  d: Diagram,
  states: Record<string, ElementState>,
): Record<string, ElementState> {
  const result = { ...states };
  const parentOf = new Map<string, string | undefined>();
  for (const group of d.groups ?? []) parentOf.set(group.id, group.parent);
  for (const node of d.nodes) parentOf.set(node.id, node.group);

  const isHidden = (id: string | undefined): boolean =>
    id !== undefined && (states[id] === 'hidden' || isHidden(parentOf.get(id)));

  for (const id of parentOf.keys()) if (isHidden(id)) result[id] = 'hidden';
  for (const edge of d.edges ?? []) {
    if (states[edge.id] === 'hidden' || isHidden(edge.from) || isHidden(edge.to)) {
      result[edge.id] = 'hidden';
    }
  }
  return result;
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

function scenarioOf(d: Diagram, id: string): DiagramScenario | undefined {
  return d.scenarios.find((scenario) => scenario.id === id);
}

/** What the view draws for a compiled diagram at a player view. */
export function toFlowModel(g: CompiledDiagram, view: PlayerView): FlowModel {
  const states = effectiveStates(g.diagram, view.states);
  const stateOf = (id: string): ElementState => states[id] ?? 'normal';
  const boxes = absoluteBoxes(g);
  const isTarget = (kind: 'node' | 'group', id: string): boolean =>
    view.target?.kind === kind && view.target.id === id;

  const earlier = scenarioOf(g.diagram, view.scenario.id)?.steps.slice(0, Math.max(view.index, 0));
  const doneEdges = new Set((earlier ?? []).map((step) => step.edge));

  return {
    width: g.width,
    height: g.height,
    groups: g.groups.map((group) => ({
      id: group.id,
      ...(group.parent === undefined ? {} : { parentId: group.parent }),
      x: group.x,
      y: group.y,
      width: group.width,
      height: group.height,
      label: group.label,
      kind: group.kind,
      depth: group.depth,
      state: stateOf(group.id),
      active: isTarget('group', group.id),
    })),
    nodes: g.nodes.map((node) => ({
      id: node.id,
      ...(node.parent === undefined ? {} : { parentId: node.parent }),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      label: node.label,
      ...(node.sub === undefined ? {} : { sub: node.sub }),
      icon: node.icon,
      state: stateOf(node.id),
      active: isTarget('node', node.id),
    })),
    edges: g.edges.map((edge) => {
      const active = view.target?.kind === 'edge' && view.target.id === edge.id;
      const from = boxes[edge.from] as Box;
      const to = boxes[edge.to] as Box;
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        ...(edge.label === undefined ? {} : { label: edge.label }),
        points: edge.points ?? directLine(from, to),
        status: active ? 'active' : doneEdges.has(edge.id) ? 'done' : 'idle',
        state: stateOf(edge.id),
        ...(active && view.packet !== undefined
          ? {
              packet: {
                ...(view.packet.label === undefined ? {} : { label: view.packet.label }),
                reverse: view.packet.reverse,
                run: view.run,
              },
            }
          : {}),
      };
    }),
  };
}

export interface LogLine {
  n: number;
  total: number;
  route: string;
  detail?: string;
}

function logLine(d: Diagram, step: DiagramStep, n: number, total: number): LogLine {
  if (step.edge !== undefined) {
    const edge = d.edges?.find((candidate) => candidate.id === step.edge);
    const [from, to] = [edge?.from ?? step.edge, edge?.to ?? step.edge];
    const detail = step.packet ?? edge?.label;
    return {
      n,
      total,
      route: step.reverse === true ? `${to} → ${from}` : `${from} → ${to}`,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  const states = Object.entries(step.state ?? {})
    .map(([id, state]) => `${id} ${state}`)
    .join(', ');
  return {
    n,
    total,
    route: step.node ?? step.group ?? '',
    ...(states === '' ? {} : { detail: states }),
  };
}

/** One log line per step 0 … step of a scenario; none before the first step. */
export function logLines(d: Diagram, scenarioId: string, step: number): LogLine[] {
  const steps = scenarioOf(d, scenarioId)?.steps ?? [];
  return steps
    .slice(0, step + 1)
    .map((current, index) => logLine(d, current, index + 1, steps.length));
}

export interface FallbackScenario {
  id: string;
  label: string;
  steps: { caption: string; metrics?: string }[];
}

/** The scenarios as plain text: captions with their metrics as `key: value` pairs. */
export function textFallback(d: Diagram): FallbackScenario[] {
  return d.scenarios.map((scenario) => ({
    id: scenario.id,
    label: scenario.label,
    steps: scenario.steps.map((step) => ({
      caption: step.caption,
      ...(step.metrics === undefined
        ? {}
        : {
            metrics: Object.entries(step.metrics)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(', '),
          }),
    })),
  }));
}

export interface StructureItem {
  text: string;
  children: StructureItem[];
}

export interface DiagramStructure {
  elements: StructureItem[];
  connections: string[];
}

/** Interface stub (spec 012, review round 2): no names yet. */
export const GROUP_KIND_NAMES = Object.freeze({}) as Readonly<Record<GroupKind, string>>;

/* eslint-disable @typescript-eslint/no-unused-vars -- interface stubs: the implementation comes after the tests */
export function textStructure(d: Diagram): DiagramStructure {
  throw new Error('not implemented');
}

export function displayState(kind: 'group' | 'node' | 'edge', state: ElementState): ElementState {
  throw new Error('not implemented');
}
