// The diagram island (spec 012): React Flow canvas, controls, scenario tabs, step log and caption.
import { ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import '@xyflow/react/dist/base.css';
import type { PlayerAction } from '../player.ts';
import { initPlayer, playerReducer, viewPlayer } from '../player.ts';
import { STEP_DURATION_MS, layoutFor, logLines, toFlowModel } from '../view-model.ts';
import type { FlowModel, LogLine } from '../view-model.ts';
import { edgeTypes, nodeTypes } from './canvas.tsx';
import type { CardType, FlowEdgeType, GroupType } from './canvas.tsx';
import type { DiagramViewProps, IconSource } from './types.ts';
import './view.css';

const FIT_PADDING = 0.08;
const HINT =
  'Arrow keys step through the diagram, Space or K plays and pauses, Home resets, End jumps to the last step.';

/** React Flow node and edge props that make the canvas read-only. */
const readOnly = {
  draggable: false,
  selectable: false,
  focusable: false,
  connectable: false,
  deletable: false,
  // React Flow labels every node "node" for assistive technology, which is not a valid role description here.
  domAttributes: { 'aria-roledescription': undefined },
} as const;

function flowNodes(
  model: FlowModel,
  icons: Record<string, IconSource>,
  groupIcons: Record<string, IconSource>,
  compact: boolean,
): Node[] {
  const groups = model.groups.map((flow): GroupType => ({
    id: flow.id,
    type: 'group',
    position: { x: flow.x, y: flow.y },
    ...(flow.parentId === undefined ? {} : { parentId: flow.parentId }),
    width: flow.width,
    height: flow.height,
    data: { flow, icon: groupIcons[flow.kind] },
    ...readOnly,
  }));
  const cards = model.nodes.map((flow): CardType => ({
    id: flow.id,
    type: 'card',
    position: { x: flow.x, y: flow.y },
    ...(flow.parentId === undefined ? {} : { parentId: flow.parentId }),
    width: flow.width,
    height: flow.height,
    data: { flow, icon: icons[flow.icon], compact },
    ...readOnly,
  }));
  return [...groups, ...cards];
}

function flowEdges(model: FlowModel): Edge[] {
  return model.edges.map((flow): FlowEdgeType => ({
    id: flow.id,
    type: 'flow',
    source: flow.from,
    target: flow.to,
    data: { flow },
    ...readOnly,
  }));
}

type IconName = 'reset' | 'back' | 'play' | 'pause' | 'replay' | 'forward';

const ICON_PATHS: Record<IconName, ReactNode> = {
  reset: <path d="M5 4h2v12H5zM16 4v12L8 10z" />,
  back: <path d="M14 4v12L5 10z" />,
  play: <path d="M5 3.5v13L16 10z" />,
  pause: <path d="M5 4h4v12H5zM11 4h4v12h-4z" />,
  replay: (
    <path
      d="M10 3a7 7 0 1 0 6.6 9.3l-1.9-.6A5 5 0 1 1 10 5v3l4-4-4-4z"
      transform="translate(0 2)"
    />
  ),
  forward: <path d="M6 4v12l9-6zM15 4h2v12h-2z" />,
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

function LogView({ lines, compact }: { lines: LogLine[]; compact: boolean }) {
  if (lines.length === 0) {
    return (
      <p className="dl-log__line is-current" data-log-line="">
        <span className="dl-log__n">$</span> Press Play or step forward to start.
      </p>
    );
  }
  const shown = compact ? lines.slice(-1) : lines;
  return (
    <>
      {shown.map((line) => (
        <p
          key={line.n}
          className={`dl-log__line${line.n === lines.length ? ' is-current' : ''}`}
          data-log-line=""
        >
          <span className="dl-log__n">{`[${String(line.n)}/${String(line.total)}]`}</span>{' '}
          <code>{line.detail === undefined ? line.route : `${line.route}   ${line.detail}`}</code>
        </p>
      ))}
    </>
  );
}

function Island({ wide, compact, icons, groupIcons }: DiagramViewProps) {
  const diagram = wide.diagram;
  const uid = useId().replace(/\W/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof initPlayer>, action: PlayerAction) =>
      playerReducer(diagram, current, action),
    diagram,
    (initial) => initPlayer(initial),
  );
  const [width, setWidth] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const { fitView } = useReactFlow();
  const fitRef = useRef(fitView);
  fitRef.current = fitView;

  const layout = layoutFor(width);
  const compiled = layout === 'compact' ? compact : wide;
  const view = useMemo(() => viewPlayer(diagram, state), [diagram, state]);
  const model = useMemo(() => toFlowModel(compiled, view), [compiled, view]);
  const nodes = useMemo(
    () => flowNodes(model, icons, groupIcons, layout === 'compact'),
    [model, icons, groupIcons, layout],
  );
  const edges = useMemo(() => flowEdges(model), [model]);
  const lines = useMemo(
    () => logLines(diagram, view.scenario.id, view.index),
    [diagram, view.scenario.id, view.index],
  );

  // Measure the island: the layout follows its own width, not the window's.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    setWidth(root.getBoundingClientRect().width);
    setHydrated(true);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Re-fit the view when the canvas changes size (a layout switch, a resize); the player state is kept.
  // React Flow learns its container size asynchronously, so fitting waits two frames.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          void fitRef.current({ padding: FIT_PADDING });
        });
      });
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [layout]);

  // The view's clock: one tick per step while playing, restarted on every step change.
  useEffect(() => {
    if (!state.playing) return;
    const timer = setTimeout(() => {
      dispatch({ type: 'tick' });
    }, STEP_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state.playing, state.run]);

  const scenarios = diagram.scenarios;
  const hasTabs = scenarios.length > 1;
  const panelId = `${uid}-panel`;
  const tabId = (id: string) => `${uid}-tab-${id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (target.closest('[role="tablist"]') !== null) return;
    if (target.closest('button') !== null && (event.key === ' ' || event.key === 'Enter')) return;
    const actions: Record<string, PlayerAction> = {
      ArrowRight: { type: 'next' },
      ArrowLeft: { type: 'back' },
      Home: { type: 'reset' },
      End: { type: 'goto', step: view.total - 1 },
      ' ': { type: 'toggle' },
      k: { type: 'toggle' },
    };
    const action = actions[event.key];
    if (action === undefined) return;
    event.preventDefault();
    dispatch(action);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = scenarios.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = targets[event.key];
    const scenario = next === undefined ? undefined : scenarios[next];
    if (next === undefined || scenario === undefined) return;
    event.preventDefault();
    dispatch({ type: 'scenario', id: scenario.id });
    tabRefs.current[next]?.focus();
  };

  const playLabel = view.playing ? 'Pause' : view.atEnd ? 'Replay' : 'Play';
  const playIcon: IconName = view.playing ? 'pause' : view.atEnd ? 'replay' : 'play';
  const count = view.atStart
    ? `${String(view.total)} steps`
    : `Step ${String(view.index + 1)} of ${String(view.total)}`;
  const metrics = view.metrics === undefined ? [] : Object.entries(view.metrics);

  return (
    <div
      ref={rootRef}
      className="dl-view"
      role="group"
      tabIndex={0}
      aria-label={`Animated diagram: ${diagram.title}`}
      aria-describedby={`${uid}-hint`}
      onKeyDown={onKeyDown}
      data-diagram-view=""
      data-layout={layout}
      data-scenario={view.scenario.id}
      data-step={view.index}
      data-playing={String(view.playing)}
      {...(hydrated ? { 'data-hydrated': 'true' } : {})}
    >
      <span id={`${uid}-hint`} className="dl-sr-only">
        {HINT}
      </span>

      {hasTabs ? (
        <div className="dl-tabs" role="tablist" aria-label="Scenarios">
          {scenarios.map((scenario, index) => {
            const selected = scenario.id === view.scenario.id;
            return (
              <button
                key={scenario.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={tabId(scenario.id)}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  dispatch({ type: 'scenario', id: scenario.id });
                }}
                onKeyDown={(event) => {
                  onTabKeyDown(event, index);
                }}
              >
                {scenario.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={canvasRef}
        className="dl-canvas"
        data-layout={layout}
        style={{ aspectRatio: `${String(compiled.width)} / ${String(compiled.height)}` }}
        {...(hasTabs
          ? { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId(view.scenario.id) }
          : {})}
      >
        <ReactFlow
          id={`dl-${uid}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: FIT_PADDING }}
          minZoom={0.1}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          autoPanOnNodeFocus={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
        />
      </div>

      <div className="dl-bar">
        <div className="dl-controls">
          <button
            type="button"
            aria-label="Reset"
            onClick={() => {
              dispatch({ type: 'reset' });
            }}
          >
            <Icon name="reset" />
          </button>
          <button
            type="button"
            aria-label="Step back"
            aria-disabled={view.atStart}
            onClick={() => {
              dispatch({ type: 'back' });
            }}
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="dl-play"
            onClick={() => {
              dispatch({ type: 'toggle' });
            }}
          >
            <Icon name={playIcon} />
            {playLabel}
          </button>
          <button
            type="button"
            aria-label="Step forward"
            aria-disabled={view.atEnd}
            onClick={() => {
              dispatch({ type: 'next' });
            }}
          >
            <Icon name="forward" />
          </button>
        </div>
        <div className="dl-progress" aria-hidden="true">
          {Array.from({ length: view.total }, (_, index) => (
            <span
              key={index}
              className={
                index < view.index ? 'is-done' : index === view.index ? 'is-current' : undefined
              }
            />
          ))}
        </div>
        <span className="dl-count">{count}</span>
      </div>

      <div className="dl-log" aria-hidden="true">
        <LogView lines={lines} compact={layout === 'compact'} />
        <p className="dl-log__caption" data-caption="">
          {view.caption}
          {metrics.length === 0 ? null : (
            <span className="dl-metrics">
              {metrics.map(([key, value]) => (
                <span key={key} className="dl-metric" data-metric="">
                  <span className="dl-metric__k">{key}</span> {String(value)}
                </span>
              ))}
            </span>
          )}
        </p>
      </div>

      <div className="dl-sr-only" aria-live="polite" aria-atomic="true">
        {view.atStart
          ? null
          : [
              `Step ${String(view.index + 1)} of ${String(view.total)}.`,
              view.caption,
              metrics.map(([key, value]) => `${key} ${String(value)}.`).join(' '),
            ]
              .filter((part) => part !== undefined && part !== '')
              .join(' ')}
      </div>
    </div>
  );
}

/** An animated, accessible diagram: one scenario player over a layout compiled at build time. */
export function DiagramView(props: DiagramViewProps) {
  return (
    <ReactFlowProvider>
      <Island {...props} />
    </ReactFlowProvider>
  );
}
