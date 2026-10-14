import { readFileSync } from 'node:fs';
import { validateDiagram } from '@field-guide/schema';
import type { Diagram, ElementState } from '@field-guide/schema';
import { describe, expect, test, vi } from 'vitest';
import { compile } from './compile.ts';
import type { Box, CompiledDiagram, Point } from './graph.ts';
import * as engineRoot from './index.ts';
import { initPlayer, viewPlayer } from './player.ts';
import type { PlayerView } from './player.ts';
import {
  COMPACT_BELOW_PX,
  STEP_DURATION_MS,
  absoluteBoxes,
  directLine,
  edgePath,
  effectiveStates,
  layoutFor,
  logLines,
  pathMidpoint,
  textFallback,
  toFlowModel,
} from './view-model.ts';

// elkjs loads lazily on the first compile and can take a while on a cold machine.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The PLAN.md 3.2 example: one group, four nodes, three edges, one scenario of four steps. */
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
          { edge: 'put', caption: 'PutObject with header x-amz-server-side-encryption: aws:kms' },
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
 * A diagram with nesting, an edge label, a packet and state changes, for the flow model and the log:
 *   region › keys; client at the top level; s3 and trail in region, kms in keys.
 */
function flowDiagram(): Diagram {
  return {
    id: 'flow',
    title: 'Flow',
    groups: [
      { id: 'region', label: 'eu-west-1', kind: 'region' },
      { id: 'keys', label: 'Key management', kind: 'generic', parent: 'region' },
    ],
    nodes: [
      { id: 'client', icon: 'user', label: 'Client', sub: 'IAM principal' },
      { id: 's3', icon: 'simple-storage-service', label: 'S3 bucket', group: 'region' },
      { id: 'kms', icon: 'key-management-service', label: 'KMS key', group: 'keys' },
      { id: 'trail', icon: 'cloudtrail', label: 'CloudTrail', group: 'region' },
    ],
    edges: [
      { id: 'put', from: 'client', to: 's3' },
      { id: 'gen', from: 's3', to: 'kms', label: 'Key request' },
      { id: 'audit', from: 'kms', to: 'trail' },
    ],
    scenarios: [
      {
        id: 'main',
        label: 'Main',
        steps: [
          { edge: 'put', packet: 'PutObject', caption: 'one' }, //                       0
          { edge: 'gen', packet: 'GenerateDataKey', caption: 'two' }, //                1
          { edge: 'gen', reverse: true, caption: 'three' }, //                          2
          { edge: 'audit', caption: 'four' }, //                                        3
          { node: 's3', caption: 'five', state: { s3: 'highlighted' } }, //             4
          { group: 'keys', caption: 'six', state: { kms: 'failed', gen: 'broken' } }, // 5
          { node: 'trail', caption: 'seven' }, //                                       6
        ],
      },
      {
        id: 'hidden-keys',
        label: 'Hidden keys',
        initial: { keys: 'hidden' },
        steps: [
          { edge: 'put', caption: 'one' },
          { node: 's3', caption: 'two', state: { s3: 'failed' } },
        ],
      },
    ],
  };
}

function box(x: number, y: number, width = 136, height = 104): Box {
  return { x, y, width, height };
}

/**
 * Hand-written compiled form of `flowDiagram()`, with parent-relative boxes.
 * Absolute positions: region (200,20), keys (400,80), client (0,100), s3 (224,120),
 * kms (407,120), trail (530,190). `audit` has no points.
 */
function flowCompiled(diagram: Diagram = flowDiagram()): CompiledDiagram {
  return {
    diagram,
    direction: 'right',
    width: 760,
    height: 360,
    groups: [
      {
        id: 'region',
        label: 'eu-west-1',
        kind: 'region',
        ...box(200, 20, 500, 300),
        depth: 0,
        grown: false,
      },
      {
        id: 'keys',
        label: 'Key management',
        kind: 'generic',
        parent: 'region',
        ...box(200, 60, 150, 150),
        depth: 1,
        grown: false,
      },
    ],
    nodes: [
      {
        id: 'client',
        icon: 'user',
        label: 'Client',
        sub: 'IAM principal',
        ...box(0, 100),
        overridden: false,
      },
      {
        id: 's3',
        icon: 'simple-storage-service',
        label: 'S3 bucket',
        parent: 'region',
        ...box(24, 100),
        overridden: false,
      },
      {
        id: 'kms',
        icon: 'key-management-service',
        label: 'KMS key',
        parent: 'keys',
        ...box(7, 40),
        overridden: false,
      },
      {
        id: 'trail',
        icon: 'cloudtrail',
        label: 'CloudTrail',
        parent: 'region',
        ...box(330, 170),
        overridden: true,
      },
    ],
    edges: [
      {
        id: 'put',
        from: 'client',
        to: 's3',
        points: [
          { x: 136, y: 152 },
          { x: 224, y: 152 },
        ],
      },
      {
        id: 'gen',
        from: 's3',
        to: 'kms',
        label: 'Key request',
        points: [
          { x: 360, y: 172 },
          { x: 407, y: 172 },
        ],
      },
      { id: 'audit', from: 'kms', to: 'trail' },
    ],
  };
}

function viewAt(
  diagram: Diagram,
  scenario: string,
  step: number,
  extra: { run?: number; playing?: boolean } = {},
): PlayerView {
  return viewPlayer(diagram, {
    scenario,
    step,
    playing: extra.playing ?? false,
    run: extra.run ?? 0,
  });
}

function allNormal(d: Diagram): Record<string, ElementState> {
  const states: Record<string, ElementState> = {};
  for (const element of [...(d.groups ?? []), ...d.nodes, ...(d.edges ?? [])]) {
    states[element.id] = 'normal';
  }
  return states;
}

function distanceToBorder(p: Point, b: Box): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy); // outside the box
  return Math.min(p.x - b.x, b.x + b.width - p.x, p.y - b.y, b.y + b.height - p.y); // inside
}

function centre(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Distance from a point to the infinite line through a and b. */
function distanceToLine(p: Point, a: Point, b: Point): number {
  const cross = (b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y);
  return Math.abs(cross) / Math.hypot(b.x - a.x, b.y - a.y);
}

// ---------------------------------------------------------------------------
// AC-1 absoluteBoxes
// ---------------------------------------------------------------------------

describe('AC-1: absoluteBoxes adds the ancestors offsets', () => {
  /** region › vpc › subnet › node, plus a top-level node. */
  function nested(): CompiledDiagram {
    const diagram: Diagram = {
      id: 'nested',
      title: 'Nested',
      groups: [
        { id: 'region', label: 'Region', kind: 'region' },
        { id: 'vpc', label: 'VPC', kind: 'vpc', parent: 'region' },
        { id: 'subnet', label: 'Subnet', kind: 'public-subnet', parent: 'vpc' },
      ],
      nodes: [
        { id: 'web', icon: 'ec2', label: 'Web', group: 'subnet' },
        { id: 'client', icon: 'user', label: 'Client' },
      ],
      scenarios: [{ id: 's', label: 'S', steps: [{ node: 'web', caption: 'x' }] }],
    };
    return {
      diagram,
      direction: 'right',
      width: 900,
      height: 700,
      groups: [
        {
          id: 'region',
          label: 'Region',
          kind: 'region',
          ...box(100, 50, 700, 600),
          depth: 0,
          grown: false,
        },
        {
          id: 'vpc',
          label: 'VPC',
          kind: 'vpc',
          parent: 'region',
          ...box(30, 40, 600, 500),
          depth: 1,
          grown: false,
        },
        {
          id: 'subnet',
          label: 'Subnet',
          kind: 'public-subnet',
          parent: 'vpc',
          ...box(5, 6, 400, 300),
          depth: 2,
          grown: false,
        },
      ],
      nodes: [
        { id: 'web', icon: 'ec2', label: 'Web', parent: 'subnet', ...box(7, 8), overridden: false },
        { id: 'client', icon: 'user', label: 'Client', ...box(3, 4), overridden: false },
      ],
      edges: [],
    };
  }

  test('AC-1: every group and node gets its own offset plus the sum of its ancestors', () => {
    const boxes = absoluteBoxes(nested());

    expect(boxes['region']).toEqual(box(100, 50, 700, 600));
    expect(boxes['vpc']).toEqual(box(130, 90, 600, 500));
    expect(boxes['subnet']).toEqual(box(135, 96, 400, 300));
    expect(boxes['web']).toEqual(box(142, 104));
  });

  test('AC-1: top-level boxes are unchanged and the keys are exactly the groups and nodes', () => {
    const boxes = absoluteBoxes(nested());

    expect(boxes['client']).toEqual(box(3, 4));
    expect(Object.keys(boxes).sort()).toEqual(['client', 'region', 'subnet', 'vpc', 'web']);
  });

  test('AC-1: sizes are never changed by the offsets', () => {
    const boxes = absoluteBoxes(nested());

    expect(boxes['vpc']).toMatchObject({ width: 600, height: 500 });
    expect(boxes['web']).toMatchObject({ width: 136, height: 104 });
  });

  test('AC-1: a real compiled diagram keeps nodes inside their absolute group boxes', async () => {
    const compiled = await compile(exampleDiagram());
    const boxes = absoluteBoxes(compiled);
    const region = boxes['region'] as Box;

    expect(Object.keys(boxes).sort()).toEqual(['client', 'kms', 'region', 's3', 'trail']);
    for (const id of ['s3', 'kms', 'trail']) {
      const node = boxes[id] as Box;
      expect(node.x).toBeGreaterThanOrEqual(region.x);
      expect(node.y).toBeGreaterThanOrEqual(region.y);
      expect(node.x + node.width).toBeLessThanOrEqual(region.x + region.width + 0.001);
      expect(node.y + node.height).toBeLessThanOrEqual(region.y + region.height + 0.001);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 directLine
// ---------------------------------------------------------------------------

describe('AC-2: directLine joins two boxes along their centres', () => {
  const left = box(0, 0, 100, 50);
  const right = box(300, 0, 100, 50);

  function expectOnCentreLine(from: Box, to: Box): [Point, Point] {
    const [start, end] = directLine(from, to);
    expect(distanceToBorder(start, from)).toBeLessThanOrEqual(0.5);
    expect(distanceToBorder(end, to)).toBeLessThanOrEqual(0.5);
    expect(distanceToLine(start, centre(from), centre(to))).toBeLessThanOrEqual(0.5);
    expect(distanceToLine(end, centre(from), centre(to))).toBeLessThanOrEqual(0.5);
    return [start, end];
  }

  test('AC-2: side-by-side boxes: the start is on the from border and the end on the to border', () => {
    const [start, end] = expectOnCentreLine(left, right);

    expect(start.x).toBeCloseTo(100, 0);
    expect(end.x).toBeCloseTo(300, 0);
    expect(start.y).toBeCloseTo(25, 0);
    expect(end.y).toBeCloseTo(25, 0);
  });

  test('AC-2: reversed (to on the left) the line is cut on the facing borders', () => {
    const [start, end] = expectOnCentreLine(right, left);

    expect(start.x).toBeCloseTo(300, 0);
    expect(end.x).toBeCloseTo(100, 0);
  });

  test('AC-2: diagonal boxes: both end points are on the borders and on the centre line', () => {
    const from = box(0, 0, 100, 50);
    const to = box(300, 200, 120, 80);

    const [start, end] = expectOnCentreLine(from, to);

    expect(start.x).toBeGreaterThan(from.x);
    expect(end.x).toBeLessThan(to.x + to.width);
  });

  test('AC-2: stacked boxes: the line leaves through the bottom and enters through the top', () => {
    const from = box(0, 0, 100, 50);
    const to = box(0, 200, 100, 50);

    const [start, end] = expectOnCentreLine(from, to);

    expect(start.y).toBeCloseTo(50, 0);
    expect(end.y).toBeCloseTo(200, 0);
  });

  test('AC-2: a box inside another: the inner bottom-centre and the point straight below on the outer bottom border', () => {
    const outer = box(0, 0, 400, 300);
    const inner = box(100, 60, 100, 50);

    const [start, end] = directLine(inner, outer);

    expect(start.x).toBeCloseTo(150, 5);
    expect(start.y).toBeCloseTo(110, 5);
    expect(end.x).toBeCloseTo(150, 5);
    expect(end.y).toBeCloseTo(300, 5);
  });

  test('AC-2: with the outer box as from, the same two points are returned', () => {
    const outer = box(0, 0, 400, 300);
    const inner = box(100, 60, 100, 50);

    const points = directLine(outer, inner);

    const sorted = [...points].sort((a, b) => a.y - b.y);
    expect(sorted[0]?.x).toBeCloseTo(150, 5);
    expect(sorted[0]?.y).toBeCloseTo(110, 5);
    expect(sorted[1]?.x).toBeCloseTo(150, 5);
    expect(sorted[1]?.y).toBeCloseTo(300, 5);
  });
});

// ---------------------------------------------------------------------------
// AC-3 edgePath, pathMidpoint
// ---------------------------------------------------------------------------

/** The commands of an SVG path made of M, L and Q with absolute coordinates. */
interface PathCommand {
  type: 'M' | 'L' | 'Q';
  values: number[];
}

function parsePath(d: string): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const match of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const values = (match[2] ?? '')
      .split(/[\s,]+/)
      .filter((part) => part !== '')
      .map(Number);
    commands.push({ type: match[1] as PathCommand['type'], values });
  }
  return commands;
}

describe('AC-3: edgePath and pathMidpoint', () => {
  const p = (x: number, y: number): Point => ({ x, y });

  test('AC-3: two points give exactly M x0 y0 L x1 y1', () => {
    expect(edgePath([p(0, 0), p(100, 50)])).toBe('M 0 0 L 100 50');
    expect(edgePath([p(10, 20), p(30, 20)])).toBe('M 10 20 L 30 20');
  });

  test('AC-3: four orthogonal points start with M at the first point and end with L at the last', () => {
    const points = [p(0, 0), p(100, 0), p(100, 100), p(200, 100)];

    const commands = parsePath(edgePath(points));

    expect(commands[0]).toEqual({ type: 'M', values: [0, 0] });
    expect(commands[commands.length - 1]).toEqual({ type: 'L', values: [200, 100] });
  });

  test('AC-3: four points give exactly two Q commands', () => {
    const d = edgePath([p(0, 0), p(100, 0), p(100, 100), p(200, 100)]);

    expect(parsePath(d).filter((command) => command.type === 'Q')).toHaveLength(2);
  });

  test('AC-3: n points give n - 2 Q commands', () => {
    const three = edgePath([p(0, 0), p(100, 0), p(100, 100)]);
    const five = edgePath([p(0, 0), p(100, 0), p(100, 100), p(200, 100), p(200, 200)]);

    expect(parsePath(three).filter((command) => command.type === 'Q')).toHaveLength(1);
    expect(parsePath(five).filter((command) => command.type === 'Q')).toHaveLength(3);
  });

  test('AC-3: each Q uses the corner as its control point', () => {
    const d = edgePath([p(0, 0), p(100, 0), p(100, 100), p(200, 100)]);

    const controls = parsePath(d)
      .filter((command) => command.type === 'Q')
      .map((command) => command.values.slice(0, 2));

    expect(controls).toEqual([
      [100, 0],
      [100, 100],
    ]);
  });

  test('AC-3: with segments of 10 px and radius 12 no curve starts farther than 5 px from its corner', () => {
    const d = edgePath([p(0, 0), p(10, 0), p(10, 10), p(20, 10)], 12);

    let current: Point = { x: 0, y: 0 };
    let curves = 0;
    for (const command of parsePath(d)) {
      if (command.type === 'Q') {
        const [cx, cy] = command.values as [number, number];
        expect(Math.hypot(current.x - cx, current.y - cy)).toBeLessThanOrEqual(5 + 1e-6);
        curves += 1;
      }
      const [x, y] = command.values.slice(-2) as [number, number];
      current = { x, y };
    }
    expect(curves).toBe(2);
  });

  test('AC-3: with long segments the curve radius is at most the radius (default 12)', () => {
    const points = [p(0, 0), p(100, 0), p(100, 100)];

    const cases: [string, number][] = [
      [edgePath(points), 12],
      [edgePath(points, 12), 12],
      [edgePath(points, 4), 4],
    ];
    for (const [d, radius] of cases) {
      let current = { x: 0, y: 0 };
      for (const command of parsePath(d)) {
        if (command.type === 'Q') {
          const [cx, cy] = command.values as [number, number];
          expect(Math.hypot(current.x - cx, current.y - cy)).toBeLessThanOrEqual(radius + 1e-6);
        }
        const [x, y] = command.values.slice(-2) as [number, number];
        current = { x, y };
      }
    }
  });

  test('AC-3: pathMidpoint of (0,0) (100,0) (100,100) is (100,0)', () => {
    expect(pathMidpoint([p(0, 0), p(100, 0), p(100, 100)])).toEqual(p(100, 0));
  });

  test('AC-3: pathMidpoint of (0,0) (10,0) is (5,0)', () => {
    expect(pathMidpoint([p(0, 0), p(10, 0)])).toEqual(p(5, 0));
  });

  test('AC-3: pathMidpoint is at half of the total length when the middle falls inside a segment', () => {
    expect(pathMidpoint([p(0, 0), p(30, 0), p(30, 10)])).toEqual(p(20, 0));
    expect(pathMidpoint([p(0, 0), p(10, 0), p(10, 30)])).toEqual(p(10, 10));
  });
});

// ---------------------------------------------------------------------------
// AC-4 effectiveStates
// ---------------------------------------------------------------------------

describe('AC-4: effectiveStates cascades hidden', () => {
  /** g1 › g2; g3 alone. n1 in g2, n2 in g1, n3 in g3, n4 at the top level. */
  function cascade(): Diagram {
    return {
      id: 'cascade',
      title: 'Cascade',
      groups: [
        { id: 'g1', label: 'G1', kind: 'vpc' },
        { id: 'g2', label: 'G2', kind: 'public-subnet', parent: 'g1' },
        { id: 'g3', label: 'G3', kind: 'generic' },
      ],
      nodes: [
        { id: 'n1', icon: 'ec2', label: 'N1', group: 'g2' },
        { id: 'n2', icon: 'ec2', label: 'N2', group: 'g1' },
        { id: 'n3', icon: 'ec2', label: 'N3', group: 'g3' },
        { id: 'n4', icon: 'ec2', label: 'N4' },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n3' },
        { id: 'e2', from: 'n2', to: 'n4' },
        { id: 'e3', from: 'n3', to: 'n4' },
        { id: 'e4', from: 'g2', to: 'n4' },
        { id: 'e5', from: 'n4', to: 'g3' },
      ],
      scenarios: [{ id: 's', label: 'S', steps: [{ node: 'n4', caption: 'x' }] }],
    };
  }

  test('AC-4: a hidden group hides its descendant groups and nodes and every edge touching them', () => {
    const d = cascade();

    const result = effectiveStates(d, { ...allNormal(d), g1: 'hidden' });

    for (const id of ['g1', 'g2', 'n1', 'n2', 'e1', 'e2', 'e4']) {
      expect(result[id], id).toBe('hidden');
    }
  });

  test('AC-4: a hidden group leaves everything outside it alone', () => {
    const d = cascade();

    const result = effectiveStates(d, { ...allNormal(d), g1: 'hidden' });

    for (const id of ['g3', 'n3', 'n4', 'e3', 'e5']) {
      expect(result[id], id).toBe('normal');
    }
  });

  test('AC-4: a hidden inner group hides its contents but not the outer group', () => {
    const d = cascade();

    const result = effectiveStates(d, { ...allNormal(d), g2: 'hidden' });

    expect(result['g2']).toBe('hidden');
    expect(result['n1']).toBe('hidden');
    expect(result['e1']).toBe('hidden');
    expect(result['e4']).toBe('hidden');
    expect(result['g1']).toBe('normal');
    expect(result['n2']).toBe('normal');
    expect(result['e2']).toBe('normal');
  });

  test('AC-4: a hidden group hides an edge that points to it', () => {
    const d = cascade();

    const result = effectiveStates(d, { ...allNormal(d), g3: 'hidden' });

    expect(result['g3']).toBe('hidden');
    expect(result['n3']).toBe('hidden');
    expect(result['e5']).toBe('hidden');
    expect(result['e1']).toBe('hidden');
    expect(result['e3']).toBe('hidden');
    expect(result['n4']).toBe('normal');
  });

  test('AC-4: a hidden node hides its edges only', () => {
    const d = cascade();

    const result = effectiveStates(d, { ...allNormal(d), n3: 'hidden' });

    expect(result['n3']).toBe('hidden');
    expect(result['e1']).toBe('hidden');
    expect(result['e3']).toBe('hidden');
    for (const id of ['g1', 'g2', 'g3', 'n1', 'n2', 'n4', 'e2', 'e4', 'e5']) {
      expect(result[id], id).toBe('normal');
    }
  });

  test('AC-4: other states pass through unchanged', () => {
    const d = cascade();
    const states: Record<string, ElementState> = {
      ...allNormal(d),
      n4: 'failed',
      e3: 'broken',
      g3: 'highlighted',
      n2: 'appearing',
    };

    const result = effectiveStates(d, states);

    expect(result).toEqual(states);
  });

  test('AC-4: hidden wins over another state inside a hidden group, and the input is not modified', () => {
    const d = cascade();
    const states: Record<string, ElementState> = { ...allNormal(d), g1: 'hidden', n1: 'failed' };
    const copy = { ...states };

    const result = effectiveStates(d, states);

    expect(result['n1']).toBe('hidden');
    expect(states).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 toFlowModel
// ---------------------------------------------------------------------------

describe('AC-5: toFlowModel lists groups and nodes', () => {
  test('AC-5: groups come in compiled order, then nodes in compiled order', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(model.groups.map((group) => group.id)).toEqual(['region', 'keys']);
    expect(model.nodes.map((node) => node.id)).toEqual(['client', 's3', 'kms', 'trail']);
    expect(model.edges.map((edge) => edge.id)).toEqual(['put', 'gen', 'audit']);
  });

  test('AC-5: the canvas size is the compiled size', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(model.width).toBe(760);
    expect(model.height).toBe(360);
  });

  test('AC-5: parentId is set exactly when the element has a parent', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));
    const group = (id: string) => model.groups.find((candidate) => candidate.id === id);
    const node = (id: string) => model.nodes.find((candidate) => candidate.id === id);

    expect(group('keys')?.parentId).toBe('region');
    expect(node('s3')?.parentId).toBe('region');
    expect(node('kms')?.parentId).toBe('keys');
    expect(Object.hasOwn(group('region') ?? {}, 'parentId')).toBe(false);
    expect(Object.hasOwn(node('client') ?? {}, 'parentId')).toBe(false);
  });

  test('AC-5: boxes are the compiled parent-relative boxes', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(model.groups[1]).toMatchObject({ id: 'keys', x: 200, y: 60, width: 150, height: 150 });
    expect(model.nodes[2]).toMatchObject({ id: 'kms', x: 7, y: 40, width: 136, height: 104 });
  });

  test('AC-5: groups carry label, kind and depth, nodes label, sub and icon', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(model.groups[0]).toMatchObject({ label: 'eu-west-1', kind: 'region', depth: 0 });
    expect(model.groups[1]).toMatchObject({ label: 'Key management', kind: 'generic', depth: 1 });
    expect(model.nodes[0]).toMatchObject({ label: 'Client', sub: 'IAM principal', icon: 'user' });
    expect(model.nodes[1]).toMatchObject({ label: 'S3 bucket', icon: 'simple-storage-service' });
  });

  test('AC-5: a node without a sub-label has no sub key', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(Object.hasOwn(model.nodes[1] ?? {}, 'sub')).toBe(false);
  });

  test('AC-5: states are the effective states (hidden cascades), normal by default', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'hidden-keys', -1));

    expect(model.groups.map((group) => [group.id, group.state])).toEqual([
      ['region', 'normal'],
      ['keys', 'hidden'],
    ]);
    expect(model.nodes.map((node) => [node.id, node.state])).toEqual([
      ['client', 'normal'],
      ['s3', 'normal'],
      ['kms', 'hidden'],
      ['trail', 'normal'],
    ]);
  });

  test('AC-5: nothing is active before the first step', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(model.groups.some((group) => group.active)).toBe(false);
    expect(model.nodes.some((node) => node.active)).toBe(false);
    expect(model.edges.some((edge) => edge.status === 'active')).toBe(false);
  });

  test('AC-5: a node step makes only that node active', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 4));

    expect(model.nodes.filter((node) => node.active).map((node) => node.id)).toEqual(['s3']);
    expect(model.groups.some((group) => group.active)).toBe(false);
    expect(model.nodes.find((node) => node.id === 's3')?.state).toBe('highlighted');
  });

  test('AC-5: a group step makes only that group active', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 5));

    expect(model.groups.filter((group) => group.active).map((group) => group.id)).toEqual(['keys']);
    expect(model.nodes.some((node) => node.active)).toBe(false);
    expect(model.nodes.find((node) => node.id === 'kms')?.state).toBe('failed');
  });

  test('AC-5: an edge step makes no group or node active', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 0));

    expect(model.groups.some((group) => group.active)).toBe(false);
    expect(model.nodes.some((node) => node.active)).toBe(false);
  });

  test('AC-5: only the current step makes an element active, earlier targets do not stay active', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 6));

    expect(model.nodes.filter((node) => node.active).map((node) => node.id)).toEqual(['trail']);
    expect(model.nodes.find((node) => node.id === 's3')?.active).toBe(false);
  });
});

describe('AC-6: toFlowModel edges', () => {
  const edgeOf = (model: ReturnType<typeof toFlowModel>, id: string) => {
    const edge = model.edges.find((candidate) => candidate.id === id);
    if (edge === undefined) throw new Error(`no edge ${id}`);
    return edge;
  };

  test('AC-6: an edge with compiled points keeps them', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(edgeOf(model, 'put').points).toEqual([
      { x: 136, y: 152 },
      { x: 224, y: 152 },
    ]);
    expect(edgeOf(model, 'gen').points).toEqual([
      { x: 360, y: 172 },
      { x: 407, y: 172 },
    ]);
  });

  test('AC-6: an edge without points gets directLine of the absolute boxes of from and to', () => {
    const compiled = flowCompiled();
    const boxes = absoluteBoxes(compiled);

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    const points = edgeOf(model, 'audit').points;
    expect(points).toHaveLength(2);
    expect(points).toEqual(directLine(boxes['kms'] as Box, boxes['trail'] as Box));
  });

  test('AC-6: an edge from or to a group is routed between the absolute group box and the node', () => {
    const diagram: Diagram = {
      ...flowDiagram(),
      edges: [{ id: 'to-keys', from: 'client', to: 'keys' }],
    };
    const compiled: CompiledDiagram = {
      ...flowCompiled(diagram),
      edges: [{ id: 'to-keys', from: 'client', to: 'keys' }],
    };
    const boxes = absoluteBoxes(compiled);

    const model = toFlowModel(compiled, viewAt(diagram, 'hidden-keys', -1));

    expect(edgeOf(model, 'to-keys').points).toEqual(
      directLine(boxes['client'] as Box, boxes['keys'] as Box),
    );
  });

  test('AC-6: edge id, from, to and label are carried over', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(edgeOf(model, 'gen')).toMatchObject({
      id: 'gen',
      from: 's3',
      to: 'kms',
      label: 'Key request',
    });
    expect(edgeOf(model, 'put').label).toBeUndefined();
  });

  test('AC-6: before the first step every edge is idle and none has a packet', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', -1));

    expect(model.edges.map((edge) => edge.status)).toEqual(['idle', 'idle', 'idle']);
    expect(model.edges.some((edge) => edge.packet !== undefined)).toBe(false);
  });

  test('AC-6: the current edge is active, earlier ones done, later ones idle', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 1));

    expect(edgeOf(model, 'put').status).toBe('done');
    expect(edgeOf(model, 'gen').status).toBe('active');
    expect(edgeOf(model, 'audit').status).toBe('idle');
  });

  test('AC-6: an edge used by an earlier step and by the current one is active, not done', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 2));

    expect(edgeOf(model, 'put').status).toBe('done');
    expect(edgeOf(model, 'gen').status).toBe('active');
    expect(edgeOf(model, 'audit').status).toBe('idle');
  });

  test('AC-6: on a node step no edge is active and the earlier edges are done', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 4));

    expect(model.edges.map((edge) => edge.status)).toEqual(['done', 'done', 'done']);
    expect(model.edges.some((edge) => edge.packet !== undefined)).toBe(false);
  });

  test('AC-6: only the active edge has a packet, with reverse, run and its label', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 1, { run: 7 }));

    expect(edgeOf(model, 'gen').packet).toStrictEqual({
      label: 'GenerateDataKey',
      reverse: false,
      run: 7,
    });
    expect(edgeOf(model, 'put').packet).toBeUndefined();
    expect(edgeOf(model, 'audit').packet).toBeUndefined();
  });

  test('AC-6: the packet label is present only when the step has a packet', () => {
    const compiled = flowCompiled();

    const model = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 3, { run: 2 }));

    const packet = edgeOf(model, 'audit').packet;
    expect(packet).toStrictEqual({ reverse: false, run: 2 });
    expect(Object.hasOwn(packet ?? {}, 'label')).toBe(false);
  });

  test('AC-6: a reverse step gives reverse: true, and run follows the view run', () => {
    const compiled = flowCompiled();

    const first = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 2, { run: 3 }));
    const second = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 2, { run: 4 }));

    expect(edgeOf(first, 'gen').packet).toStrictEqual({ reverse: true, run: 3 });
    expect(edgeOf(second, 'gen').packet?.run).toBe(4);
  });

  test('AC-6: the edge state is the effective state (a broken edge, a hidden one)', () => {
    const compiled = flowCompiled();

    const broken = toFlowModel(compiled, viewAt(compiled.diagram, 'main', 5));
    const hidden = toFlowModel(compiled, viewAt(compiled.diagram, 'hidden-keys', -1));

    expect(edgeOf(broken, 'gen').state).toBe('broken');
    expect(edgeOf(hidden, 'gen').state).toBe('hidden');
    expect(edgeOf(hidden, 'audit').state).toBe('hidden');
    expect(edgeOf(hidden, 'put').state).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// AC-7 logLines
// ---------------------------------------------------------------------------

describe('AC-7: logLines', () => {
  test('AC-7: at step -1 there are no lines', () => {
    expect(logLines(exampleDiagram(), 'upload', -1)).toEqual([]);
  });

  test('AC-7: the PLAN.md example at step 2 gives three lines numbered 1 to 3 of 4', () => {
    const lines = logLines(exampleDiagram(), 'upload', 2);

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.n)).toEqual([1, 2, 3]);
    expect(lines.map((line) => line.total)).toEqual([4, 4, 4]);
  });

  test('AC-7: edge steps give route from → to; no packet or label means no detail', () => {
    const lines = logLines(exampleDiagram(), 'upload', 2);

    expect(lines.map((line) => line.route)).toEqual(['client → s3', 's3 → kms', 'kms → trail']);
    for (const line of lines) expect(Object.hasOwn(line, 'detail')).toBe(false);
  });

  test('AC-7: step 0 gives a single line', () => {
    const lines = logLines(flowDiagram(), 'main', 0);

    expect(lines).toEqual([{ n: 1, total: 7, route: 'client → s3', detail: 'PutObject' }]);
  });

  test('AC-7: the detail is the packet, else the edge label, else absent', () => {
    const lines = logLines(flowDiagram(), 'main', 3);

    // 0: packet PutObject; 1: packet beats the label; 2: reverse step without packet → edge label
    expect(lines[0]?.detail).toBe('PutObject');
    expect(lines[1]?.detail).toBe('GenerateDataKey');
    expect(lines[2]?.detail).toBe('Key request');
    // 3: audit, neither packet nor label
    expect(Object.hasOwn(lines[3] ?? {}, 'detail')).toBe(false);
  });

  test('AC-7: a reverse step swaps the route', () => {
    const lines = logLines(flowDiagram(), 'main', 2);

    expect(lines[1]?.route).toBe('s3 → kms');
    expect(lines[2]?.route).toBe('kms → s3');
  });

  test('AC-7: a node step without state has its id as route and no detail', () => {
    const lines = logLines(flowDiagram(), 'main', 6);

    expect(lines[6]).toEqual({ n: 7, total: 7, route: 'trail' });
    expect(Object.hasOwn(lines[6] ?? {}, 'detail')).toBe(false);
  });

  test('AC-7: a node step with state shows the id state pair', () => {
    const lines = logLines(flowDiagram(), 'main', 4);

    expect(lines[4]).toEqual({ n: 5, total: 7, route: 's3', detail: 's3 highlighted' });
  });

  test('AC-7: a group step with several states joins the pairs with a comma', () => {
    const lines = logLines(flowDiagram(), 'main', 5);

    expect(lines[5]).toEqual({ n: 6, total: 7, route: 'keys', detail: 'kms failed, gen broken' });
  });

  test('AC-7: another scenario is read from its own steps', () => {
    const lines = logLines(flowDiagram(), 'hidden-keys', 1);

    expect(lines).toEqual([
      { n: 1, total: 2, route: 'client → s3' },
      { n: 2, total: 2, route: 's3', detail: 's3 failed' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-8 layoutFor and constants
// ---------------------------------------------------------------------------

describe('AC-8: layoutFor and the timing constants', () => {
  test('AC-8: layoutFor(559) is compact', () => {
    expect(layoutFor(559)).toBe('compact');
  });

  test('AC-8: layoutFor(560), layoutFor(1200), layoutFor(0) and layoutFor(NaN) are wide', () => {
    expect(layoutFor(560)).toBe('wide');
    expect(layoutFor(1200)).toBe('wide');
    expect(layoutFor(0)).toBe('wide');
    expect(layoutFor(Number.NaN)).toBe('wide');
  });

  test('AC-8: narrow widths are compact', () => {
    expect(layoutFor(400)).toBe('compact');
    expect(layoutFor(1)).toBe('compact');
    expect(layoutFor(559.9)).toBe('compact');
  });

  test('AC-8: STEP_DURATION_MS is 3600 and COMPACT_BELOW_PX is 560', () => {
    expect(STEP_DURATION_MS).toBe(3600);
    expect(COMPACT_BELOW_PX).toBe(560);
  });
});

// ---------------------------------------------------------------------------
// AC-9 textFallback
// ---------------------------------------------------------------------------

describe('AC-9: textFallback', () => {
  function fallbackDiagram(): Diagram {
    return {
      id: 'fallback',
      title: 'Fallback',
      nodes: [
        { id: 'a', icon: 'user', label: 'A' },
        { id: 'b', icon: 'user', label: 'B' },
      ],
      edges: [{ id: 'ab', from: 'a', to: 'b' }],
      scenarios: [
        {
          id: 'second-in-name',
          label: 'Zeta scenario',
          steps: [
            { edge: 'ab', caption: 'First caption' },
            {
              edge: 'ab',
              caption: 'Second caption',
              metrics: { 'KMS requests': '+1', cost: 0.03 },
            },
            { node: 'a', caption: 'Third caption', metrics: { latency: '12 ms' } },
          ],
        },
        { id: 'alpha', label: 'Alpha scenario', steps: [{ node: 'b', caption: 'Only caption' }] },
      ],
    };
  }

  test('AC-9: every scenario comes in source order with its id and label', () => {
    const result = textFallback(fallbackDiagram());

    expect(result.map((scenario) => [scenario.id, scenario.label])).toEqual([
      ['second-in-name', 'Zeta scenario'],
      ['alpha', 'Alpha scenario'],
    ]);
  });

  test('AC-9: the steps are the captions in order', () => {
    const result = textFallback(fallbackDiagram());

    expect(result[0]?.steps.map((step) => step.caption)).toEqual([
      'First caption',
      'Second caption',
      'Third caption',
    ]);
    expect(result[1]?.steps.map((step) => step.caption)).toEqual(['Only caption']);
  });

  test('AC-9: metrics become key: value pairs joined by a comma', () => {
    const result = textFallback(fallbackDiagram());

    expect(result[0]?.steps[1]?.metrics).toBe('KMS requests: +1, cost: 0.03');
    expect(result[0]?.steps[2]?.metrics).toBe('latency: 12 ms');
  });

  test('AC-9: a step without metrics has no metrics key', () => {
    const result = textFallback(fallbackDiagram());

    expect(Object.hasOwn(result[0]?.steps[0] ?? {}, 'metrics')).toBe(false);
    expect(Object.hasOwn(result[1]?.steps[0] ?? {}, 'metrics')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-10 public surface
// ---------------------------------------------------------------------------

describe('AC-10: the package surface', () => {
  const srcDir = new URL('.', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, srcDir), 'utf8');

  /** The module specifiers an ES module imports or re-exports (comments removed). */
  function specifiers(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const found: string[] = [];
    for (const match of code.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      found.push(match[1] as string);
    }
    return found;
  }

  test('AC-10: the root exports the view model functions', () => {
    for (const name of [
      'layoutFor',
      'absoluteBoxes',
      'directLine',
      'edgePath',
      'pathMidpoint',
      'effectiveStates',
      'toFlowModel',
      'logLines',
      'textFallback',
    ] as const) {
      expect(typeof engineRoot[name], name).toBe('function');
    }
  });

  test('AC-10: the root exports the view model constants and still the player', () => {
    expect(engineRoot.STEP_DURATION_MS).toBe(STEP_DURATION_MS);
    expect(engineRoot.COMPACT_BELOW_PX).toBe(COMPACT_BELOW_PX);
    expect(typeof engineRoot.playerReducer).toBe('function');
    expect(typeof engineRoot.viewPlayer).toBe('function');
  });

  test('AC-10: src/index.ts imports no react, @xyflow/react, motion, ./view, ./compile or elkjs', () => {
    const imports = specifiers(read('./index.ts'));

    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, specifier).not.toMatch(
        /^(react|react-dom|@xyflow\/react|motion|elkjs)(\/|$)/,
      );
      expect(specifier, specifier).not.toMatch(/^\.\/view(\/|\.tsx?$|$)/);
      expect(specifier, specifier).not.toMatch(/^\.\/compile(\.|$)/);
    }
  });

  test('AC-10: src/index.ts re-exports the view model', () => {
    expect(specifiers(read('./index.ts'))).toContain('./view-model.ts');
  });

  test('AC-10: package.json exports ./view as ./src/view/index.ts', () => {
    const manifest = JSON.parse(read('../package.json')) as { exports: Record<string, string> };

    expect(manifest.exports['./view']).toBe('./src/view/index.ts');
  });

  test('AC-10: src/view/index.ts exports DiagramView', () => {
    const source = read('./view/index.ts');

    expect(source).toMatch(
      /export\s+(?:type\s+)?\{[^}]*\bDiagramView\b[^}]*\}|export\s+(?:default\s+)?(?:function|const)\s+DiagramView\b/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

test('the fixtures of this file are valid diagrams', () => {
  expect(validateDiagram(exampleDiagram()).ok).toBe(true);
  expect(validateDiagram(flowDiagram()).ok).toBe(true);
  // initPlayer is part of the public player: the first scenario is the default.
  expect(initPlayer(flowDiagram()).scenario).toBe('main');
});
