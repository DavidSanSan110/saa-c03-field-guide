import { readFileSync } from 'node:fs';
import { validateDiagram } from '@field-guide/schema';
import type { Diagram, DiagramScenario } from '@field-guide/schema';
import { describe, expect, test, vi } from 'vitest';
import { COMPILE_DEFAULTS, compile } from './compile.ts';
import type { CompileOptions } from './compile.ts';
import type {
  Box,
  CompiledDiagram,
  CompiledEdge,
  CompiledGroup,
  CompiledNode,
  LayoutDirection,
  Point,
} from './graph.ts';
import * as engineRoot from './index.ts';

// elkjs loads lazily on the first compile and can take a while on a cold machine.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenarioFor(nodeId: string): DiagramScenario[] {
  return [{ id: 'main', label: 'Main flow', steps: [{ node: nodeId, caption: 'Look here' }] }];
}

/** The PLAN.md 3.2 example: one group, four nodes, three edges, one scenario. */
function exampleDiagram(): Diagram {
  return {
    id: 's3-sse-kms-upload',
    title: 'S3 upload with SSE-KMS',
    groups: [{ id: 'region', label: 'eu-west-1', kind: 'region' }],
    nodes: [
      { id: 'client', icon: 'user', label: 'Client' },
      { id: 's3', icon: 'simple-storage-service', label: 'S3 bucket', group: 'region' },
      { id: 'kms', icon: 'key-management-service', label: 'KMS key', group: 'region' },
      { id: 'trail', icon: 'cloudtrail', label: 'CloudTrail', group: 'region' },
    ],
    edges: [
      { id: 'put', from: 'client', to: 's3' },
      { id: 'gen', from: 's3', to: 'kms' },
      { id: 'audit', from: 'kms', to: 'trail' },
    ],
    scenarios: [
      {
        id: 'upload',
        label: 'Upload an object',
        steps: [
          {
            edge: 'put',
            caption: 'PutObject with header x-amz-server-side-encryption: aws:kms',
          },
          {
            edge: 'gen',
            caption: 'S3 calls GenerateDataKey. This counts toward your KMS request quota.',
          },
          {
            edge: 'audit',
            caption: 'Key usage is logged in CloudTrail, which is the audit benefit of SSE-KMS.',
          },
          {
            node: 's3',
            caption:
              'The object is stored encrypted with the data key; the encrypted data key is stored next to it.',
          },
        ],
      },
    ],
  };
}

/**
 * Nested fixture (group › children):
 *   region
 *   ├── gateway (node, directly in the region)
 *   ├── spare (empty group)
 *   └── vpc
 *       ├── az-a
 *       │   ├── public-subnet-a  › alb
 *       │   └── private-subnet-a › web-a
 *       └── az-b
 *           └── private-subnet-b › web-b, db
 *   user (top-level node)
 */
function nestedDiagram(): Diagram {
  return {
    id: 'nested-demo',
    title: 'Nested groups',
    groups: [
      { id: 'region', label: 'eu-west-1', kind: 'region' },
      { id: 'vpc', label: 'VPC', kind: 'vpc', parent: 'region' },
      { id: 'az-a', label: 'AZ a', kind: 'az', parent: 'vpc' },
      { id: 'public-subnet-a', label: 'Public a', kind: 'public-subnet', parent: 'az-a' },
      { id: 'private-subnet-a', label: 'Private a', kind: 'private-subnet', parent: 'az-a' },
      { id: 'az-b', label: 'AZ b', kind: 'az', parent: 'vpc' },
      { id: 'private-subnet-b', label: 'Private b', kind: 'private-subnet', parent: 'az-b' },
      { id: 'spare', label: 'Spare', kind: 'generic', parent: 'region' },
    ],
    nodes: [
      { id: 'user', icon: 'user', label: 'User' },
      { id: 'gateway', icon: 'internet-gateway', label: 'Gateway', group: 'region' },
      { id: 'alb', icon: 'elastic-load-balancing', label: 'ALB', group: 'public-subnet-a' },
      {
        id: 'web-a',
        icon: 'ec2',
        label: 'Web a',
        sub: 'Auto Scaling',
        group: 'private-subnet-a',
      },
      { id: 'web-b', icon: 'ec2', label: 'Web b', group: 'private-subnet-b' },
      { id: 'db', icon: 'rds', label: 'Database', sub: 'Multi-AZ', group: 'private-subnet-b' },
    ],
    edges: [
      { id: 'e-user-alb', from: 'user', to: 'alb', label: 'HTTPS' },
      { id: 'e-alb-web-a', from: 'alb', to: 'web-a' },
      { id: 'e-alb-web-b', from: 'alb', to: 'web-b', label: 'HTTP' },
      { id: 'e-web-b-db', from: 'web-b', to: 'db' },
      { id: 'e-gateway-vpc', from: 'gateway', to: 'vpc' },
      { id: 'e-web-a-subnet', from: 'web-a', to: 'private-subnet-a' },
    ],
    scenarios: scenarioFor('user'),
  };
}

/** A chain a → b → c with no groups. */
function chainDiagram(): Diagram {
  return {
    id: 'chain-demo',
    title: 'Chain',
    nodes: [
      { id: 'a', icon: 'user', label: 'A' },
      { id: 'b', icon: 'ec2', label: 'B' },
      { id: 'c', icon: 'rds', label: 'C' },
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'bc', from: 'b', to: 'c' },
    ],
    scenarios: scenarioFor('a'),
  };
}

/** Same diagram with `pos` set on the given nodes. */
function withPos(diagram: Diagram, positions: Record<string, { x: number; y: number }>): Diagram {
  return {
    ...diagram,
    nodes: diagram.nodes.map((node) => {
      const pos = positions[node.id];
      return pos === undefined ? node : { ...node, pos };
    }),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOL = 0.5;
const BORDER_TOL = 1;
const DIRECTIONS: LayoutDirection[] = ['right', 'down'];
const ALL_GROUP_IDS = [
  'region',
  'vpc',
  'az-a',
  'public-subnet-a',
  'private-subnet-a',
  'az-b',
  'private-subnet-b',
  'spare',
];

const cache = new Map<string, Promise<CompiledDiagram>>();

/** Compiles once per (diagram, options) pair; the tests never mutate the result. */
function compiled(diagram: Diagram, options?: CompileOptions): Promise<CompiledDiagram> {
  const key = JSON.stringify([diagram, options ?? null]);
  let result = cache.get(key);
  if (result === undefined) {
    result = compile(diagram, options);
    cache.set(key, result);
  }
  return result;
}

type Element = CompiledGroup | CompiledNode;

function elementsById(result: CompiledDiagram): Map<string, Element> {
  const byId = new Map<string, Element>();
  for (const element of [...result.groups, ...result.nodes]) byId.set(element.id, element);
  return byId;
}

function getNode(result: CompiledDiagram, id: string): CompiledNode {
  const node = result.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no compiled node '${id}'`);
  return node;
}

function getGroup(result: CompiledDiagram, id: string): CompiledGroup {
  const group = result.groups.find((candidate) => candidate.id === id);
  if (group === undefined) throw new Error(`no compiled group '${id}'`);
  return group;
}

function getEdge(result: CompiledDiagram, id: string): CompiledEdge {
  const edge = result.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) throw new Error(`no compiled edge '${id}'`);
  return edge;
}

function boxOf(element: Box): Box {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

/** The element's box in canvas coordinates (parent chain added up). */
function absoluteBox(result: CompiledDiagram, id: string): Box {
  const byId = elementsById(result);
  const start = byId.get(id);
  if (start === undefined) throw new Error(`no compiled element '${id}'`);
  let x = start.x;
  let y = start.y;
  let current: Element = start;
  while (current.parent !== undefined) {
    const parent = byId.get(current.parent);
    if (parent === undefined) throw new Error(`unknown parent '${current.parent}'`);
    x += parent.x;
    y += parent.y;
    current = parent;
  }
  return { x, y, width: start.width, height: start.height };
}

/** Children that don't respect the padding rules inside their parent's box (parent frame). */
function containmentViolations(result: CompiledDiagram, padding: number, header: number): string[] {
  const byId = elementsById(result);
  const violations: string[] = [];
  for (const child of [...result.groups, ...result.nodes]) {
    if (child.parent === undefined) continue;
    const parent = byId.get(child.parent);
    if (parent === undefined) {
      violations.push(`${child.id}: unknown parent '${child.parent}'`);
      continue;
    }
    if (child.x < padding - TOL)
      violations.push(`${child.id}: x ${String(child.x)} < ${String(padding)}`);
    if (child.y < header + padding - TOL) {
      violations.push(`${child.id}: y ${String(child.y)} < ${String(header + padding)}`);
    }
    if (child.x + child.width > parent.width - padding + TOL) {
      violations.push(`${child.id}: right edge exceeds ${parent.id} minus padding`);
    }
    if (child.y + child.height > parent.height - padding + TOL) {
      violations.push(`${child.id}: bottom edge exceeds ${parent.id} minus padding`);
    }
  }
  return violations;
}

function overlap(a: Box, b: Box): boolean {
  return (
    a.x + a.width - TOL > b.x &&
    b.x + b.width - TOL > a.x &&
    a.y + a.height - TOL > b.y &&
    b.y + b.height - TOL > a.y
  );
}

/** Pairs of siblings (same parent, nodes and groups together; '' = top level) that overlap. */
function siblingOverlaps(result: CompiledDiagram): string[] {
  const families = new Map<string, Element[]>();
  for (const element of [...result.groups, ...result.nodes]) {
    const key = element.parent ?? '';
    families.set(key, [...(families.get(key) ?? []), element]);
  }
  const overlaps: string[] = [];
  for (const [key, siblings] of families) {
    siblings.forEach((a, index) => {
      for (const b of siblings.slice(index + 1)) {
        if (overlap(a, b)) overlaps.push(`${a.id} / ${b.id} (in '${key}')`);
      }
    });
  }
  return overlaps;
}

function isOnBorder(point: Point, box: Box): boolean {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const within =
    point.x >= box.x - BORDER_TOL &&
    point.x <= right + BORDER_TOL &&
    point.y >= box.y - BORDER_TOL &&
    point.y <= bottom + BORDER_TOL;
  const touches =
    Math.abs(point.x - box.x) <= BORDER_TOL ||
    Math.abs(point.x - right) <= BORDER_TOL ||
    Math.abs(point.y - box.y) <= BORDER_TOL ||
    Math.abs(point.y - bottom) <= BORDER_TOL;
  return within && touches;
}

/** What is wrong with an edge's route (empty when it is a valid orthogonal border-to-border route). */
function routeProblems(result: CompiledDiagram, edge: CompiledEdge): string[] {
  const { points } = edge;
  if (points === undefined) return [`${edge.id}: no points`];
  if (points.length < 2) return [`${edge.id}: fewer than 2 points`];
  const problems: string[] = [];
  points.slice(1).forEach((point, index) => {
    const previous = points[index];
    if (previous === undefined) return;
    if (Math.abs(point.x - previous.x) > TOL && Math.abs(point.y - previous.y) > TOL) {
      problems.push(`${edge.id}: segment ${String(index)} is not orthogonal`);
    }
  });
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return problems;
  if (!isOnBorder(first, absoluteBox(result, edge.from))) {
    problems.push(`${edge.id}: first point is not on the border of '${edge.from}'`);
  }
  if (!isOnBorder(last, absoluteBox(result, edge.to))) {
    problems.push(`${edge.id}: last point is not on the border of '${edge.to}'`);
  }
  return problems;
}

/** Boxes (absolute) and edge points that stick out of [0, width] x [0, height]. */
function canvasViolations(result: CompiledDiagram): string[] {
  const violations: string[] = [];
  for (const element of [...result.groups, ...result.nodes]) {
    const box = absoluteBox(result, element.id);
    if (
      box.x < -TOL ||
      box.y < -TOL ||
      box.x + box.width > result.width + TOL ||
      box.y + box.height > result.height + TOL
    ) {
      violations.push(`${element.id} is outside the canvas`);
    }
  }
  for (const edge of result.edges) {
    for (const point of edge.points ?? []) {
      if (
        point.x < -TOL ||
        point.y < -TOL ||
        point.x > result.width + TOL ||
        point.y > result.height + TOL
      ) {
        violations.push(
          `${edge.id}: point (${String(point.x)}, ${String(point.y)}) is outside the canvas`,
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('fixtures are valid diagrams', () => {
  for (const diagram of [exampleDiagram(), nestedDiagram(), chainDiagram()]) {
    expect(validateDiagram(diagram)).toEqual({ ok: true, diagram });
  }
});

describe('AC-1: the PLAN.md example compiles to a graph that lists the diagram', () => {
  test('AC-1: the input diagram comes back deep-equal and the direction is right', async () => {
    const input = exampleDiagram();
    const result = await compile(input);
    expect(result.diagram).toEqual(exampleDiagram());
    expect(result.direction).toBe('right');
  });

  test('AC-1: groups, nodes and edges list exactly the diagram ids in source order', async () => {
    const result = await compiled(exampleDiagram());
    expect(result.groups.map((group) => group.id)).toEqual(['region']);
    expect(result.nodes.map((node) => node.id)).toEqual(['client', 's3', 'kms', 'trail']);
    expect(result.edges.map((edge) => edge.id)).toEqual(['put', 'gen', 'audit']);
  });

  test('AC-1: nodes and groups carry their label, icon and kind from the input', async () => {
    const input = exampleDiagram();
    const result = await compiled(input);
    expect(result.nodes.map(({ id, icon, label, sub }) => ({ id, icon, label, sub }))).toEqual(
      input.nodes.map(({ id, icon, label, sub }) => ({ id, icon, label, sub })),
    );
    expect(result.groups.map(({ id, label, kind }) => ({ id, label, kind }))).toEqual([
      { id: 'region', label: 'eu-west-1', kind: 'region' },
    ]);
  });

  test('AC-1: edges carry their from and to', async () => {
    const result = await compiled(exampleDiagram());
    expect(result.edges.map(({ id, from, to }) => ({ id, from, to }))).toEqual([
      { id: 'put', from: 'client', to: 's3' },
      { id: 'gen', from: 's3', to: 'kms' },
      { id: 'audit', from: 'kms', to: 'trail' },
    ]);
  });

  test('AC-1: sub on nodes and label on edges are carried over', async () => {
    const result = await compiled(nestedDiagram());
    expect(getNode(result, 'web-a').sub).toBe('Auto Scaling');
    expect(getNode(result, 'db').sub).toBe('Multi-AZ');
    expect(getEdge(result, 'e-user-alb').label).toBe('HTTPS');
    expect(getEdge(result, 'e-alb-web-b').label).toBe('HTTP');
  });

  test('AC-1: nodes and edges keep source order in a larger diagram', async () => {
    const input = nestedDiagram();
    const result = await compiled(input);
    expect(result.nodes.map((node) => node.id)).toEqual(input.nodes.map((node) => node.id));
    expect(result.edges.map((edge) => edge.id)).toEqual(input.edges?.map((edge) => edge.id));
  });
});

describe('AC-2: node sizes and defaults', () => {
  test('AC-2: COMPILE_DEFAULTS has the documented values', () => {
    expect(COMPILE_DEFAULTS).toEqual({
      direction: 'right',
      nodeWidth: 136,
      nodeHeight: 104,
      groupPadding: 24,
      groupHeader: 32,
      nodeSpacing: 48,
      layerSpacing: 72,
    });
  });

  test('AC-2: with default options every node is 136 x 104', async () => {
    const result = await compiled(nestedDiagram());
    expect(result.nodes).toHaveLength(6);
    for (const node of result.nodes) {
      expect([node.id, node.width, node.height]).toEqual([node.id, 136, 104]);
    }
  });

  test('AC-2: with nodeWidth 100 and nodeHeight 60 every node is 100 x 60', async () => {
    const result = await compiled(nestedDiagram(), { nodeWidth: 100, nodeHeight: 60 });
    expect(result.nodes).toHaveLength(6);
    for (const node of result.nodes) {
      expect([node.id, node.width, node.height]).toEqual([node.id, 100, 60]);
    }
  });
});

describe('AC-3: parent, depth and group order in the nested fixture', () => {
  test('AC-3: every node has parent equal to its group, absent at the top level', async () => {
    const input = nestedDiagram();
    const result = await compiled(input);
    for (const source of input.nodes) {
      const node = getNode(result, source.id);
      if (source.group === undefined) expect(node, source.id).not.toHaveProperty('parent');
      else expect([node.id, node.parent]).toEqual([source.id, source.group]);
    }
  });

  test('AC-3: every group has parent equal to its parent, absent at the top level', async () => {
    const input = nestedDiagram();
    const result = await compiled(input);
    for (const source of input.groups ?? []) {
      const group = getGroup(result, source.id);
      if (source.parent === undefined) expect(group, source.id).not.toHaveProperty('parent');
      else expect([group.id, group.parent]).toEqual([source.id, source.parent]);
    }
  });

  test('AC-3: depth counts the enclosing groups', async () => {
    const result = await compiled(nestedDiagram());
    const depths = Object.fromEntries(result.groups.map((group) => [group.id, group.depth]));
    expect(depths).toEqual({
      region: 0,
      vpc: 1,
      spare: 1,
      'az-a': 2,
      'az-b': 2,
      'public-subnet-a': 3,
      'private-subnet-a': 3,
      'private-subnet-b': 3,
    });
  });

  test('AC-3: groups lists every parent before its children', async () => {
    const result = await compiled(nestedDiagram());
    expect(result.groups.map((group) => group.id).sort()).toEqual([...ALL_GROUP_IDS].sort());
    const order = result.groups.map((group) => group.id);
    for (const group of result.groups) {
      if (group.parent === undefined) continue;
      expect(order.indexOf(group.parent), `${group.parent} before ${group.id}`).toBeLessThan(
        order.indexOf(group.id),
      );
    }
  });

  test('AC-3: parents come first even when the source declares a child before its parent', async () => {
    const input: Diagram = {
      ...nestedDiagram(),
      groups: [
        { id: 'private-subnet-b', label: 'Private b', kind: 'private-subnet', parent: 'az-b' },
        { id: 'az-b', label: 'AZ b', kind: 'az', parent: 'vpc' },
        { id: 'vpc', label: 'VPC', kind: 'vpc', parent: 'region' },
        { id: 'region', label: 'eu-west-1', kind: 'region' },
      ],
      nodes: [{ id: 'web-b', icon: 'ec2', label: 'Web b', group: 'private-subnet-b' }],
      edges: [],
      scenarios: scenarioFor('web-b'),
    };
    const result = await compile(input);
    const order = result.groups.map((group) => group.id);
    expect([...order].sort()).toEqual(['az-b', 'private-subnet-b', 'region', 'vpc']);
    expect(order.indexOf('region')).toBeLessThan(order.indexOf('vpc'));
    expect(order.indexOf('vpc')).toBeLessThan(order.indexOf('az-b'));
    expect(order.indexOf('az-b')).toBeLessThan(order.indexOf('private-subnet-b'));
  });

  test('AC-3: sibling groups keep their source order', async () => {
    const result = await compiled(nestedDiagram());
    const order = result.groups.map((group) => group.id);
    expect(order.indexOf('public-subnet-a')).toBeLessThan(order.indexOf('private-subnet-a'));
    expect(order.indexOf('az-a')).toBeLessThan(order.indexOf('az-b'));
    expect(order.indexOf('vpc')).toBeLessThan(order.indexOf('spare'));
  });
});

describe('AC-4: children lie inside their parent with padding and header', () => {
  test.each(DIRECTIONS)('AC-4: default padding and header hold (%s)', async (direction) => {
    const result = await compiled(nestedDiagram(), { direction });
    expect(containmentViolations(result, 24, 32)).toEqual([]);
  });

  test.each(DIRECTIONS)('AC-4: groupPadding 40 and groupHeader 50 hold (%s)', async (direction) => {
    const result = await compiled(nestedDiagram(), {
      direction,
      groupPadding: 40,
      groupHeader: 50,
    });
    expect(containmentViolations(result, 40, 50)).toEqual([]);
  });

  test('AC-4: the nested fixture has parent boxes to check (guards against an empty pass)', async () => {
    const result = await compiled(nestedDiagram());
    expect(result.groups).toHaveLength(ALL_GROUP_IDS.length);
    expect(result.nodes.filter((node) => node.parent !== undefined)).toHaveLength(5);
  });
});

describe('AC-5: no overlap between siblings', () => {
  test.each(DIRECTIONS)('AC-5: no two siblings overlap (%s)', async (direction) => {
    const result = await compiled(nestedDiagram(), { direction });
    expect(siblingOverlaps(result)).toEqual([]);
  });

  test('AC-5: no two top-level boxes overlap', async () => {
    const result = await compiled(nestedDiagram());
    const topLevel = [...result.groups, ...result.nodes].filter(
      (element) => element.parent === undefined,
    );
    expect(topLevel.map((element) => element.id).sort()).toEqual(['region', 'user']);
    const [a, b] = topLevel;
    expect(a !== undefined && b !== undefined && overlap(a, b)).toBe(false);
  });

  test('AC-5: no sibling overlap with custom sizes and spacing', async () => {
    const result = await compiled(nestedDiagram(), {
      nodeWidth: 90,
      nodeHeight: 70,
      nodeSpacing: 30,
      layerSpacing: 40,
    });
    expect(siblingOverlaps(result)).toEqual([]);
  });
});

describe('AC-6: canvas origin and bounds', () => {
  test.each(DIRECTIONS)('AC-6: the smallest top-level x and y are 0 (%s)', async (direction) => {
    const result = await compiled(nestedDiagram(), { direction });
    const topLevel = [...result.groups, ...result.nodes].filter(
      (element) => element.parent === undefined,
    );
    expect(Math.min(...topLevel.map((element) => element.x))).toBeCloseTo(0, 0);
    expect(Math.min(...topLevel.map((element) => element.y))).toBeCloseTo(0, 0);
    for (const element of topLevel) {
      expect(element.x, element.id).toBeGreaterThanOrEqual(-TOL);
      expect(element.y, element.id).toBeGreaterThanOrEqual(-TOL);
    }
  });

  test.each(DIRECTIONS)(
    'AC-6: every box and edge point lies inside the canvas (%s)',
    async (direction) => {
      const result = await compiled(nestedDiagram(), { direction });
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(canvasViolations(result)).toEqual([]);
    },
  );

  test('AC-6: the PLAN.md example starts at the origin and fits the canvas', async () => {
    const result = await compiled(exampleDiagram());
    const topLevel = [...result.groups, ...result.nodes].filter(
      (element) => element.parent === undefined,
    );
    expect(Math.min(...topLevel.map((element) => element.x))).toBeCloseTo(0, 0);
    expect(Math.min(...topLevel.map((element) => element.y))).toBeCloseTo(0, 0);
    expect(canvasViolations(result)).toEqual([]);
  });
});

describe('AC-7: layout direction', () => {
  test('AC-7: direction right gives strictly increasing x along a chain', async () => {
    const result = await compiled(chainDiagram(), { direction: 'right' });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => getNode(result, id).x);
    expect(a).toBeDefined();
    expect(b).toBeGreaterThan(a ?? Infinity);
    expect(c).toBeGreaterThan(b ?? Infinity);
    expect(result.direction).toBe('right');
  });

  test('AC-7: direction down gives strictly increasing y along a chain', async () => {
    const result = await compiled(chainDiagram(), { direction: 'down' });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => getNode(result, id).y);
    expect(a).toBeDefined();
    expect(b).toBeGreaterThan(a ?? Infinity);
    expect(c).toBeGreaterThan(b ?? Infinity);
    expect(result.direction).toBe('down');
  });

  test('AC-7: without the option the direction is right', async () => {
    const result = await compiled(chainDiagram());
    expect(result.direction).toBe('right');
    expect(getNode(result, 'b').x).toBeGreaterThan(getNode(result, 'a').x);
  });
});

describe('AC-8: orthogonal edge routes on the borders of their ends', () => {
  test.each(DIRECTIONS)(
    'AC-8: every edge of the nested fixture is routed (%s)',
    async (direction) => {
      const result = await compiled(nestedDiagram(), { direction });
      expect(result.edges).toHaveLength(6);
      expect(result.edges.flatMap((edge) => routeProblems(result, edge))).toEqual([]);
    },
  );

  test('AC-8: every edge of the PLAN.md example is routed', async () => {
    const result = await compiled(exampleDiagram());
    expect(result.edges.flatMap((edge) => routeProblems(result, edge))).toEqual([]);
  });

  test('AC-8: an edge between nodes in different groups is routed', async () => {
    const result = await compiled(nestedDiagram());
    expect(routeProblems(result, getEdge(result, 'e-alb-web-b'))).toEqual([]);
    expect(routeProblems(result, getEdge(result, 'e-user-alb'))).toEqual([]);
  });

  test('AC-8: an edge from a node to a group is routed', async () => {
    const result = await compiled(nestedDiagram());
    expect(routeProblems(result, getEdge(result, 'e-gateway-vpc'))).toEqual([]);
  });

  test('AC-8: an edge from a node to its own enclosing group is routed', async () => {
    const result = await compiled(nestedDiagram());
    expect(routeProblems(result, getEdge(result, 'e-web-a-subnet'))).toEqual([]);
  });

  test('AC-8: routes stay valid with custom sizes and spacing', async () => {
    const result = await compiled(nestedDiagram(), {
      nodeWidth: 100,
      nodeHeight: 60,
      groupPadding: 40,
      groupHeader: 50,
    });
    expect(result.edges.flatMap((edge) => routeProblems(result, edge))).toEqual([]);
  });
});

describe('AC-9: pos override inside a subnet', () => {
  const OVERRIDDEN = ['private-subnet-a', 'az-a', 'vpc', 'region'];
  const UNTOUCHED = ['public-subnet-a', 'az-b', 'private-subnet-b', 'spare'];

  async function both(): Promise<{ base: CompiledDiagram; moved: CompiledDiagram }> {
    return {
      base: await compiled(nestedDiagram()),
      moved: await compiled(withPos(nestedDiagram(), { 'web-a': { x: 500, y: 400 } })),
    };
  }

  test('AC-9: the node sits exactly at pos and is overridden', async () => {
    const { moved } = await both();
    const node = getNode(moved, 'web-a');
    expect([node.x, node.y, node.overridden]).toEqual([500, 400, true]);
  });

  test('AC-9: its subnet and every ancestor grow and are marked grown', async () => {
    const { moved } = await both();
    for (const id of OVERRIDDEN) expect([id, getGroup(moved, id).grown]).toEqual([id, true]);
  });

  test('AC-9: the grown groups contain the node with the padding rules', async () => {
    const { moved } = await both();
    expect(containmentViolations(moved, 24, 32)).toEqual([]);
    const subnet = getGroup(moved, 'private-subnet-a');
    expect(subnet.width).toBeGreaterThanOrEqual(500 + 136 + 24 - TOL);
    expect(subnet.height).toBeGreaterThanOrEqual(400 + 104 + 24 - TOL);
  });

  test('AC-9: grown groups never get smaller than before', async () => {
    const { base, moved } = await both();
    for (const id of OVERRIDDEN) {
      const before = getGroup(base, id);
      const after = getGroup(moved, id);
      expect(after.grown, id).toBe(true);
      expect(after.width, id).toBeGreaterThanOrEqual(before.width);
      expect(after.height, id).toBeGreaterThanOrEqual(before.height);
      expect(after.width > before.width || after.height > before.height, id).toBe(true);
    }
  });

  test('AC-9: groups that did not need to grow keep grown false and the same box', async () => {
    const { base, moved } = await both();
    for (const id of UNTOUCHED) {
      expect([id, getGroup(moved, id).grown]).toEqual([id, false]);
      expect([id, boxOf(getGroup(moved, id))]).toEqual([id, boxOf(getGroup(base, id))]);
    }
  });

  test('AC-9: no group x or y changes', async () => {
    const { base, moved } = await both();
    for (const group of base.groups) {
      const after = getGroup(moved, group.id);
      expect([group.id, after.x, after.y]).toEqual([group.id, group.x, group.y]);
    }
  });

  test('AC-9: the canvas still contains everything', async () => {
    const { moved } = await both();
    expect(canvasViolations(moved)).toEqual([]);
  });

  test('AC-9: without any pos nothing is grown or overridden', async () => {
    const base = await compiled(nestedDiagram());
    expect(base.groups.filter((group) => group.grown)).toEqual([]);
    expect(base.nodes.filter((node) => node.overridden)).toEqual([]);
  });

  test('AC-9: a pos that already fits grows nothing', async () => {
    const base = await compiled(nestedDiagram());
    const fitted = await compiled(withPos(nestedDiagram(), { 'web-a': { x: 24, y: 56 } }));
    const node = getNode(fitted, 'web-a');
    expect([node.x, node.y, node.overridden]).toEqual([24, 56, true]);
    expect(fitted.groups.filter((group) => group.grown)).toEqual([]);
    expect(fitted.groups.map(boxOf)).toEqual(base.groups.map(boxOf));
  });
});

describe('AC-10: pos below the minimum is raised', () => {
  test('AC-10: inside a group { x: -50, y: 0 } becomes the padding corner', async () => {
    const result = await compiled(withPos(nestedDiagram(), { 'web-a': { x: -50, y: 0 } }));
    const node = getNode(result, 'web-a');
    expect([node.x, node.y]).toEqual([24, 56]);
    expect(node.overridden).toBe(true);
  });

  test('AC-10: the minimum follows groupPadding and groupHeader', async () => {
    const result = await compiled(withPos(nestedDiagram(), { 'web-a': { x: -50, y: 0 } }), {
      groupPadding: 40,
      groupHeader: 50,
    });
    const node = getNode(result, 'web-a');
    expect([node.x, node.y]).toEqual([40, 90]);
  });

  test('AC-10: at the top level { x: -10, y: -10 } becomes { x: 0, y: 0 }', async () => {
    const result = await compiled(withPos(nestedDiagram(), { user: { x: -10, y: -10 } }));
    const node = getNode(result, 'user');
    expect([node.x, node.y]).toEqual([0, 0]);
    expect(node.overridden).toBe(true);
  });

  test('AC-10: a top-level pos { x: 2000, y: 1500 } makes the canvas wide and tall enough', async () => {
    const result = await compiled(withPos(nestedDiagram(), { user: { x: 2000, y: 1500 } }));
    const node = getNode(result, 'user');
    expect([node.x, node.y]).toEqual([2000, 1500]);
    expect(result.width).toBeGreaterThanOrEqual(2000 + 136);
    expect(result.height).toBeGreaterThanOrEqual(1500 + 104);
  });

  test('AC-10: a top-level pos does not mark any group as grown', async () => {
    const result = await compiled(withPos(nestedDiagram(), { user: { x: 2000, y: 1500 } }));
    expect(result.groups.filter((group) => group.grown)).toEqual([]);
  });
});

describe('AC-11: edges and boxes after overrides', () => {
  const MOVED = { 'web-a': { x: 500, y: 400 } };

  test('AC-11: edges touching the overridden node or a grown group have no points key', async () => {
    const moved = await compiled(withPos(nestedDiagram(), MOVED));
    // web-a is overridden; vpc and private-subnet-a are grown.
    for (const id of ['e-alb-web-a', 'e-gateway-vpc', 'e-web-a-subnet']) {
      expect(getEdge(moved, id), id).not.toHaveProperty('points');
    }
  });

  test('AC-11: every other edge keeps the points of the diagram without pos', async () => {
    const base = await compiled(nestedDiagram());
    const moved = await compiled(withPos(nestedDiagram(), MOVED));
    for (const id of ['e-user-alb', 'e-alb-web-b', 'e-web-b-db']) {
      expect(getEdge(base, id).points, `${id} has a route to keep`).toBeDefined();
      expect(getEdge(moved, id).points, id).toStrictEqual(getEdge(base, id).points);
    }
  });

  test('AC-11: an edge whose end is a grown group loses its points even when the node is not overridden', async () => {
    const result = await compiled(withPos(nestedDiagram(), MOVED));
    // gateway is not overridden, but its edge ends at vpc, which grew.
    expect(getNode(result, 'gateway').overridden).toBe(false);
    expect(getGroup(result, 'vpc').grown).toBe(true);
    expect(getEdge(result, 'e-gateway-vpc')).not.toHaveProperty('points');
  });

  test('AC-11: the edges of an overridden node lose their points even when no group grew', async () => {
    const result = await compiled(withPos(nestedDiagram(), { 'web-a': { x: 24, y: 56 } }));
    expect(result.groups.filter((group) => group.grown)).toEqual([]);
    expect(getEdge(result, 'e-alb-web-a')).not.toHaveProperty('points');
    expect(getEdge(result, 'e-web-a-subnet')).not.toHaveProperty('points');
    expect(getEdge(result, 'e-user-alb').points).toBeDefined();
  });

  test('AC-11: nodes without pos have overridden false and the same box as without the override', async () => {
    const base = await compiled(nestedDiagram());
    const moved = await compiled(withPos(nestedDiagram(), MOVED));
    for (const node of base.nodes) {
      if (node.id === 'web-a') continue;
      const after = getNode(moved, node.id);
      expect([node.id, after.overridden]).toEqual([node.id, false]);
      expect([node.id, boxOf(after)]).toEqual([node.id, boxOf(node)]);
    }
  });
});

describe('AC-12: empty groups and diagrams without groups or edges', () => {
  test('AC-12: a group with no children is nodeWidth x (groupHeader + 2 * groupPadding)', async () => {
    const result = await compiled(nestedDiagram());
    const spare = getGroup(result, 'spare');
    expect([spare.width, spare.height]).toEqual([136, 32 + 2 * 24]);
  });

  test('AC-12: the empty group size follows the options', async () => {
    const result = await compiled(nestedDiagram(), {
      nodeWidth: 100,
      groupPadding: 10,
      groupHeader: 20,
    });
    const spare = getGroup(result, 'spare');
    expect([spare.width, spare.height]).toEqual([100, 20 + 2 * 10]);
  });

  test('AC-12: a diagram with nodes only compiles with empty groups and edges', async () => {
    const input: Diagram = {
      id: 'nodes-only',
      title: 'Nodes only',
      nodes: [
        { id: 'one', icon: 'ec2', label: 'One' },
        { id: 'two', icon: 'ec2', label: 'Two' },
      ],
      scenarios: scenarioFor('one'),
    };
    const result = await compile(input);
    expect(result.groups).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.nodes.map((node) => node.id)).toEqual(['one', 'two']);
    expect(canvasViolations(result)).toEqual([]);
  });

  test('AC-12: a single node compiles at the origin', async () => {
    const input: Diagram = {
      id: 'single',
      title: 'Single',
      nodes: [{ id: 'one', icon: 'ec2', label: 'One' }],
      scenarios: scenarioFor('one'),
    };
    const result = await compile(input);
    expect(result.nodes).toHaveLength(1);
    const node = getNode(result, 'one');
    expect([node.x, node.y, node.width, node.height]).toEqual([0, 0, 136, 104]);
    expect(result.width).toBeGreaterThanOrEqual(136);
    expect(result.height).toBeGreaterThanOrEqual(104);
  });
});

describe('AC-13: plain JSON without undefined keys', () => {
  const ALLOWED_RESULT_KEYS = [
    'diagram',
    'direction',
    'edges',
    'groups',
    'height',
    'nodes',
    'width',
  ];
  const ALLOWED_GROUP_KEYS = [
    'depth',
    'grown',
    'height',
    'id',
    'kind',
    'label',
    'parent',
    'width',
    'x',
    'y',
  ];
  const ALLOWED_NODE_KEYS = [
    'height',
    'icon',
    'id',
    'label',
    'overridden',
    'parent',
    'sub',
    'width',
    'x',
    'y',
  ];
  const ALLOWED_EDGE_KEYS = ['from', 'id', 'label', 'points', 'to'];

  test('AC-13: a top-level node has no parent key', async () => {
    const result = await compiled(nestedDiagram());
    expect(getNode(result, 'user')).not.toHaveProperty('parent');
  });

  test('AC-13: a top-level group has no parent key', async () => {
    const result = await compiled(nestedDiagram());
    expect(getGroup(result, 'region')).not.toHaveProperty('parent');
  });

  test('AC-13: a node without sub has no sub key', async () => {
    const result = await compiled(nestedDiagram());
    expect(getNode(result, 'user')).not.toHaveProperty('sub');
    expect(getNode(result, 'alb')).not.toHaveProperty('sub');
  });

  test('AC-13: an edge without label has no label key', async () => {
    const result = await compiled(nestedDiagram());
    expect(getEdge(result, 'e-alb-web-a')).not.toHaveProperty('label');
    expect(getEdge(result, 'e-web-b-db')).not.toHaveProperty('label');
  });

  test('AC-13: the nested fixture with overrides survives a JSON round trip strictly', async () => {
    const result = await compiled(
      withPos(nestedDiagram(), { 'web-a': { x: 500, y: 400 }, user: { x: -10, y: -10 } }),
    );
    const roundTripped: unknown = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toStrictEqual(result);
  });

  test('AC-13: the nested fixture without overrides survives a JSON round trip strictly', async () => {
    const result = await compiled(nestedDiagram());
    const roundTripped: unknown = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toStrictEqual(result);
  });

  test('AC-13: results carry no engine-internal keys', async () => {
    const result = await compiled(withPos(nestedDiagram(), { 'web-a': { x: 500, y: 400 } }));
    expect(Object.keys(result).sort()).toEqual(ALLOWED_RESULT_KEYS);
    for (const group of result.groups) {
      expect(Object.keys(group).filter((key) => !ALLOWED_GROUP_KEYS.includes(key))).toEqual([]);
    }
    for (const node of result.nodes) {
      expect(Object.keys(node).filter((key) => !ALLOWED_NODE_KEYS.includes(key))).toEqual([]);
    }
    for (const edge of result.edges) {
      expect(Object.keys(edge).filter((key) => !ALLOWED_EDGE_KEYS.includes(key))).toEqual([]);
      for (const point of edge.points ?? []) {
        expect(Object.keys(point).sort()).toEqual(['x', 'y']);
      }
    }
  });
});

describe('AC-14: deterministic and non-mutating', () => {
  test('AC-14: compiling twice in sequence gives strictly equal results', async () => {
    const first = await compile(nestedDiagram());
    const second = await compile(nestedDiagram());
    expect(second).toStrictEqual(first);
  });

  test('AC-14: compiling twice concurrently gives strictly equal results', async () => {
    const [first, second] = await Promise.all([compile(nestedDiagram()), compile(nestedDiagram())]);
    expect(second).toStrictEqual(first);
  });

  test('AC-14: concurrent calls with different directions do not disturb each other', async () => {
    const alone = await compile(nestedDiagram(), { direction: 'down' });
    const [right, down] = await Promise.all([
      compile(nestedDiagram()),
      compile(nestedDiagram(), { direction: 'down' }),
    ]);
    expect(down).toStrictEqual(alone);
    expect(right.direction).toBe('right');
    expect(down.direction).toBe('down');
    expect(await compile(nestedDiagram())).toStrictEqual(right);
  });

  test('AC-14: the same options give the same result with overrides', async () => {
    const input = withPos(nestedDiagram(), { 'web-a': { x: 500, y: 400 } });
    const first = await compile(input, { groupPadding: 40, groupHeader: 50 });
    const second = await compile(input, { groupPadding: 40, groupHeader: 50 });
    expect(second).toStrictEqual(first);
  });

  test('AC-14: a deep-frozen input is not mutated', async () => {
    const input = deepFreeze(withPos(nestedDiagram(), { 'web-a': { x: 500, y: 400 } }));
    const snapshot = structuredClone(input);
    const result = await compile(input, { direction: 'down' });
    expect(input).toStrictEqual(snapshot);
    expect(result.diagram).toStrictEqual(snapshot);
  });

  test('AC-14: the options object is not mutated', async () => {
    const options = deepFreeze<CompileOptions>({ direction: 'down', nodeWidth: 100 });
    await compile(nestedDiagram(), options);
    expect(options).toStrictEqual({ direction: 'down', nodeWidth: 100 });
  });
});

describe('AC-15: the compiler is a separate entry point', () => {
  interface PackageJson {
    exports?: Record<string, string>;
    dependencies?: Record<string, string>;
  }

  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;

  test('AC-15: compile and COMPILE_DEFAULTS are exported from src/compile.ts', () => {
    expect(typeof compile).toBe('function');
    expect(typeof COMPILE_DEFAULTS).toBe('object');
  });

  test('AC-15: package.json maps exports["./compile"] to ./src/compile.ts', () => {
    expect(packageJson.exports?.['./compile']).toBe('./src/compile.ts');
  });

  test('AC-15: the root entry still maps to ./src/index.ts', () => {
    expect(packageJson.exports?.['.']).toBe('./src/index.ts');
  });

  test('AC-15: the root entry exports neither compile nor COMPILE_DEFAULTS', () => {
    expect(engineRoot).not.toHaveProperty('compile');
    expect(engineRoot).not.toHaveProperty('COMPILE_DEFAULTS');
  });

  test('AC-15: the root entry source imports neither ./compile nor elkjs', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/compile/);
    expect(source).not.toMatch(/elkjs/);
  });

  test('AC-15: package.json pins elkjs to exactly 0.12.0 in dependencies', () => {
    expect(packageJson.dependencies?.['elkjs']).toBe('0.12.0');
  });
});

// ---------------------------------------------------------------------------
// Review round 1: regression tests (AC-16 to AC-19)
// ---------------------------------------------------------------------------

/** Group g holding a chain a → b → c. */
function groupChainDiagram(): Diagram {
  return {
    id: 'group-chain',
    title: 'Chain inside a group',
    groups: [{ id: 'g', label: 'Group', kind: 'generic' }],
    nodes: [
      { id: 'a', icon: 'ec2', label: 'A', group: 'g' },
      { id: 'b', icon: 'ec2', label: 'B', group: 'g' },
      { id: 'c', icon: 'ec2', label: 'C', group: 'g' },
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'bc', from: 'b', to: 'c' },
    ],
    scenarios: scenarioFor('a'),
  };
}

/** Group g holding a with two successors b and c (same layer, same group). */
function groupForkDiagram(): Diagram {
  return {
    id: 'group-fork',
    title: 'Fork inside a group',
    groups: [{ id: 'g', label: 'Group', kind: 'generic' }],
    nodes: [
      { id: 'a', icon: 'ec2', label: 'A', group: 'g' },
      { id: 'b', icon: 'ec2', label: 'B', group: 'g' },
      { id: 'c', icon: 'ec2', label: 'C', group: 'g' },
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ac', from: 'a', to: 'c' },
    ],
    scenarios: scenarioFor('a'),
  };
}

/** The AC-17 fixture: group g0 holding n0, n2, n3, n4; top-level n1; edges that loop and cross. */
function fractionalDiagram(): Diagram {
  return {
    id: 'fractional',
    title: 'Fractional coordinates',
    groups: [{ id: 'g0', label: 'G0', kind: 'generic' }],
    nodes: [
      { id: 'n0', icon: 'ec2', label: 'N0', group: 'g0' },
      { id: 'n1', icon: 'ec2', label: 'N1' },
      { id: 'n2', icon: 'ec2', label: 'N2', group: 'g0' },
      { id: 'n3', icon: 'ec2', label: 'N3', group: 'g0' },
      { id: 'n4', icon: 'ec2', label: 'N4', group: 'g0' },
    ],
    edges: [
      { id: 'e0', from: 'n4', to: 'n1' },
      { id: 'e1', from: 'n2', to: 'n4' },
      { id: 'e2', from: 'n4', to: 'n2' },
      { id: 'e3', from: 'n0', to: 'n3' },
      { id: 'e4', from: 'n0', to: 'n1' },
      { id: 'to-g', from: 'n1', to: 'g0' },
    ],
    scenarios: scenarioFor('n0'),
  };
}

/** The AC-18 fixture: two top-level groups with a back edge between their nodes. */
function backEdgeDiagram(): Diagram {
  return {
    id: 'back-edge',
    title: 'Back edge between groups',
    groups: [
      { id: 'g', label: 'G', kind: 'generic' },
      { id: 'h', label: 'H', kind: 'generic' },
    ],
    nodes: [
      { id: 'a', icon: 'ec2', label: 'A', group: 'g' },
      { id: 'b', icon: 'ec2', label: 'B', group: 'h' },
    ],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ba', from: 'b', to: 'a' },
    ],
    scenarios: scenarioFor('a'),
  };
}

const SPACING_CASES: [string, CompileOptions][] = [
  ['default options', {}],
  ['nodeSpacing 200 and layerSpacing 300', { nodeSpacing: 200, layerSpacing: 300 }],
];

describe('AC-16: spacing applies inside groups', () => {
  describe.each(SPACING_CASES)('AC-16: %s', (_name, options) => {
    const layerSpacing = options.layerSpacing ?? 72;
    const nodeSpacing = options.nodeSpacing ?? 48;
    const nodeWidth = 136;
    const nodeHeight = 104;

    test('AC-16: a chain in a group keeps layerSpacing between layers (right)', async () => {
      const result = await compiled(groupChainDiagram(), { ...options, direction: 'right' });
      const [a, b, c] = ['a', 'b', 'c'].map((id) => getNode(result, id));
      expect(b?.x).toBeGreaterThanOrEqual((a?.x ?? Infinity) + nodeWidth + layerSpacing - TOL);
      expect(c?.x).toBeGreaterThanOrEqual((b?.x ?? Infinity) + nodeWidth + layerSpacing - TOL);
    });

    test('AC-16: a chain in a group keeps layerSpacing between layers (down)', async () => {
      const result = await compiled(groupChainDiagram(), { ...options, direction: 'down' });
      const [a, b, c] = ['a', 'b', 'c'].map((id) => getNode(result, id));
      expect(b?.y).toBeGreaterThanOrEqual((a?.y ?? Infinity) + nodeHeight + layerSpacing - TOL);
      expect(c?.y).toBeGreaterThanOrEqual((b?.y ?? Infinity) + nodeHeight + layerSpacing - TOL);
    });

    test('AC-16: two successors in a group keep nodeSpacing apart (right)', async () => {
      const result = await compiled(groupForkDiagram(), { ...options, direction: 'right' });
      const [b, c] = ['b', 'c'].map((id) => getNode(result, id));
      const gap = Math.abs((b?.y ?? 0) - (c?.y ?? 0)) - nodeHeight;
      expect(gap).toBeGreaterThanOrEqual(nodeSpacing - TOL);
    });

    test('AC-16: two successors in a group keep nodeSpacing apart (down)', async () => {
      const result = await compiled(groupForkDiagram(), { ...options, direction: 'down' });
      const [b, c] = ['b', 'c'].map((id) => getNode(result, id));
      const gap = Math.abs((b?.x ?? 0) - (c?.x ?? 0)) - nodeWidth;
      expect(gap).toBeGreaterThanOrEqual(nodeSpacing - TOL);
    });
  });
});

describe('AC-17: grown comes only from overrides', () => {
  test.each(DIRECTIONS)('AC-17: without pos no group is grown (%s)', async (direction) => {
    const result = await compiled(fractionalDiagram(), { direction });
    expect(result.groups.filter((group) => group.grown).map((group) => group.id)).toEqual([]);
    expect(result.nodes.filter((node) => node.overridden)).toEqual([]);
  });

  test.each(DIRECTIONS)(
    'AC-17: without pos every edge keeps its points (%s)',
    async (direction) => {
      const result = await compiled(fractionalDiagram(), { direction });
      expect(result.edges).toHaveLength(6);
      expect(
        result.edges.filter((edge) => edge.points === undefined).map((edge) => edge.id),
      ).toEqual([]);
    },
  );

  test.each(DIRECTIONS)(
    'AC-17: a group that is not an ancestor of the overridden node is not grown (%s)',
    async (direction) => {
      const result = await compiled(withPos(fractionalDiagram(), { n1: { x: 900, y: 700 } }), {
        direction,
      });
      expect(getNode(result, 'n1').overridden).toBe(true);
      expect(getGroup(result, 'g0').grown).toBe(false);
    },
  );

  test.each(DIRECTIONS)(
    'AC-17: in the nested fixture only the ancestors of the overridden node are grown (%s)',
    async (direction) => {
      const result = await compiled(withPos(nestedDiagram(), { 'web-a': { x: 500, y: 400 } }), {
        direction,
      });
      const grown = result.groups.filter((group) => group.grown).map((group) => group.id);
      expect(grown.sort()).toEqual(['az-a', 'private-subnet-a', 'region', 'vpc']);
    },
  );
});

describe('AC-18: the canvas starts at 0 even with a back edge', () => {
  function minimaOf(result: CompiledDiagram): { x: number; y: number } {
    const topLevel = [...result.groups, ...result.nodes].filter(
      (element) => element.parent === undefined,
    );
    const points = result.edges.flatMap((edge) => edge.points ?? []);
    return {
      x: Math.min(...topLevel.map((box) => box.x), ...points.map((point) => point.x)),
      y: Math.min(...topLevel.map((box) => box.y), ...points.map((point) => point.y)),
    };
  }

  test.each(DIRECTIONS)(
    'AC-18: the smallest x and y over boxes and points are 0 (%s)',
    async (direction) => {
      const result = await compiled(backEdgeDiagram(), { direction });
      expect(result.edges.every((edge) => edge.points !== undefined)).toBe(true);
      const { x, y } = minimaOf(result);
      expect(x).toBeCloseTo(0, 0);
      expect(y).toBeCloseTo(0, 0);
    },
  );

  test.each(DIRECTIONS)(
    'AC-18: every box and point lies inside the canvas (%s)',
    async (direction) => {
      const result = await compiled(backEdgeDiagram(), { direction });
      expect(canvasViolations(result)).toEqual([]);
    },
  );
});

describe('AC-19: options passed as undefined fall back to their defaults', () => {
  const UNDEFINED_OPTIONS = {
    direction: undefined,
    nodeWidth: undefined,
  } as unknown as CompileOptions;

  test('AC-19: direction undefined gives right', async () => {
    const result = await compile(chainDiagram(), UNDEFINED_OPTIONS);
    expect(result.direction).toBe('right');
    expect(getNode(result, 'b').x).toBeGreaterThan(getNode(result, 'a').x);
  });

  test('AC-19: nodeWidth undefined gives nodes 136 wide', async () => {
    const result = await compile(chainDiagram(), UNDEFINED_OPTIONS);
    for (const node of result.nodes) expect([node.id, node.width]).toEqual([node.id, 136]);
  });

  test('AC-19: every option undefined gives the same result as no options', async () => {
    const allUndefined = Object.fromEntries(
      Object.keys(COMPILE_DEFAULTS).map((key) => [key, undefined]),
    ) as unknown as CompileOptions;
    const withUndefined = await compile(nestedDiagram(), allUndefined);
    expect(withUndefined).toStrictEqual(await compile(nestedDiagram()));
  });

  test('AC-19: an undefined option does not hide the others', async () => {
    const mixed = { direction: undefined, nodeWidth: 100 } as unknown as CompileOptions;
    const result = await compile(chainDiagram(), mixed);
    expect(result.direction).toBe('right');
    expect(getNode(result, 'a').width).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Review round 2: float noise must never mark a group grown (AC-20)
// ---------------------------------------------------------------------------

/** The AC-20 fixture: g0 holds g1 and g2; a down layout of it overshoots a group by ~5.7e-14. */
function floatNoiseDiagram(): Diagram {
  return {
    id: 'float-noise',
    title: 'Float noise',
    groups: [
      { id: 'g0', label: 'G0', kind: 'generic' },
      { id: 'g1', label: 'G1', kind: 'generic', parent: 'g0' },
      { id: 'g2', label: 'G2', kind: 'generic', parent: 'g0' },
    ],
    nodes: [
      { id: 'n0', icon: 'ec2', label: 'N0' },
      { id: 'n1', icon: 'ec2', label: 'N1', group: 'g2' },
      { id: 'n2', icon: 'ec2', label: 'N2' },
      { id: 'n3', icon: 'ec2', label: 'N3', group: 'g1' },
      { id: 'n4', icon: 'ec2', label: 'N4' },
      { id: 'n5', icon: 'ec2', label: 'N5', group: 'g2' },
    ],
    edges: [
      { id: 'e0', from: 'n1', to: 'n3' },
      { id: 'e1', from: 'n5', to: 'n4' },
      { id: 'e2', from: 'n4', to: 'n3' },
      { id: 'e3', from: 'n5', to: 'g1' },
      { id: 'e4', from: 'g2', to: 'n2' },
      { id: 'e5', from: 'n0', to: 'n3' },
    ],
    scenarios: scenarioFor('n0'),
  };
}

describe('AC-20: float noise never marks a group grown', () => {
  test('AC-20: the fixture still exercises float noise (guard against a stale fixture)', async () => {
    const result = await compiled(floatNoiseDiagram(), { direction: 'down' });
    const padding = COMPILE_DEFAULTS.groupPadding;
    const noisy = result.groups.filter((group) => {
      const children = [...result.groups, ...result.nodes].filter(
        (element) => element.parent === group.id,
      );
      const right = Math.max(...children.map((child) => child.x + child.width)) + padding;
      const bottom = Math.max(...children.map((child) => child.y + child.height)) + padding;
      return [Math.abs(right - group.width), Math.abs(bottom - group.height)].some(
        (diff) => diff > 0 && diff < 1e-6,
      );
    });
    expect(noisy.map((group) => group.id)).not.toEqual([]);
  });

  test('AC-20: without pos no group is grown', async () => {
    const result = await compiled(floatNoiseDiagram(), { direction: 'down' });
    expect(result.groups).toHaveLength(3);
    expect(result.groups.filter((group) => group.grown).map((group) => group.id)).toEqual([]);
    expect(result.nodes.filter((node) => node.overridden)).toEqual([]);
  });

  test('AC-20: every edge, including the one ending at a group, keeps its points', async () => {
    const result = await compiled(floatNoiseDiagram(), { direction: 'down' });
    expect(result.edges).toHaveLength(6);
    expect(result.edges.filter((edge) => edge.points === undefined).map((edge) => edge.id)).toEqual(
      [],
    );
  });
});
