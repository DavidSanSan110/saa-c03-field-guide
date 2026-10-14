// Build-time preparation of a diagram for the island (spec 012). Runs at build only.
import { textFallback } from '@field-guide/diagram-engine';
import type { FallbackScenario } from '@field-guide/diagram-engine';
import { compile } from '@field-guide/diagram-engine/compile';
import type { DiagramViewProps, IconSource } from '@field-guide/diagram-engine/view';
import { validateDiagram } from '@field-guide/schema';
import type { GroupKind } from '@field-guide/schema';

export type { DiagramViewProps, IconSource };

/** The group kinds that have an icon file under `public/diagram-icons/groups/`. */
export const GROUP_ICON_KINDS: readonly GroupKind[] = [
  'cloud',
  'account',
  'region',
  'vpc',
  'public-subnet',
  'private-subnet',
  'auto-scaling-group',
  'on-premises',
];

/** The icon at `diagram-icons/<name>.svg` with its optional `-dark` variant, or undefined when missing. */
function iconSource(
  name: string,
  iconExists: (publicPath: string) => boolean,
): IconSource | undefined {
  if (!iconExists(`diagram-icons/${name}.svg`)) return undefined;
  const light = `/diagram-icons/${name}.svg`;
  return iconExists(`diagram-icons/${name}-dark.svg`)
    ? { light, dark: `/diagram-icons/${name}-dark.svg` }
    : { light };
}

function idOf(input: unknown): string {
  const id =
    typeof input === 'object' && input !== null ? (input as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : '(unknown)';
}

/** Validates a diagram, checks its icon files and compiles both layouts; rejects with a message naming the problem. */
export async function prepareDiagram(
  input: unknown,
  opts: { iconExists: (publicPath: string) => boolean },
): Promise<{ props: DiagramViewProps; fallback: FallbackScenario[]; title: string; id: string }> {
  const result = validateDiagram(input);
  if (!result.ok) {
    throw new Error(`Diagram '${idOf(input)}' is invalid: ${result.errors.join('; ')}`);
  }
  const diagram = result.diagram;

  const icons: Record<string, IconSource> = {};
  for (const node of diagram.nodes) {
    const source = icons[node.icon] ?? iconSource(node.icon, opts.iconExists);
    if (source === undefined) {
      throw new Error(
        `Diagram '${diagram.id}': node '${node.id}' uses icon '${node.icon}', but public/diagram-icons/${node.icon}.svg is missing`,
      );
    }
    icons[node.icon] = source;
  }

  const groupIcons: Record<string, IconSource> = {};
  for (const group of diagram.groups ?? []) {
    if (!GROUP_ICON_KINDS.includes(group.kind)) continue;
    const source = groupIcons[group.kind] ?? iconSource(`groups/${group.kind}`, opts.iconExists);
    if (source === undefined) {
      throw new Error(
        `Diagram '${diagram.id}': group '${group.id}' of kind '${group.kind}' needs public/diagram-icons/groups/${group.kind}.svg, but it is missing`,
      );
    }
    groupIcons[group.kind] = source;
  }

  return {
    props: {
      wide: await compile(diagram),
      compact: await compile(diagram, { direction: 'down', applyPos: false }),
      icons,
      groupIcons,
    },
    fallback: textFallback(diagram),
    title: diagram.title,
    id: diagram.id,
  };
}
