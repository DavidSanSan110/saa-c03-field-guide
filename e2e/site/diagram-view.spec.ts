/// <reference lib="dom" />
// Browser checks of the diagram island (spec 012), on the fixture route /fixtures/diagram/.
// The DOM contract (data-* attributes) is part of the spec; roles and labels are used otherwise.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Diagram, DiagramScenario } from '../../packages/schema/src/index.ts';
import { viewFixture, viewFixtureMini } from '../fixtures/view-fixture.ts';
import { viewFixtureStates } from '../fixtures/view-fixture.ts';
import { DESKTOP_VIEWPORT, pixel7 } from './support.ts';

const FIXTURE_PATH = '/fixtures/diagram/';
const STEP_MS = 3600;

// ---------------------------------------------------------------------------
// Fixture facts (derived from the fixture data, not from the implementation)
// ---------------------------------------------------------------------------

function scenarioOf(diagram: Diagram, id: string): DiagramScenario {
  const scenario = diagram.scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  return scenario;
}

const upload = scenarioOf(viewFixture, 'upload');
const keyDisabled = scenarioOf(viewFixture, 'key-disabled');

/** The caption of a step (0-based). */
function captionOf(scenario: DiagramScenario, step: number): string {
  const found = scenario.steps[step];
  if (found === undefined) throw new Error(`no step ${String(step)}`);
  return found.caption;
}

/** The text of a step in the "Steps as text" list: the caption, then its metrics in parentheses. */
function fallbackText(step: DiagramScenario['steps'][number]): string {
  if (step.metrics === undefined) return step.caption;
  const metrics = Object.entries(step.metrics)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
  return `${step.caption} (${metrics})`;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

interface Island {
  figure: Locator;
  root: Locator;
  back: Locator;
  forward: Locator;
  reset: Locator;
  toggle: Locator;
}

function islandOf(page: Page, diagramId: string): Island {
  const figure = page.locator(`figure[data-diagram="${diagramId}"]`);
  return {
    figure,
    root: figure.locator('[data-diagram-view]'),
    back: figure.getByRole('button', { name: 'Step back' }),
    forward: figure.getByRole('button', { name: 'Step forward' }),
    reset: figure.getByRole('button', { name: 'Reset' }),
    toggle: figure.getByRole('button', { name: /^(Play|Pause|Replay)$/ }),
  };
}

interface Fixture {
  main: Island;
  mini: Island;
}

/** Opens the fixture page and waits until the islands are hydrated (`client:visible` needs them on screen). */
async function openFixture(page: Page, options: { both?: boolean } = {}): Promise<Fixture> {
  await page.goto(FIXTURE_PATH);
  const main = islandOf(page, viewFixture.id);
  const mini = islandOf(page, viewFixtureMini.id);
  const toHydrate = options.both === false ? [main] : [main, mini];
  for (const island of toHydrate) {
    await island.figure.scrollIntoViewIfNeeded();
    await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  }
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  return { main, mini };
}

async function expectStep(island: Island, step: number): Promise<void> {
  await expect(island.root).toHaveAttribute('data-step', String(step));
}

/** Clicks Step forward until the player is at the 0-based `step`. */
async function goToStep(island: Island, step: number): Promise<void> {
  for (let reached = 0; reached <= step; reached += 1) await island.forward.click();
  await expectStep(island, step);
}

async function selectScenario(island: Island, label: string, id: string): Promise<void> {
  await island.figure.getByRole('tab', { name: label, exact: true }).click();
  await expect(island.root).toHaveAttribute('data-scenario', id);
}

function groupHead(island: Island, id: string): Locator {
  return island.root.locator(`[data-group-head="${id}"]`);
}

function nodeCard(island: Island, id: string): Locator {
  return island.root.locator(`[data-node-id="${id}"]`);
}

function groupBox(island: Island, id: string): Locator {
  return island.root.locator(`[data-group-id="${id}"]`);
}

function edge(island: Island, id: string): Locator {
  return island.root.locator(`[data-edge-id="${id}"]`);
}

function packetOf(island: Island): Locator {
  return island.root.locator('[data-packet]');
}

function captionRegion(island: Island): Locator {
  return island.root.locator('[data-caption]');
}

/** Sets the colour scheme and Starlight's stored theme before the page loads (Starlight then sets `data-theme`). */
async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => {
    window.localStorage.setItem('starlight-theme', value);
  }, theme);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function rectOf(locator: Locator): Promise<Rect> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('element has no box (not visible?)');
  return found;
}

function expectInside(inner: Rect, outer: Rect, tolerance = 1): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + tolerance);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + tolerance);
}

interface EdgeGeometry {
  /** Distance (px, screen) from the centre of the packet to the nearest point of the edge's path. */
  distance: number;
  /** The first and last point of the path on screen. */
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** The centre of the packet on screen. */
  packet: { x: number; y: number };
}

/** Measures where the packet of `diagramId` is relative to the drawn path of `edgeId`. */
async function packetGeometry(
  page: Page,
  diagramId: string,
  edgeId: string,
): Promise<EdgeGeometry> {
  return page.evaluate(
    ({ diagramId: figureId, edgeId: id }) => {
      const figure = document.querySelector(`figure[data-diagram="${figureId}"]`);
      const edgeElement = figure?.querySelector(`[data-edge-id="${id}"]`);
      const packetElement = figure?.querySelector('[data-packet]');
      if (!edgeElement || !packetElement) throw new Error('edge or packet not found');
      const candidates = edgeElement.matches('path')
        ? [edgeElement]
        : Array.from(edgeElement.querySelectorAll('path'));
      const paths = candidates.filter((path) => path.closest('marker') === null);
      const path = paths.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0];
      if (!path) throw new Error('edge has no path');
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error('path is not rendered');
      const length = path.getTotalLength();
      const samples = Array.from({ length: 201 }, (_, index) => {
        const point = path.getPointAtLength((length * index) / 200);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
      });
      const rect = packetElement.getBoundingClientRect();
      const packet = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const distance = Math.min(
        ...samples.map((sample) => Math.hypot(sample.x - packet.x, sample.y - packet.y)),
      );
      return {
        distance,
        start: samples[0] as { x: number; y: number },
        end: samples[samples.length - 1] as { x: number; y: number },
        packet,
      };
    },
    { diagramId, edgeId },
  );
}

async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

// ---------------------------------------------------------------------------
// AC-15 rendering
// ---------------------------------------------------------------------------

test.describe('rendering on desktop', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-15: both fixtures hydrate with the wide layout', async ({ page }) => {
    const { main, mini } = await openFixture(page);

    for (const island of [main, mini]) {
      await expect(island.root).toHaveAttribute('data-hydrated', 'true');
      await expect(island.root).toHaveAttribute('data-layout', 'wide');
    }
  });

  test('AC-15: every group and node of view-fixture is visible with its label and sub-label', async ({
    page,
  }) => {
    const { main } = await openFixture(page);

    for (const group of viewFixture.groups ?? []) {
      await expect(groupBox(main, group.id)).toBeVisible();
      const head = groupHead(main, group.id);
      await expect(head).toBeVisible();
      await expect(head).toContainText(group.label);
      const headRect = await rectOf(head);
      const boxRect = await rectOf(groupBox(main, group.id));
      expect(headRect.x).toBeGreaterThanOrEqual(boxRect.x - 1);
      expect(headRect.y).toBeGreaterThanOrEqual(boxRect.y - 1);
      expect(headRect.x).toBeLessThanOrEqual(boxRect.x + boxRect.width + 1);
      expect(headRect.y).toBeLessThanOrEqual(boxRect.y + boxRect.height + 1);
    }
    for (const node of viewFixture.nodes) {
      await expect(nodeCard(main, node.id)).toBeVisible();
      await expect(nodeCard(main, node.id).getByText(node.label, { exact: true })).toBeVisible();
      if (node.sub !== undefined) {
        await expect(nodeCard(main, node.id).getByText(node.sub, { exact: true })).toBeVisible();
      }
    }
  });

  test('AC-15: keys lies inside region and kms inside keys on screen', async ({ page }) => {
    const { main } = await openFixture(page);

    const region = await rectOf(groupBox(main, 'region'));
    const keys = await rectOf(groupBox(main, 'keys'));
    const kms = await rectOf(nodeCard(main, 'kms'));

    expectInside(keys, region);
    expectInside(kms, keys);
  });

  test('AC-15: s3 and trail lie inside region and client outside it', async ({ page }) => {
    const { main } = await openFixture(page);

    const region = await rectOf(groupBox(main, 'region'));

    expectInside(await rectOf(nodeCard(main, 's3')), region);
    expectInside(await rectOf(nodeCard(main, 'trail')), region);
    const client = await rectOf(nodeCard(main, 'client'));
    expect(client.x + client.width).toBeLessThanOrEqual(region.x + 1);
  });

  for (const { id } of viewFixture.edges ?? []) {
    test(`AC-15: the ${id} edge is drawn with a non-empty path`, async ({ page }) => {
      const { main } = await openFixture(page);

      const lengths = await edge(main, id)
        .first()
        .evaluate((element) => {
          const paths = element.matches('path')
            ? [element]
            : Array.from(element.querySelectorAll('path'));
          return paths
            .filter((path) => path.closest('marker') === null)
            .map((path) => ({ d: path.getAttribute('d') ?? '', length: path.getTotalLength() }));
        });

      expect(lengths.length).toBeGreaterThan(0);
      expect(lengths.some((path) => path.d.trim() !== '' && path.length > 0)).toBe(true);
    });
  }

  test('AC-15: the gen edge label is visible', async ({ page }) => {
    const { main } = await openFixture(page);

    await expect(main.root.getByText('Data key request', { exact: true })).toBeVisible();
  });

  test('AC-15: the React Flow attribution link is visible in each island', async ({ page }) => {
    const { main, mini } = await openFixture(page);

    for (const island of [main, mini]) {
      await expect(island.figure.getByRole('link', { name: /React Flow/i })).toBeVisible();
    }
  });

  test('AC-15: view-fixture-mini renders its two nodes without groups or edges', async ({
    page,
  }) => {
    const { mini } = await openFixture(page);

    for (const node of viewFixtureMini.nodes) {
      await expect(nodeCard(mini, node.id).getByText(node.label, { exact: true })).toBeVisible();
    }
    await expect(mini.root.locator('[data-group-id]')).toHaveCount(0);
    await expect(mini.root.locator('[data-edge-id]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// AC-16 stepping
// ---------------------------------------------------------------------------

test.describe('stepping', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-16: at the start the count reads 5 steps, the log shows the prompt and there is no packet', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });

    await expectStep(main, -1);
    await expect(main.root.getByText('5 steps', { exact: true })).toBeVisible();
    await expect(main.root.getByText('Press Play or step forward to start.')).toBeVisible();
    await expect(packetOf(main)).toHaveCount(0);
  });

  test('AC-16: Step forward shows step 1: count, caption and the first log line', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });

    await main.forward.click();

    await expectStep(main, 0);
    await expect(main.root.getByText('Step 1 of 5').first()).toBeVisible();
    await expect(captionRegion(main)).toContainText(captionOf(upload, 0));
    const lines = main.root.locator('[data-log-line]');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText('[1/5]');
    await expect(lines.first()).toContainText('client → s3');
    await expect(lines.first()).toContainText('PutObject');
    await expect(main.root.getByText('Press Play or step forward to start.')).toBeHidden();
  });

  test('AC-16: a second step adds a log line, Step back removes it again', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await main.forward.click();
    await main.forward.click();
    await expectStep(main, 1);
    await expect(main.root.locator('[data-log-line]')).toHaveCount(2);
    await expect(captionRegion(main)).toContainText(captionOf(upload, 1));

    await main.back.click();

    await expectStep(main, 0);
    await expect(main.root.locator('[data-log-line]')).toHaveCount(1);
    await expect(captionRegion(main)).toContainText(captionOf(upload, 0));
    await expect(main.root.getByText('Step 1 of 5').first()).toBeVisible();
  });

  test('AC-16: Reset returns to the start view', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    await goToStep(main, 2);

    await main.reset.click();

    await expectStep(main, -1);
    await expect(main.root.getByText('5 steps', { exact: true })).toBeVisible();
    await expect(main.root.getByText('Press Play or step forward to start.')).toBeVisible();
    await expect(
      main.root.locator('[data-log-line]').filter({ hasText: /\[\d+\/\d+\]/ }),
    ).toHaveCount(0);
    await expect(packetOf(main)).toHaveCount(0);
  });

  test('AC-16: at the start Step back is aria-disabled, still focusable, does nothing and keeps focus', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });

    await expect(main.back).toHaveAttribute('aria-disabled', 'true');
    await expect(main.back).not.toHaveAttribute('disabled');
    await main.back.focus();
    await main.back.click({ force: true });
    await page.keyboard.press('Enter');

    await expectStep(main, -1);
    await expect(main.back).toBeFocused();
    await expect(main.back).toHaveAttribute('aria-disabled', 'true');
  });

  test('AC-16: Step forward is not disabled at the start', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await expect(main.forward).not.toHaveAttribute('aria-disabled', 'true');
    await expect(main.forward).not.toHaveAttribute('disabled');
  });

  test('AC-16: at the last step Step forward is aria-disabled, still focusable, does nothing and keeps focus', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });
    await goToStep(main, 4);

    await expect(main.forward).toHaveAttribute('aria-disabled', 'true');
    await expect(main.forward).not.toHaveAttribute('disabled');
    await main.forward.focus();
    await main.forward.click({ force: true });
    await page.keyboard.press('Enter');

    await expectStep(main, 4);
    await expect(main.forward).toBeFocused();
    await expect(main.back).not.toHaveAttribute('aria-disabled', 'true');
    await expect(main.root.getByText('Step 5 of 5').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-17 playing (fake clock)
// ---------------------------------------------------------------------------

test.describe('playing', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  async function openWithClock(page: Page): Promise<Island> {
    await page.clock.install({ time: new Date('2026-01-01T10:00:00') });
    const { main } = await openFixture(page, { both: false });
    await page.clock.pauseAt(new Date('2026-01-01T10:01:00'));
    return main;
  }

  test('AC-17: Play shows step 1 at once and starts playing', async ({ page }) => {
    const main = await openWithClock(page);

    await main.toggle.click();

    await expectStep(main, 0);
    await expect(main.root).toHaveAttribute('data-playing', 'true');
    await expect(main.toggle).toHaveText('Pause');
  });

  test('AC-17: the next step comes after 3600 ms, not before', async ({ page }) => {
    const main = await openWithClock(page);
    await main.toggle.click();
    await expectStep(main, 0);

    await page.clock.runFor(STEP_MS - 600);
    await expectStep(main, 0);

    await page.clock.runFor(600);
    await expectStep(main, 1);
    await expect(main.root).toHaveAttribute('data-playing', 'true');
  });

  test('AC-17: every 3600 ms moves one step, then playing stops and the button reads Replay', async ({
    page,
  }) => {
    const main = await openWithClock(page);
    await main.toggle.click();

    for (const step of [1, 2, 3]) {
      await page.clock.runFor(STEP_MS);
      await expectStep(main, step);
      await expect(main.root).toHaveAttribute('data-playing', 'true');
    }
    await page.clock.runFor(STEP_MS);

    await expectStep(main, 4);
    await expect(main.root).toHaveAttribute('data-playing', 'false');
    await expect(main.toggle).toHaveText('Replay');
  });

  test('AC-17: Replay goes to step 1 and plays again', async ({ page }) => {
    const main = await openWithClock(page);
    await main.toggle.click();
    for (let tick = 0; tick < 4; tick += 1) await page.clock.runFor(STEP_MS);
    await expect(main.toggle).toHaveText('Replay');

    await main.toggle.click();

    await expectStep(main, 0);
    await expect(main.root).toHaveAttribute('data-playing', 'true');
    await expect(main.toggle).toHaveText('Pause');
  });

  test('AC-17: Pause stops: nothing changes after another 3600 ms', async ({ page }) => {
    const main = await openWithClock(page);
    await main.toggle.click();
    await page.clock.runFor(STEP_MS);
    await expectStep(main, 1);

    await main.toggle.click();
    await expect(main.root).toHaveAttribute('data-playing', 'false');
    await expect(main.toggle).toHaveText('Play');
    await page.clock.runFor(STEP_MS);
    await page.clock.runFor(STEP_MS);

    await expectStep(main, 1);
    await expect(main.root).toHaveAttribute('data-playing', 'false');
  });

  test('AC-17: stepping by hand while playing pauses', async ({ page }) => {
    const main = await openWithClock(page);
    await main.toggle.click();
    await page.clock.runFor(STEP_MS - 600);
    await expectStep(main, 0);

    await main.forward.click();

    await expectStep(main, 1);
    await expect(main.root).toHaveAttribute('data-playing', 'false');
    await expect(main.toggle).toHaveText('Play');
    await page.clock.runFor(STEP_MS);
    await expectStep(main, 1);
  });
});

// ---------------------------------------------------------------------------
// AC-18 packet and edge status
// ---------------------------------------------------------------------------

test.describe('packet', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-18: step 2 shows GenerateDataKey on the gen edge, gen active and put done', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 1);

    await expect(packetOf(main)).toHaveCount(1);
    await expect(packetOf(main)).toHaveText('GenerateDataKey');
    await expect(packetOf(main)).toBeVisible();
    await expect(edge(main, 'gen')).toHaveAttribute('data-status', 'active');
    await expect(edge(main, 'put')).toHaveAttribute('data-status', 'done');
    await expect(edge(main, 'audit')).toHaveAttribute('data-status', 'idle');
    await expect(packetOf(main)).toHaveAttribute('data-reverse', 'false');
    expect((await packetGeometry(page, 'view-fixture', 'gen')).distance).toBeLessThanOrEqual(12);
  });

  test('AC-18: at the start no edge is active', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    for (const { id } of viewFixture.edges ?? []) {
      await expect(edge(main, id)).toHaveAttribute('data-status', 'idle');
      await expect(edge(main, id)).toHaveAttribute('data-active', 'false');
    }
  });

  test('AC-18: step 3 shows "data key" travelling back (data-reverse=true) on the gen edge', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 2);

    await expect(packetOf(main)).toHaveText('data key');
    await expect(packetOf(main)).toHaveAttribute('data-reverse', 'true');
    await expect(edge(main, 'gen')).toHaveAttribute('data-status', 'active');
    expect((await packetGeometry(page, 'view-fixture', 'gen')).distance).toBeLessThanOrEqual(12);
  });

  test('AC-18: step 4 has no packet label: a packet without text on the audit edge', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 3);

    await expect(packetOf(main)).toHaveCount(1);
    await expect(packetOf(main)).toBeVisible();
    await expect(packetOf(main)).toHaveText('');
    await expect(edge(main, 'audit')).toHaveAttribute('data-status', 'active');
    await expect(edge(main, 'gen')).toHaveAttribute('data-status', 'done');
    expect((await packetGeometry(page, 'view-fixture', 'audit')).distance).toBeLessThanOrEqual(12);
  });

  test('AC-18: step 5 is a node step: no packet, s3 active and highlighted', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 4);

    await expect(packetOf(main)).toHaveCount(0);
    await expect(nodeCard(main, 's3')).toHaveAttribute('data-active', 'true');
    await expect(nodeCard(main, 's3')).toHaveAttribute('data-state', 'highlighted');
    await expect(nodeCard(main, 'kms')).toHaveAttribute('data-active', 'false');
    for (const { id } of viewFixture.edges ?? []) {
      await expect(edge(main, id)).toHaveAttribute('data-status', 'done');
    }
  });

  test('AC-18: Step back from step 5 restores the packet of step 4 and clears the highlight', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });
    await goToStep(main, 4);

    await main.back.click();

    await expectStep(main, 3);
    await expect(packetOf(main)).toHaveCount(1);
    await expect(nodeCard(main, 's3')).toHaveAttribute('data-state', 'normal');
    await expect(nodeCard(main, 's3')).toHaveAttribute('data-active', 'false');
  });
});

// ---------------------------------------------------------------------------
// AC-19 element states
// ---------------------------------------------------------------------------

test.describe('element states', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  async function openKeyDisabled(page: Page): Promise<Island> {
    const { main } = await openFixture(page, { both: false });
    await selectScenario(main, keyDisabled.label, 'key-disabled');
    return main;
  }

  test('AC-19: at the start trail and the audit edge are hidden', async ({ page }) => {
    const main = await openKeyDisabled(page);

    await expect(nodeCard(main, 'trail')).toHaveAttribute('data-state', 'hidden');
    await expect(nodeCard(main, 'trail')).toBeHidden();
    await expect(edge(main, 'audit')).toHaveAttribute('data-state', 'hidden');
    await expect(edge(main, 'audit')).toBeHidden();
    await expect(nodeCard(main, 'kms')).toBeVisible();
  });

  test('AC-19: after step 1 the keys group is active and kms is failed with a visible failed pill', async ({
    page,
  }) => {
    const main = await openKeyDisabled(page);

    await goToStep(main, 0);

    await expect(groupBox(main, 'keys')).toHaveAttribute('data-active', 'true');
    await expect(nodeCard(main, 'kms')).toHaveAttribute('data-state', 'failed');
    await expect(nodeCard(main, 'kms').getByText('failed', { exact: true })).toBeVisible();
    await expect(packetOf(main)).toHaveCount(0);
  });

  test('AC-19: after step 3 the gen edge is broken and shows a cross', async ({ page }) => {
    const main = await openKeyDisabled(page);

    await goToStep(main, 2);

    await expect(edge(main, 'gen')).toHaveAttribute('data-state', 'broken');
    await expect(edge(main, 'gen')).toHaveAttribute('data-active', 'true');
    await expect(main.root.getByText('✕')).toBeVisible();
  });

  test('AC-19: at step 5 trail is visible and appearing', async ({ page }) => {
    const main = await openKeyDisabled(page);

    await goToStep(main, 4);

    await expect(nodeCard(main, 'trail')).toHaveAttribute('data-state', 'appearing');
    await expect(nodeCard(main, 'trail')).toBeVisible();
    await expect(nodeCard(main, 'trail')).toHaveAttribute('data-active', 'true');
    await expect(nodeCard(main, 'kms')).toHaveAttribute('data-state', 'failed');
    await expect(edge(main, 'gen')).toHaveAttribute('data-state', 'broken');
  });

  test('AC-19: Step back from step 5 to step 1 restores trail hidden and gen normal', async ({
    page,
  }) => {
    const main = await openKeyDisabled(page);
    await goToStep(main, 4);

    for (let back = 0; back < 4; back += 1) await main.back.click();

    await expectStep(main, 0);
    await expect(nodeCard(main, 'trail')).toHaveAttribute('data-state', 'hidden');
    await expect(nodeCard(main, 'trail')).toBeHidden();
    await expect(edge(main, 'gen')).toHaveAttribute('data-state', 'normal');
    await expect(nodeCard(main, 'kms')).toHaveAttribute('data-state', 'failed');
  });

  test('AC-19: Reset restores every state of the scenario start', async ({ page }) => {
    const main = await openKeyDisabled(page);
    await goToStep(main, 4);

    await main.reset.click();

    await expect(nodeCard(main, 'trail')).toHaveAttribute('data-state', 'hidden');
    await expect(nodeCard(main, 'kms')).toHaveAttribute('data-state', 'normal');
    await expect(edge(main, 'gen')).toHaveAttribute('data-state', 'normal');
  });
});

// ---------------------------------------------------------------------------
// AC-20 metric pills
// ---------------------------------------------------------------------------

test.describe('metric pills', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-20: step 2 of upload shows one pill KMS requests +1', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 1);

    const pills = captionRegion(main).locator('[data-metric]');
    await expect(pills).toHaveCount(1);
    await expect(pills).toHaveText(/KMS requests\s*\+1/);
  });

  test('AC-20: step 3 of key-disabled shows two pills', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    await selectScenario(main, keyDisabled.label, 'key-disabled');

    await goToStep(main, 2);

    const pills = captionRegion(main).locator('[data-metric]');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveText(/KMS requests\s*\+1/);
    await expect(pills.nth(1)).toHaveText(/Errors\s*1/);
  });

  test('AC-20: steps without metrics show no pill', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await expect(captionRegion(main).locator('[data-metric]')).toHaveCount(0);
    await goToStep(main, 0);
    await expect(captionRegion(main).locator('[data-metric]')).toHaveCount(0);
    await main.reset.click();
    await expectStep(main, -1);
    await goToStep(main, 2);
    await expect(captionRegion(main).locator('[data-metric]')).toHaveCount(0);
  });

  test('AC-20: going back from a step with metrics removes the pill', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    await goToStep(main, 1);
    await expect(captionRegion(main).locator('[data-metric]')).toHaveCount(1);

    await main.back.click();

    await expectStep(main, 0);
    await expect(captionRegion(main).locator('[data-metric]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// AC-21 scenario tabs
// ---------------------------------------------------------------------------

test.describe('scenario tabs', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-21: view-fixture has a tablist with both scenario labels, the first selected', async ({
    page,
  }) => {
    const { main } = await openFixture(page);

    await expect(main.figure.getByRole('tablist')).toHaveCount(1);
    const tabs = main.figure.getByRole('tab');
    await expect(tabs).toHaveText([upload.label, keyDisabled.label]);
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
    await expect(main.figure.getByRole('tabpanel')).toBeVisible();
    await expect(main.root).toHaveAttribute('data-scenario', 'upload');
  });

  test('AC-21: clicking the second tab selects it, switches the scenario and resets the log', async ({
    page,
  }) => {
    const { main } = await openFixture(page);
    await goToStep(main, 1);
    await expect(main.root.locator('[data-log-line]')).toHaveCount(2);

    await main.figure.getByRole('tab', { name: keyDisabled.label, exact: true }).click();

    await expect(
      main.figure.getByRole('tab', { name: keyDisabled.label, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(main.figure.getByRole('tab', { name: upload.label, exact: true })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await expect(main.root).toHaveAttribute('data-scenario', 'key-disabled');
    await expectStep(main, -1);
    await expect(main.root.getByText('Press Play or step forward to start.')).toBeVisible();
    await expect(
      main.root.locator('[data-log-line]').filter({ hasText: /\[\d+\/\d+\]/ }),
    ).toHaveCount(0);
  });

  test('AC-21: with focus on a tab, ArrowRight and ArrowLeft move the selection and wrap around', async ({
    page,
  }) => {
    const { main } = await openFixture(page);
    const first = main.figure.getByRole('tab', { name: upload.label, exact: true });
    const second = main.figure.getByRole('tab', { name: keyDisabled.label, exact: true });
    await first.focus();

    await page.keyboard.press('ArrowRight');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(main.root).toHaveAttribute('data-scenario', 'key-disabled');

    await page.keyboard.press('ArrowRight');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(main.root).toHaveAttribute('data-scenario', 'upload');

    await page.keyboard.press('ArrowLeft');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(main.root).toHaveAttribute('data-scenario', 'key-disabled');
  });

  test('AC-21: with focus on a tab, Home and End select the first and the last tab', async ({
    page,
  }) => {
    const { main } = await openFixture(page);
    const first = main.figure.getByRole('tab', { name: upload.label, exact: true });
    const second = main.figure.getByRole('tab', { name: keyDisabled.label, exact: true });
    await first.focus();

    await page.keyboard.press('End');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(main.root).toHaveAttribute('data-scenario', 'key-disabled');

    await page.keyboard.press('Home');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(main.root).toHaveAttribute('data-scenario', 'upload');
  });

  test('AC-21: keys pressed in the tablist do not step the diagram', async ({ page }) => {
    const { main } = await openFixture(page);
    await main.figure.getByRole('tab', { name: upload.label, exact: true }).focus();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('End');

    await expectStep(main, -1);
    await expect(main.root).toHaveAttribute('data-playing', 'false');
  });

  test('AC-21: view-fixture-mini has no tablist', async ({ page }) => {
    const { mini } = await openFixture(page);

    await expect(mini.figure.getByRole('tablist')).toHaveCount(0);
    await expect(mini.figure.getByRole('tab')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// AC-22 keyboard
// ---------------------------------------------------------------------------

test.describe('keyboard', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-22: the island root is a focusable group labelled with the title', async ({ page }) => {
    const { main } = await openFixture(page);

    await expect(main.root).toHaveAttribute('role', 'group');
    await expect(main.root).toHaveAttribute('tabindex', '0');
    await expect(main.root).toHaveAttribute('aria-label', 'Animated diagram: View fixture');
    await expect(
      main.figure.getByRole('group', { name: 'Animated diagram: View fixture' }),
    ).toBeVisible();
  });

  test('AC-22: ArrowRight steps forward, ArrowLeft back, End jumps to the last step, Home resets', async ({
    page,
  }) => {
    const { main } = await openFixture(page);
    await main.root.focus();

    await page.keyboard.press('ArrowRight');
    await expectStep(main, 0);
    await page.keyboard.press('ArrowRight');
    await expectStep(main, 1);
    await page.keyboard.press('ArrowLeft');
    await expectStep(main, 0);
    await page.keyboard.press('End');
    await expectStep(main, 4);
    await page.keyboard.press('Home');
    await expectStep(main, -1);
  });

  test('AC-22: Space and k toggle playing', async ({ page }) => {
    const { main } = await openFixture(page);
    await main.root.focus();

    await page.keyboard.press('Space');
    await expect(main.root).toHaveAttribute('data-playing', 'true');
    await expectStep(main, 0);
    await page.keyboard.press('Space');
    await expect(main.root).toHaveAttribute('data-playing', 'false');

    await page.keyboard.press('k');
    await expect(main.root).toHaveAttribute('data-playing', 'true');
    await page.keyboard.press('k');
    await expect(main.root).toHaveAttribute('data-playing', 'false');
  });

  test('AC-22: pressing Space on the island does not scroll the page', async ({ page }) => {
    const { main } = await openFixture(page);
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight,
    );
    expect(scrollable, 'the fixture page must be taller than the viewport').toBe(true);
    await main.root.focus();
    const before = await page.evaluate(() => window.scrollY);

    await page.keyboard.press('Space');
    await expect(main.root).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(300); // a scroll caused by the key would land within this time

    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });

  test('AC-22: keys also work while focus is on a button inside the island', async ({ page }) => {
    const { main } = await openFixture(page);
    await main.reset.focus();

    await page.keyboard.press('ArrowRight');

    await expectStep(main, 0);
  });

  test('AC-22: with focus on Step forward, Space advances exactly one step', async ({ page }) => {
    const { main } = await openFixture(page);
    await main.forward.focus();

    await page.keyboard.press('Space');

    await expectStep(main, 0);
    await expect(main.root).toHaveAttribute('data-playing', 'false');
    await expect(main.forward).toBeFocused();
  });

  test('AC-22: with focus on Step forward, Enter advances exactly one step', async ({ page }) => {
    const { main } = await openFixture(page);
    await main.forward.focus();

    await page.keyboard.press('Enter');

    await expectStep(main, 0);
    await expect(main.root).toHaveAttribute('data-playing', 'false');
  });

  test('AC-22: keys pressed in view-fixture leave view-fixture-mini at step -1', async ({
    page,
  }) => {
    const { main, mini } = await openFixture(page);
    await main.root.focus();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');

    await expectStep(main, 4);
    await expectStep(mini, -1);
    await expect(mini.root).toHaveAttribute('data-playing', 'false');
  });

  test('AC-22: keys pressed in view-fixture-mini leave view-fixture at step -1', async ({
    page,
  }) => {
    const { main, mini } = await openFixture(page);
    await mini.root.focus();

    await page.keyboard.press('ArrowRight');

    await expectStep(mini, 0);
    await expectStep(main, -1);
  });
});

// ---------------------------------------------------------------------------
// AC-23 compact layout
// ---------------------------------------------------------------------------

test.describe('compact layout on a Pixel 7', () => {
  test.use(pixel7);

  test('AC-23: the island is compact, with client above s3', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await expect(main.root).toHaveAttribute('data-layout', 'compact');
    const client = await rectOf(nodeCard(main, 'client'));
    const s3 = await rectOf(nodeCard(main, 's3'));
    expect(client.y + client.height).toBeLessThanOrEqual(s3.y + 1);
  });

  test('AC-23: sub-labels are not visible', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await expect(main.root).toHaveAttribute('data-layout', 'compact');
    await expect(nodeCard(main, 'client').getByText('Client', { exact: true })).toBeVisible();
    await expect(main.root.getByText('IAM principal', { exact: true })).toBeHidden();
  });

  test('AC-23: every node label is rendered at least 11 px tall', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    await expect(main.root).toHaveAttribute('data-layout', 'compact');

    for (const node of viewFixture.nodes) {
      const label = nodeCard(main, node.id).getByText(node.label, { exact: true });
      await expect(label, node.id).toBeVisible();
      expect((await rectOf(label)).height, node.id).toBeGreaterThanOrEqual(11);
    }
  });

  test('AC-23: after two steps exactly one log line is visible', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 1);

    await expect(main.root.locator('[data-log-line]:visible')).toHaveCount(1);
    await expect(main.root.locator('[data-log-line]:visible')).toContainText('[2/5]');
  });

  test('AC-23: the page has no horizontal scroll', async ({ page }) => {
    const { main } = await openFixture(page);
    await goToStep(main, 2);

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));

    expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
  });
});

test.describe('resizing', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-23: resizing a desktop page to 400 px wide switches to compact and keeps data-step', async ({
    page,
  }) => {
    const { main } = await openFixture(page, { both: false });
    await expect(main.root).toHaveAttribute('data-layout', 'wide');
    await goToStep(main, 1);

    await page.setViewportSize({ width: 400, height: 800 });

    await expect(main.root).toHaveAttribute('data-layout', 'compact');
    await expectStep(main, 1);
    await expect(main.root).toHaveAttribute('data-scenario', 'upload');
    await expect(captionRegion(main)).toContainText(captionOf(upload, 1));
  });

  test('AC-23: resizing back to desktop width returns to the wide layout', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    await page.setViewportSize({ width: 400, height: 800 });
    await expect(main.root).toHaveAttribute('data-layout', 'compact');

    await page.setViewportSize(DESKTOP_VIEWPORT);

    await expect(main.root).toHaveAttribute('data-layout', 'wide');
  });
});

// ---------------------------------------------------------------------------
// AC-24 themes
// ---------------------------------------------------------------------------

/** The first painted background of the island root or of one of its large descendants. */
async function islandBackground(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const root = document.querySelector('figure[data-diagram="view-fixture"] [data-diagram-view]');
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const rect = element.getBoundingClientRect();
      if (rect.width < rootRect.width * 0.9 || rect.height < rootRect.height * 0.5) continue;
      const colour = getComputedStyle(element).backgroundColor;
      if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
    }
    return null;
  });
}

test.describe('themes', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-24: the island background differs between the light and the dark theme', async ({
    page,
  }) => {
    await useTheme(page, 'light');
    await openFixture(page, { both: false });
    const light = await islandBackground(page);

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    const dark = await islandBackground(page);

    expect(light, 'the island paints a background in light').not.toBeNull();
    expect(dark, 'the island paints a background in dark').not.toBeNull();
    expect(dark).not.toBe(light);
  });

  test('AC-24: in the dark theme user-dark.svg is the visible client icon and the light one is hidden', async ({
    page,
  }) => {
    await useTheme(page, 'dark');
    const { main } = await openFixture(page, { both: false });

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(nodeCard(main, 'client').locator('img[src$="/user-dark.svg"]')).toBeVisible();
    await expect(nodeCard(main, 'client').locator('img[src$="/user.svg"]')).toBeHidden();
  });

  test('AC-24: in the light theme user.svg is visible and user-dark.svg hidden', async ({
    page,
  }) => {
    await useTheme(page, 'light');
    const { main } = await openFixture(page, { both: false });

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(nodeCard(main, 'client').locator('img[src$="/user.svg"]')).toBeVisible();
    await expect(nodeCard(main, 'client').locator('img[src$="/user-dark.svg"]')).toBeHidden();
  });

  test('AC-24: switching the theme at runtime swaps the icon without a reload', async ({
    page,
  }) => {
    await useTheme(page, 'light');
    const { main } = await openFixture(page, { both: false });
    await goToStep(main, 1);
    await expect(nodeCard(main, 'client').locator('img[src$="/user.svg"]')).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    await expect(nodeCard(main, 'client').locator('img[src$="/user-dark.svg"]')).toBeVisible();
    await expect(nodeCard(main, 'client').locator('img[src$="/user.svg"]')).toBeHidden();
    await expectStep(main, 1);
  });
});

// ---------------------------------------------------------------------------
// AC-25 text fallback
// ---------------------------------------------------------------------------

async function expectFallbackLists(page: Page, diagram: Diagram): Promise<void> {
  const figure = page.locator(`figure[data-diagram="${diagram.id}"]`);
  const details = figure.locator('details');
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute('open');
  await expect(details.locator('summary')).toHaveText('Steps as text');
  const lists = details.locator('ol');
  await expect(lists).toHaveCount(diagram.scenarios.length);
  for (const [index, scenario] of diagram.scenarios.entries()) {
    const list = lists.nth(index);
    await expect(list.locator('li'), scenario.id).toHaveText(scenario.steps.map(fallbackText));
    const labelId = await list.getAttribute('aria-labelledby');
    expect(labelId, `${scenario.id} list is labelled`).toBeTruthy();
    await expect(page.locator(`[id="${String(labelId)}"]`)).toHaveText(scenario.label);
  }
}

test.describe('text fallback', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-25: view-fixture has a closed "Steps as text" with both scenarios in order and the metrics in parentheses', async ({
    page,
  }) => {
    await openFixture(page);

    await expectFallbackLists(page, viewFixture);
  });

  test('AC-25: the metrics of a step are written in parentheses after its caption', async ({
    page,
  }) => {
    await openFixture(page);
    const items = page.locator('figure[data-diagram="view-fixture"] details ol li');

    await expect(items.nth(1)).toHaveText(`${captionOf(upload, 1)} (KMS requests: +1)`);
    await expect(items.nth(7)).toHaveText(
      `${captionOf(keyDisabled, 2)} (KMS requests: +1, Errors: 1)`,
    );
  });

  test('AC-25: view-fixture-mini has a closed "Steps as text" with its single list', async ({
    page,
  }) => {
    await openFixture(page);

    await expectFallbackLists(page, viewFixtureMini);
  });

  test('AC-25: opening the details makes the lists visible', async ({ page }) => {
    await openFixture(page);
    const figure = page.locator('figure[data-diagram="view-fixture"]');

    await figure.getByText('Steps as text', { exact: true }).click();

    await expect(figure.locator('details')).toHaveAttribute('open', '');
    await expect(figure.locator('details ol').first()).toBeVisible();
  });
});

test.describe('text fallback without JavaScript', () => {
  test.use({ viewport: DESKTOP_VIEWPORT, javaScriptEnabled: false });

  test('AC-25: the same lists are in the page HTML with JavaScript disabled', async ({ page }) => {
    await page.goto(FIXTURE_PATH);

    await expectFallbackLists(page, viewFixture);
    await expectFallbackLists(page, viewFixtureMini);
  });
});

// ---------------------------------------------------------------------------
// AC-26 read-only canvas
// ---------------------------------------------------------------------------

test.describe('read-only canvas', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-26: a mouse wheel over the canvas scrolls the page', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    const card = await rectOf(nodeCard(main, 's3'));
    const x = card.x + card.width / 2;
    const y = card.y + card.height / 2;
    expect(y, 'the card is on screen at the top of the page').toBeLessThan(DESKTOP_VIEWPORT.height);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 400);

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('AC-26: dragging a card leaves its position unchanged', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    const before = await rectOf(nodeCard(main, 's3'));
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 90, y + 50, { steps: 6 });
    await page.mouse.up();

    const after = await rectOf(nodeCard(main, 's3'));
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  });

  test('AC-26: dragging the canvas does not pan it', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    const before = await rectOf(groupBox(main, 'region'));
    const client = await rectOf(nodeCard(main, 'client'));
    // An empty spot of the canvas: in the gap between the client card and the region, below the put edge.
    const x = (client.x + client.width + before.x) / 2;
    const y = client.y + client.height / 2 + 30;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 30, { steps: 6 });
    await page.mouse.up();

    const after = await rectOf(groupBox(main, 'region'));
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  });

  test('AC-26: there are no zoom or pan controls', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });

    await expect(
      main.figure.getByRole('button', { name: /zoom|fit view|interactivity|lock/i }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// AC-27 accessibility
// ---------------------------------------------------------------------------

const AXE_SETUPS = [
  { name: 'desktop', use: { viewport: DESKTOP_VIEWPORT } },
  { name: 'Pixel 7', use: pixel7 },
] as const;

for (const setup of AXE_SETUPS) {
  test.describe(`accessibility on ${setup.name}`, () => {
    test.use(setup.use);

    for (const theme of ['light', 'dark'] as const) {
      test(`AC-27: axe finds no WCAG A/AA violations at the start (${theme} theme, ${setup.name})`, async ({
        page,
      }) => {
        await useTheme(page, theme);
        await openFixture(page);

        expect(await axeViolations(page)).toEqual([]);
      });

      test(`AC-27: axe finds no WCAG A/AA violations at step 3 of key-disabled with the text steps open (${theme} theme, ${setup.name})`, async ({
        page,
      }) => {
        await useTheme(page, theme);
        const { main, mini } = await openFixture(page);
        await selectScenario(main, keyDisabled.label, 'key-disabled');
        await goToStep(main, 2);
        for (const island of [main, mini]) {
          await island.figure.getByText('Steps as text', { exact: true }).click();
          await expect(island.figure.locator('details')).toHaveAttribute('open', '');
        }

        expect(await axeViolations(page)).toEqual([]);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// AC-28 reduced motion
// ---------------------------------------------------------------------------

test.describe('reduced motion', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  async function runningCssAnimations(edgeLocator: Locator): Promise<number> {
    return edgeLocator.first().evaluate((element) => {
      return element
        .getAnimations({ subtree: true })
        .filter(
          (animation) => animation instanceof CSSAnimation && animation.playState === 'running',
        ).length;
    });
  }

  test('AC-28: the active edge has no running CSS animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 1);

    await expect(edge(main, 'gen')).toHaveAttribute('data-status', 'active');
    expect(await runningCssAnimations(edge(main, 'gen'))).toBe(0);
  });

  test('AC-28: the packet is visible at once at the end of the edge it travels to', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 1);
    const geometry = await packetGeometry(page, 'view-fixture', 'gen');

    await expect(packetOf(main)).toBeVisible();
    expect(
      Math.hypot(geometry.packet.x - geometry.end.x, geometry.packet.y - geometry.end.y),
    ).toBeLessThanOrEqual(8);
  });

  test('AC-28: a reverse packet sits at the from end of the edge', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { main } = await openFixture(page, { both: false });

    await goToStep(main, 2);
    const geometry = await packetGeometry(page, 'view-fixture', 'gen');

    await expect(packetOf(main)).toHaveAttribute('data-reverse', 'true');
    expect(
      Math.hypot(geometry.packet.x - geometry.start.x, geometry.packet.y - geometry.start.y),
    ).toBeLessThanOrEqual(8);
  });

  test('AC-28: the packet does not move', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { main } = await openFixture(page, { both: false });
    await goToStep(main, 1);

    const first = await packetGeometry(page, 'view-fixture', 'gen');
    await page.waitForTimeout(500); // long enough for a travelling packet to have moved
    const second = await packetGeometry(page, 'view-fixture', 'gen');

    expect(
      Math.hypot(second.packet.x - first.packet.x, second.packet.y - first.packet.y),
    ).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC-29 the build
// ---------------------------------------------------------------------------

const dist = resolve(import.meta.dirname, '..', '..', 'apps', 'site', 'dist');

test.describe('build output', () => {
  test('AC-29: no JavaScript file of the build contains org.eclipse.elk', () => {
    const files = readdirSync(join(dist, '_astro'), { recursive: true })
      .map(String)
      .filter((file) => /\.m?js$/.test(file));

    expect(files.length, 'the build has JavaScript').toBeGreaterThan(0);
    const offenders = files.filter((file) =>
      readFileSync(join(dist, '_astro', file), 'utf8').includes('org.eclipse.elk'),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-29: the fixture page ships islands, so the elk check above is not vacuous', () => {
    const html = readFileSync(join(dist, 'fixtures', 'diagram', 'index.html'), 'utf8');

    expect(html).toContain('astro-island');
  });

  test('AC-29: a guide page without a diagram (/d1/) has no astro-island', async ({ page }) => {
    await page.goto('/d1/');

    await expect(page.locator('astro-island')).toHaveCount(0);
    expect(readFileSync(join(dist, 'd1', 'index.html'), 'utf8')).not.toContain('astro-island');
  });
});

// ---------------------------------------------------------------------------
// AC-30 only the text fallback is indexed
// ---------------------------------------------------------------------------

test.describe('search indexing', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-30: every diagram island sits inside a data-pagefind-ignore element', async ({
    page,
  }) => {
    await page.goto(FIXTURE_PATH);

    const islands = await page.locator('astro-island').evaluateAll((elements) =>
      elements.map((element) => ({
        inDiagram: element.closest('figure[data-diagram]') !== null,
        ignored: element.closest('[data-pagefind-ignore]') !== null,
      })),
    );

    const diagramIslands = islands.filter((island) => island.inDiagram);
    expect(diagramIslands.length).toBeGreaterThanOrEqual(2);
    expect(diagramIslands.every((island) => island.ignored)).toBe(true);
  });

  test('AC-30: the "Steps as text" details is not inside a data-pagefind-ignore element', async ({
    page,
  }) => {
    await page.goto(FIXTURE_PATH);

    const details = await page
      .locator('figure[data-diagram] details')
      .evaluateAll((elements) =>
        elements.map((element) => element.closest('[data-pagefind-ignore]') !== null),
      );

    expect(details.length).toBeGreaterThanOrEqual(2);
    expect(details.every((ignored) => !ignored)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-31 K (Shift+k) toggles like k
// ---------------------------------------------------------------------------

test.describe('keyboard with Caps Lock or Shift', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-31: K (Shift+k) toggles playing like k', async ({ page }) => {
    const { main } = await openFixture(page, { both: false });
    await main.root.focus();

    await page.keyboard.press('Shift+K');
    await expect(main.root).toHaveAttribute('data-playing', 'true');
    await expectStep(main, 0);

    await page.keyboard.press('Shift+K');
    await expect(main.root).toHaveAttribute('data-playing', 'false');
  });
});

// ---------------------------------------------------------------------------
// Review round 2 helpers
// ---------------------------------------------------------------------------

/** Opens the fixture page and hydrates the third figure, `view-fixture-states`. */
async function openStates(page: Page): Promise<Island> {
  await page.goto(FIXTURE_PATH);
  const states = islandOf(page, viewFixtureStates.id);
  await expect(states.figure, 'the fixture page has the states diagram').toHaveCount(1);
  await states.figure.scrollIntoViewIfNeeded();
  await expect(states.root).toHaveAttribute('data-hydrated', 'true');
  return states;
}

/** Opens the fixture page and hydrates every figure; returns how many there are. */
async function hydrateAllFigures(page: Page): Promise<number> {
  await page.goto(FIXTURE_PATH);
  const figures = page.locator('figure[data-diagram]');
  const count = await figures.count();
  for (let index = 0; index < count; index += 1) {
    const figure = figures.nth(index);
    await figure.scrollIntoViewIfNeeded();
    await expect(figure.locator('[data-diagram-view]')).toHaveAttribute('data-hydrated', 'true');
  }
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  return count;
}

interface StrokeLook {
  dash: string;
  stroke: string;
  width: number;
}

/** The computed stroke of the visible line of an edge (its first painted, non-marker path). */
async function strokeOf(island: Island, edgeId: string): Promise<StrokeLook> {
  return edge(island, edgeId)
    .first()
    .evaluate((element) => {
      const candidates = element.matches('path')
        ? [element]
        : Array.from(element.querySelectorAll('path'));
      const painted = candidates
        .filter((path) => path.closest('marker') === null)
        .map((path) => getComputedStyle(path))
        .filter(
          (style) =>
            style.stroke !== 'none' &&
            style.stroke !== 'rgba(0, 0, 0, 0)' &&
            style.stroke !== 'transparent',
        );
      const style = painted[0];
      if (style === undefined) throw new Error('the edge has no painted path');
      return {
        dash: style.strokeDasharray,
        stroke: style.stroke,
        width: Number.parseFloat(style.strokeWidth),
      };
    });
}

interface ListItem {
  text: string;
  children: ListItem[];
}

interface StructureBlock {
  /** One entry per top-level list of the block: its name and its nested items. */
  lists: { name: string; items: ListItem[] }[];
}

/** Reads the nested lists of a `[data-diagram-structure]` block as plain data. */
async function readStructure(block: Locator): Promise<StructureBlock> {
  await expect(block).toHaveCount(1);
  return block.evaluate((root) => {
    const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
    const itemOf = (li: Element): ListItem => {
      const copy = li.cloneNode(true) as Element;
      copy.querySelectorAll('ul, ol').forEach((nested) => {
        nested.remove();
      });
      const nested = Array.from(li.children).filter((child) => child.matches('ul, ol'));
      return {
        text: clean(copy.textContent ?? ''),
        children: nested.flatMap((list) =>
          Array.from(list.children)
            .filter((child) => child.matches('li'))
            .map(itemOf),
        ),
      };
    };
    const nameOf = (list: Element): string => {
      const label = list.getAttribute('aria-label');
      if (label) return clean(label);
      const labelledBy = list.getAttribute('aria-labelledby');
      if (labelledBy) {
        return clean(
          labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' '),
        );
      }
      return clean(list.previousElementSibling?.textContent ?? '');
    };
    const topLists = Array.from(root.querySelectorAll('ul')).filter(
      (list) => list.parentElement?.closest('li') == null,
    );
    return {
      lists: topLists.map((list) => ({
        name: nameOf(list),
        items: Array.from(list.children)
          .filter((child) => child.matches('li'))
          .map(itemOf),
      })),
    };
  });
}

const VIEW_FIXTURE_ELEMENTS: ListItem[] = [
  {
    text: 'eu-west-1 (Region)',
    children: [
      {
        text: 'Key management (Group)',
        children: [{ text: 'KMS key', children: [] }],
      },
      { text: 'S3 bucket', children: [] },
      { text: 'CloudTrail', children: [] },
    ],
  },
  { text: 'Client (IAM principal)', children: [] },
];

const VIEW_FIXTURE_CONNECTIONS = [
  'Client → S3 bucket',
  'S3 bucket → KMS key: Data key request',
  'KMS key → CloudTrail',
];

// ---------------------------------------------------------------------------
// AC-35 states that get a look on every element
// ---------------------------------------------------------------------------

test.describe('states with a look on every element', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-35: an edge set highlighted is drawn solid, in another colour than an idle edge', async ({
    page,
  }) => {
    const states = await openStates(page);

    await goToStep(states, 0);

    await expect(edge(states, 'lit')).toHaveAttribute('data-state', 'highlighted');
    const lit = await strokeOf(states, 'lit');
    const rest = await strokeOf(states, 'rest');
    expect(lit.dash).toBe('none');
    expect(rest.dash).not.toBe('none');
    expect(lit.stroke).not.toBe(rest.stroke);
  });

  test('AC-35: the highlighted edge keeps that look on the next step', async ({ page }) => {
    const states = await openStates(page);

    await goToStep(states, 1);

    await expect(edge(states, 'lit')).toHaveAttribute('data-state', 'highlighted');
    await expect(edge(states, 'lit')).toHaveAttribute('data-active', 'false');
    const lit = await strokeOf(states, 'lit');
    const rest = await strokeOf(states, 'rest');
    expect(lit.dash).toBe('none');
    expect(lit.stroke).not.toBe(rest.stroke);
  });

  test('AC-35: an edge set appearing is visible with data-state appearing', async ({ page }) => {
    const states = await openStates(page);

    await goToStep(states, 1);

    await expect(edge(states, 'fade')).toHaveAttribute('data-state', 'appearing');
    await expect(edge(states, 'fade')).toBeVisible();
  });

  test('AC-35: an edge set failed has data-state broken and shows the cross', async ({ page }) => {
    const states = await openStates(page);

    await goToStep(states, 2);

    await expect(edge(states, 'bad')).toHaveAttribute('data-state', 'broken');
    await expect(states.root.getByText('✕')).toBeVisible();
  });

  test('AC-35: a node set broken has data-state failed and a visible failed pill', async ({
    page,
  }) => {
    const states = await openStates(page);

    await goToStep(states, 3);

    await expect(nodeCard(states, 'keys')).toHaveAttribute('data-state', 'failed');
    await expect(nodeCard(states, 'keys').getByText('failed', { exact: true })).toBeVisible();
  });

  test('AC-35: a group set broken has data-state failed and a failed pill in its header', async ({
    page,
  }) => {
    const states = await openStates(page);

    await goToStep(states, 4);

    await expect(groupBox(states, 'zone')).toHaveAttribute('data-state', 'failed');
    await expect(groupHead(states, 'zone').getByText('failed', { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-36 the canvas is hidden from assistive technology
// ---------------------------------------------------------------------------

test.describe('hidden canvas', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-36: in every figure the react-flow element is inside an aria-hidden element', async ({
    page,
  }) => {
    const count = await hydrateAllFigures(page);

    const hidden = await page.locator('figure[data-diagram]').evaluateAll((figures) =>
      figures.map((figure) => {
        const flow = figure.querySelector('.react-flow');
        return flow !== null && flow.closest('[aria-hidden="true"]') !== null;
      }),
    );

    expect(count).toBeGreaterThanOrEqual(2);
    expect(hidden).toEqual(Array.from({ length: count }, () => true));
  });

  test('AC-36: there is no react-flow attribution element', async ({ page }) => {
    await hydrateAllFigures(page);

    await expect(page.locator('.react-flow__attribution')).toHaveCount(0);
  });

  test('AC-36: each figure has a visible React Flow link outside any aria-hidden element', async ({
    page,
  }) => {
    const count = await hydrateAllFigures(page);

    for (let index = 0; index < count; index += 1) {
      const figure = page.locator('figure[data-diagram]').nth(index);
      // getByRole skips aria-hidden subtrees: finding the link proves it is exposed.
      const link = figure.getByRole('link', { name: 'React Flow', exact: true });
      await expect(link).toHaveCount(1);
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', 'https://reactflow.dev');
      expect(await link.evaluate((element) => element.closest('[aria-hidden="true"]'))).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-37 the text structure replaces the canvas for assistive technology
// ---------------------------------------------------------------------------

test.describe('text structure', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-37: each figure has exactly one structure block, outside data-pagefind-ignore', async ({
    page,
  }) => {
    const count = await hydrateAllFigures(page);

    const blocks = await page.locator('figure[data-diagram]').evaluateAll((figures) =>
      figures.map((figure) => {
        const found = figure.querySelectorAll('[data-diagram-structure]');
        return {
          count: found.length,
          ignored: found[0]?.closest('[data-pagefind-ignore]') != null,
        };
      }),
    );

    expect(blocks).toEqual(Array.from({ length: count }, () => ({ count: 1, ignored: false })));
  });

  test('AC-37: the block is visually hidden but present in the accessibility tree', async ({
    page,
  }) => {
    const { main } = await openFixture(page);
    const block = main.figure.locator('[data-diagram-structure]');

    const look = await block.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        height: rect.height,
        display: style.display,
        visibility: style.visibility,
        hiddenAncestor: element.closest('[aria-hidden="true"]') !== null,
      };
    });

    expect(look.width).toBeLessThanOrEqual(2);
    expect(look.height).toBeLessThanOrEqual(2);
    expect(look.display).not.toBe('none');
    expect(look.visibility).toBe('visible');
    expect(look.hiddenAncestor).toBe(false);
    // getByRole only finds accessible elements.
    expect(await block.getByRole('list').count()).toBeGreaterThanOrEqual(2);
  });

  test('AC-37: the "Diagram elements" list mirrors the groups and nodes of view-fixture', async ({
    page,
  }) => {
    const { main } = await openFixture(page);

    const structure = await readStructure(main.figure.locator('[data-diagram-structure]'));

    expect(structure.lists[0]?.name).toBe('Diagram elements');
    expect(structure.lists[0]?.items).toEqual(VIEW_FIXTURE_ELEMENTS);
  });

  test('AC-37: the "Connections" list has one item per edge', async ({ page }) => {
    const { main } = await openFixture(page);

    const structure = await readStructure(main.figure.locator('[data-diagram-structure]'));

    expect(structure.lists[1]?.name).toBe('Connections');
    expect(structure.lists[1]?.items.map((item) => item.text)).toEqual(VIEW_FIXTURE_CONNECTIONS);
  });

  test('AC-37: view-fixture-mini lists its two nodes', async ({ page }) => {
    const { mini } = await openFixture(page);

    const structure = await readStructure(mini.figure.locator('[data-diagram-structure]'));

    expect(structure.lists[0]?.items).toEqual([
      { text: 'First bucket', children: [] },
      { text: 'Second bucket', children: [] },
    ]);
  });
});

test.describe('text structure without JavaScript', () => {
  test.use({ viewport: DESKTOP_VIEWPORT, javaScriptEnabled: false });

  test('AC-37: the same lists are in the page with JavaScript disabled', async ({ page }) => {
    await page.goto(FIXTURE_PATH);
    const block = islandOf(page, viewFixture.id).figure.locator('[data-diagram-structure]');
    await expect(block).toHaveCount(1);

    const structure = await readStructure(block);

    expect(structure.lists[0]?.items).toEqual(VIEW_FIXTURE_ELEMENTS);
    expect(structure.lists[1]?.items.map((item) => item.text)).toEqual(VIEW_FIXTURE_CONNECTIONS);
  });
});

// ---------------------------------------------------------------------------
// AC-38 the picture is there without JavaScript
// ---------------------------------------------------------------------------

test.describe('picture without JavaScript', () => {
  test.use({ viewport: DESKTOP_VIEWPORT, javaScriptEnabled: false });

  test('AC-38: every node label and both group labels are visible', async ({ page }) => {
    await page.goto(FIXTURE_PATH);
    const main = islandOf(page, viewFixture.id);

    for (const group of viewFixture.groups ?? []) {
      await expect(groupHead(main, group.id)).toBeVisible();
      await expect(groupHead(main, group.id)).toContainText(group.label);
    }
    for (const node of viewFixture.nodes) {
      await expect(nodeCard(main, node.id)).toBeVisible();
      await expect(nodeCard(main, node.id).getByText(node.label, { exact: true })).toBeVisible();
    }
  });

  test('AC-38: the edges are drawn with non-empty paths', async ({ page }) => {
    await page.goto(FIXTURE_PATH);
    const main = islandOf(page, viewFixture.id);

    for (const { id } of viewFixture.edges ?? []) {
      await expect(edge(main, id)).toHaveCount(1);
      const lengths = await edge(main, id)
        .first()
        .evaluate((element) => {
          const candidates = element.matches('path')
            ? [element]
            : Array.from(element.querySelectorAll('path'));
          return candidates
            .filter((path) => path.closest('marker') === null)
            .map((path) => ({ d: path.getAttribute('d') ?? '', length: path.getTotalLength() }));
        });
      expect(
        lengths.some((path) => path.d.trim() !== '' && path.length > 0),
        id,
      ).toBe(true);
    }
  });

  test('AC-38: the controls bar and the tablist are not visible', async ({ page }) => {
    await page.goto(FIXTURE_PATH);
    const main = islandOf(page, viewFixture.id);

    await expect(
      main.figure.getByRole('button', { name: 'Play', exact: true, includeHidden: true }),
    ).toBeHidden();
    await expect(main.figure.getByRole('tablist', { includeHidden: true })).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// AC-39 hydrating does not move the page (spec 012, review round 3)
// ---------------------------------------------------------------------------

/** The scripts that hydrate the islands, read from the built fixture page. */
async function hydrationScriptUrls(page: Page): Promise<string[]> {
  const response = await page.request.get(FIXTURE_PATH);
  const html = await response.text();
  const urls = new Set<string>();
  for (const match of html.matchAll(/(?:component|renderer)-url="([^"]+)"/g)) {
    urls.add(match[1] as string);
  }
  return [...urls];
}

/**
 * Loads the fixture page with the island scripts held back, measures the top of the
 * "Steps as text" details of view-fixture, releases the scripts and measures again once
 * the island is hydrated.
 */
async function measureHydrationShift(page: Page): Promise<{ before: number; after: number }> {
  const urls = await hydrationScriptUrls(page);
  expect(urls.length, 'the island scripts were found in the built page').toBeGreaterThan(0);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const url of urls) {
    await page.route(`**${url}`, async (route) => {
      await gate;
      await route.continue();
    });
  }
  const top = () =>
    page
      .locator('figure[data-diagram="view-fixture"] details')
      .evaluate((element) => element.getBoundingClientRect().top + window.scrollY);

  await page.goto(FIXTURE_PATH, { waitUntil: 'load' });
  const main = islandOf(page, viewFixture.id);
  await expect(main.root).toBeAttached();
  // The "before" measurement must really be pre-hydration.
  await expect(main.root).not.toHaveAttribute('data-hydrated');
  const before = await top();

  release();
  await expect(main.root).toHaveAttribute('data-hydrated', 'true');
  const after = await top();
  return { before, after };
}

test.describe('hydration does not shift the page on desktop', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-39: the Steps as text details moves by at most 8 px when the island hydrates', async ({
    page,
  }) => {
    const { before, after } = await measureHydrationShift(page);

    expect(Math.abs(after - before), `top before ${before}, after ${after}`).toBeLessThanOrEqual(8);
  });
});

test.describe('hydration does not shift the page on a Pixel 7', () => {
  test.use(pixel7);

  test('AC-39: the Steps as text details moves by at most 8 px when the island hydrates', async ({
    page,
  }) => {
    const { before, after } = await measureHydrationShift(page);

    expect(Math.abs(after - before), `top before ${before}, after ${after}`).toBeLessThanOrEqual(8);
  });
});
