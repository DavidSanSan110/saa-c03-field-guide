// Diagram player: a pure reducer over one diagram's scenarios (spec 011). Interface stubs only.
/* eslint-disable @typescript-eslint/no-unused-vars -- stubs: the signatures are final, the bodies are not written yet */
import type { Diagram, DiagramStep, ElementState } from '@field-guide/schema';

export interface PlayerState {
  /** Id of the current scenario. */
  scenario: string;
  /** -1 = before the first step; otherwise 0 … steps.length - 1. */
  step: number;
  playing: boolean;
  /** Increases by 1 every time `step` or `scenario` changes (lets the view restart the packet animation). */
  run: number;
}

export type PlayerAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'tick' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: number }
  | { type: 'reset' }
  | { type: 'scenario'; id: string };

export interface PlayerView {
  scenario: { id: string; label: string };
  /** `state.step`. */
  index: number;
  /** Number of steps in the scenario. */
  total: number;
  /** `step === -1`. */
  atStart: boolean;
  /** `step === total - 1`. */
  atEnd: boolean;
  /** Undefined at step -1. */
  step: DiagramStep | undefined;
  target: { kind: 'edge' | 'node' | 'group'; id: string } | undefined;
  /** Edge steps only. */
  packet: { edge: string; label?: string; reverse: boolean } | undefined;
  caption: string | undefined;
  metrics: Record<string, string | number> | undefined;
  /** Every group, node and edge id → its state now. */
  states: Record<string, ElementState>;
  playing: boolean;
  run: number;
}

export function initPlayer(diagram: Diagram, scenarioId?: string): PlayerState {
  throw new Error('not implemented');
}

export function playerReducer(
  diagram: Diagram,
  state: PlayerState,
  action: PlayerAction,
): PlayerState {
  throw new Error('not implemented');
}

export function viewPlayer(diagram: Diagram, state: PlayerState): PlayerView {
  throw new Error('not implemented');
}

export function statesAt(
  diagram: Diagram,
  scenarioId: string,
  step: number,
): Record<string, ElementState> {
  throw new Error('not implemented');
}
