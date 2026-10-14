// Diagram player: a pure reducer over one diagram's scenarios (spec 011).
import type { Diagram, DiagramScenario, DiagramStep, ElementState } from '@field-guide/schema';

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

/** The scenario with this id, if the diagram has one. */
function findScenario(diagram: Diagram, id: string): DiagramScenario | undefined {
  return diagram.scenarios.find((scenario) => scenario.id === id);
}

/** The scenario with this id, or the first one (a valid diagram has at least one). */
function scenarioOrFirst(diagram: Diagram, id: string): DiagramScenario {
  return findScenario(diagram, id) ?? (diagram.scenarios[0] as DiagramScenario);
}

/** The same state when step and playing are unchanged; otherwise a new one, with `run` bumped if the step moved. */
function withStep(state: PlayerState, step: number, playing: boolean): PlayerState {
  if (step === state.step && playing === state.playing) return state;
  const run = step === state.step ? state.run : state.run + 1;
  return { scenario: state.scenario, step, playing, run };
}

/** Moves to a step (clamped to -1 … last) and pauses. */
function stopAt(diagram: Diagram, state: PlayerState, step: number): PlayerState {
  const last = scenarioOrFirst(diagram, state.scenario).steps.length - 1;
  return withStep(state, Math.min(Math.max(step, -1), last), false);
}

/** Starts playing; from before the first step or at the last one it begins at step 0. */
function startPlaying(diagram: Diagram, state: PlayerState): PlayerState {
  const last = scenarioOrFirst(diagram, state.scenario).steps.length - 1;
  const step = state.step === -1 || state.step === last ? 0 : state.step;
  return withStep(state, step, step < last);
}

/** One tick of the view's timer: advances while playing, and stops at the last step. */
function advance(diagram: Diagram, state: PlayerState): PlayerState {
  if (!state.playing) return state;
  const last = scenarioOrFirst(diagram, state.scenario).steps.length - 1;
  const step = Math.min(state.step + 1, last);
  return withStep(state, step, step < last);
}

/** Switches scenario at step -1, paused; an unknown or current id changes nothing. */
function switchScenario(diagram: Diagram, state: PlayerState, id: string): PlayerState {
  if (id === state.scenario || findScenario(diagram, id) === undefined) return state;
  return { scenario: id, step: -1, playing: false, run: state.run + 1 };
}

/** The player before the first step of the given scenario (the first one if it is unknown). */
export function initPlayer(diagram: Diagram, scenarioId?: string): PlayerState {
  const scenario = scenarioOrFirst(diagram, scenarioId ?? '');
  return { scenario: scenario.id, step: -1, playing: false, run: 0 };
}

/** The next player state for an action; no-ops return the same object. */
export function playerReducer(
  diagram: Diagram,
  state: PlayerState,
  action: PlayerAction,
): PlayerState {
  switch (action.type) {
    case 'play':
      return startPlaying(diagram, state);
    case 'pause':
      return withStep(state, state.step, false);
    case 'toggle':
      return state.playing ? withStep(state, state.step, false) : startPlaying(diagram, state);
    case 'tick':
      return advance(diagram, state);
    case 'next':
      return stopAt(diagram, state, state.step + 1);
    case 'back':
      return stopAt(diagram, state, state.step - 1);
    case 'goto':
      return stopAt(diagram, state, action.step);
    case 'reset':
      return stopAt(diagram, state, -1);
    case 'scenario':
      return switchScenario(diagram, state, action.id);
  }
}

/** What the target of a step is: its edge, node or group. */
function targetOf(step: DiagramStep): { kind: 'edge' | 'node' | 'group'; id: string } {
  if (step.edge !== undefined) return { kind: 'edge', id: step.edge };
  if (step.node !== undefined) return { kind: 'node', id: step.node };
  return { kind: 'group', id: step.group as string }; // a valid step has exactly one target
}

/** The packet travelling along an edge step, if any. */
function packetOf(step: DiagramStep): PlayerView['packet'] {
  if (step.edge === undefined) return undefined;
  const packet = { edge: step.edge, reverse: step.reverse ?? false };
  return step.packet === undefined ? packet : { ...packet, label: step.packet };
}

/** Everything the view needs for a player state, derived from the diagram. */
export function viewPlayer(diagram: Diagram, state: PlayerState): PlayerView {
  const scenario = scenarioOrFirst(diagram, state.scenario);
  const step = scenario.steps[state.step];
  return {
    scenario: { id: scenario.id, label: scenario.label },
    index: state.step,
    total: scenario.steps.length,
    atStart: state.step === -1,
    atEnd: state.step === scenario.steps.length - 1,
    step,
    target: step && targetOf(step),
    packet: step && packetOf(step),
    caption: step?.caption,
    metrics: step?.metrics,
    states: statesAt(diagram, scenario.id, state.step),
    playing: state.playing,
    run: state.run,
  };
}

/** The state of every group, node and edge after steps 0 … step (later steps win). */
export function statesAt(
  diagram: Diagram,
  scenarioId: string,
  step: number,
): Record<string, ElementState> {
  const scenario = scenarioOrFirst(diagram, scenarioId);
  const ids = [...(diagram.groups ?? []), ...diagram.nodes, ...(diagram.edges ?? [])].map(
    (element) => element.id,
  );
  const states: Record<string, ElementState> = {};
  for (const id of ids) states[id] = 'normal';
  Object.assign(states, scenario.initial);
  for (const { state } of scenario.steps.slice(0, step + 1)) Object.assign(states, state);
  return states;
}
