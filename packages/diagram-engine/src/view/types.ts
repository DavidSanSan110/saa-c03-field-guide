// Props of the diagram island: plain JSON prepared at build time (spec 012).
import type { CompiledDiagram } from '../graph.ts';

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
