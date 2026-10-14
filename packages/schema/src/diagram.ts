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

/** Stub: every parse throws until the schema is implemented. */
export const diagramSchema: z.ZodType<Diagram> = z.custom<Diagram>(() => {
  throw new Error('not implemented');
});

export function validateDiagram(data: unknown): DiagramValidationResult {
  void data;
  throw new Error('not implemented');
}
