import { validateDiagram } from '@field-guide/schema';
import type { Diagram, ElementState } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import * as engineRoot from './index.ts';
import { initPlayer, playerReducer, statesAt, viewPlayer } from './player.ts';
import type { PlayerAction, PlayerState } from './player.ts';

// Fixture: two scenarios of different shapes plus a one-step scenario.
//
// main (5 steps, last = 4), initial: db hidden
//   0 edge  e-req   packet 'GET /'              state e-req highlighted          metrics latency
//   1 node  web                                 state web highlighted, db appearing
//   2 edge  e-query reverse, packet 'rows'      state e-req normal, db highlighted
//   3 group g-vpc                               state g-vpc failed               metrics requests, errors
//   4 edge  e-query (no packet, no reverse)     no state
// second (2 steps), initial: client highlighted, web hidden
//   0 node  web                                 state web appearing
//   1 edge  e-query                             state e-query failed, client normal
// single (1 step)
//   0 node  db

const ELEMENT_IDS = ['client', 'db', 'e-query', 'e-req', 'g-vpc', 'web'];
const LAST = 4;

function makeDiagram(): Diagram {
  return {
    id: 'player-demo',
    title: 'Player demo',
    groups: [{ id: 'g-vpc', label: 'VPC', kind: 'vpc' }],
    nodes: [
      { id: 'client', icon: 'user', label: 'Client' },
      { id: 'web', icon: 'ec2', label: 'Web', group: 'g-vpc' },
      { id: 'db', icon: 'rds', label: 'Database', group: 'g-vpc' },
    ],
    edges: [
      { id: 'e-req', from: 'client', to: 'web' },
      { id: 'e-query', from: 'web', to: 'db' },
    ],
    scenarios: [
      {
        id: 'main',
        label: 'Main flow',
        initial: { db: 'hidden' },
        steps: [
          {
            edge: 'e-req',
            packet: 'GET /',
            caption: 'The client calls the web tier',
            state: { 'e-req': 'highlighted' },
            metrics: { latency: '20 ms' },
          },
          {
            node: 'web',
            caption: 'The web tier renders the page',
            state: { web: 'highlighted', db: 'appearing' },
          },
          {
            edge: 'e-query',
            reverse: true,
            packet: 'rows',
            caption: 'The database answers',
            state: { 'e-req': 'normal', db: 'highlighted' },
          },
          {
            group: 'g-vpc',
            caption: 'The whole VPC fails',
            state: { 'g-vpc': 'failed' },
            metrics: { requests: 3, errors: 1 },
          },
          { edge: 'e-query', caption: 'Nothing flows any more' },
        ],
      },
      {
        id: 'second',
        label: 'Failure case',
        initial: { client: 'highlighted', web: 'hidden' },
        steps: [
          { node: 'web', caption: 'The web tier appears', state: { web: 'appearing' } },
          {
            edge: 'e-query',
            caption: 'The query fails',
            state: { 'e-query': 'failed', client: 'normal' },
          },
        ],
      },
      {
        id: 'single',
        label: 'Single step',
        steps: [{ node: 'db', caption: 'Only one step', state: { db: 'highlighted' } }],
      },
    ],
  };
}

function normalWith(overrides: Record<string, ElementState>): Record<string, ElementState> {
  const states: Record<string, ElementState> = {};
  for (const id of ELEMENT_IDS) states[id] = 'normal';
  return { ...states, ...overrides };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Applies the actions one after the other, starting from `state`. */
function run(diagram: Diagram, state: PlayerState, ...actions: PlayerAction[]): PlayerState {
  return actions.reduce((current, action) => playerReducer(diagram, current, action), state);
}

const next: PlayerAction = { type: 'next' };
const back: PlayerAction = { type: 'back' };
const play: PlayerAction = { type: 'play' };
const pause: PlayerAction = { type: 'pause' };
const toggle: PlayerAction = { type: 'toggle' };
const tick: PlayerAction = { type: 'tick' };
const reset: PlayerAction = { type: 'reset' };
const goto = (step: number): PlayerAction => ({ type: 'goto', step });
const scenario = (id: string): PlayerAction => ({ type: 'scenario', id });

/** A player on `main`, paused at `step`. */
function pausedAt(diagram: Diagram, step: number): PlayerState {
  return run(diagram, initPlayer(diagram), goto(step));
}

/** A player on `main`, playing at `step` (0 … LAST - 1). */
function playingAt(diagram: Diagram, step: number): PlayerState {
  const state = run(diagram, pausedAt(diagram, step), play);
  expect(state.playing).toBe(true);
  expect(state.step).toBe(step);
  return state;
}

describe('fixture', () => {
  test('the fixture diagram is valid', () => {
    expect(validateDiagram(makeDiagram())).toEqual({ ok: true, diagram: makeDiagram() });
  });
});

describe('initPlayer', () => {
  test('AC-1: initPlayer(d) starts on the first scenario, before the first step', () => {
    expect(initPlayer(makeDiagram())).toStrictEqual({
      scenario: 'main',
      step: -1,
      playing: false,
      run: 0,
    });
  });

  test('AC-1: initPlayer(d, id) picks that scenario', () => {
    expect(initPlayer(makeDiagram(), 'second')).toStrictEqual({
      scenario: 'second',
      step: -1,
      playing: false,
      run: 0,
    });
  });

  test('AC-1: an unknown scenario id falls back to the first scenario', () => {
    expect(initPlayer(makeDiagram(), 'nope')).toStrictEqual({
      scenario: 'main',
      step: -1,
      playing: false,
      run: 0,
    });
  });
});

describe('next and back', () => {
  test('AC-2: next walks 0, 1, ... up to the last step and stays there', () => {
    const d = makeDiagram();
    let state = initPlayer(d);
    const seen: number[] = [];
    for (let i = 0; i < LAST + 3; i++) {
      state = playerReducer(d, state, next);
      seen.push(state.step);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 4, 4]);
  });

  test('AC-2: back walks down to -1 and stays there', () => {
    const d = makeDiagram();
    let state = pausedAt(d, 2);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      state = playerReducer(d, state, back);
      seen.push(state.step);
    }
    expect(seen).toEqual([1, 0, -1, -1, -1]);
  });

  test('AC-2: next pauses playback', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 1), next);
    expect(state.step).toBe(2);
    expect(state.playing).toBe(false);
  });

  test('AC-2: back pauses playback', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 2), back);
    expect(state.step).toBe(1);
    expect(state.playing).toBe(false);
  });

  test('AC-2: next and back keep the scenario', () => {
    const d = makeDiagram();
    const state = run(d, initPlayer(d, 'second'), next, next, back);
    expect(state.scenario).toBe('second');
    expect(state.step).toBe(0);
  });

  test('AC-2: next stops at the last step of the current scenario, not of the first one', () => {
    const d = makeDiagram();
    const state = run(d, initPlayer(d, 'second'), next, next, next, next);
    expect(state.step).toBe(1);
  });
});

describe('goto', () => {
  test('AC-3: goto 2 jumps to step 2', () => {
    const d = makeDiagram();
    expect(playerReducer(d, initPlayer(d), goto(2)).step).toBe(2);
  });

  test('AC-3: goto past the end clamps to the last step', () => {
    const d = makeDiagram();
    expect(playerReducer(d, initPlayer(d), goto(99)).step).toBe(LAST);
  });

  test('AC-3: goto below -1 clamps to -1', () => {
    const d = makeDiagram();
    expect(playerReducer(d, pausedAt(d, 3), goto(-5)).step).toBe(-1);
  });

  test('AC-3: goto 0 and goto -1 reach the two lower bounds exactly', () => {
    const d = makeDiagram();
    expect(playerReducer(d, initPlayer(d), goto(0)).step).toBe(0);
    expect(playerReducer(d, pausedAt(d, 3), goto(-1)).step).toBe(-1);
  });

  test('AC-3: goto clamps to the last step of the current scenario', () => {
    const d = makeDiagram();
    expect(playerReducer(d, initPlayer(d, 'second'), goto(99)).step).toBe(1);
  });

  test('AC-3: goto pauses playback', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 1), goto(3));
    expect(state.step).toBe(3);
    expect(state.playing).toBe(false);
  });
});

describe('play', () => {
  test('AC-4: play from -1 moves to step 0 and starts playing', () => {
    const d = makeDiagram();
    const state = playerReducer(d, initPlayer(d), play);
    expect(state.step).toBe(0);
    expect(state.playing).toBe(true);
  });

  test('AC-4: play at the last step replays from step 0', () => {
    const d = makeDiagram();
    const state = playerReducer(d, pausedAt(d, LAST), play);
    expect(state.step).toBe(0);
    expect(state.playing).toBe(true);
  });

  test('AC-4: play mid-way keeps the step and starts playing', () => {
    const d = makeDiagram();
    const state = playerReducer(d, pausedAt(d, 2), play);
    expect(state.step).toBe(2);
    expect(state.playing).toBe(true);
  });

  test('AC-4: play keeps the scenario', () => {
    const d = makeDiagram();
    expect(playerReducer(d, initPlayer(d, 'second'), play).scenario).toBe('second');
  });

  test('AC-4: play while already playing mid-way is a no-op that returns the same object', () => {
    const d = makeDiagram();
    const state = playingAt(d, 2);
    expect(playerReducer(d, state, play)).toBe(state);
  });
});

describe('tick', () => {
  test('AC-5: tick while playing advances one step and keeps playing', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 0), tick);
    expect(state.step).toBe(1);
    expect(state.playing).toBe(true);
  });

  test('AC-5: the tick that reaches the last step sets playing to false', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, LAST - 1), tick);
    expect(state.step).toBe(LAST);
    expect(state.playing).toBe(false);
  });

  test('AC-5: play then ticking to the end visits every step once and stops', () => {
    const d = makeDiagram();
    let state = playerReducer(d, initPlayer(d), play);
    const seen = [state.step];
    while (state.playing) {
      state = playerReducer(d, state, tick);
      seen.push(state.step);
      expect(seen.length).toBeLessThanOrEqual(LAST + 2);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(state.playing).toBe(false);
  });

  test('AC-5: tick while paused returns the same object', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 1);
    expect(playerReducer(d, state, tick)).toBe(state);
  });

  test('AC-5: tick while paused at -1 returns the same object', () => {
    const d = makeDiagram();
    const state = initPlayer(d);
    expect(playerReducer(d, state, tick)).toBe(state);
  });
});

describe('pause and toggle', () => {
  test('AC-6: pause stops playback and keeps the step', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 2), pause);
    expect(state.playing).toBe(false);
    expect(state.step).toBe(2);
  });

  test('AC-6: toggle from paused at -1 plays from step 0', () => {
    const d = makeDiagram();
    const state = playerReducer(d, initPlayer(d), toggle);
    expect(state.playing).toBe(true);
    expect(state.step).toBe(0);
  });

  test('AC-6: toggle from paused mid-way plays from the same step', () => {
    const d = makeDiagram();
    const state = playerReducer(d, pausedAt(d, 2), toggle);
    expect(state.playing).toBe(true);
    expect(state.step).toBe(2);
  });

  test('AC-6: toggle from paused at the last step replays from step 0', () => {
    const d = makeDiagram();
    const state = playerReducer(d, pausedAt(d, LAST), toggle);
    expect(state.playing).toBe(true);
    expect(state.step).toBe(0);
  });

  test('AC-6: toggle while playing pauses and keeps the step', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 3), toggle);
    expect(state.playing).toBe(false);
    expect(state.step).toBe(3);
  });

  test('AC-6: toggle twice mid-way is back to paused at the same step', () => {
    const d = makeDiagram();
    const state = run(d, pausedAt(d, 1), toggle, toggle);
    expect(state.playing).toBe(false);
    expect(state.step).toBe(1);
  });
});

describe('reset', () => {
  test('AC-7: reset from mid-way returns to -1 and pauses', () => {
    const d = makeDiagram();
    const state = playerReducer(d, pausedAt(d, 3), reset);
    expect(state.step).toBe(-1);
    expect(state.playing).toBe(false);
  });

  test('AC-7: reset while playing pauses', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 1), reset);
    expect(state.step).toBe(-1);
    expect(state.playing).toBe(false);
  });

  test('AC-7: reset does not change the scenario', () => {
    const d = makeDiagram();
    const state = run(d, initPlayer(d, 'second'), next, reset);
    expect(state.scenario).toBe('second');
    expect(state.step).toBe(-1);
  });
});

describe('scenario', () => {
  test('AC-8: scenario with another id switches to it at -1, paused', () => {
    const d = makeDiagram();
    const state = playerReducer(d, playingAt(d, 2), scenario('second'));
    expect(state.scenario).toBe('second');
    expect(state.step).toBe(-1);
    expect(state.playing).toBe(false);
  });

  test('AC-8: scenario with an unknown id returns the same object', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(playerReducer(d, state, scenario('nope'))).toBe(state);
  });

  test('AC-8: scenario with the current id returns the same object', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(playerReducer(d, state, scenario('main'))).toBe(state);
  });

  test('AC-8: scenario with the current id does not stop playback', () => {
    const d = makeDiagram();
    const state = playingAt(d, 1);
    expect(playerReducer(d, state, scenario('main'))).toBe(state);
  });
});

describe('run counter', () => {
  test('AC-9: run increases by exactly 1 on every next, back and goto that changes the step', () => {
    const d = makeDiagram();
    const states = [initPlayer(d)];
    for (const action of [next, next, back, goto(4), goto(-1)]) {
      const previous = states[states.length - 1] as PlayerState;
      states.push(playerReducer(d, previous, action));
    }
    expect(states.map((state) => state.run)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('AC-9: run increases by 1 when play moves from -1 to step 0', () => {
    const d = makeDiagram();
    expect(playerReducer(d, initPlayer(d), play).run).toBe(1);
  });

  test('AC-9: run increases by 1 when play replays from the last step to step 0', () => {
    const d = makeDiagram();
    const atEnd = pausedAt(d, LAST);
    expect(playerReducer(d, atEnd, play).run).toBe(atEnd.run + 1);
  });

  test('AC-9: run increases by 1 on a tick that advances, including the one that stops at the end', () => {
    const d = makeDiagram();
    const playing = playingAt(d, LAST - 1);
    const afterTick = playerReducer(d, playing, tick);
    expect(afterTick.run).toBe(playing.run + 1);
    expect(afterTick.step).toBe(LAST);
  });

  test('AC-9: run increases by 1 when reset leaves a step', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(playerReducer(d, state, reset).run).toBe(state.run + 1);
  });

  test('AC-9: run increases by 1 when the scenario changes, even from step -1', () => {
    const d = makeDiagram();
    const state = initPlayer(d);
    expect(playerReducer(d, state, scenario('second')).run).toBe(state.run + 1);
  });

  test('AC-9: run is unchanged by pause', () => {
    const d = makeDiagram();
    const state = playingAt(d, 2);
    expect(playerReducer(d, state, pause).run).toBe(state.run);
  });

  test('AC-9: run is unchanged by play mid-way', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(playerReducer(d, state, play).run).toBe(state.run);
  });

  test('AC-9: run is unchanged by toggle mid-way, in both directions', () => {
    const d = makeDiagram();
    const paused = pausedAt(d, 2);
    const playing = playerReducer(d, paused, toggle);
    expect(playing.run).toBe(paused.run);
    expect(playerReducer(d, playing, toggle).run).toBe(paused.run);
  });

  test('AC-9: run is unchanged by goto to the current step while playing, which only pauses', () => {
    const d = makeDiagram();
    const state = playingAt(d, 2);
    const after = playerReducer(d, state, goto(2));
    expect(after.step).toBe(2);
    expect(after.playing).toBe(false);
    expect(after.run).toBe(state.run);
  });

  test('AC-9: run is unchanged by no-ops', () => {
    const d = makeDiagram();
    const atStart = initPlayer(d);
    const atEnd = pausedAt(d, LAST);
    expect(playerReducer(d, atStart, back).run).toBe(atStart.run);
    expect(playerReducer(d, atStart, reset).run).toBe(atStart.run);
    expect(playerReducer(d, atStart, tick).run).toBe(atStart.run);
    expect(playerReducer(d, atStart, scenario('nope')).run).toBe(atStart.run);
    expect(playerReducer(d, atEnd, next).run).toBe(atEnd.run);
    expect(playerReducer(d, atEnd, goto(99)).run).toBe(atEnd.run);
  });

  test('AC-9: run counts every change over a longer session', () => {
    const d = makeDiagram();
    // play (+1: -1 -> 0), tick (+1), pause (0), play (0), next (+1, pauses),
    // scenario (+1), next (+1), back (+1: 0 -> -1), back (0: no-op at -1), back (0)
    const actions = [play, tick, pause, play, next, scenario('second'), next, back, back, back];
    const expected = [1, 2, 2, 2, 3, 4, 5, 6, 6, 6];
    let state = initPlayer(d);
    const runs: number[] = [];
    for (const action of actions) {
      state = playerReducer(d, state, action);
      runs.push(state.run);
    }
    expect(runs).toEqual(expected);
  });
});

describe('statesAt', () => {
  test('AC-10: at -1 every element is normal, overlaid with the scenario initial', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'main', -1)).toEqual(normalWith({ db: 'hidden' }));
  });

  test('AC-10: at -1 a scenario without initial gives every element normal', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'single', -1)).toEqual(normalWith({}));
  });

  test('AC-10: the result has a key for every group, node and edge, and no others', () => {
    const d = makeDiagram();
    for (const step of [-1, 0, 2, LAST]) {
      expect(Object.keys(statesAt(d, 'main', step)).sort()).toEqual(ELEMENT_IDS);
    }
  });

  test('AC-10: at step 0 it includes the state of step 0', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'main', 0)).toEqual(normalWith({ db: 'hidden', 'e-req': 'highlighted' }));
  });

  test('AC-10: at step i it includes every state from steps 0 to i, later steps winning', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'main', 1)).toEqual(
      normalWith({ db: 'appearing', 'e-req': 'highlighted', web: 'highlighted' }),
    );
    // step 2 overrides db (appearing -> highlighted)
    expect(statesAt(d, 'main', 2).db).toBe('highlighted');
  });

  test('AC-10: a key set back to normal by a later step reads normal', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'main', 1)['e-req']).toBe('highlighted');
    expect(statesAt(d, 'main', 2)['e-req']).toBe('normal');
    expect(statesAt(d, 'main', 3)['e-req']).toBe('normal');
  });

  test('AC-10: a step state overrides the initial state of the same element', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'second', -1)).toEqual(normalWith({ client: 'highlighted', web: 'hidden' }));
    expect(statesAt(d, 'second', 0)).toEqual(
      normalWith({ client: 'highlighted', web: 'appearing' }),
    );
    expect(statesAt(d, 'second', 1)).toEqual(
      normalWith({ client: 'normal', web: 'appearing', 'e-query': 'failed' }),
    );
  });

  test('AC-10: states persist through steps that set nothing', () => {
    const d = makeDiagram();
    expect(statesAt(d, 'main', 3)).toEqual(
      normalWith({ db: 'highlighted', web: 'highlighted', 'g-vpc': 'failed' }),
    );
    expect(statesAt(d, 'main', LAST)).toEqual(statesAt(d, 'main', 3));
  });

  test('AC-10: statesAt does not depend on earlier calls', () => {
    const d = makeDiagram();
    const first = statesAt(d, 'main', 3);
    statesAt(d, 'main', 0);
    statesAt(d, 'second', 1);
    expect(statesAt(d, 'main', 3)).toEqual(first);
  });
});

describe('stepping back', () => {
  test('AC-11: forward to step 3 then back to step 1 restores the states first seen at step 1', () => {
    const d = makeDiagram();
    const firstVisit = viewPlayer(d, run(d, initPlayer(d), next, next)).states;
    const atThree = run(d, initPlayer(d), next, next, next, next);
    expect(atThree.step).toBe(3);
    const backAtOne = run(d, atThree, back, back);
    expect(backAtOne.step).toBe(1);
    expect(viewPlayer(d, backAtOne).states).toEqual(firstVisit);
  });

  test('AC-11: the picture at step 3 differs from the one at step 1 (the check above is not vacuous)', () => {
    const d = makeDiagram();
    const at1 = viewPlayer(d, pausedAt(d, 1)).states;
    const at3 = viewPlayer(d, pausedAt(d, 3)).states;
    expect(at3).not.toEqual(at1);
  });

  test('AC-11: stepping all the way back to -1 restores the initial picture', () => {
    const d = makeDiagram();
    const initialView = viewPlayer(d, initPlayer(d));
    const backAtStart = run(d, pausedAt(d, LAST), back, back, back, back, back);
    expect(backAtStart.step).toBe(-1);
    expect(viewPlayer(d, backAtStart).states).toEqual(initialView.states);
  });

  test('AC-11: stepping back restores the picture on another scenario too', () => {
    const d = makeDiagram();
    const firstVisit = viewPlayer(d, run(d, initPlayer(d, 'second'), next)).states;
    const after = run(d, initPlayer(d, 'second'), next, next, back);
    expect(viewPlayer(d, after).states).toEqual(firstVisit);
  });
});

describe('viewPlayer', () => {
  test('AC-12: at -1 step, target, packet, caption and metrics are undefined and atStart is true', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, initPlayer(d));
    expect(view.step).toBeUndefined();
    expect(view.target).toBeUndefined();
    expect(view.packet).toBeUndefined();
    expect(view.caption).toBeUndefined();
    expect(view.metrics).toBeUndefined();
    expect(view.atStart).toBe(true);
    expect(view.atEnd).toBe(false);
    expect(view.index).toBe(-1);
  });

  test('AC-12: the view carries the scenario id and label, total, playing and run', () => {
    const d = makeDiagram();
    const state = run(d, initPlayer(d, 'second'), play);
    const view = viewPlayer(d, state);
    expect(view.scenario).toEqual({ id: 'second', label: 'Failure case' });
    expect(view.total).toBe(2);
    expect(view.index).toBe(0);
    expect(view.playing).toBe(true);
    expect(view.run).toBe(state.run);
  });

  test('AC-12: states in the view are the states at the current step', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(viewPlayer(d, state).states).toEqual(statesAt(d, 'main', 2));
    expect(viewPlayer(d, initPlayer(d)).states).toEqual(statesAt(d, 'main', -1));
  });

  test('AC-12: at an edge step the target is the edge and the packet has its edge, label and reverse false', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, pausedAt(d, 0));
    expect(view.target).toEqual({ kind: 'edge', id: 'e-req' });
    expect(view.packet).toEqual({ edge: 'e-req', label: 'GET /', reverse: false });
    expect(view.atStart).toBe(false);
    expect(view.step).toEqual(d.scenarios[0]?.steps[0]);
  });

  test('AC-12: a reverse edge step gives reverse true on the packet', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, pausedAt(d, 2));
    expect(view.target).toEqual({ kind: 'edge', id: 'e-query' });
    expect(view.packet).toEqual({ edge: 'e-query', label: 'rows', reverse: true });
  });

  test('AC-12: an edge step without a packet label gives a packet without a label', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, pausedAt(d, LAST));
    expect(view.packet).toBeDefined();
    expect(view.packet?.edge).toBe('e-query');
    expect(view.packet?.reverse).toBe(false);
    expect(view.packet?.label).toBeUndefined();
  });

  test('AC-12: at a node step the packet is undefined and the target kind is node', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, pausedAt(d, 1));
    expect(view.target).toEqual({ kind: 'node', id: 'web' });
    expect(view.packet).toBeUndefined();
  });

  test('AC-12: at a group step the packet is undefined and the target kind is group', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, pausedAt(d, 3));
    expect(view.target).toEqual({ kind: 'group', id: 'g-vpc' });
    expect(view.packet).toBeUndefined();
  });

  test('AC-12: caption and metrics come from the step', () => {
    const d = makeDiagram();
    const atZero = viewPlayer(d, pausedAt(d, 0));
    expect(atZero.caption).toBe('The client calls the web tier');
    expect(atZero.metrics).toEqual({ latency: '20 ms' });
    const atThree = viewPlayer(d, pausedAt(d, 3));
    expect(atThree.caption).toBe('The whole VPC fails');
    expect(atThree.metrics).toEqual({ requests: 3, errors: 1 });
  });

  test('AC-12: a step without metrics gives undefined metrics', () => {
    const d = makeDiagram();
    const view = viewPlayer(d, pausedAt(d, 1));
    expect(view.caption).toBe('The web tier renders the page');
    expect(view.metrics).toBeUndefined();
  });

  test('AC-12: atEnd is true only at the last step and total is the step count', () => {
    const d = makeDiagram();
    const atEnd: boolean[] = [];
    for (let step = -1; step <= LAST; step++) {
      const view = viewPlayer(d, pausedAt(d, step));
      expect(view.total).toBe(5);
      expect(view.index).toBe(step);
      atEnd.push(view.atEnd);
    }
    expect(atEnd).toEqual([false, false, false, false, false, true]);
  });

  test('AC-12: atStart is true only at -1', () => {
    const d = makeDiagram();
    const atStart: boolean[] = [];
    for (let step = -1; step <= LAST; step++)
      atStart.push(viewPlayer(d, pausedAt(d, step)).atStart);
    expect(atStart).toEqual([true, false, false, false, false, false]);
  });
});

describe('purity', () => {
  const allActions: PlayerAction[] = [
    play,
    tick,
    tick,
    pause,
    toggle,
    next,
    next,
    back,
    goto(3),
    goto(99),
    goto(-5),
    play,
    reset,
    scenario('second'),
    scenario('nope'),
    toggle,
    tick,
    tick,
    tick,
    next,
    back,
    reset,
  ];

  test('AC-13: the reducer and the selectors work on a deep-frozen diagram and state', () => {
    const d = deepFreeze(makeDiagram());
    let state = deepFreeze(initPlayer(d));
    for (const action of allActions) {
      state = deepFreeze(playerReducer(d, state, action));
      viewPlayer(d, state);
      statesAt(d, state.scenario, state.step);
    }
    expect(state).toBeDefined();
  });

  test('AC-13: the reducer does not change the diagram or the input state', () => {
    const d = makeDiagram();
    const pristine = makeDiagram();
    let state = initPlayer(d);
    for (const action of allActions) {
      const before = { ...state };
      const result = playerReducer(d, state, action);
      expect(state).toEqual(before);
      state = result;
    }
    expect(d).toEqual(pristine);
  });

  test('AC-13: viewPlayer and statesAt do not change the diagram', () => {
    const d = makeDiagram();
    for (const step of [-1, 0, 1, 2, 3, LAST]) {
      viewPlayer(d, pausedAt(d, step));
      statesAt(d, 'main', step);
      statesAt(d, 'second', Math.min(step, 1));
    }
    expect(d).toEqual(makeDiagram());
  });

  test('AC-13: changing a returned states object does not affect later results', () => {
    const d = makeDiagram();
    const states = statesAt(d, 'main', 2);
    states.web = 'broken';
    states['e-req'] = 'failed';
    expect(statesAt(d, 'main', 2)).toEqual(normalWith({ db: 'highlighted', web: 'highlighted' }));
    const viewStates = viewPlayer(d, pausedAt(d, 2)).states;
    viewStates.web = 'broken';
    expect(viewPlayer(d, pausedAt(d, 2)).states.web).toBe('highlighted');
  });

  test('AC-13: the same inputs always give equal outputs', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(playerReducer(d, state, next)).toEqual(playerReducer(d, state, next));
    expect(viewPlayer(d, state)).toEqual(viewPlayer(d, state));
    expect(statesAt(d, 'main', 2)).toEqual(statesAt(d, 'main', 2));
  });

  test('AC-13: next at the end while paused returns the same object', () => {
    const d = deepFreeze(makeDiagram());
    const state = deepFreeze(pausedAt(d, LAST));
    expect(playerReducer(d, state, next)).toBe(state);
  });

  test('AC-13: back at -1 while paused returns the same object', () => {
    const d = deepFreeze(makeDiagram());
    const state = deepFreeze(initPlayer(d));
    expect(playerReducer(d, state, back)).toBe(state);
  });

  test('AC-13: pause while paused returns the same object', () => {
    const d = deepFreeze(makeDiagram());
    const state = deepFreeze(pausedAt(d, 2));
    expect(playerReducer(d, state, pause)).toBe(state);
  });

  test('AC-13: an action that changes something returns a new object', () => {
    const d = makeDiagram();
    const state = pausedAt(d, 2);
    expect(playerReducer(d, state, next)).not.toBe(state);
    expect(playerReducer(d, state, back)).not.toBe(state);
    expect(playerReducer(d, state, play)).not.toBe(state);
    expect(playerReducer(d, state, reset)).not.toBe(state);
  });
});

describe('one-step scenario', () => {
  test('AC-14: play from -1 lands on step 0 with playing false', () => {
    const d = makeDiagram();
    const state = playerReducer(d, initPlayer(d, 'single'), play);
    expect(state.scenario).toBe('single');
    expect(state.step).toBe(0);
    expect(state.playing).toBe(false);
    expect(state.run).toBe(1);
  });

  test('AC-14: toggle from -1 also lands on step 0 and stops', () => {
    const d = makeDiagram();
    const state = playerReducer(d, initPlayer(d, 'single'), toggle);
    expect(state.step).toBe(0);
    expect(state.playing).toBe(false);
  });

  test('AC-14: next at step 0 is a no-op that returns the same object', () => {
    const d = makeDiagram();
    const state = run(d, initPlayer(d, 'single'), next);
    expect(state.step).toBe(0);
    expect(playerReducer(d, state, next)).toBe(state);
  });

  test('AC-14: the view at step 0 is both the end and not the start', () => {
    const d = makeDiagram();
    const atZero = viewPlayer(d, run(d, initPlayer(d, 'single'), next));
    expect(atZero.total).toBe(1);
    expect(atZero.atEnd).toBe(true);
    expect(atZero.atStart).toBe(false);
    const beforeZero = viewPlayer(d, initPlayer(d, 'single'));
    expect(beforeZero.atEnd).toBe(false);
    expect(beforeZero.atStart).toBe(true);
  });

  test('AC-14: switching to the one-step scenario and playing lands on step 0, paused', () => {
    const d = makeDiagram();
    const state = run(d, playingAt(d, 2), scenario('single'), play);
    expect(state.scenario).toBe('single');
    expect(state.step).toBe(0);
    expect(state.playing).toBe(false);
  });
});

describe('package root', () => {
  test('AC-15: initPlayer, playerReducer, viewPlayer and statesAt are exported from the package root', () => {
    expect(engineRoot.initPlayer).toBe(initPlayer);
    expect(engineRoot.playerReducer).toBe(playerReducer);
    expect(engineRoot.viewPlayer).toBe(viewPlayer);
    expect(engineRoot.statesAt).toBe(statesAt);
  });

  test('AC-15: the functions exported from the package root drive a player end to end', () => {
    const d = makeDiagram();
    const state = engineRoot.playerReducer(d, engineRoot.initPlayer(d), { type: 'next' });
    expect(state).toStrictEqual({ scenario: 'main', step: 0, playing: false, run: 1 });
    expect(engineRoot.viewPlayer(d, state).caption).toBe('The client calls the web tier');
    expect(engineRoot.statesAt(d, 'main', 0)).toEqual(
      normalWith({ db: 'hidden', 'e-req': 'highlighted' }),
    );
  });
});
