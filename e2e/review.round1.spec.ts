// Spec 023, review round 1 regression tests (AC-35 to AC-38, AC-40, AC-41): the review page.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROKEN_SIDECAR,
  injected,
  JS_URL,
  PAYLOAD,
  parseErrorLine,
  withFlowProvenance,
} from '../tools/review/src/__mocks__/round1-fixtures.ts';
import {
  draft,
  filesOf,
  flagged,
  marks,
  parsed,
  readLog,
  readText,
  replaceOnce,
  snapshot,
  verification,
} from '../tools/review/src/__mocks__/review-fixtures.ts';
import type { Draft, Item } from '../tools/review/src/__mocks__/review-fixtures.ts';
import { startOn, startWith, stopAll } from '../tools/review/src/__mocks__/server-fixtures.ts';

test.afterEach(async () => {
  await stopAll();
});

const q1 = draft({ id: 'd1-1.3-0001', slug: 'zeta-first' });
const q2 = draft({ id: 'd1-1.3-0002', slug: 'alpha-second' });
const verified1: Item = { draft: q1, sidecar: { verification: verification(q1) } };
const flagged2: Item = { draft: q2, sidecar: { verification: flagged(q2) } };

async function open(page: Page, ...items: (Draft | Item)[]) {
  const started = await startWith(...items);
  await page.goto(started.server.url);
  return started;
}

async function expectShowing(page: Page, d: Draft): Promise<void> {
  await expect(page.getByText(d.stem)).toBeVisible();
}

async function press(page: Page, ...keys: string[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(key);
}

async function revealWith(page: Page, d: Draft, ...keys: string[]): Promise<void> {
  await expectShowing(page, d);
  await press(page, ...keys, 'Enter');
  await expect(page.getByText(marks.why('A'))).toBeVisible();
}

/** True when the focused element is inside `main` and is not the body. */
function focusInMain(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return (
      active !== null &&
      active !== document.body &&
      document.querySelector('main')?.contains(active) === true
    );
  });
}

async function expectFocusInMain(page: Page): Promise<void> {
  await expect.poll(() => focusInMain(page)).toBe(true);
}

// --- AC-35 ---------------------------------------------------------------------------------

test.describe('flow-style provenance', () => {
  const flow = withFlowProvenance(q1);

  test('AC-35: approving it shows the error in the reveal phase and changes nothing', async ({
    page,
  }) => {
    const { dir } = await open(
      page,
      { draft: flow, sidecar: { verification: verification(flow) } },
      q2,
    );
    await revealWith(page, flow, 'c');
    const before = snapshot(dir);
    await press(page, 'a');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    await expectShowing(page, flow);
    expect(snapshot(dir)).toEqual(before);
    expect(readText(dir, flow.path)).toBe(flow.text);
    expect(readLog(dir)).toEqual([]);
  });
});

// --- AC-36 ---------------------------------------------------------------------------------

test.describe('sidecar that is not valid YAML', () => {
  test('AC-36: the reveal phase shows the sidecar parse error', async ({ page }) => {
    await open(page, { draft: q1, sidecar: BROKEN_SIDECAR });
    await revealWith(page, q1, 'c');
    const line = parseErrorLine(BROKEN_SIDECAR).split(/\s+/).join(' ');
    await expect(page.getByText(line)).toBeVisible();
  });

  test('AC-36: a valid sidecar shows no parse error (control)', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    const line = parseErrorLine(BROKEN_SIDECAR).split(/\s+/).join(' ');
    await expect(page.getByText(line)).toHaveCount(0);
  });
});

// --- AC-37 ---------------------------------------------------------------------------------

test.describe('HTML in the data', () => {
  const item = injected('d1-1.3-0005', 'html-payload');

  test('AC-37: the stem, a why, the quote and the reasons are shown as literal text', async ({
    page,
  }) => {
    await open(page, item);
    await expect(page.getByText(item.draft.stem)).toBeVisible();
    await press(page, 'c', 'Enter');
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    const text = await page.locator('main').innerText();
    // stem, why, quote and reason (the reveal shows the stem again, so at least four)
    expect(text.split(PAYLOAD).length - 1).toBeGreaterThanOrEqual(4);
  });

  test('AC-37: no b or img element comes out of the data', async ({ page }) => {
    await open(page, item);
    await expect(page.getByText(item.draft.stem)).toBeVisible();
    await expect(page.locator('main b')).toHaveCount(0);
    await expect(page.locator('main img')).toHaveCount(0);
    await press(page, 'c', 'Enter');
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    await expect(page.locator('main b')).toHaveCount(0);
    await expect(page.locator('main img')).toHaveCount(0);
  });

  test('AC-37: a javascript: source is not rendered as a link', async ({ page }) => {
    await open(page, item);
    await expect(page.getByText(item.draft.stem)).toBeVisible();
    await press(page, 'c', 'Enter');
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    await expect(page.locator(`a[href^="javascript:"]`)).toHaveCount(0);
    await expect(page.getByRole('link', { name: JS_URL })).toHaveCount(0);
    // the page still links the https references (control)
    await expect(page.locator('main a[href^="https://"]').first()).toBeVisible();
  });
});

// --- AC-38 ---------------------------------------------------------------------------------

test.describe('problem files list', () => {
  const files = { ...filesOf(q1), 'd1/1.1/broken.yaml': 'id: [unclosed\n' };

  test('AC-38: Enter on the focused summary toggles the list and does not reveal', async ({
    page,
  }) => {
    const { server } = await startOn(files);
    await page.goto(server.url);
    await expectShowing(page, q1);
    const summary = page.locator('summary');
    const details = page.locator('details');
    await expect(summary).toBeVisible();
    const initial = await details.evaluate((element) => (element as HTMLDetailsElement).open);
    await summary.focus();
    await expect(summary).toBeFocused();

    await page.keyboard.press('Enter');
    await expect
      .poll(() => details.evaluate((element) => (element as HTMLDetailsElement).open))
      .toBe(!initial);
    await expectShowing(page, q1);
    await expect(page.getByText(marks.why('A'))).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect
      .poll(() => details.evaluate((element) => (element as HTMLDetailsElement).open))
      .toBe(initial);
    await expect(page.getByText(marks.why('A'))).toHaveCount(0);
  });

  test('AC-38: Enter with nothing focused still reveals (control)', async ({ page }) => {
    await open(page, q1);
    await revealWith(page, q1, 'c');
  });
});

// --- AC-40 ---------------------------------------------------------------------------------

test.describe('focus after a screen change', () => {
  test('AC-40: after next', async ({ page }) => {
    await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    await press(page, 'n');
    await expectShowing(page, q2);
    await expectFocusInMain(page);
  });

  test('AC-40: after the reveal', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await expectFocusInMain(page);
  });

  test('AC-40: after an approve loads the next question', async ({ page }) => {
    await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await expectShowing(page, q2);
    await expectFocusInMain(page);
  });

  test('AC-40: after the editor is closed with Esc', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'e');
    await expect(page.getByRole('textbox')).toBeFocused();
    await press(page, 'Escape');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    await expectFocusInMain(page);
  });

  test('AC-40: after the editor is closed by a save', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'e');
    const editor = page.getByRole('textbox');
    await editor.fill(replaceOnce(q1.text, 'owns the keys.', 'owns and rotates the keys.'));
    await press(page, 'Control+Enter');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText('owns and rotates the keys.', { exact: false })).toBeVisible();
    await expectFocusInMain(page);
  });

  test('AC-40: after the reason field is closed with Esc', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'r');
    await expect(page.getByRole('textbox')).toBeFocused();
    await press(page, 'Escape');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    await expectFocusInMain(page);
  });

  test('AC-40: after the reason field rejects the last question (empty queue)', async ({
    page,
  }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'r');
    await page.getByRole('textbox').fill('Not good enough');
    await press(page, 'Enter');
    await expect(page.getByText(/queue is empty/i)).toBeVisible();
    await expectFocusInMain(page);
  });

  test('AC-40: after the last approve (empty queue)', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await expect(page.getByText(/queue is empty/i)).toBeVisible();
    await expectFocusInMain(page);
  });
});

// --- AC-41 ---------------------------------------------------------------------------------

test.describe('edit refused because the file changed on disk', () => {
  const HAND = 'owns every key (hand edit).';
  const MINE = 'owns and rotates the keys.';

  test('AC-41: the message shows and the reveal phase is reloaded from disk', async ({ page }) => {
    const { dir } = await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    await press(page, 'e');
    const editor = page.getByRole('textbox');
    await expect(editor).toHaveValue(q1.text);

    const onDisk = replaceOnce(q1.text, 'owns the keys.', HAND);
    writeFileSync(join(dir, q1.path), onDisk);
    await editor.fill(replaceOnce(q1.text, 'owns the keys.', MINE));
    await press(page, 'Control+Enter');

    await expect(page.getByText(/changed on disk/i).first()).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(HAND, { exact: false })).toBeVisible();
    await expect(page.getByText(MINE, { exact: false })).toHaveCount(0);
    expect(readText(dir, q1.path)).toBe(onDisk);
  });

  test('AC-41: a second save after re-opening the editor succeeds', async ({ page }) => {
    const { dir } = await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    await press(page, 'e');
    const editor = page.getByRole('textbox');
    await expect(editor).toHaveValue(q1.text);

    const onDisk = replaceOnce(q1.text, 'owns the keys.', HAND);
    writeFileSync(join(dir, q1.path), onDisk);
    await editor.fill(replaceOnce(q1.text, 'owns the keys.', MINE));
    await press(page, 'Control+Enter');
    await expect(page.getByText(HAND, { exact: false })).toBeVisible();

    await press(page, 'e');
    await expect(page.getByRole('textbox')).toBeFocused();
    await expect(page.getByRole('textbox')).toHaveValue(onDisk);
    const retried = replaceOnce(onDisk, HAND, MINE);
    await page.getByRole('textbox').fill(retried);
    await press(page, 'Control+Enter');

    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(MINE, { exact: false })).toBeVisible();
    expect(readText(dir, q1.path)).toBe(retried);
    expect(parsed(dir, q1.path)['status']).toBe('draft');
  });
});
