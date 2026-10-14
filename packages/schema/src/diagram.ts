// Diagram schema: one zod schema for animated-diagram specs, shared by CI, the compiler and the player.
import { z } from 'zod';

export const GROUP_KINDS = [
  'cloud',
  'account',
  'region',
  'az',
  'vpc',
  'public-subnet',
  'private-subnet',
  'auto-scaling-group',
  'security-group',
  'on-premises',
  'generic',
] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const ELEMENT_STATES = [
  'normal',
  'highlighted',
  'appearing',
  'hidden',
  'failed',
  'broken',
] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export interface DiagramGroup {
  id: string;
  label: string;
  kind: GroupKind;
  parent?: string;
}

export interface DiagramNode {
  id: string;
  icon: string;
  label: string;
  sub?: string;
  group?: string;
  pos?: { x: number; y: number };
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface DiagramStep {
  edge?: string;
  node?: string;
  group?: string;
  reverse?: boolean;
  packet?: string;
  caption: string;
  state?: Record<string, ElementState>;
  metrics?: Record<string, string | number>;
}

export interface DiagramScenario {
  id: string;
  label: string;
  initial?: Record<string, ElementState>;
  steps: DiagramStep[];
}

export interface Diagram {
  id: string;
  title: string;
  description?: string;
  groups?: DiagramGroup[];
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  scenarios: DiagramScenario[];
}

export type DiagramValidationResult =
  { ok: true; diagram: Diagram } | { ok: false; errors: string[] };

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_CAPTION_LENGTH = 300;
const MAX_METRICS = 3;

/** A string with at least one non-whitespace character. */
const nonEmpty = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be empty or blank',
});

const slug = z.string().regex(SLUG_PATTERN, 'must be a lowercase slug');
const elementState = z.enum(ELEMENT_STATES);

/** z.record silently drops an own `__proto__` key, so it is rejected on the raw input first. */
const noProtoKey = z
  .unknown()
  .refine(
    (value) => typeof value !== 'object' || value === null || !Object.hasOwn(value, '__proto__'),
    {
      message: "unknown key '__proto__'",
    },
  );

const stateMap = noProtoKey.pipe(z.record(z.string(), elementState));

const groupSchema = z.strictObject({
  id: slug,
  label: nonEmpty,
  kind: z.enum(GROUP_KINDS),
  parent: z.string().exactOptional(),
});

const nodeSchema = z.strictObject({
  id: slug,
  icon: slug,
  label: nonEmpty,
  sub: nonEmpty.exactOptional(),
  group: z.string().exactOptional(),
  pos: z.strictObject({ x: z.number(), y: z.number() }).exactOptional(),
});

const edgeSchema = z.strictObject({
  id: slug,
  from: z.string(),
  to: z.string(),
  label: nonEmpty.exactOptional(),
});

const metricsSchema = noProtoKey
  .pipe(z.record(nonEmpty, z.union([nonEmpty, z.number()])))
  .refine(
    (metrics) => Object.keys(metrics).length >= 1 && Object.keys(metrics).length <= MAX_METRICS,
    {
      message: `must have 1 to ${String(MAX_METRICS)} entries`,
    },
  );

const stepSchema = z.strictObject({
  edge: z.string().exactOptional(),
  node: z.string().exactOptional(),
  group: z.string().exactOptional(),
  reverse: z.boolean().exactOptional(),
  packet: nonEmpty.exactOptional(),
  caption: nonEmpty.max(MAX_CAPTION_LENGTH),
  state: stateMap.exactOptional(),
  metrics: metricsSchema.exactOptional(),
});

const scenarioSchema = z.strictObject({
  id: slug,
  label: nonEmpty,
  initial: stateMap.exactOptional(),
  steps: z.array(stepSchema).min(1),
});

type Ctx = z.RefinementCtx;
type Path = (string | number)[];
type ElementKind = 'group' | 'node' | 'edge';
type ElementKinds = Map<string, ElementKind>;

function fail(ctx: Ctx, path: Path, message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

/** Groups, nodes and edges share one id namespace; a repeated id is reported where it repeats. */
function collectElementKinds(diagram: Diagram, ctx: Ctx): ElementKinds {
  const kinds: ElementKinds = new Map();
  const collections: [ElementKind, string, { id: string }[]][] = [
    ['group', 'groups', diagram.groups ?? []],
    ['node', 'nodes', diagram.nodes],
    ['edge', 'edges', diagram.edges ?? []],
  ];
  for (const [kind, field, items] of collections) {
    items.forEach(({ id }, index) => {
      if (kinds.has(id)) fail(ctx, [field, index, 'id'], `duplicate id '${id}'`);
      else kinds.set(id, kind);
    });
  }
  return kinds;
}

function checkScenarioIds(scenarios: DiagramScenario[], ctx: Ctx): void {
  const seen = new Set<string>();
  scenarios.forEach(({ id }, index) => {
    if (seen.has(id)) fail(ctx, ['scenarios', index, 'id'], `duplicate scenario id '${id}'`);
    seen.add(id);
  });
}

/** True when following the parents from `start` leads back to `start`. */
function isInParentCycle(start: string, parents: Map<string, string | undefined>): boolean {
  const seen = new Set<string>();
  let current = parents.get(start);
  while (current !== undefined && !seen.has(current)) {
    if (current === start) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

function checkGroups(groups: DiagramGroup[], kinds: ElementKinds, ctx: Ctx): void {
  const parents = new Map(groups.map((group) => [group.id, group.parent]));
  groups.forEach((group, index) => {
    if (group.parent !== undefined && kinds.get(group.parent) !== 'group') {
      fail(ctx, ['groups', index, 'parent'], `unknown group '${group.parent}'`);
    } else if (isInParentCycle(group.id, parents)) {
      fail(ctx, ['groups', index, 'parent'], `group '${group.id}' is its own ancestor`);
    }
  });
}

function checkNodeGroups(nodes: DiagramNode[], kinds: ElementKinds, ctx: Ctx): void {
  nodes.forEach((node, index) => {
    if (node.group !== undefined && kinds.get(node.group) !== 'group') {
      fail(ctx, ['nodes', index, 'group'], `unknown group '${node.group}'`);
    }
  });
}

function checkEdges(edges: DiagramEdge[], kinds: ElementKinds, ctx: Ctx): void {
  edges.forEach((edge, index) => {
    for (const end of ['from', 'to'] as const) {
      const kind = kinds.get(edge[end]);
      if (kind !== 'node' && kind !== 'group') {
        fail(ctx, ['edges', index, end], `unknown node or group '${edge[end]}'`);
      }
    }
    if (edge.from === edge.to) fail(ctx, ['edges', index], 'from and to must differ');
  });
}

/** Keys of a `state` or `initial` map must be element ids. */
function checkStateKeys(
  state: Record<string, ElementState> | undefined,
  kinds: ElementKinds,
  path: Path,
  ctx: Ctx,
): void {
  for (const key of Object.keys(state ?? {})) {
    if (!kinds.has(key)) fail(ctx, [...path, key], `unknown element '${key}'`);
  }
}

/** A step names exactly one existing element of its kind; reverse and packet need an edge. */
function checkStepTarget(step: DiagramStep, kinds: ElementKinds, path: Path, ctx: Ctx): void {
  const targets = (['edge', 'node', 'group'] as const).flatMap((kind) => {
    const id = step[kind];
    return id === undefined ? [] : [{ kind, id }];
  });
  const [target] = targets;
  if (target === undefined || targets.length > 1) {
    fail(ctx, path, 'a step needs exactly one of edge, node or group');
  } else if (kinds.get(target.id) !== target.kind) {
    fail(ctx, [...path, target.kind], `unknown ${target.kind} '${target.id}'`);
  }
  if (step.edge === undefined) {
    for (const field of ['reverse', 'packet'] as const) {
      if (step[field] !== undefined) fail(ctx, [...path, field], `${field} is only for edge steps`);
    }
  }
}

function checkScenarios(scenarios: DiagramScenario[], kinds: ElementKinds, ctx: Ctx): void {
  scenarios.forEach((scenario, scenarioIndex) => {
    const path = ['scenarios', scenarioIndex];
    checkStateKeys(scenario.initial, kinds, [...path, 'initial'], ctx);
    scenario.steps.forEach((step, stepIndex) => {
      const stepPath = [...path, 'steps', stepIndex];
      checkStepTarget(step, kinds, stepPath, ctx);
      checkStateKeys(step.state, kinds, [...stepPath, 'state'], ctx);
    });
  });
}

function checkDiagram(diagram: Diagram, ctx: Ctx): void {
  const kinds = collectElementKinds(diagram, ctx);
  checkScenarioIds(diagram.scenarios, ctx);
  checkGroups(diagram.groups ?? [], kinds, ctx);
  checkNodeGroups(diagram.nodes, kinds, ctx);
  checkEdges(diagram.edges ?? [], kinds, ctx);
  checkScenarios(diagram.scenarios, kinds, ctx);
}

export const diagramSchema: z.ZodType<Diagram> = z
  .strictObject({
    id: slug,
    title: nonEmpty,
    description: nonEmpty.exactOptional(),
    groups: z.array(groupSchema).exactOptional(),
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(edgeSchema).exactOptional(),
    scenarios: z.array(scenarioSchema).min(1),
  })
  .superRefine(checkDiagram);

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

export function validateDiagram(data: unknown): DiagramValidationResult {
  const result = diagramSchema.safeParse(data);
  if (result.success) return { ok: true, diagram: result.data };
  return { ok: false, errors: result.error.issues.map(formatIssue) };
}
