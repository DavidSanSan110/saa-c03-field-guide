// Test data for the diagram view (spec 012): two diagrams rendered on the /fixtures/diagram/ route.
// Original wording, neutral and factual; nothing here is exam material.
import type { Diagram } from '../../packages/schema/src/index.ts';

/** Two groups, four nodes, three edges and two scenarios; `audit` has no compiled points. */
export const viewFixture: Diagram = {
  id: 'view-fixture',
  title: 'View fixture',
  groups: [
    { id: 'region', label: 'eu-west-1', kind: 'region' },
    { id: 'keys', label: 'Key management', kind: 'generic', parent: 'region' },
  ],
  nodes: [
    { id: 'client', icon: 'user', label: 'Client', sub: 'IAM principal' },
    { id: 's3', icon: 'simple-storage-service', label: 'S3 bucket', group: 'region' },
    { id: 'kms', icon: 'key-management-service', label: 'KMS key', group: 'keys' },
    // Placed by hand, below the key group but inside the region: the `audit` edge gets no points.
    {
      id: 'trail',
      icon: 'cloudtrail',
      label: 'CloudTrail',
      group: 'region',
      pos: { x: 232, y: 272 },
    },
  ],
  edges: [
    { id: 'put', from: 'client', to: 's3' },
    { id: 'gen', from: 's3', to: 'kms', label: 'Data key request' },
    { id: 'audit', from: 'kms', to: 'trail' },
  ],
  scenarios: [
    {
      id: 'upload',
      label: 'Upload an object',
      steps: [
        {
          edge: 'put',
          packet: 'PutObject',
          caption: 'The client sends an object to the bucket.',
        },
        {
          edge: 'gen',
          packet: 'GenerateDataKey',
          caption: 'The bucket asks the key service for a data key.',
          metrics: { 'KMS requests': '+1' },
        },
        {
          edge: 'gen',
          reverse: true,
          packet: 'data key',
          caption: 'The key service returns the data key.',
        },
        {
          edge: 'audit',
          caption: 'The key use is recorded in the audit trail.',
        },
        {
          node: 's3',
          caption: 'The bucket stores the object encrypted.',
          state: { s3: 'highlighted' },
        },
      ],
    },
    {
      id: 'key-disabled',
      label: 'Key disabled',
      initial: { trail: 'hidden' },
      steps: [
        {
          group: 'keys',
          caption: 'The key is disabled, so it cannot be used.',
          state: { kms: 'failed' },
        },
        {
          edge: 'put',
          packet: 'PutObject',
          caption: 'The client sends an object to the bucket again.',
        },
        {
          edge: 'gen',
          caption: 'The data key request fails.',
          state: { gen: 'broken' },
          metrics: { 'KMS requests': '+1', Errors: 1 },
        },
        {
          edge: 'put',
          reverse: true,
          packet: 'error',
          caption: 'The bucket returns an error to the client.',
        },
        {
          node: 'trail',
          caption: 'The audit trail records the failed call.',
          state: { trail: 'appearing' },
        },
      ],
    },
  ],
};

/** The smallest diagram: one scenario, two nodes, no groups or edges, two node steps. */
export const viewFixtureMini: Diagram = {
  id: 'view-fixture-mini',
  title: 'View fixture mini',
  nodes: [
    { id: 'first', icon: 'simple-storage-service', label: 'First bucket' },
    { id: 'second', icon: 'simple-storage-service', label: 'Second bucket' },
  ],
  scenarios: [
    {
      id: 'tour',
      label: 'Tour',
      steps: [
        { node: 'first', caption: 'This is the first bucket.' },
        { node: 'second', caption: 'This is the second bucket.' },
      ],
    },
  ],
};

/**
 * One scenario that sets every state an element has no separate look for (AC-35):
 * an edge `highlighted` (then still highlighted on the next step), an edge `appearing`,
 * an edge `failed`, a node `broken` and a group `broken`. The edge `rest` is never touched.
 */
export const viewFixtureStates: Diagram = {
  id: 'view-fixture-states',
  title: 'View fixture states',
  groups: [{ id: 'zone', label: 'Zone A', kind: 'az' }],
  nodes: [
    { id: 'source', icon: 'user', label: 'Source' },
    { id: 'store', icon: 'simple-storage-service', label: 'Store', group: 'zone' },
    { id: 'keys', icon: 'key-management-service', label: 'Keys' },
    { id: 'log', icon: 'cloudtrail', label: 'Log' },
  ],
  edges: [
    { id: 'lit', from: 'source', to: 'store' },
    { id: 'fade', from: 'store', to: 'keys' },
    { id: 'bad', from: 'keys', to: 'log' },
    { id: 'rest', from: 'source', to: 'log' },
  ],
  scenarios: [
    {
      id: 'states',
      label: 'States',
      steps: [
        {
          node: 'source',
          caption: 'The first link is highlighted.',
          state: { lit: 'highlighted' },
        },
        {
          edge: 'fade',
          caption: 'The second link appears.',
          state: { fade: 'appearing' },
        },
        {
          edge: 'bad',
          caption: 'The third link is marked as failed.',
          state: { bad: 'failed' },
        },
        {
          node: 'keys',
          caption: 'The keys node is marked as broken.',
          state: { keys: 'broken' },
        },
        {
          group: 'zone',
          caption: 'The zone is marked as broken.',
          state: { zone: 'broken' },
        },
      ],
    },
  ],
};
