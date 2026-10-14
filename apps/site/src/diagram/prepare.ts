/* eslint-disable @typescript-eslint/no-unused-vars -- interface stub: the implementation comes after the tests (spec 012) */
// Build-time preparation of a diagram for the island (spec 012). Interface stub: no behaviour yet.
import type { CompiledDiagram, FallbackScenario } from '@field-guide/diagram-engine';
import type { GroupKind } from '@field-guide/schema';

/** URLs under /diagram-icons/. */
export interface IconSource {
  light: string;
  dark?: string;
}

export interface DiagramViewProps {
  /** compile(d) */
  wide: CompiledDiagram;
  /** compile(d, { direction: 'down' }) */
  compact: CompiledDiagram;
  /** Every node icon slug the diagram uses. */
  icons: Record<string, IconSource>;
  /** Every group kind the diagram uses that has an icon. */
  groupIcons: Record<string, IconSource>;
}

export const GROUP_ICON_KINDS: readonly GroupKind[] = [];

export function prepareDiagram(
  input: unknown,
  opts: { iconExists: (publicPath: string) => boolean },
): Promise<{ props: DiagramViewProps; fallback: FallbackScenario[]; title: string; id: string }> {
  return Promise.reject(new Error('not implemented'));
}
