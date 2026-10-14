import { describe, expect, test } from 'vitest';
import { ELEMENT_STATES, GROUP_KINDS, diagramSchema, validateDiagram } from './diagram.ts';
import type { Diagram, DiagramNode, DiagramStep, DiagramGroup } from './diagram.ts';
import * as schemaRoot from './index.ts';

type Mutator = (diagram: Diagram) => void;

// The example diagram from PLAN.md section 3.2, as a JS object.
const exampleDiagram: Diagram = {
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
        { edge: 'put', caption: 'The client sends PutObject with the SSE-KMS header.' },
        { edge: 'gen', caption: 'S3 asks KMS for a data key.' },
        { edge: 'audit', caption: 'KMS logs the call to CloudTrail.' },
        { node: 's3', caption: 'S3 encrypts the object with the data key and stores it.' },
      ],
    },
  ],
};

// A fuller diagram: nested groups, pos, sub, edges to groups, initial, reverse + packet,
// node and group steps, state and metrics.
const fullDiagram: Diagram = {
  id: 'multi-az-failover',
  title: 'Multi-AZ failover',
  description: 'An application tier spread over two Availability Zones.',
  groups: [
    { id: 'region', label: 'eu-west-1', kind: 'region' },
    { id: 'vpc', label: 'VPC 10.0.0.0/16', kind: 'vpc', parent: 'region' },
    { id: 'az-a', label: 'eu-west-1a', kind: 'az', parent: 'vpc' },
    { id: 'az-b', label: 'eu-west-1b', kind: 'az', parent: 'vpc' },
    { id: 'subnet-a', label: 'Private subnet A', kind: 'private-subnet', parent: 'az-a' },
    { id: 'subnet-b', label: 'Private subnet B', kind: 'private-subnet', parent: 'az-b' },
    { id: 'office', label: 'Office', kind: 'on-premises' },
  ],
  nodes: [
    { id: 'user', icon: 'user', label: 'User', pos: { x: 40, y: 120.5 } },
    {
      id: 'alb',
      icon: 'elastic-load-balancing',
      label: 'ALB',
      sub: 'Application Load Balancer',
      group: 'vpc',
    },
    { id: 'app-a', icon: 'ec2', label: 'App A', group: 'subnet-a' },
    { id: 'app-b', icon: 'ec2', label: 'App B', group: 'subnet-b' },
  ],
  edges: [
    { id: 'request', from: 'user', to: 'alb', label: 'HTTPS' },
    { id: 'to-a', from: 'alb', to: 'app-a' },
    { id: 'to-b', from: 'alb', to: 'app-b' },
    { id: 'user-to-vpc', from: 'user', to: 'vpc' },
    { id: 'office-link', from: 'office', to: 'vpc' },
  ],
  scenarios: [
    {
      id: 'az-failure',
      label: 'AZ A fails',
      initial: { 'to-b': 'hidden', 'subnet-b': 'normal' },
      steps: [
        { edge: 'request', packet: 'GET /', caption: 'A user request reaches the load balancer.' },
        {
          edge: 'to-a',
          reverse: true,
          packet: '200 OK',
          caption: 'The response travels back from the app tier.',
        },
        {
          node: 'alb',
          caption: 'The load balancer picks a target.',
          state: { alb: 'highlighted' },
        },
        {
          group: 'az-a',
          caption: 'AZ A fails.',
          state: { 'az-a': 'failed', 'app-a': 'broken' },
        },
        {
          edge: 'to-b',
          caption: 'Traffic shifts to AZ B.',
          state: { 'to-b': 'highlighted' },
          metrics: { 'Healthy targets': 1, cost: 0.03 },
        },
      ],
    },
    {
      id: 'recovery',
      label: 'AZ A recovers',
      steps: [{ group: 'az-a', caption: 'AZ A is healthy again.', state: { 'az-a': 'normal' } }],
    },
  ],
};

// The smallest valid diagram: every optional field omitted.
const minimalDiagram: Diagram = {
  id: 'tiny',
  title: 'Tiny',
  nodes: [{ id: 'n', icon: 'user', label: 'Node' }],
  scenarios: [{ id: 'only', label: 'Only scenario', steps: [{ node: 'n', caption: 'A node.' }] }],
};

/** A value the type system would refuse, to feed invalid data into a fixture. */
function bad(value: unknown): never {
  return value as never;
}

/** `items[index]`, failing loudly if the fixture does not have it. */
function at<T>(items: readonly T[] | undefined, index = 0): T {
  const item = items?.[index];
  if (item === undefined) throw new Error(`fixture has no item ${String(index)}`);
  return item;
}

/** Step `stepIndex` of scenario `scenarioIndex`. */
function stepAt(diagram: Diagram, stepIndex: number, scenarioIndex = 0): DiagramStep {
  return at(at(diagram.scenarios, scenarioIndex).steps, stepIndex);
}

/** A deep copy of a fixture, changed by `mutate`. */
function make(mutate: Mutator = () => undefined, base: Diagram = exampleDiagram): unknown {
  const copy = structuredClone(base);
  mutate(copy);
  return copy;
}

function node(id: string): DiagramNode {
  return { id, icon: 'user', label: `Node ${id}` };
}

function group(id: string): DiagramGroup {
  return { id, label: `Group ${id}`, kind: 'generic' };
}

function expectAccepted(data: unknown): void {
  const result = validateDiagram(data);
  expect(result.ok).toBe(true);
  expect(diagramSchema.safeParse(data).success).toBe(true);
}

/** Rejected by validateDiagram and diagramSchema, each needle appearing in some error string. */
function expectRejected(data: unknown, ...needles: string[]): void {
  const result = validateDiagram(data);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0);
    for (const needle of needles) {
      expect(result.errors.some((error) => error.includes(needle))).toBe(true);
    }
  }
  expect(diagramSchema.safeParse(data).success).toBe(false);
}

/** Rejected, with an error string of the form `<path>: <message>` for exactly this path. */
function expectRejectedAt(data: unknown, path: string): void {
  const result = validateDiagram(data);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.some((error) => error.startsWith(`${path}: `))).toBe(true);
  }
  expect(diagramSchema.safeParse(data).success).toBe(false);
}

describe('AC-1: valid diagrams', () => {
  test('AC-1: the PLAN.md example validates', () => {
    expectAccepted(exampleDiagram);
  });

  test('AC-1: validateDiagram returns ok with the diagram equal to the input (example)', () => {
    const result = validateDiagram(exampleDiagram);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagram).toEqual(exampleDiagram);
  });

  test('AC-1: the fuller fixture (nested groups, pos, sub, reverse + packet, metrics) validates', () => {
    expectAccepted(fullDiagram);
  });

  test('AC-1: validateDiagram returns ok with the diagram equal to the input (fuller fixture)', () => {
    const result = validateDiagram(fullDiagram);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagram).toEqual(fullDiagram);
  });

  test('AC-1: diagramSchema parses the fuller fixture to the same data', () => {
    const result = diagramSchema.safeParse(fullDiagram);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(fullDiagram);
  });

  test('AC-1: a minimal diagram (no description, groups or edges) validates', () => {
    expectAccepted(minimalDiagram);
  });

  test('AC-1: the fuller fixture really covers a node step, a group step with state and metrics', () => {
    const steps = at(fullDiagram.scenarios).steps;
    expect(steps.some((step) => step.node !== undefined)).toBe(true);
    expect(
      steps.some((step) => step.group !== undefined && step.state?.['az-a'] === 'failed'),
    ).toBe(true);
    expect(steps.some((step) => step.metrics !== undefined)).toBe(true);
  });
});

describe('AC-2: ids are lowercase slugs', () => {
  const badIds = ['S3', 's3 bucket', '', 's3_kms', '-s3', 's3-', 's3--kms'];
  // The element under test is appended as a spare, so its id is the only fault (nothing refers to it).
  const targets: [string, (d: Diagram, id: string) => void, string][] = [
    [
      'the diagram',
      (d, id) => {
        d.id = id;
      },
      'id',
    ],
    [
      'a group',
      (d, id) => {
        d.groups?.push(group(id));
      },
      'groups.1.id',
    ],
    [
      'a node',
      (d, id) => {
        d.nodes.push(node(id));
      },
      'nodes.4.id',
    ],
    [
      'an edge',
      (d, id) => {
        d.edges?.push({ id, from: 'client', to: 's3' });
      },
      'edges.3.id',
    ],
    [
      'a scenario',
      (d, id) => {
        d.scenarios.push({ id, label: 'Spare', steps: [{ node: 's3', caption: 'Spare step.' }] });
      },
      'scenarios.1.id',
    ],
  ];

  describe.each(targets)('%s', (what, plant, path) => {
    test.each(badIds)(`AC-2: rejects ${what} with the id %j`, (id) => {
      expectRejectedAt(
        make((d) => {
          plant(d, id);
        }),
        path,
      );
    });

    test(`AC-2: accepts ${what} with an id of digits and single hyphens`, () => {
      expectAccepted(
        make((d) => {
          plant(d, 'vpc-2-tier');
        }),
      );
    });
  });

  test('AC-2: rejects an id that is not a string', () => {
    expectRejectedAt(
      make((d) => {
        d.id = bad(42);
      }),
      'id',
    );
  });

  test('AC-2: rejects a node icon that is not a lowercase slug', () => {
    for (const icon of ['User', 'simple storage', '', 'icon_1']) {
      expectRejectedAt(
        make((d) => {
          at(d.nodes).icon = icon;
        }),
        'nodes.0.icon',
      );
    }
  });
});

describe('AC-3: ids are unique', () => {
  const clashes: [string, Mutator, string][] = [
    [
      'a node and an edge both named put',
      (d) => {
        d.nodes.push(node('put'));
      },
      'put',
    ],
    [
      'two nodes named s3',
      (d) => {
        d.nodes.push(node('s3'));
      },
      's3',
    ],
    [
      'a group and a node both named region',
      (d) => {
        d.nodes.push(node('region'));
      },
      'region',
    ],
    [
      'a group and an edge both named region',
      (d) => {
        d.edges?.push({ id: 'region', from: 'client', to: 's3' });
      },
      'region',
    ],
    [
      'two groups named region',
      (d) => {
        d.groups?.push(group('region'));
      },
      'region',
    ],
    [
      'two edges named put',
      (d) => {
        d.edges?.push({ id: 'put', from: 'kms', to: 'trail' });
      },
      'put',
    ],
  ];

  test.each(clashes)('AC-3: rejects %s, naming the id', (_label, clash, id) => {
    expectRejected(make(clash), id);
  });

  test('AC-3: rejects two scenarios with the same id, naming it', () => {
    const data = make((d) => {
      d.scenarios.push({
        id: 'upload',
        label: 'Same id again',
        steps: [{ node: 's3', caption: 'Another step.' }],
      });
    });
    expectRejected(data, 'upload');
  });

  test('AC-3: a scenario may reuse the id of a node (scenario ids are their own namespace)', () => {
    const data = make((d) => {
      d.scenarios.push({
        id: 's3',
        label: 'Named like a node',
        steps: [{ node: 's3', caption: 'Another step.' }],
      });
    });
    expectAccepted(data);
  });
});

describe('AC-4: groups and node membership', () => {
  test('AC-4: GROUP_KINDS lists the eleven group kinds', () => {
    expect([...GROUP_KINDS]).toEqual([
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
    ]);
  });

  test.each(GROUP_KINDS)('AC-4: accepts the group kind %s', (kind) => {
    expectAccepted(
      make((d) => {
        at(d.groups).kind = kind;
      }),
    );
  });

  test('AC-4: rejects a group with an unknown kind', () => {
    expectRejected(
      make((d) => {
        at(d.groups).kind = bad('subnet');
      }),
      'kind',
    );
  });

  test('AC-4: rejects a group with an unknown parent', () => {
    expectRejected(
      make((d) => {
        at(d.groups).parent = 'nowhere';
      }),
      'parent',
    );
  });

  test('AC-4: rejects a group that is its own parent', () => {
    expectRejected(
      make((d) => {
        at(d.groups).parent = 'region';
      }),
      'groups',
    );
  });

  test('AC-4: rejects a parent cycle between two groups (a -> b -> a)', () => {
    const data = make((d) => {
      d.groups = [
        { ...group('a'), parent: 'b' },
        { ...group('b'), parent: 'a' },
      ];
      for (const n of d.nodes) delete n.group;
    });
    expectRejected(data, 'groups');
  });

  test('AC-4: rejects a parent cycle through three groups', () => {
    const data = make((d) => {
      d.groups = [
        { ...group('a'), parent: 'c' },
        { ...group('b'), parent: 'a' },
        { ...group('c'), parent: 'b' },
      ];
      for (const n of d.nodes) delete n.group;
    });
    expectRejected(data, 'groups');
  });

  test('AC-4: rejects a group whose parent is a node id', () => {
    expectRejected(
      make((d) => {
        at(d.groups).parent = 's3';
      }),
      'parent',
    );
  });

  test('AC-4: accepts a parent declared after its child (order does not matter)', () => {
    const data = make((d) => {
      d.groups = [{ ...group('inner'), parent: 'outer' }, group('outer')];
      for (const n of d.nodes) delete n.group;
    });
    expectAccepted(data);
  });

  test('AC-4: rejects a node whose group is unknown', () => {
    expectRejected(
      make((d) => {
        at(d.nodes, 1).group = 'nowhere';
      }),
      'nodes.1.group',
    );
  });

  test('AC-4: rejects a node whose group is a node id', () => {
    expectRejected(
      make((d) => {
        at(d.nodes, 1).group = 'kms';
      }),
      'nodes.1.group',
    );
  });

  test('AC-4: rejects a node whose group is an edge id', () => {
    expectRejected(
      make((d) => {
        at(d.nodes, 1).group = 'put';
      }),
      'nodes.1.group',
    );
  });

  test('AC-4: rejects a node group when the diagram has no groups at all', () => {
    expectRejected(
      make((d) => {
        delete d.groups;
      }),
      'group',
    );
  });
});

describe('AC-5: edges', () => {
  test('AC-5: rejects an edge whose from is unknown', () => {
    expectRejected(
      make((d) => {
        at(d.edges).from = 'ghost';
      }),
      'edges.0.from',
    );
  });

  test('AC-5: rejects an edge whose to is unknown', () => {
    expectRejected(
      make((d) => {
        at(d.edges).to = 'ghost';
      }),
      'edges.0.to',
    );
  });

  test('AC-5: rejects an edge from a node to itself', () => {
    expectRejected(
      make((d) => {
        at(d.edges).to = 'client';
      }),
      'edges.0',
    );
  });

  test('AC-5: rejects an edge from a group to itself', () => {
    expectRejected(
      make((d) => {
        d.edges?.push({ id: 'loop', from: 'region', to: 'region' });
      }),
      'edges.3',
    );
  });

  test('AC-5: rejects an edge that ends at another edge', () => {
    expectRejected(
      make((d) => {
        at(d.edges).to = 'gen';
      }),
      'edges.0.to',
    );
  });

  test('AC-5: accepts an edge from a node to a group', () => {
    expectAccepted(
      make((d) => {
        d.edges?.push({ id: 'to-region', from: 'client', to: 'region' });
      }),
    );
  });

  test('AC-5: accepts an edge from a group to a node', () => {
    expectAccepted(
      make((d) => {
        d.edges?.push({ id: 'from-region', from: 'region', to: 'client' });
      }),
    );
  });

  test('AC-5: accepts an edge between two groups', () => {
    expectAccepted(
      make((d) => {
        d.groups?.push(group('office'));
        d.edges?.push({ id: 'link', from: 'office', to: 'region' });
      }),
    );
  });

  test('AC-5: rejects an edge without a from', () => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(at(d.edges), 'from');
      }),
      'from',
    );
  });
});

describe('AC-6: each step targets exactly one existing element of its kind', () => {
  test('AC-6: rejects a step with no target', () => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(stepAt(d, 0), 'edge');
      }),
      'scenarios.0.steps.0',
    );
  });

  test.each<[string, DiagramStep]>([
    ['edge + node', { edge: 'put', node: 's3', caption: 'Two targets.' }],
    ['edge + group', { edge: 'put', group: 'region', caption: 'Two targets.' }],
    ['node + group', { node: 's3', group: 'region', caption: 'Two targets.' }],
    ['edge + node + group', { edge: 'put', node: 's3', group: 'region', caption: 'Three.' }],
  ])('AC-6: rejects a step with two or more targets (%s)', (_label, step) => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[0] = step;
      }),
      'scenarios.0.steps.0',
    );
  });

  test.each<[string, DiagramStep, string]>([
    ['an unknown edge', { edge: 'gen2', caption: 'Unknown.' }, 'steps.0.edge'],
    ['an unknown node', { node: 'ghost', caption: 'Unknown.' }, 'steps.0.node'],
    ['an unknown group', { group: 'ghost', caption: 'Unknown.' }, 'steps.0.group'],
    ['a node id as edge', { edge: 's3', caption: 'Wrong kind.' }, 'steps.0.edge'],
    ['a group id as edge', { edge: 'region', caption: 'Wrong kind.' }, 'steps.0.edge'],
    ['an edge id as node', { node: 'put', caption: 'Wrong kind.' }, 'steps.0.node'],
    ['a group id as node', { node: 'region', caption: 'Wrong kind.' }, 'steps.0.node'],
    ['a node id as group', { group: 's3', caption: 'Wrong kind.' }, 'steps.0.group'],
    ['an edge id as group', { group: 'put', caption: 'Wrong kind.' }, 'steps.0.group'],
  ])('AC-6: rejects a step naming %s', (_label, step, path) => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[0] = step;
      }),
      path,
    );
  });

  test('AC-6: accepts a step on an edge, a node and a group of the right kind', () => {
    expectAccepted(
      make((d) => {
        at(d.scenarios).steps = [
          { edge: 'put', caption: 'An edge.' },
          { node: 's3', caption: 'A node.' },
          { group: 'region', caption: 'A group.' },
        ];
      }),
    );
  });

  test('AC-6: rejects an edge step when the diagram has no edges at all', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[0] = { edge: 'put', caption: 'No edges exist.' };
      }, minimalDiagram),
      'steps.0.edge',
    );
  });
});

describe('AC-7: reverse and packet belong to edge steps', () => {
  test('AC-7: rejects reverse on a node step', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[3] = { node: 's3', reverse: true, caption: 'Node step.' };
      }),
      'reverse',
    );
  });

  test('AC-7: rejects reverse on a group step', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[0] = { group: 'region', reverse: true, caption: 'Group step.' };
      }),
      'reverse',
    );
  });

  test('AC-7: rejects packet on a node step', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[3] = { node: 's3', packet: 'PutObject', caption: 'Node step.' };
      }),
      'packet',
    );
  });

  test('AC-7: rejects packet on a group step', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps[0] = { group: 'region', packet: 'PutObject', caption: 'Group.' };
      }),
      'packet',
    );
  });

  test.each(['', '   ', '\t\n'])('AC-7: rejects a blank packet %j on an edge step', (packet) => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).packet = packet;
      }),
      'packet',
    );
  });

  test('AC-7: accepts reverse and packet on an edge step', () => {
    expectAccepted(
      make((d) => {
        at(d.scenarios).steps[1] = {
          edge: 'gen',
          reverse: true,
          packet: 'GenerateDataKey',
          caption: 'The key travels back.',
        };
      }),
    );
  });

  test('AC-7: accepts reverse: false and a packet without reverse on edge steps', () => {
    expectAccepted(
      make((d) => {
        stepAt(d, 0).reverse = false;
        stepAt(d, 1).packet = 'GenerateDataKey';
      }),
    );
  });
});

describe('AC-8: state and initial', () => {
  test('AC-8: ELEMENT_STATES lists the six states', () => {
    expect([...ELEMENT_STATES]).toEqual([
      'normal',
      'highlighted',
      'appearing',
      'hidden',
      'failed',
      'broken',
    ]);
  });

  test.each(ELEMENT_STATES)('AC-8: accepts the state %s in a step and in initial', (state) => {
    expectAccepted(
      make((d) => {
        at(d.scenarios).initial = { s3: state };
        stepAt(d, 0).state = { s3: state };
      }),
    );
  });

  test('AC-8: accepts state keys that are a node, an edge and a group', () => {
    expectAccepted(
      make((d) => {
        stepAt(d, 0).state = { s3: 'highlighted', put: 'failed', region: 'broken' };
        at(d.scenarios).initial = { kms: 'hidden', gen: 'hidden', region: 'normal' };
      }),
    );
  });

  test.each(['upload', 'ghost'])(
    'AC-8: rejects a state key that is not an element id (%s)',
    (key) => {
      expectRejected(
        make((d) => {
          stepAt(d, 0).state = { [key]: 'failed' };
        }),
        'state',
      );
    },
  );

  test.each(['upload', 'ghost'])(
    'AC-8: rejects an initial key that is not an element id (%s)',
    (key) => {
      expectRejected(
        make((d) => {
          at(d.scenarios).initial = { [key]: 'hidden' };
        }),
        'initial',
      );
    },
  );

  test('AC-8: rejects a state value outside ELEMENT_STATES', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).state = { s3: bad('down') };
      }),
      'state',
    );
  });

  test('AC-8: rejects an initial value outside ELEMENT_STATES', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).initial = { s3: bad('down') };
      }),
      'initial',
    );
  });

  test('AC-8: rejects a state value that is not a string', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).state = { s3: bad(true) };
      }),
      'state',
    );
  });
});

describe('AC-9: metrics', () => {
  test('AC-9: rejects an empty metrics object', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = {};
      }),
      'metrics',
    );
  });

  test('AC-9: rejects metrics with four entries', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = { a: 1, b: 2, c: 3, d: 4 };
      }),
      'metrics',
    );
  });

  test.each(['', '   '])('AC-9: rejects a blank metric key %j', (key) => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = { [key]: 1 };
      }),
      'metrics',
    );
  });

  test.each(['', '   ', '\t\n'])('AC-9: rejects a blank string metric value %j', (value) => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = { cost: value };
      }),
      'metrics',
    );
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('AC-9: rejects a non-finite metric number (%s)', (_label, value) => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = { cost: value };
      }),
      'metrics',
    );
  });

  test('AC-9: rejects a metric value that is neither a string nor a number', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = { cost: bad(true) };
      }),
      'metrics',
    );
  });

  test('AC-9: accepts a numeric metric { cost: 0.03 }', () => {
    expectAccepted(
      make((d) => {
        stepAt(d, 0).metrics = { cost: 0.03 };
      }),
    );
  });

  test("AC-9: accepts a string metric { 'KMS requests': '+1' }", () => {
    expectAccepted(
      make((d) => {
        stepAt(d, 0).metrics = { 'KMS requests': '+1' };
      }),
    );
  });

  test('AC-9: accepts one, two and three entries, and the number 0', () => {
    for (const metrics of [{ a: 0 }, { a: 1, b: 'x' }, { a: 1, b: 2, c: '+3' }]) {
      expectAccepted(
        make((d) => {
          stepAt(d, 0).metrics = metrics;
        }),
      );
    }
  });
});

describe('AC-10: blank strings and caption length', () => {
  test.each(['', '   ', '\t\n'])('AC-10: rejects a blank caption %j', (caption) => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).caption = caption;
      }),
      'caption',
    );
  });

  test('AC-10: rejects a caption of 301 characters', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).caption = 'c'.repeat(301);
      }),
      'caption',
    );
  });

  test('AC-10: accepts a caption of 300 characters', () => {
    expectAccepted(
      make((d) => {
        stepAt(d, 0).caption = 'c'.repeat(300);
      }),
    );
  });

  test('AC-10: rejects a step without a caption', () => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(stepAt(d, 0), 'caption');
      }),
      'caption',
    );
  });

  const blankCases: [string, (d: Diagram, value: string) => void, string][] = [
    [
      'title',
      (d, value) => {
        d.title = value;
      },
      'title',
    ],
    [
      'description',
      (d, value) => {
        d.description = value;
      },
      'description',
    ],
    [
      'group label',
      (d, value) => {
        at(d.groups).label = value;
      },
      'groups.0.label',
    ],
    [
      'node label',
      (d, value) => {
        at(d.nodes).label = value;
      },
      'nodes.0.label',
    ],
    [
      'node sub',
      (d, value) => {
        at(d.nodes).sub = value;
      },
      'nodes.0.sub',
    ],
    [
      'edge label',
      (d, value) => {
        at(d.edges).label = value;
      },
      'edges.0.label',
    ],
    [
      'scenario label',
      (d, value) => {
        at(d.scenarios).label = value;
      },
      'scenarios.0.label',
    ],
  ];

  describe.each(blankCases)('blank %s', (what, apply, path) => {
    test.each(['', '   ', '\t\n'])(`AC-10: rejects a blank ${what} %j`, (value) => {
      expectRejected(
        make((d) => {
          apply(d, value);
        }),
        path,
      );
    });
  });

  test('AC-10: accepts a diagram with real content in title, description, labels and sub', () => {
    expectAccepted(
      make((d) => {
        d.description = 'Why this diagram exists.';
        at(d.nodes).sub = 'a subtitle';
        at(d.edges).label = 'HTTPS';
      }),
    );
  });
});

describe('AC-11: required content and strict keys', () => {
  test('AC-11: rejects a diagram with no nodes', () => {
    expectRejected(
      make((d) => {
        d.nodes = [];
        at(d.scenarios).steps = [{ group: 'g', caption: 'A group.' }];
        d.groups = [group('g')];
      }, minimalDiagram),
      'nodes',
    );
  });

  test('AC-11: rejects a diagram without a nodes field', () => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(d, 'nodes');
      }),
      'nodes',
    );
  });

  test('AC-11: rejects a diagram with no scenarios', () => {
    expectRejected(
      make((d) => {
        d.scenarios = [];
      }),
      'scenarios',
    );
  });

  test('AC-11: rejects a diagram without a scenarios field', () => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(d, 'scenarios');
      }),
      'scenarios',
    );
  });

  test('AC-11: rejects a scenario with no steps', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).steps = [];
      }),
      'scenarios.0.steps',
    );
  });

  test('AC-11: rejects a scenario without a steps field', () => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(at(d.scenarios), 'steps');
      }),
      'scenarios.0.steps',
    );
  });

  test.each(['id', 'title'])('AC-11: rejects a diagram without %s', (field) => {
    expectRejected(
      make((d) => {
        Reflect.deleteProperty(d, field);
      }),
      field,
    );
  });

  test('AC-11: rejects an unknown key at the top level', () => {
    expectRejected(
      make((d) => {
        Object.assign(d, { bogus: 1 });
      }),
      'bogus',
    );
  });

  test('AC-11: rejects an unknown key on a node', () => {
    expectRejected(
      make((d) => {
        Object.assign(at(d.nodes), { bogus: 1 });
      }),
      'nodes.0',
    );
  });

  test('AC-11: rejects an unknown key on a step', () => {
    expectRejected(
      make((d) => {
        Object.assign(stepAt(d, 0), { bogus: 1 });
      }),
      'scenarios.0.steps.0',
    );
  });

  test.each<[string, Mutator, string]>([
    [
      'a group',
      (d) => {
        Object.assign(at(d.groups), { bogus: 1 });
      },
      'groups.0',
    ],
    [
      'an edge',
      (d) => {
        Object.assign(at(d.edges), { bogus: 1 });
      },
      'edges.0',
    ],
    [
      'a scenario',
      (d) => {
        Object.assign(at(d.scenarios), { bogus: 1 });
      },
      'scenarios.0',
    ],
    [
      'a node pos',
      (d) => {
        at(d.nodes).pos = bad({ x: 1, y: 2, bogus: 1 });
      },
      'nodes.0.pos',
    ],
  ])('AC-11: rejects an unknown key on %s', (_label, mutate, path) => {
    expectRejected(make(mutate), path);
  });
});

describe('AC-12: node pos', () => {
  test.each<[string, unknown]>([
    ['a string x', { x: '10', y: 20 }],
    ['a string y', { x: 10, y: '20' }],
    ['NaN x', { x: Number.NaN, y: 20 }],
    ['NaN y', { x: 10, y: Number.NaN }],
    ['Infinity x', { x: Number.POSITIVE_INFINITY, y: 20 }],
    ['-Infinity y', { x: 10, y: Number.NEGATIVE_INFINITY }],
    ['a missing y', { x: 10 }],
    ['a missing x', { y: 20 }],
    ['null', null],
  ])('AC-12: rejects a pos with %s', (_label, pos) => {
    expectRejected(
      make((d) => {
        at(d.nodes).pos = bad(pos);
      }),
      'nodes.0.pos',
    );
  });

  test('AC-12: accepts zero, negative and fractional coordinates', () => {
    for (const pos of [
      { x: 0, y: 0 },
      { x: -15, y: 2.5 },
    ]) {
      expectAccepted(
        make((d) => {
          at(d.nodes).pos = pos;
        }),
      );
    }
  });
});

describe('AC-13: validateDiagram never throws and reports <path>: <message>', () => {
  test.each<[string, unknown]>([
    ['null', null],
    ['a string', 'multi-az-failover'],
    ['an empty object', {}],
    ['undefined', undefined],
    ['a number', 42],
    ['an array', []],
  ])('AC-13: returns ok: false with errors for %s without throwing', (_label, data) => {
    expect(() => validateDiagram(data)).not.toThrow();
    const result = validateDiagram(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(typeof error).toBe('string');
        expect(error).toContain(': ');
      }
    }
  });

  test('AC-13: a root-level problem uses the (root) path', () => {
    expectRejectedAt(null, '(root)');
  });

  test('AC-13: an empty object reports each required field by path', () => {
    const result = validateDiagram({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const field of ['id', 'title', 'nodes', 'scenarios']) {
        expect(result.errors.some((error) => error.startsWith(`${field}: `))).toBe(true);
      }
    }
  });

  test('AC-13: a step with an unknown edge is reported at scenarios.0.steps.1.edge', () => {
    const data = make((d) => {
      stepAt(d, 1).edge = 'gen2';
    });
    expectRejectedAt(data, 'scenarios.0.steps.1.edge');
    const result = validateDiagram(data);
    if (!result.ok) {
      expect(
        result.errors.some(
          (error) => error.startsWith('scenarios.0.steps.1.edge: ') && error.includes('gen2'),
        ),
      ).toBe(true);
    }
  });

  test('AC-13: does not throw on a diagram with collections of the wrong type', () => {
    const data = make((d) => {
      d.nodes = bad('not a list');
      d.groups = bad({});
      d.scenarios = bad(7);
    });
    expect(() => validateDiagram(data)).not.toThrow();
    expectRejected(data, 'nodes', 'groups', 'scenarios');
  });

  test('AC-13: a valid diagram yields ok: true and no errors field', () => {
    const result = validateDiagram(exampleDiagram);
    expect(result.ok).toBe(true);
    expect('errors' in result).toBe(false);
  });
});

describe('AC-14: package root exports', () => {
  test('AC-14: the package root exports diagramSchema, validateDiagram, GROUP_KINDS and ELEMENT_STATES', () => {
    expect(schemaRoot.diagramSchema).toBe(diagramSchema);
    expect(schemaRoot.validateDiagram).toBe(validateDiagram);
    expect(schemaRoot.GROUP_KINDS).toBe(GROUP_KINDS);
    expect(schemaRoot.ELEMENT_STATES).toBe(ELEMENT_STATES);
  });

  test('AC-14: validateDiagram imported from the package root validates the example', () => {
    expect(typeof schemaRoot.validateDiagram).toBe('function');
    expect(schemaRoot.validateDiagram(exampleDiagram).ok).toBe(true);
  });

  test('AC-14: diagramSchema imported from the package root parses the example', () => {
    expect(schemaRoot.diagramSchema.safeParse(exampleDiagram).success).toBe(true);
  });
});

describe('AC-15: an own __proto__ key in state, initial or metrics is rejected, not dropped', () => {
  test('AC-15: rejects a step state with an own __proto__ key', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).state = bad(JSON.parse('{"__proto__":"failed"}'));
      }),
      'state',
    );
  });

  test('AC-15: rejects a scenario initial with an own __proto__ key', () => {
    expectRejected(
      make((d) => {
        at(d.scenarios).initial = bad(JSON.parse('{"__proto__":"failed"}'));
      }),
      'initial',
    );
  });

  test('AC-15: rejects metrics with an own __proto__ key among three entries', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = bad(JSON.parse('{"__proto__":"x","a":1,"b":2,"c":3}'));
      }),
      'metrics',
    );
  });

  test('AC-15: rejects metrics whose only entry is an own __proto__ key', () => {
    expectRejected(
      make((d) => {
        stepAt(d, 0).metrics = bad(JSON.parse('{"__proto__":"x"}'));
      }),
      'metrics',
    );
  });
});

describe('AC-16: a parent chain that runs into a cycle it is not part of', () => {
  test('AC-16: rejects x -> p -> q -> p and returns', () => {
    const data = make((d) => {
      d.groups = [
        { ...group('x'), parent: 'p' },
        { ...group('p'), parent: 'q' },
        { ...group('q'), parent: 'p' },
      ];
      for (const n of d.nodes) delete n.group;
    });
    expect(() => validateDiagram(data)).not.toThrow();
    expectRejected(data, 'groups');
  });
});
