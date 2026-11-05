/// <reference lib="dom" />
// Browser checks of parallel edges in a step (spec 045), on the fixture route /fixtures/diagram-parallel/.
// The DOM contract of spec 012 (data-* attributes) is used for packets and edges; roles and labels otherwise.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { parallelFixture } from '../fixtures/parallel-fixture.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

const FIXTURE_PATH = '/fixtures/diagram-parallel/';

// ---------------------------------------------------------------------------
// Fixture facts (derived from the fixture data, not from the implementation)
// ---------------------------------------------------------------------------

const steps = parallelFixture.scenarios[0]?.steps ?? [];
const TOTAL = steps.length;

function captionOf(step: number): string {
  const found = steps[step];
  if (found === undefined) throw new Error(`no step ${String(step)}`);
  return found.caption;
}

/** Step 2 (0-based 1): the packet label each edge carries ('' = a packet without text) and where it lies. */
const PARALLEL_STEP = 1;
const PARALLEL_PACKETS = [
  { edge: 'to-a', text: 'copy a' },
  { edge: 'to-b', text: '' },
  { edge: 'to-c', text: 'copy c' },
] as const;
const PARALLEL_ROUTE = 'topic → q-a, topic → q-b, topic → q-c';

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

interface Island {
  figure: Locator;
  root: Locator;
  back: Locator;
  forward: Locator;
  reset: Locator;
}

async function openFixture(page: Page): Promise<Island> {
  await page.goto(FIXTURE_PATH);
  const figure = page.locator(`figure[data-diagram="${parallelFixture.id}"]`);
  const island: Island = {
    figure,
    root: figure.locator('[data-diagram-view]'),
    back: figure.getByRole('button', { name: 'Step back' }),
    forward: figure.getByRole('button', { name: 'Step forward' }),
    reset: figure.getByRole('button', { name: 'Reset' }),
  };
  await figure.scrollIntoViewIfNeeded();
  await expect(island.root).toHaveAttribute('data-hydrated', 'true');
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  return island;
}

async function expectStep(island: Island, step: number): Promise<void> {
  await expect(island.root).toHaveAttribute('data-step', String(step));
}

/** Clicks Step forward until the player is at the 0-based `step`. */
async function goToStep(island: Island, step: number): Promise<void> {
  for (let reached = 0; reached <= step; reached += 1) await island.forward.click();
  await expectStep(island, step);
}

function edge(island: Island, id: string): Locator {
  return island.root.locator(`[data-edge-id="${id}"]`);
}

function packets(island: Island): Locator {
  return island.root.locator('[data-packet]');
}

async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => {
    window.localStorage.setItem('starlight-theme', value);
  }, theme);
}

interface PacketOnEdge {
  text: string;
  reverse: string | null;
  /** Distance (px, screen) from the centre of the packet to the nearest point of the edge's path. */
  distance: number;
  /** The first and last point of the edge's path on screen. */
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** The centre of the packet on screen. */
  centre: { x: number; y: number };
}

/** Where every packet of the diagram is relative to the drawn path of `edgeId`. */
async function packetsOnEdge(page: Page, edgeId: string): Promise<PacketOnEdge[]> {
  return page.evaluate(
    ({ diagramId, edgeId: id }) => {
      const figure = document.querySelector(`figure[data-diagram="${diagramId}"]`);
      const edgeElement = figure?.querySelector(`[data-edge-id="${id}"]`);
      if (!figure || !edgeElement) throw new Error('figure or edge not found');
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
      const first = samples[0] as { x: number; y: number };
      const last = samples[samples.length - 1] as { x: number; y: number };
      return Array.from(figure.querySelectorAll('[data-packet]')).map((element) => {
        const rect = element.getBoundingClientRect();
        const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        return {
          text: (element.textContent ?? '').trim(),
          reverse: element.getAttribute('data-reverse'),
          distance: Math.min(
            ...samples.map((sample) => Math.hypot(sample.x - centre.x, sample.y - centre.y)),
          ),
          start: first,
          end: last,
          centre,
        };
      });
    },
    { diagramId: parallelFixture.id, edgeId },
  );
}

/** The packet with this text, measured against `edgeId` (fails when there is none or several). */
async function packetWithText(page: Page, edgeId: string, text: string): Promise<PacketOnEdge> {
  const matching = (await packetsOnEdge(page, edgeId)).filter((packet) => packet.text === text);
  if (matching.length !== 1) {
    throw new Error(`expected one packet with text '${text}', found ${String(matching.length)}`);
  }
  return matching[0] as PacketOnEdge;
}

function gap(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
// AC-13 to AC-15: packets and edge status
// ---------------------------------------------------------------------------

test.describe('parallel packets', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-13: the fixture hydrates and has no packet at the start', async ({ page }) => {
    const island = await openFixture(page);

    await expectStep(island, -1);
    await expect(packets(island)).toHaveCount(0);
  });

  test('AC-13: at the parallel step there are exactly 3 visible packets', async ({ page }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    await expect(packets(island)).toHaveCount(3);
    for (let index = 0; index < 3; index += 1)
      await expect(packets(island).nth(index)).toBeVisible();
  });

  test('AC-13: the packets carry the labels of the fixture, copy c on to-c', async ({ page }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    await expect(packets(island)).toHaveCount(3);
    const texts = (await packets(island).allTextContents()).map((text) => text.trim());
    expect(texts.sort()).toEqual(PARALLEL_PACKETS.map(({ text }) => text).sort());
    await expect(packets(island).filter({ hasText: 'copy c' })).toHaveCount(1);
  });

  test('AC-13: each packet lies on the path of its own edge', async ({ page }) => {
    const island = await openFixture(page);
    await goToStep(island, PARALLEL_STEP);
    await expect(packets(island)).toHaveCount(3);

    for (const { edge: edgeId, text } of PARALLEL_PACKETS) {
      const packet = await packetWithText(page, edgeId, text);
      expect(packet.distance, `packet '${text}' on ${edgeId}`).toBeLessThanOrEqual(12);
    }
  });

  test('AC-13: to-a, to-b and to-c are active, publish is done and a-work is idle', async ({
    page,
  }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    for (const { edge: edgeId } of PARALLEL_PACKETS) {
      await expect(edge(island, edgeId)).toHaveAttribute('data-status', 'active');
    }
    await expect(edge(island, 'publish')).toHaveAttribute('data-status', 'done');
    await expect(edge(island, 'a-work')).toHaveAttribute('data-status', 'idle');
  });

  test('AC-13: the packets of the parallel step are not reversed', async ({ page }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    await expect(packets(island)).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(packets(island).nth(index)).toHaveAttribute('data-reverse', 'false');
    }
  });

  test('AC-14: at the next step (single edge) there is exactly 1 packet and the three edges are done', async ({
    page,
  }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP + 1);

    await expect(packets(island)).toHaveCount(1);
    await expect(packets(island)).toHaveText('job');
    await expect(edge(island, 'a-work')).toHaveAttribute('data-status', 'active');
    for (const { edge: edgeId } of PARALLEL_PACKETS) {
      await expect(edge(island, edgeId)).toHaveAttribute('data-status', 'done');
    }
  });

  test('AC-14: Step back from the single step shows the 3 packets again', async ({ page }) => {
    const island = await openFixture(page);
    await goToStep(island, PARALLEL_STEP + 1);

    await island.back.click();

    await expectStep(island, PARALLEL_STEP);
    await expect(packets(island)).toHaveCount(3);
    for (const { edge: edgeId } of PARALLEL_PACKETS) {
      await expect(edge(island, edgeId)).toHaveAttribute('data-status', 'active');
    }
    await expect(edge(island, 'a-work')).toHaveAttribute('data-status', 'idle');
  });

  test('AC-14: before the parallel step (publish) there is exactly 1 packet and the fan-out edges are idle', async ({
    page,
  }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP - 1);

    await expect(packets(island)).toHaveCount(1);
    await expect(packets(island)).toHaveText('event');
    for (const { edge: edgeId } of PARALLEL_PACKETS) {
      await expect(edge(island, edgeId)).toHaveAttribute('data-status', 'idle');
    }
  });

  test('AC-15: at the last step the two packets are reversed, one on a-work and one on to-b', async ({
    page,
  }) => {
    const island = await openFixture(page);

    await goToStep(island, TOTAL - 1);

    await expect(packets(island)).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      await expect(packets(island).nth(index)).toBeVisible();
      await expect(packets(island).nth(index)).toHaveAttribute('data-reverse', 'true');
    }
    const onWork = await packetWithText(page, 'a-work', 'result');
    const onB = await packetWithText(page, 'to-b', '');
    expect(onWork.distance).toBeLessThanOrEqual(12);
    expect(onB.distance).toBeLessThanOrEqual(12);
  });

  test('AC-15: at the last step a-work and to-b are active, to-a and to-c are done', async ({
    page,
  }) => {
    const island = await openFixture(page);

    await goToStep(island, TOTAL - 1);

    await expect(edge(island, 'a-work')).toHaveAttribute('data-status', 'active');
    await expect(edge(island, 'to-b')).toHaveAttribute('data-status', 'active');
    await expect(edge(island, 'to-a')).toHaveAttribute('data-status', 'done');
    await expect(edge(island, 'to-c')).toHaveAttribute('data-status', 'done');
    await expect(edge(island, 'publish')).toHaveAttribute('data-status', 'done');
  });
});

// ---------------------------------------------------------------------------
// AC-16 reduced motion
// ---------------------------------------------------------------------------

test.describe('reduced motion with parallel packets', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-16: every packet is visible at once at the end of its own edge', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    await expect(packets(island)).toHaveCount(3);
    for (let index = 0; index < 3; index += 1)
      await expect(packets(island).nth(index)).toBeVisible();
    for (const { edge: edgeId, text } of PARALLEL_PACKETS) {
      const packet = await packetWithText(page, edgeId, text);
      expect(
        gap(packet.centre, packet.end),
        `packet '${text}' at the end of ${edgeId}`,
      ).toBeLessThanOrEqual(8);
    }
  });

  test('AC-16: the packets do not move', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const island = await openFixture(page);
    await goToStep(island, PARALLEL_STEP);
    await expect(packets(island)).toHaveCount(3);

    const first = await packetWithText(page, 'to-c', 'copy c');
    await page.waitForTimeout(500); // long enough for a travelling packet to have moved
    const second = await packetWithText(page, 'to-c', 'copy c');

    expect(gap(first.centre, second.centre)).toBeLessThanOrEqual(1);
  });

  test('AC-16: the three packets sit at three different places', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const island = await openFixture(page);
    await goToStep(island, PARALLEL_STEP);
    await expect(packets(island)).toHaveCount(3);

    const centres = await Promise.all(
      PARALLEL_PACKETS.map(
        async ({ edge: edgeId, text }) => (await packetWithText(page, edgeId, text)).centre,
      ),
    );

    expect(
      gap(centres[0] as { x: number; y: number }, centres[1] as { x: number; y: number }),
    ).toBeGreaterThan(8);
    expect(
      gap(centres[1] as { x: number; y: number }, centres[2] as { x: number; y: number }),
    ).toBeGreaterThan(8);
    expect(
      gap(centres[0] as { x: number; y: number }, centres[2] as { x: number; y: number }),
    ).toBeGreaterThan(8);
  });

  test('AC-16: reversed packets sit at the from end of their own edge', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const island = await openFixture(page);
    await goToStep(island, TOTAL - 1);
    await expect(packets(island)).toHaveCount(2);

    const onWork = await packetWithText(page, 'a-work', 'result');
    const onB = await packetWithText(page, 'to-b', '');

    expect(gap(onWork.centre, onWork.start)).toBeLessThanOrEqual(8);
    expect(gap(onB.centre, onB.start)).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// AC-17 step log and caption
// ---------------------------------------------------------------------------

test.describe('step log and caption', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-17: the step log at the parallel step shows the route of all three edges joined by a comma', async ({
    page,
  }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    const lines = island.root.locator('[data-log-line]');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText('publisher → topic');
    await expect(lines.nth(1)).toContainText('[2/4]');
    await expect(lines.nth(1)).toContainText(PARALLEL_ROUTE);
    await expect(lines.nth(1)).toContainText('copy a, copy c');
  });

  test('AC-17: the last step log line swaps each route by its own reverse', async ({ page }) => {
    const island = await openFixture(page);

    await goToStep(island, TOTAL - 1);

    const lines = island.root.locator('[data-log-line]');
    await expect(lines).toHaveCount(TOTAL);
    await expect(lines.nth(TOTAL - 1)).toContainText('worker → q-a, q-b → topic');
    await expect(lines.nth(TOTAL - 1)).toContainText('result');
  });

  test('AC-17: the caption of the parallel step is shown once', async ({ page }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    await expect(island.root.locator('[data-caption]')).toHaveCount(1);
    await expect(island.root.locator('[data-caption]')).toContainText(captionOf(PARALLEL_STEP));
  });

  test('AC-17: the live region announces the step once, with one caption', async ({ page }) => {
    const island = await openFixture(page);

    await goToStep(island, PARALLEL_STEP);

    const live = island.root.locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    const announced = (await live.textContent()) ?? '';
    expect(announced.split(captionOf(PARALLEL_STEP)).length - 1).toBe(1);
    expect(announced).toContain('Step 2 of 4');
  });
});

// ---------------------------------------------------------------------------
// AC-18 accessibility
// ---------------------------------------------------------------------------

test.describe('accessibility of the parallel fixture', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  for (const theme of ['light', 'dark'] as const) {
    test(`AC-18: axe finds no WCAG A/AA violations at the start (${theme} theme)`, async ({
      page,
    }) => {
      await useTheme(page, theme);
      await openFixture(page);

      expect(await axeViolations(page)).toEqual([]);
    });

    test(`AC-18: axe finds no WCAG A/AA violations at the parallel step (${theme} theme)`, async ({
      page,
    }) => {
      await useTheme(page, theme);
      const island = await openFixture(page);
      await goToStep(island, PARALLEL_STEP);
      await expect(packets(island)).toHaveCount(3);

      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-22 packets are remounted when the parallel step is reached again
// ---------------------------------------------------------------------------

test.describe('revisiting the parallel step', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-22: after Step forward and Step back none of the first packets is still connected', async ({
    page,
  }) => {
    const island = await openFixture(page);
    await goToStep(island, PARALLEL_STEP);
    await expect(packets(island)).toHaveCount(3);
    const firstVisit = await packets(island).elementHandles();
    expect(firstVisit).toHaveLength(3);

    await island.forward.click();
    await expectStep(island, PARALLEL_STEP + 1);
    await island.back.click();
    await expectStep(island, PARALLEL_STEP);

    await expect(packets(island)).toHaveCount(3);
    for (let index = 0; index < 3; index += 1)
      await expect(packets(island).nth(index)).toBeVisible();
    for (const handle of firstVisit) {
      expect(await handle.evaluate((element) => element.isConnected)).toBe(false);
    }
  });

  // Leaving the parallel step unmounts its packets whatever the key is, so the test above cannot tell a
  // packet keyed by run from one keyed by edge id. A packet on an edge that stays active from one step
  // to the next can: it is remounted only when the key changes with the run.
  test('AC-22: a packet on an edge that stays active in the next step is remounted too', async ({
    page,
  }) => {
    const island = await openFixture(page);
    await goToStep(island, PARALLEL_STEP + 1);
    await expect(packets(island)).toHaveCount(1);
    const before = await packets(island).elementHandles();

    await island.forward.click();
    await expectStep(island, PARALLEL_STEP + 2);

    await expect(packets(island)).toHaveCount(2);
    for (const handle of before) {
      expect(await handle.evaluate((element) => element.isConnected)).toBe(false);
    }
  });
});
