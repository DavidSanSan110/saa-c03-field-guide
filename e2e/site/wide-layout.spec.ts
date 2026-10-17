/// <reference lib="dom" />
// Browser checks of the wide layout (spec 015, AC-1…AC-7), against the built site, in the light theme.
// AC-8 (the stylesheet is registered) is a unit test: apps/site/src/layout-css.test.ts.
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ colorScheme: 'light' });

const DIAGRAM_PAGE = '/d1/1-3-data-security/';
const DIAGRAM_ID = 's3-sse-kms-upload';

/** The prose reading width: 45rem. */
const PROSE_MAX = 720;

interface Viewport {
  width: number;
  height: number;
}

const V1280: Viewport = { width: 1280, height: 800 };
const V1600: Viewport = { width: 1600, height: 1000 };
const V1600_SHORT: Viewport = { width: 1600, height: 700 };
const V2560: Viewport = { width: 2560, height: 1300 };
const V1100: Viewport = { width: 1100, height: 800 };

function label(viewport: Viewport): string {
  return `${String(viewport.width)} x ${String(viewport.height)}`;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

interface Box {
  left: number;
  right: number;
  width: number;
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  await expect(locator, `${name} is visible`).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${name} has no box`);
  return { left: box.x, right: box.x + box.width, width: box.width };
}

/** Opens the page; with a diagram, waits until its island is hydrated (`client:visible` needs it on screen). */
async function open(page: Page, viewport: Viewport, path: string = DIAGRAM_PAGE): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(path);
  const view = page.locator('figure.dl [data-diagram-view]');
  if ((await page.locator('figure.dl').count()) > 0) {
    await page.locator('figure.dl').first().scrollIntoViewIfNeeded();
    await expect(view.first()).toHaveAttribute('data-hydrated', 'true');
  }
}

/** Starlight's left sidebar pane (the `nav.sidebar` element itself spans the whole window). */
function leftSidebar(page: Page): Locator {
  return page.locator('nav.sidebar .sidebar-pane');
}

/**
 * The "On this page" column. Starlight fixes `.right-sidebar` to the right edge of the window, so only
 * the part inside the window counts as the column: from its left edge to the window's right edge.
 */
async function tocColumn(page: Page): Promise<Box> {
  const box = await boxOf(page.locator('.right-sidebar'), '"On this page"');
  const windowWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const right = Math.min(box.right, windowWidth);
  return { left: box.left, right, width: right - box.left };
}

function h1Of(page: Page): Locator {
  return page.getByRole('heading', { level: 1 });
}

function firstParagraph(page: Page): Locator {
  return page.locator('.sl-markdown-content > p').first();
}

function figureOf(page: Page): Locator {
  return page.locator(`figure.dl[data-diagram="${DIAGRAM_ID}"]`);
}

async function wideCanvasMaxHeight(page: Page): Promise<number> {
  const canvas = page.locator('.dl-canvas[data-layout="wide"]');
  const raw = await canvas.evaluate((element) => getComputedStyle(element).maxHeight);
  expect(raw, 'the computed max-height resolves to pixels').toMatch(/^\d+(\.\d+)?px$/);
  return parseFloat(raw);
}

// ---------------------------------------------------------------------------
// AC-1: the content starts one side padding after the left sidebar
// ---------------------------------------------------------------------------

test.describe('side padding', () => {
  const cases: { viewport: Viewport; padding: number }[] = [
    { viewport: V1600, padding: 48 },
    { viewport: V2560, padding: 80 },
    { viewport: V1280, padding: 24 },
  ];

  for (const { viewport, padding } of cases) {
    test(`AC-1: at ${label(viewport)} the h1 starts ${String(padding)} px after the left sidebar`, async ({
      page,
    }) => {
      await open(page, viewport);

      const sidebar = await boxOf(leftSidebar(page), 'the left sidebar');
      const h1 = await boxOf(h1Of(page), 'the h1');

      expect(Math.abs(h1.left - sidebar.right - padding)).toBeLessThanOrEqual(2);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-2: "On this page" is as wide as the left sidebar
// ---------------------------------------------------------------------------

test.describe('"On this page" column', () => {
  test(`AC-2: at ${label(V1600)} "On this page" is as wide as the left sidebar`, async ({
    page,
  }) => {
    await open(page, V1600);

    const sidebar = await boxOf(leftSidebar(page), 'the left sidebar');
    const toc = await tocColumn(page);

    expect(Math.abs(toc.width - sidebar.width)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC-3: prose at reading width, one left edge for text and diagram
// ---------------------------------------------------------------------------

test.describe('prose width and left edge', () => {
  for (const viewport of [V1600, V2560]) {
    test(`AC-3: at ${label(viewport)} the h1 is at most 720 px wide`, async ({ page }) => {
      await open(page, viewport);

      const h1 = await boxOf(h1Of(page), 'the h1');

      expect(h1.width).toBeLessThanOrEqual(PROSE_MAX);
    });

    test(`AC-3: at ${label(viewport)} the first paragraph is at most 720 px wide`, async ({
      page,
    }) => {
      await open(page, viewport);

      const paragraph = await boxOf(firstParagraph(page), 'the first paragraph');

      expect(paragraph.width).toBeLessThanOrEqual(PROSE_MAX);
    });

    test(`AC-3: at ${label(viewport)} the h1, the paragraph and the figure share one left edge`, async ({
      page,
    }) => {
      await open(page, viewport);

      const h1 = await boxOf(h1Of(page), 'the h1');
      const paragraph = await boxOf(firstParagraph(page), 'the first paragraph');
      const figure = await boxOf(figureOf(page), 'the figure');

      expect(Math.abs(paragraph.left - h1.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(figure.left - h1.left)).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-4: the diagram takes the full width of the content column
// ---------------------------------------------------------------------------

test.describe('diagram width', () => {
  test(`AC-4: at ${label(V1600)} the figure is wider than the 720 px prose`, async ({ page }) => {
    await open(page, V1600);

    const figure = await boxOf(figureOf(page), 'the figure');

    expect(figure.width).toBeGreaterThan(PROSE_MAX);
  });

  test(`AC-4: at ${label(V1600)} the figure ends one side padding before "On this page"`, async ({
    page,
  }) => {
    await open(page, V1600);

    const figure = await boxOf(figureOf(page), 'the figure');
    const toc = await tocColumn(page);

    expect(Math.abs(toc.left - figure.right - 48)).toBeLessThanOrEqual(2);
  });

  test(`AC-4: at ${label(V2560)} the figure is 1200 px wide (the 75rem column cap)`, async ({
    page,
  }) => {
    await open(page, V2560);

    const figure = await boxOf(figureOf(page), 'the figure');

    expect(Math.abs(figure.width - 1200)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC-5: the wide canvas is capped at min(56rem, 80svh)
// ---------------------------------------------------------------------------

test.describe('canvas height cap', () => {
  const cases: { viewport: Viewport; expected: number }[] = [
    { viewport: V1600, expected: 800 },
    { viewport: V1600_SHORT, expected: 560 },
    { viewport: V2560, expected: 896 },
  ];

  for (const { viewport, expected } of cases) {
    test(`AC-5: at ${label(viewport)} the wide canvas max-height is ${String(expected)} px`, async ({
      page,
    }) => {
      await open(page, viewport);

      const maxHeight = await wideCanvasMaxHeight(page);

      expect(Math.abs(maxHeight - expected)).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-6: below 72rem nothing changes
// ---------------------------------------------------------------------------

test.describe('below 72rem', () => {
  test(`AC-6: at ${label(V1100)} "On this page" is not a column beside the content`, async ({
    page,
  }) => {
    await open(page, V1100);

    // Starlight's own layout: the content pane runs from the sidebar to the window's right edge ...
    const content = await boxOf(page.locator('.main-pane'), 'the content pane');
    const windowWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(Math.abs(content.right - windowWidth)).toBeLessThanOrEqual(1);

    // ... and the "On this page" list is not shown (a collapsed bar replaces it).
    await expect(page.locator('.right-sidebar-panel')).toBeHidden();
  });

  test(`AC-6: at ${label(V1100)} the figure is as wide as the content column`, async ({ page }) => {
    await open(page, V1100);

    const column = await boxOf(page.locator('.sl-markdown-content'), 'the content column');
    const figure = await boxOf(figureOf(page), 'the figure');

    expect(Math.abs(figure.width - column.width)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC-7: no sideways scroll, the diagram stays wide
// ---------------------------------------------------------------------------

test.describe('no sideways scroll', () => {
  const pages = [DIAGRAM_PAGE, '/d2/2-2-high-availability/', '/d1/', '/'];
  const widths: Viewport[] = [V1100, V1280, V1600, V2560];

  for (const path of pages) {
    for (const viewport of widths) {
      test(`AC-7: at ${label(viewport)} ${path} does not scroll sideways`, async ({ page }) => {
        await open(page, viewport, path);

        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));

        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }
  }

  for (const viewport of [V1280, V1600, V2560]) {
    test(`AC-7: at ${label(viewport)} the diagram keeps the wide layout`, async ({ page }) => {
      await open(page, viewport);

      await expect(figureOf(page).locator('.dl-canvas')).toHaveAttribute('data-layout', 'wide');
    });
  }
});

// ---------------------------------------------------------------------------
// AC-9: media wider than the column never overflows it (regression, review of #32)
// ---------------------------------------------------------------------------

test.describe('media in a narrow column', () => {
  const V1152: Viewport = { width: 1152, height: 800 };

  for (const viewport of [V1280, V1152]) {
    test(`AC-9: at ${label(viewport)} a 900 px img and iframe are no wider than the column`, async ({
      page,
    }) => {
      await open(page, viewport);

      const widths = await page.evaluate(() => {
        const content = document.querySelector('.sl-markdown-content');
        if (content === null) throw new Error('no .sl-markdown-content');
        const img = document.createElement('img');
        img.src = '/favicon.svg';
        img.alt = '';
        img.setAttribute('width', '900');
        img.setAttribute('height', '50');
        const frame = document.createElement('iframe');
        frame.src = 'about:blank';
        frame.title = 'wide frame';
        frame.setAttribute('width', '900');
        content.append(img, frame);
        return {
          column: content.getBoundingClientRect().width,
          img: img.getBoundingClientRect().width,
          iframe: frame.getBoundingClientRect().width,
        };
      });

      expect
        .soft(widths.img, 'the img is no wider than the column')
        .toBeLessThanOrEqual(widths.column + 1);
      expect
        .soft(widths.iframe, 'the iframe is no wider than the column')
        .toBeLessThanOrEqual(widths.column + 1);
    });

    test(`AC-9: at ${label(viewport)} a 900 px img and iframe do not scroll the page sideways`, async ({
      page,
    }) => {
      await open(page, viewport);

      await page.evaluate(() => {
        const content = document.querySelector('.sl-markdown-content');
        if (content === null) throw new Error('no .sl-markdown-content');
        const img = document.createElement('img');
        img.src = '/favicon.svg';
        img.alt = '';
        img.setAttribute('width', '900');
        img.setAttribute('height', '50');
        const frame = document.createElement('iframe');
        frame.src = 'about:blank';
        frame.title = 'wide frame';
        frame.setAttribute('width', '900');
        content.append(img, frame);
      });
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-10: the rules apply to the content column only (regression, review of #32)
// ---------------------------------------------------------------------------

test.describe('"On this page" panel container', () => {
  test(`AC-10: at ${label(V1600)} the panel container keeps Starlight's max-width`, async ({
    page,
  }) => {
    await open(page, V1600);

    const maxWidth = await page
      .locator('.right-sidebar-panel .sl-container')
      .evaluate((element) => getComputedStyle(element).maxWidth);

    // 1200px is the content column cap, 720px the prose cap; Starlight's own value is a calc() of
    // the window width, about a quarter of the free space (a few hundred px at this size).
    expect(maxWidth, 'not the content column cap').not.toBe('1200px');
    expect(maxWidth, 'not the prose cap').not.toBe('720px');
    expect(maxWidth, 'a pixel length').toMatch(/^\d+(\.\d+)?px$/);
    expect(parseFloat(maxWidth), 'narrower than the prose cap').toBeLessThan(PROSE_MAX);
  });
});
