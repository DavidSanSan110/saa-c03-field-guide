// Spec 044, AC-19 to AC-22: the AI-draft panel of the review page.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { draft, marks, verification } from '../tools/review/src/__mocks__/review-fixtures.ts';
import type { Draft, Item } from '../tools/review/src/__mocks__/review-fixtures.ts';
import { startWith, stopAll } from '../tools/review/src/__mocks__/server-fixtures.ts';

test.afterEach(async () => {
  await stopAll();
});

const q1 = draft({ id: 'd1-1.3-0001', slug: 'zeta-first' });
const q2 = draft({ id: 'd1-1.3-0002', slug: 'alpha-second' });

const PANEL_TITLE = 'AI-draft notes';
const WITH_NAMES = (names: string[]): string =>
  `Written from AI-draft notes that the owner has not studied yet: ${names.join(', ')}. Check every fact against the references.`;
const WITHOUT_NAMES =
  'Written from AI-draft notes that the owner has not studied yet. Check every fact against the references.';

const FOLDER_1 = '02-first-notes';
const FOLDER_2 = '05-second-notes';

/** A draft with a verified sidecar that also carries the AI-draft marker. */
function marked(d: Draft, sections: string[]): Item {
  return { draft: d, sidecar: { verification: verification(d), ai_draft: { sections } } };
}

async function open(page: Page, ...items: (Draft | Item)[]): Promise<void> {
  const started = await startWith(...items);
  await page.goto(started.server.url);
}

async function expectShowing(page: Page, d: Draft): Promise<void> {
  await expect(page.getByText(d.stem)).toBeVisible();
}

async function press(page: Page, ...keys: string[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(key);
}

/** Answers C (the key of every fixture draft) and waits for the reveal screen. */
async function answer(page: Page, d: Draft): Promise<void> {
  await expectShowing(page, d);
  await press(page, 'c', 'Enter');
  await expect(page.getByText(marks.why('A'))).toBeVisible();
}

function panelHeading(page: Page): Locator {
  return page.getByRole('heading', { name: PANEL_TITLE, exact: true, level: 2 });
}

/** The section that holds the AI-draft heading. */
function panelOf(page: Page): Locator {
  return page.locator('section').filter({ has: panelHeading(page) });
}

test.describe('marked draft', () => {
  test('AC-19: the reveal screen shows the AI-draft notes panel with the exact text', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await answer(page, q1);

    await expect(panelHeading(page)).toBeVisible();
    await expect(page.getByText(WITH_NAMES([FOLDER_1, FOLDER_2]), { exact: true })).toBeVisible();
  });

  test('AC-19: the text names both folders, in the order of the sidecar', async ({ page }) => {
    const names = ['07-zeta-notes', '01-alpha-notes'];
    await open(page, marked(q1, names));
    await answer(page, q1);

    const paragraph = panelOf(page).locator('p');
    await expect(paragraph).toHaveCount(1);
    await expect(paragraph).toHaveText(WITH_NAMES(names));
    await expect(paragraph).toContainText('07-zeta-notes');
    await expect(paragraph).toContainText('01-alpha-notes');
  });

  test('AC-19: one folder gives the same sentence with one name', async ({ page }) => {
    await open(page, marked(q1, [FOLDER_1]));
    await answer(page, q1);

    await expect(panelOf(page).locator('p')).toHaveText(WITH_NAMES([FOLDER_1]));
  });

  test('AC-19: the panel is a level 2 heading with its text in the same section', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await answer(page, q1);

    await expect(panelOf(page)).toHaveCount(1);
    await expect(
      panelOf(page).getByText(WITH_NAMES([FOLDER_1, FOLDER_2]), { exact: true }),
    ).toBeVisible();
    await expect(panelHeading(page)).toHaveCount(1);
  });

  test('AC-19: the panel comes before the Verification panel', async ({ page }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await answer(page, q1);

    await expect(panelHeading(page)).toBeVisible();
    const titles = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(titles).toContain('Verification');
    expect(titles.indexOf(PANEL_TITLE)).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf(PANEL_TITLE)).toBeLessThan(titles.indexOf('Verification'));
  });

  test('AC-19: it also sits above the Verification panel on the screen', async ({ page }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await answer(page, q1);

    await expect(panelHeading(page)).toBeVisible();
    const aiBox = await panelHeading(page).boundingBox();
    const verificationBox = await page
      .getByRole('heading', { name: 'Verification', exact: true })
      .boundingBox();
    expect(aiBox).not.toBeNull();
    expect(verificationBox).not.toBeNull();
    expect((aiBox as { y: number }).y).toBeLessThan((verificationBox as { y: number }).y);
  });

  test('AC-19: the panel is the section with the ai-draft class that the spec names', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1]));
    await answer(page, q1);

    const section = page.locator('section.panel.ai-draft');
    await expect(section).toHaveCount(1);
    await expect(section.getByRole('heading', { name: PANEL_TITLE, level: 2 })).toBeVisible();
  });

  test('AC-19: the marker does not hide the rest of the reveal', async ({ page }) => {
    await open(page, marked(q1, [FOLDER_1]));
    await answer(page, q1);

    await expect(page.getByRole('heading', { name: 'Verification', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'References', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible();
  });

  test('AC-19: the panel shows for a draft with no verification in its sidecar too', async ({
    page,
  }) => {
    await open(page, { draft: q1, sidecar: { ai_draft: { sections: [FOLDER_1, FOLDER_2] } } });
    await answer(page, q1);

    await expect(page.getByText(WITH_NAMES([FOLDER_1, FOLDER_2]), { exact: true })).toBeVisible();
  });

  test('AC-19: the panel of the first draft is gone on the next, marked with other folders', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1]), marked(q2, [FOLDER_2]));
    await answer(page, q1);
    await expect(page.getByText(WITH_NAMES([FOLDER_1]), { exact: true })).toBeVisible();

    await press(page, 'n');
    await answer(page, q2);

    await expect(page.getByText(WITH_NAMES([FOLDER_2]), { exact: true })).toBeVisible();
    await expect(page.getByText(FOLDER_1)).toHaveCount(0);
    await expect(panelHeading(page)).toHaveCount(1);
  });
});

test.describe('draft without a marker', () => {
  test('AC-20: a draft with a sidecar without ai_draft has no panel', async ({ page }) => {
    await open(page, { draft: q1, sidecar: { verification: verification(q1) } });
    await answer(page, q1);

    await expect(page.getByRole('heading', { name: 'Verification', exact: true })).toBeVisible();
    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('.ai-draft')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(PANEL_TITLE);
    await expect(page.locator('body')).not.toContainText('not studied yet');
  });

  test('AC-20: a draft with no sidecar has no panel', async ({ page }) => {
    await open(page, q1);
    await answer(page, q1);

    await expect(page.getByRole('heading', { name: 'References', exact: true })).toBeVisible();
    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('.ai-draft')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(PANEL_TITLE);
  });

  test('AC-20: a draft with an unreadable sidecar has no panel', async ({ page }) => {
    await open(page, { draft: q1, sidecar: 'ai_draft: [unclosed\n' });
    await answer(page, q1);

    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('.ai-draft')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('not studied yet');
  });

  test('AC-20: the panel of a marked draft does not stay on the next, unmarked one', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1]), q2);
    await answer(page, q1);
    await expect(panelHeading(page)).toBeVisible();

    await press(page, 'n');
    await answer(page, q2);

    await expect(page.getByRole('heading', { name: 'References', exact: true })).toBeVisible();
    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(FOLDER_1);
  });

  test('AC-20: an unmarked draft shows no panel and the marked one after it does', async ({
    page,
  }) => {
    await open(page, q1, marked(q2, [FOLDER_2]));
    await answer(page, q1);
    await expect(panelHeading(page)).toHaveCount(0);

    await press(page, 'n');
    await answer(page, q2);

    await expect(page.getByText(WITH_NAMES([FOLDER_2]), { exact: true })).toBeVisible();
  });

  const WITHOUT_NAMES_CASES: [string, string][] = [
    ['ai_draft: true', 'ai_draft: true\n'],
    ['an empty ai_draft key', 'verification:\n  result: verified\nai_draft:\n'],
    ['sections that is a string', 'ai_draft:\n  sections: a-folder\n'],
    ['sections with a number', 'ai_draft:\n  sections:\n    - a-folder\n    - 1\n'],
    ['an empty list of sections', 'ai_draft:\n  sections: []\n'],
    ['an empty mapping', 'ai_draft: {}\n'],
  ];

  for (const [name, sidecar] of WITHOUT_NAMES_CASES) {
    test(`AC-20: ${name} shows the panel with the text without names`, async ({ page }) => {
      await open(page, { draft: q1, sidecar });
      await answer(page, q1);

      await expect(panelHeading(page)).toBeVisible();
      await expect(page.getByText(WITHOUT_NAMES, { exact: true })).toBeVisible();
      await expect(panelOf(page).locator('p')).toHaveCount(1);
      await expect(panelOf(page).locator('p')).toHaveText(WITHOUT_NAMES);
      await expect(page.locator('body')).not.toContainText('a-folder');
    });
  }

  test('AC-20: the text without names comes before the Verification panel as well', async ({
    page,
  }) => {
    await open(page, { draft: q1, sidecar: 'verification:\n  result: verified\nai_draft: true\n' });
    await answer(page, q1);

    await expect(panelHeading(page)).toBeVisible();
    const titles = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(titles.indexOf(PANEL_TITLE)).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf(PANEL_TITLE)).toBeLessThan(titles.indexOf('Verification'));
  });
});

test.describe('HTML in a folder name', () => {
  const PAYLOAD = '<img src=x onerror="window.__xss=1">';

  test('AC-21: the folder name is shown as literal text in the panel', async ({ page }) => {
    await open(page, marked(q1, [PAYLOAD]));
    await answer(page, q1);

    await expect(panelHeading(page)).toBeVisible();
    await expect(page.getByText(WITH_NAMES([PAYLOAD]), { exact: true })).toBeVisible();
    await expect(panelOf(page).locator('p')).toHaveText(WITH_NAMES([PAYLOAD]));
  });

  test('AC-21: no img element is added and window.__xss stays undefined', async ({ page }) => {
    await open(page, marked(q1, [PAYLOAD]));
    await answer(page, q1);

    await expect(page.getByText(WITH_NAMES([PAYLOAD]), { exact: true })).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss), {
        timeout: 1000,
      })
      .toBeUndefined();
  });

  test('AC-21: markup next to a plain folder name stays text as well', async ({ page }) => {
    const names = ['01-plain-notes', '<b>bold</b>'];
    await open(page, marked(q1, names));
    await answer(page, q1);

    await expect(page.getByText(WITH_NAMES(names), { exact: true })).toBeVisible();
    await expect(panelOf(page).locator('b')).toHaveCount(0);
  });
});

test.describe('answer screen', () => {
  test('AC-22: the answer screen of a marked draft shows no AI-draft notes text', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await expectShowing(page, q1);

    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('.ai-draft')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(PANEL_TITLE);
    await expect(page.locator('body')).not.toContainText('not studied yet');
    await expect(page.locator('body')).not.toContainText(FOLDER_1);
    await expect(page.locator('body')).not.toContainText(FOLDER_2);
  });

  test('AC-22: picking an option does not show it either', async ({ page }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await expectShowing(page, q1);

    await press(page, 'c');

    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(PANEL_TITLE);
    await expect(page.locator('body')).not.toContainText(FOLDER_1);
  });

  test('AC-22: it shows up only after the answer (control)', async ({ page }) => {
    await open(page, marked(q1, [FOLDER_1, FOLDER_2]));
    await expectShowing(page, q1);
    await expect(panelHeading(page)).toHaveCount(0);

    await press(page, 'c', 'Enter');

    await expect(panelHeading(page)).toBeVisible();
  });

  test('AC-22: the answer screen of the next draft shows nothing either, after a marked reveal', async ({
    page,
  }) => {
    await open(page, marked(q1, [FOLDER_1]), marked(q2, [FOLDER_2]));
    await answer(page, q1);
    await expect(panelHeading(page)).toBeVisible();

    await press(page, 'n');
    await expectShowing(page, q2);

    await expect(panelHeading(page)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(FOLDER_2);
    await expect(page.locator('body')).not.toContainText(PANEL_TITLE);
  });
});
