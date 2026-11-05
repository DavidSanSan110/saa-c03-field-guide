// Test data for parallel edges in a step (spec 045): one diagram rendered on the
// /fixtures/diagram-parallel/ route. Original wording, neutral and factual; nothing here is exam material.
import type { Diagram } from '../../packages/schema/src/index.ts';

/**
 * A publisher, a topic with three queues behind it and a worker behind the first queue.
 * Scenario `fan-out`:
 *   1 `publish` (single, packet `event`)
 *   2 `to-a` (packet `copy a`) with `to-b` (no packet) and `to-c` (packet `copy c`)
 *   3 `a-work` (single, packet `job`)
 *   4 `a-work` reversed (packet `result`) with `to-b` reversed (no packet)
 */
export const parallelFixture: Diagram = {
  id: 'parallel-fixture',
  title: 'Parallel fixture',
  nodes: [
    { id: 'publisher', icon: 'user', label: 'Publisher' },
    { id: 'topic', icon: 'elastic-load-balancing', label: 'Topic' },
    { id: 'q-a', icon: 'ec2', label: 'Queue A' },
    { id: 'q-b', icon: 'ec2', label: 'Queue B' },
    { id: 'q-c', icon: 'ec2', label: 'Queue C' },
    { id: 'worker', icon: 'simple-storage-service', label: 'Worker' },
  ],
  edges: [
    { id: 'publish', from: 'publisher', to: 'topic' },
    { id: 'to-a', from: 'topic', to: 'q-a' },
    { id: 'to-b', from: 'topic', to: 'q-b' },
    { id: 'to-c', from: 'topic', to: 'q-c' },
    { id: 'a-work', from: 'q-a', to: 'worker' },
  ],
  scenarios: [
    {
      id: 'fan-out',
      label: 'Fan out',
      steps: [
        {
          edge: 'publish',
          packet: 'event',
          caption: 'The publisher sends one event to the topic.',
        },
        {
          edge: 'to-a',
          packet: 'copy a',
          with: [{ edge: 'to-b' }, { edge: 'to-c', packet: 'copy c' }],
          caption: 'The topic sends a copy to every queue at the same time.',
        },
        {
          edge: 'a-work',
          packet: 'job',
          caption: 'The worker takes a job from the first queue.',
        },
        {
          edge: 'a-work',
          reverse: true,
          packet: 'result',
          with: [{ edge: 'to-b', reverse: true }],
          caption: 'The worker and the second queue answer back at the same time.',
        },
      ],
    },
  ],
};
