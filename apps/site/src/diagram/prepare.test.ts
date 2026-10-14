import { compile } from '@field-guide/diagram-engine/compile';
import { textFallback } from '@field-guide/diagram-engine';
import { validateDiagram } from '@field-guide/schema';
import type { Diagram, DiagramGroup } from '@field-guide/schema';
import { describe, expect, test, vi } from 'vitest';
import { viewFixture, viewFixtureMini } from '../../../../e2e/fixtures/view-fixture.ts';
import { GROUP_ICON_KINDS, prepareDiagram } from './prepare.ts';

// elkjs loads lazily on the first compile and can take a while on a cold machine.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The files of `public/` that exist, as the paths `iconExists` is asked about. */
function filesOf(...paths: string[]) {
  const present = new Set(paths);
  const asked: string[] = [];
  return {
    iconExists: (publicPath: string) => {
      asked.push(publicPath);
      return present.has(publicPath);
    },
    asked,
  };
}

/** Every icon file `view-fixture` needs (the light ones), plus the optional dark user icon and the region icon. */
const fixtureFiles = [
  'diagram-icons/user.svg',
  'diagram-icons/user-dark.svg',
  'diagram-icons/simple-storage-service.svg',
  'diagram-icons/key-management-service.svg',
  'diagram-icons/cloudtrail.svg',
  'diagram-icons/groups/region.svg',
];

function clone(diagram: Diagram): Diagram {
  return structuredClone(diagram);
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the promise to reject');
}

/** A tiny diagram with one group of the given kind and one node in it. */
function groupDiagram(kind: DiagramGroup): Diagram {
  return {
    id: 'group-check',
    title: 'Group check',
    groups: [kind],
    nodes: [{ id: 'bucket', icon: 'simple-storage-service', label: 'Bucket', group: kind.id }],
    scenarios: [{ id: 'main', label: 'Main', steps: [{ node: 'bucket', caption: 'A bucket.' }] }],
  };
}

// ---------------------------------------------------------------------------
// The fixtures (spec 012, "Fixture route")
// ---------------------------------------------------------------------------

describe('the e2e fixtures', () => {
  test('both fixture diagrams are valid', () => {
    expect(validateDiagram(viewFixture).ok).toBe(true);
    expect(validateDiagram(viewFixtureMini).ok).toBe(true);
  });

  test('view-fixture has the shape the spec describes', () => {
    expect(viewFixture.id).toBe('view-fixture');
    expect(viewFixture.title).toBe('View fixture');
    expect(viewFixture.scenarios.map((scenario) => scenario.id)).toEqual([
      'upload',
      'key-disabled',
    ]);
    expect(viewFixture.scenarios.map((scenario) => scenario.steps.length)).toEqual([5, 5]);
    expect(viewFixture.nodes.find((node) => node.id === 'trail')?.pos).toBeDefined();
  });

  test('view-fixture-mini has one scenario, two nodes and no groups or edges', () => {
    expect(viewFixtureMini.id).toBe('view-fixture-mini');
    expect(viewFixtureMini.nodes).toHaveLength(2);
    expect(viewFixtureMini.groups ?? []).toHaveLength(0);
    expect(viewFixtureMini.edges ?? []).toHaveLength(0);
    expect(viewFixtureMini.scenarios).toHaveLength(1);
    expect(viewFixtureMini.scenarios[0]?.steps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-11 prepareDiagram on a valid diagram
// ---------------------------------------------------------------------------

describe('AC-11: prepareDiagram resolves the props of a valid diagram', () => {
  test('AC-11: wide is compile(d) (direction right) and compact is compile(d, down)', async () => {
    const { props } = await prepareDiagram(viewFixture, filesOf(...fixtureFiles));

    expect(props.wide.direction).toBe('right');
    expect(props.compact.direction).toBe('down');
    expect(props.wide).toEqual(await compile(viewFixture));
    expect(props.compact).toEqual(await compile(viewFixture, { direction: 'down' }));
  });

  test('AC-11: id and title come from the diagram', async () => {
    const result = await prepareDiagram(viewFixture, filesOf(...fixtureFiles));

    expect(result.id).toBe('view-fixture');
    expect(result.title).toBe('View fixture');
  });

  test('AC-11: the fallback equals textFallback(diagram)', async () => {
    const { fallback } = await prepareDiagram(viewFixture, filesOf(...fixtureFiles));

    expect(fallback).toEqual(textFallback(viewFixture));
  });

  test('AC-11: icons has one entry per node icon used, with dark only when the -dark file exists', async () => {
    const { props } = await prepareDiagram(viewFixture, filesOf(...fixtureFiles));

    expect(props.icons).toStrictEqual({
      user: { light: '/diagram-icons/user.svg', dark: '/diagram-icons/user-dark.svg' },
      'simple-storage-service': { light: '/diagram-icons/simple-storage-service.svg' },
      'key-management-service': { light: '/diagram-icons/key-management-service.svg' },
      cloudtrail: { light: '/diagram-icons/cloudtrail.svg' },
    });
  });

  test('AC-11: an icon used by several nodes appears once', async () => {
    const { props } = await prepareDiagram(
      viewFixtureMini,
      filesOf('diagram-icons/simple-storage-service.svg'),
    );

    expect(props.icons).toStrictEqual({
      'simple-storage-service': { light: '/diagram-icons/simple-storage-service.svg' },
    });
    expect(props.groupIcons).toStrictEqual({});
  });

  test('AC-11: groupIcons has an entry for a used kind that has an icon, and none for generic', async () => {
    const { props } = await prepareDiagram(viewFixture, filesOf(...fixtureFiles));

    expect(props.groupIcons).toStrictEqual({
      region: { light: '/diagram-icons/groups/region.svg' },
    });
  });

  test('AC-11: a -dark group icon file becomes the dark variant', async () => {
    const { props } = await prepareDiagram(
      viewFixture,
      filesOf(...fixtureFiles, 'diagram-icons/groups/region-dark.svg'),
    );

    expect(props.groupIcons).toStrictEqual({
      region: {
        light: '/diagram-icons/groups/region.svg',
        dark: '/diagram-icons/groups/region-dark.svg',
      },
    });
  });

  test('AC-11: with every file present only the used kinds and icons are listed', async () => {
    const everything = { iconExists: () => true };

    const { props } = await prepareDiagram(viewFixture, everything);

    expect(Object.keys(props.groupIcons)).toEqual(['region']);
    expect(Object.keys(props.icons).sort()).toEqual([
      'cloudtrail',
      'key-management-service',
      'simple-storage-service',
      'user',
    ]);
    for (const icon of Object.values(props.icons)) expect(icon.dark).toBeDefined();
  });

  test('AC-11: GROUP_ICON_KINDS lists the eight kinds that have an icon', () => {
    expect([...GROUP_ICON_KINDS].sort()).toEqual(
      [
        'cloud',
        'account',
        'region',
        'vpc',
        'public-subnet',
        'private-subnet',
        'auto-scaling-group',
        'on-premises',
      ].sort(),
    );
  });

  test('AC-11: the input is validated data: props.wide.diagram deep-equals the input', async () => {
    const { props } = await prepareDiagram(
      viewFixtureMini,
      filesOf('diagram-icons/simple-storage-service.svg'),
    );

    expect(props.wide.diagram).toEqual(viewFixtureMini);
    expect(props.compact.diagram).toEqual(viewFixtureMini);
  });
});

// ---------------------------------------------------------------------------
// AC-12 invalid input
// ---------------------------------------------------------------------------

describe('AC-12: an invalid diagram rejects', () => {
  test('AC-12: the message starts with Diagram <id> is invalid and contains the failing path', async () => {
    const broken = clone(viewFixture);
    const step = broken.scenarios[0]?.steps[1];
    if (step === undefined) throw new Error('fixture changed');
    step.edge = 'no-such-edge';

    const message = await rejectionOf(prepareDiagram(broken, filesOf(...fixtureFiles)));

    expect(message.startsWith("Diagram 'view-fixture' is invalid:")).toBe(true);
    expect(message).toContain('scenarios.0.steps.1.edge');
  });

  test('AC-12: every validation error is in the message, joined by a semicolon', async () => {
    const broken = clone(viewFixture);
    const first = broken.scenarios[0]?.steps[0];
    const second = broken.scenarios[0]?.steps[1];
    if (first === undefined || second === undefined) throw new Error('fixture changed');
    first.edge = 'nope-one';
    second.edge = 'nope-two';

    const message = await rejectionOf(prepareDiagram(broken, filesOf(...fixtureFiles)));

    expect(message).toContain('scenarios.0.steps.0.edge');
    expect(message).toContain('scenarios.0.steps.1.edge');
    expect(message).toContain('; ');
  });

  test('AC-12: a non-object input rejects with Diagram (unknown) is invalid', async () => {
    for (const input of [42, 'text', null, undefined, []]) {
      const message = await rejectionOf(prepareDiagram(input, filesOf()));
      expect(message.startsWith("Diagram '(unknown)' is invalid:"), String(input)).toBe(true);
    }
  });

  test('AC-12: an object whose id is not a string rejects with (unknown)', async () => {
    const message = await rejectionOf(prepareDiagram({ id: 7, title: 'x' }, filesOf()));

    expect(message.startsWith("Diagram '(unknown)' is invalid:")).toBe(true);
  });

  test('AC-12: an object with a string id but no nodes uses that id', async () => {
    const message = await rejectionOf(prepareDiagram({ id: 'half-done', title: 'x' }, filesOf()));

    expect(message.startsWith("Diagram 'half-done' is invalid:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-13 missing icons
// ---------------------------------------------------------------------------

describe('AC-13: missing icon files reject', () => {
  test('AC-13: a missing node icon names the node, the icon and public/diagram-icons/<icon>.svg', async () => {
    const files = fixtureFiles.filter((file) => file !== 'diagram-icons/user.svg');

    const message = await rejectionOf(prepareDiagram(viewFixture, filesOf(...files)));

    expect(message).toBe(
      "Diagram 'view-fixture': node 'client' uses icon 'user', but public/diagram-icons/user.svg is missing",
    );
  });

  test('AC-13: a missing dark node icon is fine', async () => {
    const files = fixtureFiles.filter((file) => file !== 'diagram-icons/user-dark.svg');

    const { props } = await prepareDiagram(viewFixture, filesOf(...files));

    expect(props.icons['user']).toStrictEqual({ light: '/diagram-icons/user.svg' });
  });

  test('AC-13: a used region group without groups/region.svg names the group and the kind', async () => {
    const files = fixtureFiles.filter((file) => file !== 'diagram-icons/groups/region.svg');
    const diagram = groupDiagram({ id: 'eu-main', label: 'EU main', kind: 'region' });

    const message = await rejectionOf(prepareDiagram(diagram, filesOf(...files)));

    expect(message).toContain("Diagram 'group-check'");
    expect(message).toContain('eu-main');
    expect(message).toContain('region');
    expect(message).toContain('diagram-icons/groups/region.svg');
  });

  test('AC-13: the view-fixture region group also needs its icon file', async () => {
    const files = fixtureFiles.filter((file) => file !== 'diagram-icons/groups/region.svg');

    const message = await rejectionOf(prepareDiagram(viewFixture, filesOf(...files)));

    expect(message).toContain('diagram-icons/groups/region.svg');
  });

  test('AC-13: az and generic groups need no icon file', async () => {
    const diagram: Diagram = {
      id: 'no-icon-groups',
      title: 'No icon groups',
      groups: [
        { id: 'zone', label: 'AZ a', kind: 'az' },
        { id: 'other', label: 'Other', kind: 'generic' },
        { id: 'firewall', label: 'Firewall', kind: 'security-group' },
      ],
      nodes: [
        { id: 'bucket', icon: 'simple-storage-service', label: 'Bucket', group: 'zone' },
        { id: 'second', icon: 'simple-storage-service', label: 'Second', group: 'other' },
      ],
      scenarios: [{ id: 'main', label: 'Main', steps: [{ node: 'bucket', caption: 'A bucket.' }] }],
    };
    const files = filesOf('diagram-icons/simple-storage-service.svg');

    const { props } = await prepareDiagram(diagram, files);

    expect(props.groupIcons).toStrictEqual({});
    expect(files.asked.some((path) => path.startsWith('diagram-icons/groups/'))).toBe(false);
  });

  test('AC-13: a group kind that is not used does not need its icon', async () => {
    // view-fixture uses region and generic only: no vpc.svg is needed.
    const { props } = await prepareDiagram(viewFixture, filesOf(...fixtureFiles));

    expect(Object.keys(props.groupIcons)).not.toContain('vpc');
  });
});
