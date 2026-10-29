/// <reference lib="dom" />
// Browser checks of the first real diagram on a guide page (spec 013, AC-14…AC-18).
// The expected values are read from diagrams/s3-sse-kms-upload.yaml at test time.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { parse } from 'yaml';
import type { Diagram, DiagramScenario } from '../../packages/schema/src/index.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

const PAGE_PATH = '/d1/1-3-data-security/';
const DIAGRAM_ID = 's3-sse-kms-upload';
const HEADING = 'S3 encryption with SSE-KMS';
const DIAGRAM_FILE = resolve(import.meta.dirname, '..', '..', 'diagrams', `${DIAGRAM_ID}.yaml`);

/** The scenario ids AC-18 pins; also the fallback when the file cannot be read at collection time. */
const PINNED_SCENARIO_IDS = ['upload', 'download', 'denied', 'bucket-key'];

// ---------------------------------------------------------------------------
// The expected data, read from the diagram file
// ---------------------------------------------------------------------------

/** Reads the diagram file; throws (failing the test that asks) when it is missing. */
function loadDiagram(): Diagram {
  return parse(readFileSync(DIAGRAM_FILE, 'utf8')) as Diagram;
}

/** The scenario ids to build one test each for: the file's, or the pinned ones while the file is missing. */
function scenarioIdsForTests(): string[] {
  try {
    return loadDiagram().scenarios.map((scenario) => scenario.id);
  } catch {
    return PINNED_SCENARIO_IDS;
  }
}

function scenarioOf(diagram: Diagram, id: string): DiagramScenario {
  const scenario = diagram.scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id} in ${DIAGRAM_ID}.yaml`);
  return scenario;
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
}

function islandOf(page: Page): Island {
  const figure = page.locator(`figure[data-diagram="${DIAGRAM_ID}"]`);
  return {
    figure,
    root: figure.locator('[data-diagram-view]'),
    back: figure.getByRole('button', { name: 'Step back' }),
    forward: figure.getByRole('button', { name: 'Step forward' }),
  };
}

/** Opens the guide page and waits until the island is hydrated (`client:visible` needs it on screen). */
async function openGuidePage(page: Page): Promise<Island> {
  await page.goto(PAGE_PATH);
  const island = islandOf(page);
  await island.figure.scrollIntoViewIfNeeded();
  await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  return island;
}

async function expectStep(island: Island, step: number): Promise<void> {
  await expect(island.root).toHaveAttribute('data-step', String(step));
}

async function selectScenario(island: Island, scenario: DiagramScenario): Promise<void> {
  await island.figure.getByRole('tab', { name: scenario.label, exact: true }).click();
  await expect(island.root).toHaveAttribute('data-scenario', scenario.id);
}

function captionRegion(island: Island): Locator {
  return island.root.locator('[data-caption]');
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
// AC-14 the figure on the page
// ---------------------------------------------------------------------------

test.describe('the diagram on the 1.3 page', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-14: the page contains exactly one figure for s3-sse-kms-upload', async ({ page }) => {
    await page.goto(PAGE_PATH);

    await expect(page.locator(`figure[data-diagram="${DIAGRAM_ID}"]`)).toHaveCount(1);
  });

  test(`AC-14: the page has a heading "${HEADING}"`, async ({ page }) => {
    await page.goto(PAGE_PATH);

    await expect(page.getByRole('heading', { name: HEADING, level: 2 })).toHaveCount(1);
  });

  test('AC-14: the figure sits under the heading: it is the nearest heading before the figure', async ({
    page,
  }) => {
    await page.goto(PAGE_PATH);

    const nearestHeading = await page
      .locator(`figure[data-diagram="${DIAGRAM_ID}"]`)
      .evaluate((figure) => {
        const headings = Array.from(
          document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6'),
        ).filter(
          (heading) =>
            !figure.contains(heading) &&
            (heading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        );
        return headings.at(-1)?.textContent?.trim() ?? null;
      });

    expect(nearestHeading).toBe(HEADING);
  });

  test('AC-14: the island of the figure hydrates', async ({ page }) => {
    const island = await openGuidePage(page);

    await expect(island.root).toHaveAttribute('data-hydrated', 'true');
    await expect(island.forward).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-15 text fallback
// ---------------------------------------------------------------------------

test.describe('steps as text', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-15: "Steps as text" lists every scenario label of the file, each with its captions in file order', async ({
    page,
  }) => {
    const diagram = loadDiagram();
    await page.goto(PAGE_PATH);
    const details = page.locator(`figure[data-diagram="${DIAGRAM_ID}"] details`);

    await expect(details).toHaveCount(1);
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
  });
});

// ---------------------------------------------------------------------------
// AC-16 stepping through every scenario
// ---------------------------------------------------------------------------

test.describe('stepping through the scenarios', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  for (const id of scenarioIdsForTests()) {
    test(`AC-16: scenario "${id}" shows each step's caption in order when stepping forward`, async ({
      page,
    }) => {
      const scenario = scenarioOf(loadDiagram(), id);
      const island = await openGuidePage(page);
      await selectScenario(island, scenario);

      for (const [index, step] of scenario.steps.entries()) {
        await island.forward.click();
        await expectStep(island, index);
        await expect(captionRegion(island)).toContainText(step.caption);
      }
    });

    test(`AC-16: scenario "${id}" shows the previous caption again when stepping back from the last step`, async ({
      page,
    }) => {
      const scenario = scenarioOf(loadDiagram(), id);
      const island = await openGuidePage(page);
      await selectScenario(island, scenario);
      test.skip(scenario.steps.length < 2, 'a one-step scenario has no previous caption');
      for (let step = 0; step < scenario.steps.length; step += 1) await island.forward.click();
      await expectStep(island, scenario.steps.length - 1);
      const previous = scenario.steps.at(-2);

      await island.back.click();

      await expectStep(island, scenario.steps.length - 2);
      await expect(captionRegion(island)).toContainText(previous?.caption ?? '');
    });
  }
});

// ---------------------------------------------------------------------------
// AC-17 accessibility
// ---------------------------------------------------------------------------

test.describe('accessibility of the 1.3 page', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-17: axe finds no WCAG A/AA violations at the start', async ({ page }) => {
    await openGuidePage(page);

    expect(await axeViolations(page)).toEqual([]);
  });

  test('AC-17: axe finds no WCAG A/AA violations at the last step of the last scenario', async ({
    page,
  }) => {
    const diagram = loadDiagram();
    const last = diagram.scenarios.at(-1);
    if (last === undefined) throw new Error(`${DIAGRAM_ID}.yaml has no scenario`);
    const island = await openGuidePage(page);
    await selectScenario(island, last);
    for (let step = 0; step < last.steps.length; step += 1) await island.forward.click();
    await expectStep(island, last.steps.length - 1);

    expect(await axeViolations(page)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-18 content pin
// ---------------------------------------------------------------------------

test.describe('the diagram file', () => {
  test('AC-18: has 4 scenarios with the ids upload, download, denied and bucket-key', () => {
    expect(loadDiagram().scenarios.map((scenario) => scenario.id)).toEqual(PINNED_SCENARIO_IDS);
  });
});

// ===========================================================================
// The second real diagram: alb-asg-az-failure on the 2.2 page (spec 013, AC-14…AC-17).
// Same checks as above, plus the element states this diagram uses. The expected captions are read
// from diagrams/alb-asg-az-failure.yaml at test time.
// ===========================================================================

const ALB_PAGE_PATH = '/d2/2-2-high-availability/';
const ALB_DIAGRAM_ID = 'alb-asg-az-failure';
const ALB_HEADING = 'ALB and Auto Scaling across two AZs';
const ALB_DIAGRAM_FILE = resolve(
  import.meta.dirname,
  '..',
  '..',
  'diagrams',
  `${ALB_DIAGRAM_ID}.yaml`,
);
const ALB_SCENARIO_IDS = ['traffic', 'az-failure', 'az-recovery'];

function loadAlbDiagram(): Diagram {
  return parse(readFileSync(ALB_DIAGRAM_FILE, 'utf8')) as Diagram;
}

function albScenarioIdsForTests(): string[] {
  try {
    return loadAlbDiagram().scenarios.map((scenario) => scenario.id);
  } catch {
    return ALB_SCENARIO_IDS;
  }
}

function albScenarioOf(id: string): DiagramScenario {
  const scenario = loadAlbDiagram().scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id} in ${ALB_DIAGRAM_ID}.yaml`);
  return scenario;
}

function albIslandOf(page: Page): Island {
  const figure = page.locator(`figure[data-diagram="${ALB_DIAGRAM_ID}"]`);
  return {
    figure,
    root: figure.locator('[data-diagram-view]'),
    back: figure.getByRole('button', { name: 'Step back' }),
    forward: figure.getByRole('button', { name: 'Step forward' }),
  };
}

async function openAlbPage(page: Page): Promise<Island> {
  await page.goto(ALB_PAGE_PATH);
  const island = albIslandOf(page);
  await island.figure.scrollIntoViewIfNeeded();
  await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  return island;
}

/** Opens the page, selects the scenario and steps forward to the 0-based `step` (-1 = the start). */
async function openAlbAt(page: Page, scenarioId: string, step: number): Promise<Island> {
  const island = await openAlbPage(page);
  await selectScenario(island, albScenarioOf(scenarioId));
  for (let reached = 0; reached <= step; reached += 1) await island.forward.click();
  await expectStep(island, step);
  return island;
}

function albNode(island: Island, id: string): Locator {
  return island.root.locator(`[data-node-id="${id}"]`);
}

function albGroup(island: Island, id: string): Locator {
  return island.root.locator(`[data-group-id="${id}"]`);
}

function albEdge(island: Island, id: string): Locator {
  return island.root.locator(`[data-edge-id="${id}"]`);
}

test.describe('the ALB diagram on the 2.2 page', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-14: the page contains exactly one figure for alb-asg-az-failure', async ({ page }) => {
    await page.goto(ALB_PAGE_PATH);

    await expect(page.locator(`figure[data-diagram="${ALB_DIAGRAM_ID}"]`)).toHaveCount(1);
  });

  test(`AC-14: the page has a heading "${ALB_HEADING}"`, async ({ page }) => {
    await page.goto(ALB_PAGE_PATH);

    await expect(page.getByRole('heading', { name: ALB_HEADING, level: 2 })).toHaveCount(1);
  });

  test('AC-14: the alb figure sits under the heading: it is the nearest heading before the figure', async ({
    page,
  }) => {
    await page.goto(ALB_PAGE_PATH);

    const nearestHeading = await page
      .locator(`figure[data-diagram="${ALB_DIAGRAM_ID}"]`)
      .evaluate((figure) => {
        const headings = Array.from(
          document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6'),
        ).filter(
          (heading) =>
            !figure.contains(heading) &&
            (heading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        );
        return headings.at(-1)?.textContent?.trim() ?? null;
      });

    expect(nearestHeading).toBe(ALB_HEADING);
  });

  test('AC-14: the island of the alb figure hydrates', async ({ page }) => {
    const island = await openAlbPage(page);

    await expect(island.root).toHaveAttribute('data-hydrated', 'true');
    await expect(island.forward).toBeVisible();
  });

  test('AC-15: "Steps as text" of the alb figure lists every scenario label of the file, each with its captions in file order', async ({
    page,
  }) => {
    const diagram = loadAlbDiagram();
    await page.goto(ALB_PAGE_PATH);
    const details = page.locator(`figure[data-diagram="${ALB_DIAGRAM_ID}"] details`);

    await expect(details).toHaveCount(1);
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
  });

  test('AC-18: the alb file has 3 scenarios with the ids traffic, az-failure and az-recovery', () => {
    expect(albScenarioIdsForTests()).toEqual(ALB_SCENARIO_IDS);
  });
});

test.describe('stepping through the scenarios of the ALB diagram', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  for (const id of albScenarioIdsForTests()) {
    test(`AC-16: alb scenario "${id}" shows each step's caption in order when stepping forward`, async ({
      page,
    }) => {
      const scenario = albScenarioOf(id);
      const island = await openAlbPage(page);
      await selectScenario(island, scenario);

      for (const [index, step] of scenario.steps.entries()) {
        await island.forward.click();
        await expectStep(island, index);
        await expect(captionRegion(island)).toContainText(step.caption);
      }
    });

    test(`AC-16: alb scenario "${id}" shows the previous caption again when stepping back from the last step`, async ({
      page,
    }) => {
      const scenario = albScenarioOf(id);
      const island = await openAlbPage(page);
      await selectScenario(island, scenario);
      test.skip(scenario.steps.length < 2, 'a one-step scenario has no previous caption');
      for (let step = 0; step < scenario.steps.length; step += 1) await island.forward.click();
      await expectStep(island, scenario.steps.length - 1);
      const previous = scenario.steps.at(-2);

      await island.back.click();

      await expectStep(island, scenario.steps.length - 2);
      await expect(captionRegion(island)).toContainText(previous?.caption ?? '');
    });
  }
});

test.describe('element states of the ALB diagram', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-16: at the start of "az-failure" web-a is visible and web-b2 with its edges is hidden', async ({
    page,
  }) => {
    const island = await openAlbAt(page, 'az-failure', -1);

    await expect(albNode(island, 'web-a')).toBeVisible();
    await expect(albNode(island, 'web-a')).toHaveAttribute('data-state', 'normal');
    await expect(albNode(island, 'web-b2')).toHaveAttribute('data-state', 'hidden');
    await expect(albNode(island, 'web-b2')).toBeHidden();
    await expect(albEdge(island, 'to-b2')).toHaveAttribute('data-state', 'hidden');
    await expect(albEdge(island, 'launch-b2')).toHaveAttribute('data-state', 'hidden');
  });

  test('AC-16: "az-failure" step 1 marks az-a and web-a failed, each with a failed pill', async ({
    page,
  }) => {
    const island = await openAlbAt(page, 'az-failure', 0);

    await expect(albGroup(island, 'az-a')).toHaveAttribute('data-state', 'failed');
    await expect(albGroup(island, 'az-a')).toHaveAttribute('data-active', 'true');
    await expect(
      island.root.locator('[data-group-head="az-a"]').getByText('failed', { exact: true }),
    ).toBeVisible();
    await expect(albNode(island, 'web-a')).toHaveAttribute('data-state', 'failed');
    await expect(albNode(island, 'web-a').getByText('failed', { exact: true })).toBeVisible();
    await expect(albGroup(island, 'az-b')).toHaveAttribute('data-state', 'normal');
    await expect(albNode(island, 'web-b')).toHaveAttribute('data-state', 'normal');
  });

  test('AC-16: "az-failure" step 2 breaks the to-a edge and shows its cross', async ({ page }) => {
    const island = await openAlbAt(page, 'az-failure', 1);

    await expect(albEdge(island, 'to-a')).toHaveAttribute('data-state', 'broken');
    await expect(albEdge(island, 'to-a')).toHaveAttribute('data-active', 'true');
    await expect(island.root.getByText('✕')).toBeVisible();
    await expect(albGroup(island, 'az-a')).toHaveAttribute('data-state', 'failed');
  });

  test('AC-16: "az-failure" step 4 hides web-a (and its edges) and highlights the asg', async ({
    page,
  }) => {
    const island = await openAlbAt(page, 'az-failure', 3);

    await expect(albNode(island, 'web-a')).toHaveAttribute('data-state', 'hidden');
    await expect(albNode(island, 'web-a')).toBeHidden();
    await expect(albEdge(island, 'to-a')).toHaveAttribute('data-state', 'hidden');
    await expect(albEdge(island, 'launch-a')).toHaveAttribute('data-state', 'hidden');
    await expect(albNode(island, 'asg')).toHaveAttribute('data-state', 'highlighted');
    await expect(albNode(island, 'asg')).toHaveAttribute('data-active', 'true');
    await expect(albGroup(island, 'az-a')).toHaveAttribute('data-state', 'failed');
    await expect(albNode(island, 'web-b2')).toBeHidden();
  });

  test('AC-16: "az-failure" step 5 launches web-b2, which appears, and the asg is normal again', async ({
    page,
  }) => {
    const island = await openAlbAt(page, 'az-failure', 4);

    await expect(albNode(island, 'web-b2')).toHaveAttribute('data-state', 'appearing');
    await expect(albNode(island, 'web-b2')).toBeVisible();
    await expect(albNode(island, 'asg')).toHaveAttribute('data-state', 'normal');
    await expect(albEdge(island, 'launch-b2')).toHaveAttribute('data-active', 'true');
    await expect(albNode(island, 'web-a')).toBeHidden();
  });

  test('AC-16: "az-failure" step back from step 5 hides web-b2 and highlights the asg again', async ({
    page,
  }) => {
    const island = await openAlbAt(page, 'az-failure', 4);

    await island.back.click();

    await expectStep(island, 3);
    await expect(albNode(island, 'web-b2')).toHaveAttribute('data-state', 'hidden');
    await expect(albNode(island, 'web-b2')).toBeHidden();
    await expect(albNode(island, 'asg')).toHaveAttribute('data-state', 'highlighted');
  });

  test('AC-16: "az-recovery" starts with web-a hidden and az-a normal', async ({ page }) => {
    const island = await openAlbAt(page, 'az-recovery', -1);

    await expect(albNode(island, 'web-a')).toHaveAttribute('data-state', 'hidden');
    await expect(albNode(island, 'web-a')).toBeHidden();
    await expect(albNode(island, 'web-b2')).toBeVisible();
    await expect(albGroup(island, 'az-a')).toHaveAttribute('data-state', 'normal');
  });

  test('AC-16: "az-recovery" step 2 makes web-a appear and az-a normal again', async ({ page }) => {
    const island = await openAlbAt(page, 'az-recovery', 1);

    await expect(albNode(island, 'web-a')).toHaveAttribute('data-state', 'appearing');
    await expect(albNode(island, 'web-a')).toBeVisible();
    await expect(albGroup(island, 'az-a')).toHaveAttribute('data-state', 'normal');
  });

  test('AC-16: "az-recovery" ends with web-b2 hidden', async ({ page }) => {
    const island = await openAlbAt(page, 'az-recovery', 4);

    await expect(albNode(island, 'web-b2')).toHaveAttribute('data-state', 'hidden');
    await expect(albNode(island, 'web-b2')).toBeHidden();
    await expect(albNode(island, 'web-a')).toBeVisible();
  });
});

test.describe('accessibility of the 2.2 page', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-17: axe finds no WCAG A/AA violations on the 2.2 page at the start', async ({
    page,
  }) => {
    await openAlbPage(page);

    await expect.poll(() => axeViolations(page)).toEqual([]); // a state that just appeared is mid-fade
  });

  test('AC-17: axe finds no WCAG A/AA violations at the failed state of "az-failure"', async ({
    page,
  }) => {
    await openAlbAt(page, 'az-failure', 1);

    await expect.poll(() => axeViolations(page)).toEqual([]); // a state that just appeared is mid-fade
  });

  test('AC-17: axe finds no WCAG A/AA violations at the last step of the last scenario', async ({
    page,
  }) => {
    const last = loadAlbDiagram().scenarios.at(-1);
    if (last === undefined) throw new Error(`${ALB_DIAGRAM_ID}.yaml has no scenario`);
    const island = await openAlbPage(page);
    await selectScenario(island, last);
    for (let step = 0; step < last.steps.length; step += 1) await island.forward.click();
    await expectStep(island, last.steps.length - 1);

    await expect.poll(() => axeViolations(page)).toEqual([]); // a state that just appeared is mid-fade
  });
});

// ===========================================================================
// The task 1.2 diagrams on the 1.2 page: sg-vs-nacl, vpc-nat-vs-gateway-endpoint and cloudfront-oac
// (spec 013, AC-14…AC-18). Same checks for each, driven by one table. The expected captions are read
// from diagrams/<id>.yaml at test time.
// ===========================================================================

const TASK_1_2_PAGE_PATH = '/d1/1-2-secure-workloads/';

const TASK_1_2_DIAGRAMS = [
  {
    id: 'sg-vs-nacl',
    heading: 'Security groups and network ACLs',
    scenarioIds: ['allowed', 'ephemeral-missing', 'sg-rule-missing', 'deny-one-ip'],
  },
  {
    id: 'vpc-nat-vs-gateway-endpoint',
    heading: 'Private access to AWS services: NAT gateway or VPC endpoint',
    scenarioIds: ['via-nat', 'via-endpoint', 'policy-deny'],
  },
  {
    id: 'cloudfront-oac',
    heading: 'Delivering through CloudFront',
    scenarioIds: ['cache-miss', 'cache-hit', 'direct-bucket', 'oac-removed'],
  },
] as const;

function loadDiagramById(id: string): Diagram {
  return parse(
    readFileSync(resolve(import.meta.dirname, '..', '..', 'diagrams', `${id}.yaml`), 'utf8'),
  ) as Diagram;
}

/** The scenario ids to build one test each for: the file's, or the pinned ones while it is missing. */
function scenarioIdsOf(id: string, pinned: readonly string[]): string[] {
  try {
    return loadDiagramById(id).scenarios.map((scenario) => scenario.id);
  } catch {
    return [...pinned];
  }
}

function islandFor(page: Page, id: string): Island {
  const figure = page.locator(`figure[data-diagram="${id}"]`);
  return {
    figure,
    root: figure.locator('[data-diagram-view]'),
    back: figure.getByRole('button', { name: 'Step back' }),
    forward: figure.getByRole('button', { name: 'Step forward' }),
  };
}

async function openTask12Island(page: Page, id: string): Promise<Island> {
  await page.goto(TASK_1_2_PAGE_PATH);
  const island = islandFor(page, id);
  await island.figure.scrollIntoViewIfNeeded();
  await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  return island;
}

for (const entry of TASK_1_2_DIAGRAMS) {
  test.describe(`the ${entry.id} diagram on the 1.2 page`, () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test(`AC-14: the page contains exactly one figure for ${entry.id}`, async ({ page }) => {
      await page.goto(TASK_1_2_PAGE_PATH);

      await expect(page.locator(`figure[data-diagram="${entry.id}"]`)).toHaveCount(1);
    });

    test(`AC-14: the ${entry.id} figure sits under the heading "${entry.heading}"`, async ({
      page,
    }) => {
      await page.goto(TASK_1_2_PAGE_PATH);
      await expect(page.getByRole('heading', { name: entry.heading, level: 2 })).toHaveCount(1);

      const nearestHeading = await page
        .locator(`figure[data-diagram="${entry.id}"]`)
        .evaluate((figure) => {
          const headings = Array.from(
            document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6'),
          ).filter(
            (heading) =>
              !figure.contains(heading) &&
              (heading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          );
          return headings.at(-1)?.textContent?.trim() ?? null;
        });

      expect(nearestHeading).toBe(entry.heading);
    });

    test(`AC-15: "Steps as text" of ${entry.id} lists every scenario with its captions in file order`, async ({
      page,
    }) => {
      const diagram = loadDiagramById(entry.id);
      await page.goto(TASK_1_2_PAGE_PATH);
      const details = page.locator(`figure[data-diagram="${entry.id}"] details`);

      await expect(details).toHaveCount(1);
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
    });

    test(`AC-18: ${entry.id} has the scenarios ${entry.scenarioIds.join(', ')}`, () => {
      expect(loadDiagramById(entry.id).scenarios.map((scenario) => scenario.id)).toEqual(
        entry.scenarioIds,
      );
    });

    test(`AC-17: axe finds no WCAG A/AA violations with ${entry.id} at the start`, async ({
      page,
    }) => {
      await openTask12Island(page, entry.id);

      await expect.poll(() => axeViolations(page)).toEqual([]);
    });

    for (const scenarioId of scenarioIdsOf(entry.id, entry.scenarioIds)) {
      test(`AC-16: ${entry.id} scenario "${scenarioId}" shows each caption in order, and the previous one after a step back`, async ({
        page,
      }) => {
        const scenario = scenarioOf(loadDiagramById(entry.id), scenarioId);
        const island = await openTask12Island(page, entry.id);
        await selectScenario(island, scenario);

        for (const [index, step] of scenario.steps.entries()) {
          await island.forward.click();
          await expectStep(island, index);
          await expect(captionRegion(island)).toContainText(step.caption);
        }
        test.skip(scenario.steps.length < 2, 'a one-step scenario has no previous caption');
        await island.back.click();
        await expectStep(island, scenario.steps.length - 2);
        await expect(captionRegion(island)).toContainText(scenario.steps.at(-2)?.caption ?? '');
      });

      test(`AC-17: axe finds no WCAG A/AA violations at the last step of ${entry.id} "${scenarioId}"`, async ({
        page,
      }) => {
        const scenario = scenarioOf(loadDiagramById(entry.id), scenarioId);
        const island = await openTask12Island(page, entry.id);
        await selectScenario(island, scenario);
        for (let step = 0; step < scenario.steps.length; step += 1) await island.forward.click();
        await expectStep(island, scenario.steps.length - 1);

        await expect.poll(() => axeViolations(page)).toEqual([]); // a state that just appeared is mid-fade
      });
    }
  });
}

// ===========================================================================
// The task 1.3 diagram added next to s3-sse-kms-upload: kms-envelope-encryption (spec 013,
// AC-14…AC-18). Same checks as the 1.2 block, on the 1.3 page, reusing its helpers.
// ===========================================================================

const TASK_1_3_DIAGRAMS = [
  {
    id: 'kms-envelope-encryption',
    heading: 'Envelope encryption',
    scenarioIds: ['encrypt', 'decrypt', 'denied'],
  },
] as const;

async function openTask13Island(page: Page, id: string): Promise<Island> {
  await page.goto(PAGE_PATH);
  const island = islandFor(page, id);
  await island.figure.scrollIntoViewIfNeeded();
  await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  return island;
}

for (const entry of TASK_1_3_DIAGRAMS) {
  test.describe(`the ${entry.id} diagram on the 1.3 page`, () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test(`AC-14: the page contains exactly one figure for ${entry.id}`, async ({ page }) => {
      await page.goto(PAGE_PATH);

      await expect(page.locator(`figure[data-diagram="${entry.id}"]`)).toHaveCount(1);
    });

    test(`AC-14: the ${entry.id} figure sits under the heading "${entry.heading}"`, async ({
      page,
    }) => {
      await page.goto(PAGE_PATH);
      await expect(page.getByRole('heading', { name: entry.heading, level: 2 })).toHaveCount(1);

      const nearestHeading = await page
        .locator(`figure[data-diagram="${entry.id}"]`)
        .evaluate((figure) => {
          const headings = Array.from(
            document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6'),
          ).filter(
            (heading) =>
              !figure.contains(heading) &&
              (heading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          );
          return headings.at(-1)?.textContent?.trim() ?? null;
        });

      expect(nearestHeading).toBe(entry.heading);
    });

    test(`AC-15: "Steps as text" of ${entry.id} lists every scenario with its captions in file order`, async ({
      page,
    }) => {
      const diagram = loadDiagramById(entry.id);
      await page.goto(PAGE_PATH);
      const details = page.locator(`figure[data-diagram="${entry.id}"] details`);

      await expect(details).toHaveCount(1);
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
    });

    test(`AC-18: ${entry.id} has the scenarios ${entry.scenarioIds.join(', ')}`, () => {
      expect(loadDiagramById(entry.id).scenarios.map((scenario) => scenario.id)).toEqual(
        entry.scenarioIds,
      );
    });

    test(`AC-17: axe finds no WCAG A/AA violations with ${entry.id} at the start`, async ({
      page,
    }) => {
      await openTask13Island(page, entry.id);

      await expect.poll(() => axeViolations(page)).toEqual([]);
    });

    for (const scenarioId of scenarioIdsOf(entry.id, entry.scenarioIds)) {
      test(`AC-16: ${entry.id} scenario "${scenarioId}" shows each caption in order, and the previous one after a step back`, async ({
        page,
      }) => {
        const scenario = scenarioOf(loadDiagramById(entry.id), scenarioId);
        const island = await openTask13Island(page, entry.id);
        await selectScenario(island, scenario);

        for (const [index, step] of scenario.steps.entries()) {
          await island.forward.click();
          await expectStep(island, index);
          await expect(captionRegion(island)).toContainText(step.caption);
        }
        test.skip(scenario.steps.length < 2, 'a one-step scenario has no previous caption');
        await island.back.click();
        await expectStep(island, scenario.steps.length - 2);
        await expect(captionRegion(island)).toContainText(scenario.steps.at(-2)?.caption ?? '');
      });

      test(`AC-17: axe finds no WCAG A/AA violations at the last step of ${entry.id} "${scenarioId}"`, async ({
        page,
      }) => {
        const scenario = scenarioOf(loadDiagramById(entry.id), scenarioId);
        const island = await openTask13Island(page, entry.id);
        await selectScenario(island, scenario);
        for (let step = 0; step < scenario.steps.length; step += 1) await island.forward.click();
        await expectStep(island, scenario.steps.length - 1);

        await expect.poll(() => axeViolations(page)).toEqual([]); // a state that just appeared is mid-fade
      });
    }
  });
}

// ===========================================================================
// The task 1.1 diagrams on the 1.1 page: iam-cross-account-assume-role and scp-permission-evaluation
// (spec 013, AC-14…AC-18). Same checks as the 1.2 and 1.3 blocks, reusing their helpers.
// ===========================================================================

const TASK_1_1_PAGE_PATH = '/d1/1-1-secure-access/';

const TASK_1_1_DIAGRAMS = [
  {
    id: 'iam-cross-account-assume-role',
    heading: 'Cross-account access',
    scenarioIds: ['assume', 'no-trust', 'no-permission', 'external-id'],
  },
  {
    id: 'scp-permission-evaluation',
    heading: 'How a request is evaluated',
    scenarioIds: ['allowed', 'scp-blocks', 'boundary-blocks', 'explicit-deny'],
  },
] as const;

async function openTask11Island(page: Page, id: string): Promise<Island> {
  await page.goto(TASK_1_1_PAGE_PATH);
  const island = islandFor(page, id);
  await island.figure.scrollIntoViewIfNeeded();
  await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  return island;
}

for (const entry of TASK_1_1_DIAGRAMS) {
  test.describe(`the ${entry.id} diagram on the 1.1 page`, () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test(`AC-14: the page contains exactly one figure for ${entry.id}`, async ({ page }) => {
      await page.goto(TASK_1_1_PAGE_PATH);

      await expect(page.locator(`figure[data-diagram="${entry.id}"]`)).toHaveCount(1);
    });

    test(`AC-14: the ${entry.id} figure sits under the heading "${entry.heading}"`, async ({
      page,
    }) => {
      await page.goto(TASK_1_1_PAGE_PATH);
      await expect(page.getByRole('heading', { name: entry.heading, level: 2 })).toHaveCount(1);

      const nearestHeading = await page
        .locator(`figure[data-diagram="${entry.id}"]`)
        .evaluate((figure) => {
          const headings = Array.from(
            document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6'),
          ).filter(
            (heading) =>
              !figure.contains(heading) &&
              (heading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          );
          return headings.at(-1)?.textContent?.trim() ?? null;
        });

      expect(nearestHeading).toBe(entry.heading);
    });

    test(`AC-15: "Steps as text" of ${entry.id} lists every scenario with its captions in file order`, async ({
      page,
    }) => {
      const diagram = loadDiagramById(entry.id);
      await page.goto(TASK_1_1_PAGE_PATH);
      const details = page.locator(`figure[data-diagram="${entry.id}"] details`);

      await expect(details).toHaveCount(1);
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
    });

    test(`AC-18: ${entry.id} has the scenarios ${entry.scenarioIds.join(', ')}`, () => {
      expect(loadDiagramById(entry.id).scenarios.map((scenario) => scenario.id)).toEqual(
        entry.scenarioIds,
      );
    });

    test(`AC-17: axe finds no WCAG A/AA violations with ${entry.id} at the start`, async ({
      page,
    }) => {
      await openTask11Island(page, entry.id);

      await expect.poll(() => axeViolations(page)).toEqual([]);
    });

    for (const scenarioId of scenarioIdsOf(entry.id, entry.scenarioIds)) {
      test(`AC-16: ${entry.id} scenario "${scenarioId}" shows each caption in order, and the previous one after a step back`, async ({
        page,
      }) => {
        const scenario = scenarioOf(loadDiagramById(entry.id), scenarioId);
        const island = await openTask11Island(page, entry.id);
        await selectScenario(island, scenario);

        for (const [index, step] of scenario.steps.entries()) {
          await island.forward.click();
          await expectStep(island, index);
          await expect(captionRegion(island)).toContainText(step.caption);
        }
        test.skip(scenario.steps.length < 2, 'a one-step scenario has no previous caption');
        await island.back.click();
        await expectStep(island, scenario.steps.length - 2);
        await expect(captionRegion(island)).toContainText(scenario.steps.at(-2)?.caption ?? '');
      });

      test(`AC-17: axe finds no WCAG A/AA violations at the last step of ${entry.id} "${scenarioId}"`, async ({
        page,
      }) => {
        const scenario = scenarioOf(loadDiagramById(entry.id), scenarioId);
        const island = await openTask11Island(page, entry.id);
        await selectScenario(island, scenario);
        for (let step = 0; step < scenario.steps.length; step += 1) await island.forward.click();
        await expectStep(island, scenario.steps.length - 1);

        await expect.poll(() => axeViolations(page)).toEqual([]); // a state that just appeared is mid-fade
      });
    }
  });
}
