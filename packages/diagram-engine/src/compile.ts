// Layout compiler (spec 010): turns a valid diagram into a laid-out graph. Build-time only.
import type { Diagram, DiagramEdge, DiagramGroup, DiagramNode } from '@field-guide/schema';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type {
  Box,
  CompiledDiagram,
  CompiledEdge,
  CompiledGroup,
  CompiledNode,
  LayoutDirection,
  Point,
} from './graph.ts';

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

type Settings = Required<CompileOptions>;

/** Float noise from the layout is not growth. */
const GROW_EPSILON = 1e-6;

export const COMPILE_DEFAULTS: Readonly<Settings> = Object.freeze({
  direction: 'right',
  nodeWidth: 136,
  nodeHeight: 104,
  groupPadding: 24,
  groupHeader: 32,
  nodeSpacing: 48,
  layerSpacing: 72,
});

/** The diagram's containment tree: children of each group (undefined = top level). */
interface Tree {
  groups: Map<string | undefined, DiagramGroup[]>;
  nodes: Map<string | undefined, DiagramNode[]>;
}

interface LaidOut {
  boxes: Map<string, Box>;
  routes: Map<string, Point[]>;
  width: number;
  height: number;
}

function buildTree(diagram: Diagram): Tree {
  const tree: Tree = { groups: new Map(), nodes: new Map() };
  for (const group of diagram.groups ?? []) {
    tree.groups.set(group.parent, [...(tree.groups.get(group.parent) ?? []), group]);
  }
  for (const node of diagram.nodes) {
    tree.nodes.set(node.group, [...(tree.nodes.get(node.group) ?? []), node]);
  }
  return tree;
}

/** Each container reads its own spacing options, so groups need them too. */
function spacingOptions(settings: Settings): Record<string, string> {
  return {
    'elk.spacing.nodeNode': String(settings.nodeSpacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(settings.layerSpacing),
  };
}

function elkChildren(parent: string | undefined, tree: Tree, settings: Settings): ElkNode[] {
  const groups = (tree.groups.get(parent) ?? []).map((group) => elkGroup(group, tree, settings));
  const nodes = (tree.nodes.get(parent) ?? []).map((node) => ({
    id: node.id,
    width: settings.nodeWidth,
    height: settings.nodeHeight,
  }));
  return [...groups, ...nodes];
}

function elkGroup(group: DiagramGroup, tree: Tree, settings: Settings): ElkNode {
  const { groupPadding: padding, groupHeader: header } = settings;
  const children = elkChildren(group.id, tree, settings);
  if (children.length === 0) {
    return { id: group.id, width: settings.nodeWidth, height: header + 2 * padding };
  }
  return {
    id: group.id,
    layoutOptions: {
      ...spacingOptions(settings),
      'elk.padding': `[top=${String(header + padding)},left=${String(padding)},bottom=${String(padding)},right=${String(padding)}]`,
    },
    children,
  };
}

function elkGraph(diagram: Diagram, tree: Tree, settings: Settings): ElkNode {
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': settings.direction === 'right' ? 'RIGHT' : 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT',
      'elk.json.shapeCoords': 'PARENT',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      ...spacingOptions(settings),
    },
    children: elkChildren(undefined, tree, settings),
    edges: (diagram.edges ?? []).map((edge) => ({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };
}

function collectBoxes(node: ElkNode, boxes: Map<string, Box>): void {
  for (const child of node.children ?? []) {
    boxes.set(child.id, {
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 0,
      height: child.height ?? 0,
    });
    collectBoxes(child, boxes);
  }
}

function collectRoutes(root: ElkNode): Map<string, Point[]> {
  const routes = new Map<string, Point[]>();
  for (const edge of root.edges ?? []) {
    const section = edge.sections?.[0];
    if (section === undefined) continue;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    routes.set(
      edge.id,
      points.map(({ x, y }) => ({ x, y })),
    );
  }
  return routes;
}

async function layout(diagram: Diagram, tree: Tree, settings: Settings): Promise<LaidOut> {
  const root = await new ELK().layout(elkGraph(diagram, tree, settings));
  const boxes = new Map<string, Box>();
  collectBoxes(root, boxes);
  return {
    boxes,
    routes: collectRoutes(root),
    width: root.width ?? 0,
    height: root.height ?? 0,
  };
}

function boxOf(boxes: Map<string, Box>, id: string): Box {
  const box = boxes.get(id);
  if (box === undefined) throw new Error(`layout returned no box for '${id}'`);
  return box;
}

/** Groups parents before children, siblings in source order. */
function buildGroups(tree: Tree, boxes: Map<string, Box>): CompiledGroup[] {
  const groups: CompiledGroup[] = [];
  const visit = (parent: string | undefined, depth: number): void => {
    for (const group of tree.groups.get(parent) ?? []) {
      groups.push({
        id: group.id,
        label: group.label,
        kind: group.kind,
        ...(parent === undefined ? {} : { parent }),
        depth,
        grown: false,
        ...boxOf(boxes, group.id),
      });
      visit(group.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return groups;
}

function buildNode(node: DiagramNode, boxes: Map<string, Box>, settings: Settings): CompiledNode {
  const { groupPadding: padding, groupHeader: header } = settings;
  const inGroup = node.group !== undefined;
  const { x, y } =
    node.pos === undefined
      ? boxOf(boxes, node.id)
      : {
          x: Math.max(node.pos.x, inGroup ? padding : 0),
          y: Math.max(node.pos.y, inGroup ? header + padding : 0),
        };
  return {
    id: node.id,
    icon: node.icon,
    label: node.label,
    ...(node.sub === undefined ? {} : { sub: node.sub }),
    ...(node.group === undefined ? {} : { parent: node.group }),
    overridden: node.pos !== undefined,
    x,
    y,
    width: settings.nodeWidth,
    height: settings.nodeHeight,
  };
}

/** Ids of the groups enclosing an overridden node. */
function overriddenAncestors(groups: CompiledGroup[], nodes: CompiledNode[]): Set<string> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ancestors = new Set<string>();
  for (const node of nodes) {
    if (!node.overridden) continue;
    for (let id = node.parent; id !== undefined; id = byId.get(id)?.parent) ancestors.add(id);
  }
  return ancestors;
}

/** Grows those groups to the right and down until they contain their children, children first. */
function growGroups(groups: CompiledGroup[], nodes: CompiledNode[], padding: number): void {
  const ancestors = overriddenAncestors(groups, nodes);
  for (const group of [...groups].reverse()) {
    if (!ancestors.has(group.id)) continue;
    const children = [...groups, ...nodes].filter((child) => child.parent === group.id);
    const width = Math.max(...children.map((child) => child.x + child.width)) + padding;
    const height = Math.max(...children.map((child) => child.y + child.height)) + padding;
    if (width > group.width + GROW_EPSILON || height > group.height + GROW_EPSILON) {
      group.width = Math.max(group.width, width);
      group.height = Math.max(group.height, height);
      group.grown = true;
    }
  }
}

function buildEdge(
  edge: DiagramEdge,
  routes: Map<string, Point[]>,
  moved: Set<string>,
): CompiledEdge {
  const points = moved.has(edge.from) || moved.has(edge.to) ? undefined : routes.get(edge.id);
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...(edge.label === undefined ? {} : { label: edge.label }),
    ...(points === undefined ? {} : { points }),
  };
}

export async function compile(
  diagram: Diagram,
  options: CompileOptions = {},
): Promise<CompiledDiagram> {
  const given = Object.entries(options).filter(([, value]) => value !== undefined);
  const settings: Settings = { ...COMPILE_DEFAULTS, ...Object.fromEntries(given) };
  const tree = buildTree(diagram);
  const laidOut = await layout(diagram, tree, settings);

  const groups = buildGroups(tree, laidOut.boxes);
  const nodes = diagram.nodes.map((node) => buildNode(node, laidOut.boxes, settings));
  growGroups(groups, nodes, settings.groupPadding);

  const moved = new Set(
    [...groups.filter((group) => group.grown), ...nodes.filter((node) => node.overridden)].map(
      (element) => element.id,
    ),
  );
  const topLevel = [...groups, ...nodes].filter((element) => element.parent === undefined);
  return {
    diagram,
    direction: settings.direction,
    width: Math.max(laidOut.width, ...topLevel.map((element) => element.x + element.width)),
    height: Math.max(laidOut.height, ...topLevel.map((element) => element.y + element.height)),
    groups,
    nodes,
    edges: (diagram.edges ?? []).map((edge) => buildEdge(edge, laidOut.routes, moved)),
  };
}
