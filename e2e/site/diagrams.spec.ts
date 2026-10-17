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
