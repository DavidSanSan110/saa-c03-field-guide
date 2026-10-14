// Custom React Flow nodes and edges of the diagram island (spec 012). Everything is drawn from the
// flow model: React Flow only provides the viewport; its computed handle coordinates are ignored.
import {
  EdgeLabelRenderer,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useEffect, useId } from 'react';
import { edgePath, pathMidpoint } from '../view-model.ts';
import type { FlowEdge, FlowGroup, FlowNode } from '../view-model.ts';
import type { IconSource } from './types.ts';

const PACKET_SECONDS = 1.5;

export interface CardData extends Record<string, unknown> {
  flow: FlowNode;
  icon: IconSource | undefined;
  compact: boolean;
}
export interface GroupData extends Record<string, unknown> {
  flow: FlowGroup;
  icon: IconSource | undefined;
}
export interface EdgeData extends Record<string, unknown> {
  flow: FlowEdge;
}
export type CardType = Node<CardData, 'card'>;
export type GroupType = Node<GroupData, 'group'>;
export type FlowEdgeType = Edge<EdgeData, 'flow'>;

/** The icon image; with a dark variant both are rendered and the CSS picks one by theme. */
function IconImage({ source }: { source: IconSource | undefined }) {
  if (source === undefined) return null;
  return (
    <>
      <img
        src={source.light}
        alt=""
        draggable={false}
        className={source.dark === undefined ? undefined : 'dl-only-light'}
      />
      {source.dark === undefined ? null : (
        <img src={source.dark} alt="" draggable={false} className="dl-only-dark" />
      )}
    </>
  );
}

/** React Flow needs a handle on each side of a node to render an edge; they stay invisible. */
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

function CardNode({ data }: NodeProps<CardType>) {
  const { flow, icon, compact } = data;
  return (
    <>
      <Handles />
      <div
        className="dl-card"
        data-node-id={flow.id}
        data-state={flow.state}
        data-active={String(flow.active)}
      >
        <span className="dl-card__icon">
          <IconImage source={icon} />
        </span>
        <span className="dl-card__label">{flow.label}</span>
        {!compact && flow.sub !== undefined ? (
          <span className="dl-card__sub">{flow.sub}</span>
        ) : null}
        {flow.state === 'failed' ? <span className="dl-pill dl-pill--failed">failed</span> : null}
      </div>
    </>
  );
}

function GroupNode({ data }: NodeProps<GroupType>) {
  const { flow, icon } = data;
  return (
    <>
      <Handles />
      <div
        className="dl-group"
        data-group-id={flow.id}
        data-kind={flow.kind}
        data-state={flow.state}
        data-active={String(flow.active)}
      >
        <div className="dl-group__header">
          <IconImage source={icon} />
          <span className="dl-group__label">{flow.label}</span>
          {flow.state === 'failed' ? <span className="dl-pill dl-pill--failed">failed</span> : null}
        </div>
      </div>
    </>
  );
}

/** The chip that travels the active edge along an SVG offset path (it does not move under reduced motion). */
function Packet({
  path,
  label,
  reverse,
}: {
  path: string;
  label: string | undefined;
  reverse: boolean;
}) {
  const reduced = useReducedMotion() === true;
  const [from, to] = reverse ? [100, 0] : [0, 100];
  const progress = useMotionValue(reduced ? to : from);
  const distance = useTransform(progress, (value) => `${value}%`);
  const opacity = useTransform(
    progress,
    reverse ? [from - 6, from] : [from, from + 6],
    reverse ? [1, 0] : [0, 1],
  );

  useEffect(() => {
    if (reduced) return;
    const controls = animate(progress, to, { duration: PACKET_SECONDS, ease: [0.45, 0, 0.25, 1] });
    return () => {
      controls.stop();
    };
  }, [progress, reduced, to]);

  return (
    <motion.div
      className="dl-packet"
      data-packet=""
      data-reverse={String(reverse)}
      style={{
        offsetPath: `path("${path}")`,
        offsetDistance: distance,
        offsetRotate: '0deg',
        opacity,
      }}
    >
      <span className="dl-packet__dot" />
      {label === undefined ? null : <span className="dl-packet__label">{label}</span>}
    </motion.div>
  );
}

function FlowEdgeView({ data }: EdgeProps<FlowEdgeType>) {
  const markerId = `dl-arrow-${useId().replace(/\W/g, '')}`;
  if (data === undefined) return null;
  const { flow } = data;
  const broken = flow.state === 'broken';
  const kind = broken ? 'broken' : flow.status;
  const path = edgePath(flow.points);
  const middle = pathMidpoint(flow.points);
  const at = `translate(-50%, -50%) translate(${middle.x}px, ${middle.y}px)`;
  const shown = flow.state !== 'hidden';
  return (
    <>
      <g
        data-edge-id={flow.id}
        data-state={flow.state}
        data-active={String(flow.status === 'active')}
        data-status={flow.status}
        className={`dl-edge dl-edge--${kind}`}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="9"
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="dl-edge__arrow" />
          </marker>
        </defs>
        <path className="dl-edge__line" d={path} fill="none" markerEnd={`url(#${markerId})`} />
      </g>
      {shown ? (
        <EdgeLabelRenderer>
          {flow.label === undefined ? null : (
            <div
              className="dl-edge-label"
              style={{ transform: `${at} translateY(${broken ? '-1.6rem' : '-1.4rem'})` }}
            >
              {flow.label}
            </div>
          )}
          {broken ? (
            <div className="dl-edge-cross" style={{ transform: at }}>
              ✕
            </div>
          ) : null}
          {flow.packet === undefined ? null : (
            <Packet
              key={flow.packet.run}
              path={path}
              label={flow.packet.label}
              reverse={flow.packet.reverse}
            />
          )}
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const nodeTypes = { card: CardNode, group: GroupNode };
export const edgeTypes = { flow: FlowEdgeView };
