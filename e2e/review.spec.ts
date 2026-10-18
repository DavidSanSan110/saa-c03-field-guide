// Spec 023 (AC-23 to AC-32): the review page, served by the tool itself on a temporary folder.
// No baseURL and no site build are needed: each test starts its own server on port 0.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  allMarks,
  dedupe,
  draft,
  filesOf,
  flagged,
  marks,
  mutated,
  parsed,
  problemLines,
  readLog,
  readText,
  REFERENCES,
  replaceOnce,
  snapshot,
  verification,
} from '../tools/review/src/__mocks__/review-fixtures.ts';
import type { Draft, Item } from '../tools/review/src/__mocks__/review-fixtures.ts';
import {
  queueIds,
  REVIEWER,
  startOn,
  startWith,
  stopAll,
} from '../tools/review/src/__mocks__/server-fixtures.ts';

test.afterEach(async () => {
  await stopAll();
});

// Three questions whose ids sort q1, q2, q3 but whose paths sort q2, q3, q1.
const q1 = draft({ id: 'd1-1.3-0001', slug: 'zeta-first' }); // single, verified, dedupe flags
const q2 = draft({ id: 'd1-1.3-0002', slug: 'alpha-second' }); // single, flagged by the verifier
const q3 = draft({ id: 'd1-1.3-0003', slug: 'multi-third', type: 'multiple' }); // no sidecar

const verified1: Item = {
  draft: q1,
  sidecar: { verification: verification(q1), dedupe: dedupe() },
};
const flagged2: Item = {
  draft: q2,
  sidecar: {
    verification: flagged(q2, 'mismatch', {
      answer: ['D'],
      reasons: [`The verifier disagreed with the key. ${marks.reason}`],
    }),
  },
};

const PROGRESS = /\b\d+ of \d+\b/;

function count(label: string, n: number): RegExp {
  return new RegExp(`(${label}\\D{0,3}${String(n)}\\b|\\b${String(n)}\\D{0,3}${label})`, 'i');
}

function label(d: Draft, index: number): string {
  return `${String.fromCharCode(65 + index)}. ${d.optionTexts[index] ?? ''}`;
}

/** Opens the page of a new server over the given drafts. */
async function open(page: Page, ...items: (Draft | Item)[]) {
  const started = await startWith(...items);
  await page.goto(started.server.url);
  return started;
}

async function expectShowing(page: Page, d: Draft): Promise<void> {
  await expect(page.getByText(d.stem)).toBeVisible();
}

/** The keys of the options that are picked (checked, pressed or selected). */
async function pickedKeys(page: Page, d: Draft): Promise<string[]> {
  const keys: string[] = [];
  for (const [index, text] of d.optionTexts.entries()) {
    const picked = page
      .getByRole('radio', { name: text, checked: true })
      .or(page.getByRole('checkbox', { name: text, checked: true }))
      .or(page.getByRole('button', { name: text, pressed: true }))
      .or(page.getByRole('option', { name: text, selected: true }));
    if ((await picked.count()) > 0) keys.push(String.fromCharCode(65 + index));
  }
  return keys;
}

async function press(page: Page, ...keys: string[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(key);
}

/** Picks the keys, then reveals with Enter. */
async function revealWith(page: Page, d: Draft, ...keys: string[]): Promise<void> {
  await expectShowing(page, d);
  await press(page, ...keys, 'Enter');
  await expect(page.getByText(marks.why('A'))).toBeVisible();
}

/** The row of an option in the reveal phase, found through its `why` marker. */
function row(page: Page, key: string): Locator {
  return page
    .getByRole('listitem')
    .or(page.getByRole('row'))
    .filter({ hasText: marks.why(key) })
    .last();
}

async function tabTo(page: Page, target: Locator): Promise<boolean> {
  for (let step = 0; step < 80; step++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return true;
  }
  return false;
}

// --- AC-23 ---------------------------------------------------------------------------------

test.describe('answer phase', () => {
  test('AC-23: the first queued question shows its id, task, Choose k, stem and options', async ({
    page,
  }) => {
    await open(page, flagged2, verified1, q3);
    await expectShowing(page, q1);
    await expect(page.getByText(q1.id).first()).toBeVisible();
    await expect(page.getByText(q1.taskTitle)).toBeVisible();
    await expect(page.locator('body')).toContainText('1.3');
    await expect(page.getByText(/Choose 1\b/)).toBeVisible();
    for (const index of q1.optionTexts.keys()) {
      await expect(page.getByText(label(q1, index))).toBeVisible();
    }
  });

  test('AC-23: the progress starts at 1 of the number of queued questions', async ({ page }) => {
    await open(page, verified1, flagged2, q3);
    await expectShowing(page, q1);
    await expect(page.getByText(/\b1 of 3\b/)).toBeVisible();
  });

  test('AC-23: a multiple-answer question says Choose 2', async ({ page }) => {
    await open(page, q3);
    await expectShowing(page, q3);
    await expect(page.getByText(/Choose 2\b/)).toBeVisible();
  });

  test('AC-23: before the reveal the page shows no why, cue, quote or other sidecar text', async ({
    page,
  }) => {
    await open(page, verified1, flagged2, q3);
    await expectShowing(page, q1);
    for (const marker of [...allMarks(), 'claude-opus', REFERENCES[0] as string]) {
      await expect(page.locator('body')).not.toContainText(marker);
    }
    const html = await page.content();
    for (const marker of allMarks()) expect(html).not.toContain(marker);
  });

  test('AC-23: before the reveal the page has no correct marking', async ({ page }) => {
    await open(page, verified1);
    await expectShowing(page, q1);
    await expect(page.locator('body')).not.toContainText(/\bcorrect\b/i, { useInnerText: true });
  });

  test('AC-23: the browser receives no key data before the reveal', async ({ page }) => {
    const bodies: Promise<string>[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/')) {
        bodies.push(response.text().catch(() => ''));
      }
    });
    await open(page, verified1, flagged2, q3);
    await expectShowing(page, q1);
    const received = (await Promise.all(bodies)).join('\n');
    expect(received).toContain(q1.optionTexts[0]);
    for (const marker of [...allMarks(), 'claude-opus']) expect(received).not.toContain(marker);
    expect(received).not.toMatch(/"(correct|why|cue|references|verification|dedupe)"/);
  });
});

// --- AC-24 ---------------------------------------------------------------------------------

test.describe('picking options', () => {
  test('AC-24: on a single question, B then C leaves only C picked', async ({ page }) => {
    await open(page, q1);
    await expectShowing(page, q1);
    await press(page, 'B');
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['B']);
    await press(page, 'C');
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['C']);
  });

  test('AC-24: on a multiple question, B, C, B leaves only C picked', async ({ page }) => {
    await open(page, q3);
    await expectShowing(page, q3);
    await press(page, 'B');
    await expect.poll(() => pickedKeys(page, q3)).toEqual(['B']);
    await press(page, 'C');
    await expect.poll(() => pickedKeys(page, q3)).toEqual(['B', 'C']);
    await press(page, 'B');
    await expect.poll(() => pickedKeys(page, q3)).toEqual(['C']);
  });

  test('AC-24: lower-case keys pick the same options', async ({ page }) => {
    await open(page, q1);
    await expectShowing(page, q1);
    await press(page, 'b');
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['B']);
    await press(page, 'c');
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['C']);
  });

  test('AC-24: a key past the last option does nothing', async ({ page }) => {
    await open(page, q1);
    await expectShowing(page, q1);
    await press(page, 'b', 'e', 'F', 'f');
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['B']);
    await expect(page.getByText(label(q1, 0))).toBeVisible();
  });

  test('AC-24: on a five-option question, E picks and F does nothing', async ({ page }) => {
    await open(page, q3);
    await expectShowing(page, q3);
    await press(page, 'F', 'e');
    await expect.poll(() => pickedKeys(page, q3)).toEqual(['E']);
  });

  test('AC-24: clicking an option picks it like its key (single replaces)', async ({ page }) => {
    await open(page, q1);
    await expectShowing(page, q1);
    await page.getByText(label(q1, 1)).click();
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['B']);
    await page.getByText(label(q1, 2)).click();
    await expect.poll(() => pickedKeys(page, q1)).toEqual(['C']);
  });

  test('AC-24: clicking options of a multiple question toggles them', async ({ page }) => {
    await open(page, q3);
    await expectShowing(page, q3);
    await page.getByText(label(q3, 1)).click();
    await page.getByText(label(q3, 3)).click();
    await expect.poll(() => pickedKeys(page, q3)).toEqual(['B', 'D']);
    await page.getByText(label(q3, 1)).click();
    await expect.poll(() => pickedKeys(page, q3)).toEqual(['D']);
  });
});

// --- AC-25 ---------------------------------------------------------------------------------

test.describe('reveal phase', () => {
  test('AC-25: Enter shows the why of every option', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    for (const key of ['A', 'B', 'C', 'D']) {
      await expect(page.getByText(marks.why(key))).toBeVisible();
    }
  });

  test('AC-25: Enter reveals with no pick at all', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1);
    await expect(page.getByText(/\bwrong\b/i).first()).toBeVisible();
  });

  test('AC-25: shows which options are correct and which were picked', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'a');
    await expect(row(page, 'C')).toContainText(/\bcorrect\b/i, { useInnerText: true });
    for (const key of ['A', 'B', 'D']) {
      await expect(row(page, key)).not.toContainText(/\bcorrect\b/i, { useInnerText: true });
    }
    await expect(row(page, 'A')).toContainText(/\bpicked\b/i, { useInnerText: true });
    for (const key of ['B', 'C', 'D']) {
      await expect(row(page, key)).not.toContainText(/\bpicked\b/i, { useInnerText: true });
    }
  });

  test('AC-25: says the answer was right when the picks are the key', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await expect(page.getByText(/\bright\b/i).first()).toBeVisible();
    await expect(page.getByText(/\bwrong\b/i)).toHaveCount(0);
    await expect(row(page, 'C')).toContainText(/\bpicked\b/i, { useInnerText: true });
  });

  test('AC-25: says the answer was wrong for another option', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'a');
    await expect(page.getByText(/\bwrong\b/i).first()).toBeVisible();
  });

  test('AC-25: a multiple question is right only for the exact set', async ({ page }) => {
    await open(page, q3);
    await revealWith(page, q3, 'b', 'd');
    await expect(page.getByText(/\bright\b/i).first()).toBeVisible();
    await expect(page.getByText(/\bwrong\b/i)).toHaveCount(0);
  });

  test('AC-25: a multiple question with only a subset picked is wrong', async ({ page }) => {
    await open(page, q3);
    await revealWith(page, q3, 'b');
    await expect(page.getByText(/\bwrong\b/i).first()).toBeVisible();
  });

  test('AC-25: shows the cue', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await expect(page.getByText(marks.cue)).toBeVisible();
  });

  test('AC-25: shows the services and the difficulty', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await expect(page.getByText(/\bs3\b/i).first()).toBeVisible();
    await expect(page.getByText(/\bmedium\b/i).first()).toBeVisible();
  });

  test('AC-25: the references are links that open in a new tab', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    for (const url of REFERENCES) {
      const link = page.locator(`a[href="${url}"]`);
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  test('AC-25: a verified question shows the verifier, the quote, the source and the check', async ({
    page,
  }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await expect(page.getByText(/\bverified\b/i).first()).toBeVisible();
    await expect(page.getByText(/not verified/i)).toHaveCount(0);
    await expect(page.getByText('claude-opus').first()).toBeVisible();
    await expect(page.getByText(marks.quote)).toBeVisible();
    const source = `https://docs.aws.amazon.com/AmazonS3/latest/userguide/${marks.source}.html`;
    await expect(page.locator(`a[href="${source}"]`)).toBeVisible();
    await expect(page.getByText(/\bfound\b/i).first()).toBeVisible();
  });

  test('AC-25: a flagged question shows its state, the verifier answer, the reasons and notes', async ({
    page,
  }) => {
    await open(page, flagged2);
    await revealWith(page, q2, 'c');
    await expect(page.getByText(/\bflagged\b/i).first()).toBeVisible();
    await expect(
      page
        .getByText(/answer/i)
        .filter({ hasText: /\bD\b/ })
        .first(),
    ).toBeVisible();
    await expect(page.getByText(marks.reason)).toBeVisible();
    await expect(page.getByText(marks.notes)).toBeVisible();
    await expect(page.getByText(/not-found|not found/i).first()).toBeVisible();
  });

  test('AC-25: the dedupe list shows the threshold and every similar question', async ({
    page,
  }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await expect(page.getByText(/threshold\D{0,5}0\.5\b/i)).toBeVisible();
    await expect(page.getByText(/0\.62|62\s?%/).first()).toBeVisible();
    await expect(page.getByText('d1-1.3-0042').first()).toBeVisible();
    await expect(page.getByText(`bank/d1/1.3/${marks.similar}-twin.yaml`)).toBeVisible();
    await expect(page.getByText(/0\.55|55\s?%/).first()).toBeVisible();
    await expect(page.getByText('d1-1.3-0009').first()).toBeVisible();
    await expect(page.getByText('drafts/d1/1.3/another-draft.yaml')).toBeVisible();
  });

  test('AC-25: without a sidecar it says not verified and dedupe not run', async ({ page }) => {
    await open(page, q3);
    await revealWith(page, q3, 'b', 'd');
    await expect(page.getByText(/not verified/i)).toBeVisible();
    await expect(page.getByText(/dedupe not run/i)).toBeVisible();
  });

  test('AC-25: the reveal shows the action buttons with their keys', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    for (const name of [/approve/i, /edit/i, /reject/i, /next/i]) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }
  });
});

// --- AC-26 ---------------------------------------------------------------------------------

test.describe('approve', () => {
  test('AC-26: on a verified question, a approves and the next question is in its answer phase', async ({
    page,
  }) => {
    const { dir } = await open(page, verified1, flagged2, q3);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await expectShowing(page, q2);
    await expect(page.getByText(marks.why('A'))).toHaveCount(0);
    await expect(page.getByText(/Choose 1\b/)).toBeVisible();
    const approved = parsed(dir, q1.path);
    expect(approved['status']).toBe('reviewed');
    expect(approved['provenance']).toEqual({
      generated_by: 'claude-sonnet',
      verified_by: 'claude-opus',
      reviewed_by: REVIEWER,
    });
  });

  test('AC-26: one press of a is enough, with no warning', async ({ page }) => {
    await open(page, verified1, q3);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await expectShowing(page, q3);
    await expect(page.getByText(/again/i)).toHaveCount(0);
  });

  test('AC-26: the progress and the approved count update', async ({ page }) => {
    await open(page, verified1, flagged2, q3);
    await expectShowing(page, q1);
    const before = await page.getByText(PROGRESS).first().innerText();
    await expect(page.getByText(count('approved', 1))).toHaveCount(0);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await expectShowing(page, q2);
    await expect(page.getByText(PROGRESS).first()).not.toHaveText(before);
    await expect(page.getByText(count('approved', 1)).first()).toBeVisible();
  });

  test('AC-26: the approve button does the same as the key', async ({ page }) => {
    const { dir } = await open(page, verified1, q3);
    await revealWith(page, q1, 'c');
    await page.getByRole('button', { name: /approve/i }).click();
    await expectShowing(page, q3);
    expect(parsed(dir, q1.path)['status']).toBe('reviewed');
  });

  test('AC-26: the approved question leaves the queue and its sidecar is kept', async ({
    page,
  }) => {
    const { server, dir } = await open(page, verified1, q3);
    const sidecar = readText(dir, q1.sidecar);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await expectShowing(page, q3);
    expect(await queueIds(server)).toEqual([q3.id]);
    expect(readText(dir, q1.sidecar)).toBe(sidecar);
  });
});

// --- AC-27 ---------------------------------------------------------------------------------

test.describe('approve anyway', () => {
  const STALE: Item = {
    draft: q1,
    sidecar: { verification: verification(q1, { digest: '0000000000000000' }) },
  };

  test('AC-27: on a flagged question the first a shows a warning and changes no file', async ({
    page,
  }) => {
    const { dir } = await open(page, flagged2, q3);
    await revealWith(page, q2, 'c');
    const before = snapshot(dir);
    await press(page, 'a');
    const warning = page.getByText(/again/i).filter({ hasText: /flagged/i });
    await expect(warning.first()).toBeVisible();
    await expect(page.getByText(/press\s+a\s+again/i).first()).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
  });

  test('AC-27: a second a approves anyway, with the reviewer as verified_by', async ({ page }) => {
    const { dir } = await open(page, flagged2, q3);
    await revealWith(page, q2, 'c');
    await press(page, 'a');
    await expect(page.getByText(/press\s+a\s+again/i).first()).toBeVisible();
    await press(page, 'a');
    await expectShowing(page, q3);
    const approved = parsed(dir, q2.path);
    expect(approved['status']).toBe('reviewed');
    expect(approved['provenance']).toEqual({
      generated_by: 'claude-sonnet',
      verified_by: REVIEWER,
      reviewed_by: REVIEWER,
    });
  });

  test('AC-27: Esc cancels the warning and nothing is approved', async ({ page }) => {
    const { dir } = await open(page, flagged2, q3);
    await revealWith(page, q2, 'c');
    const before = snapshot(dir);
    await press(page, 'a');
    await expect(page.getByText(/press\s+a\s+again/i).first()).toBeVisible();
    await press(page, 'Escape');
    await expect(page.getByText(/press\s+a\s+again/i)).toHaveCount(0);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-27: after Esc a single a does not approve either', async ({ page }) => {
    const { dir } = await open(page, flagged2, q3);
    await revealWith(page, q2, 'c');
    await press(page, 'a', 'Escape', 'a');
    await expect(page.getByText(/press\s+a\s+again/i).first()).toBeVisible();
    expect(parsed(dir, q2.path)['status']).toBe('draft');
  });

  test('AC-27: a question with no verification names the state none', async ({ page }) => {
    const { dir } = await open(page, q3);
    await revealWith(page, q3, 'b', 'd');
    const before = snapshot(dir);
    await press(page, 'a');
    await expect(
      page
        .getByText(/again/i)
        .filter({ hasText: /\bnone\b/i })
        .first(),
    ).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-27: a question changed since its verification names the state changed', async ({
    page,
  }) => {
    const { dir } = await open(page, STALE);
    await revealWith(page, q1, 'c');
    const before = snapshot(dir);
    await press(page, 'a');
    await expect(
      page
        .getByText(/again/i)
        .filter({ hasText: /\bchanged\b/i })
        .first(),
    ).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });
});

// --- AC-28 ---------------------------------------------------------------------------------

test.describe('edit', () => {
  const NEW_WHY = replaceOnce(q1.text, 'owns the keys.', 'owns and rotates the keys.');
  const NEW_STEM_TEXT = replaceOnce(q1.text, 'Which option meets', 'Which single option meets');

  async function openEditor(page: Page) {
    const started = await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    await press(page, 'e');
    const editor = page.getByRole('textbox');
    await expect(editor).toBeFocused();
    return { ...started, editor };
  }

  test('AC-28: e opens the editor with the YAML text, focused', async ({ page }) => {
    const { editor } = await openEditor(page);
    await expect(editor).toHaveValue(q1.text);
  });

  test('AC-28: letter keys type text in the editor and fire no action', async ({ page }) => {
    const { dir, editor } = await openEditor(page);
    const before = snapshot(dir);
    await page.keyboard.type('arenx');
    await expect(editor).toHaveValue(/arenx/);
    await expect(editor).toBeVisible();
    await expect(page.getByText(/press\s+a\s+again/i)).toHaveCount(0);
    await expect(page.getByText(q2.stem)).toHaveCount(0);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: Ctrl+Enter with a valid change saves it and shows the reveal of the update', async ({
    page,
  }) => {
    const { dir, editor } = await openEditor(page);
    await editor.fill(NEW_STEM_TEXT);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText('Which single option meets', { exact: false })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    expect(readText(dir, q1.path)).toBe(NEW_STEM_TEXT);
  });

  test('AC-28: after a saved edit the verification state is recomputed', async ({ page }) => {
    const { editor } = await openEditor(page);
    await expect(page.getByText(/\bchanged\b/i)).toHaveCount(0);
    await editor.fill(NEW_STEM_TEXT);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/\bchanged\b/i).first()).toBeVisible();
  });

  test('AC-28: a change to a why is saved too', async ({ page }) => {
    const { dir, editor } = await openEditor(page);
    await editor.fill(NEW_WHY);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText('owns and rotates the keys.', { exact: false })).toBeVisible();
    expect(readText(dir, q1.path)).toBe(NEW_WHY);
  });

  test('AC-28: an invalid change shows the errors, keeps the editor open and the file as it was', async ({
    page,
  }) => {
    const { dir, editor } = await openEditor(page);
    const before = snapshot(dir);
    await editor.fill(replaceOnce(q1.text, 'difficulty: medium', 'difficulty: nightmare'));
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/difficulty/i).first()).toBeVisible();
    await expect(page.getByRole('textbox')).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: invalid YAML is refused and keeps the editor open', async ({ page }) => {
    const { dir, editor } = await openEditor(page);
    const before = snapshot(dir);
    await editor.fill('id: [unclosed\n');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('alert').or(page.getByText(/yaml/i)).first()).toBeVisible();
    await expect(page.getByRole('textbox')).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: a changed id is refused and names the field', async ({ page }) => {
    const { dir, editor } = await openEditor(page);
    const before = snapshot(dir);
    await editor.fill(replaceOnce(q1.text, 'id: d1-1.3-0001', 'id: d1-1.3-0099'));
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/\bid\b/i).first()).toBeVisible();
    await expect(page.getByRole('textbox')).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-28: Esc cancels the editor and goes back to the reveal', async ({ page }) => {
    const { dir, editor } = await openEditor(page);
    const before = snapshot(dir);
    await editor.fill(NEW_STEM_TEXT);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    await expect(page.getByText(q1.stem)).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });
});

// --- AC-29 ---------------------------------------------------------------------------------

test.describe('reject', () => {
  const REASON = 'Not exam-style, near-duplicate';

  async function openReason(page: Page) {
    const started = await open(page, verified1, flagged2);
    await revealWith(page, q1, 'a');
    await press(page, 'r');
    const reason = page.getByRole('textbox');
    await expect(reason).toBeFocused();
    await expect(reason).toHaveValue('');
    return { ...started, reason };
  }

  test('AC-29: r opens a focused reason field', async ({ page }) => {
    await openReason(page);
  });

  test('AC-29: Enter with a blank reason is refused and nothing moves', async ({ page }) => {
    const { dir, reason } = await openReason(page);
    const before = snapshot(dir);
    await page.keyboard.press('Enter');
    await expect(reason).toBeVisible();
    await reason.fill('   ');
    await page.keyboard.press('Enter');
    await expect(reason).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, 'rejected'))).toBe(false);
  });

  test('AC-29: Enter with a reason moves the files and loads the next question', async ({
    page,
  }) => {
    const { dir, reason } = await openReason(page);
    const sidecar = readText(dir, q1.sidecar);
    await reason.fill(REASON);
    await page.keyboard.press('Enter');
    await expectShowing(page, q2);
    expect(existsSync(join(dir, q1.path))).toBe(false);
    expect(existsSync(join(dir, q1.sidecar))).toBe(false);
    expect(readText(dir, `rejected/${q1.path}`)).toBe(q1.text);
    expect(readText(dir, `rejected/${q1.sidecar}`)).toBe(sidecar);
  });

  test('AC-29: typing the letters a, e, n and r in the reason fires no shortcut', async ({
    page,
  }) => {
    const { dir } = await openReason(page);
    await page.keyboard.type(REASON);
    await expect(page.getByRole('textbox')).toHaveValue(REASON);
    expect(existsSync(join(dir, q1.path))).toBe(true);
    await page.keyboard.press('Enter');
    await expectShowing(page, q2);
    expect(readLog(dir)[0]).toMatchObject({ decision: 'rejected', id: q1.id, reason: REASON });
  });

  test('AC-29: Esc cancels the reason field and nothing moves', async ({ page }) => {
    const { dir, reason } = await openReason(page);
    const before = snapshot(dir);
    await reason.fill(REASON);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText(marks.why('A'))).toBeVisible();
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-29: the reject button opens the reason field', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'a');
    await page.getByRole('button', { name: /reject/i }).click();
    await expect(page.getByRole('textbox')).toBeFocused();
  });
});

// --- AC-30 ---------------------------------------------------------------------------------

test.describe('next', () => {
  test('AC-30: n shows the next question without changing any file', async ({ page }) => {
    const { server, dir } = await open(page, verified1, flagged2, q3);
    await revealWith(page, q1, 'c');
    const before = snapshot(dir);
    await press(page, 'n');
    await expectShowing(page, q2);
    await expect(page.getByText(marks.why('A'))).toHaveCount(0);
    expect(snapshot(dir)).toEqual(before);
    expect(await queueIds(server)).toEqual([q1.id, q2.id, q3.id]);
  });

  test('AC-30: the next button does the same as the key', async ({ page }) => {
    const { dir } = await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    const before = snapshot(dir);
    await page.getByRole('button', { name: /next/i }).click();
    await expectShowing(page, q2);
    expect(snapshot(dir)).toEqual(before);
  });
});

// --- AC-31 ---------------------------------------------------------------------------------

test.describe('end of the queue', () => {
  const done = draft({ id: 'd2-2.1-0001', slug: 'done', status: 'reviewed' });
  const shortStem = mutated(draft({ id: 'd1-1.1-0005', slug: 'short-stem' }), (q) => {
    q['stem'] = 'Why?';
  });

  test('AC-31: with nothing queued the page says so and shows the hint and the problem files', async ({
    page,
  }) => {
    const files = {
      ...filesOf(done),
      'd1/1.1/short-stem.yaml': shortStem,
      'd1/1.1/Bad_Slug.yaml': q1.text,
      'd1/1.1/old-extension.yml': q1.text,
    };
    const lines = problemLines(files);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const started = await startOn(files);
    await page.goto(started.server.url);
    await expect(page.getByText(/queue is empty/i)).toBeVisible();
    await expect(page.getByText('pnpm questions promote')).toBeVisible();
    for (const line of lines) await expect(page.getByText(line)).toBeVisible();
  });

  test('AC-31: the empty page shows the session counts and the reviewed drafts waiting', async ({
    page,
  }) => {
    await open(page, done);
    await expect(page.getByText(/queue is empty/i)).toBeVisible();
    await expect(page.getByText(count('approved', 0)).first()).toBeVisible();
    await expect(page.getByText(count('rejected', 0)).first()).toBeVisible();
    await expect(
      page.getByText(/(\b1\b\D{0,30}waiting|waiting\D{0,30}\b1\b)/i).first(),
    ).toBeVisible();
  });

  test('AC-31: after the last question the page shows the session counts', async ({ page }) => {
    await open(page, verified1, flagged2);
    await revealWith(page, q1, 'c');
    await press(page, 'a');
    await revealWith(page, q2, 'c');
    await press(page, 'r');
    await page.getByRole('textbox').fill('Not good enough');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/queue is empty/i)).toBeVisible();
    await expect(page.getByText(count('approved', 1)).first()).toBeVisible();
    await expect(page.getByText(count('rejected', 1)).first()).toBeVisible();
    await expect(page.getByText('pnpm questions promote')).toBeVisible();
  });

  test('AC-31: a queue with questions does not show the empty message', async ({ page }) => {
    await open(page, verified1);
    await expectShowing(page, q1);
    await expect(page.getByText(/queue is empty/i)).toHaveCount(0);
    await expect(page.getByText('pnpm questions promote')).toHaveCount(0);
  });
});

// --- AC-32 ---------------------------------------------------------------------------------

async function violations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

test.describe('accessibility', () => {
  test('AC-32: the answer phase has no axe violations', async ({ page }) => {
    await open(page, verified1, flagged2);
    await expectShowing(page, q1);
    await press(page, 'c');
    expect(await violations(page)).toEqual([]);
  });

  test('AC-32: the reveal phase has no axe violations', async ({ page }) => {
    await open(page, verified1, flagged2);
    await revealWith(page, q1, 'a');
    expect(await violations(page)).toEqual([]);
  });

  test('AC-32: the reveal phase of a flagged question has no axe violations', async ({ page }) => {
    await open(page, flagged2);
    await revealWith(page, q2, 'c');
    expect(await violations(page)).toEqual([]);
  });

  test('AC-32: the warning has no axe violations', async ({ page }) => {
    await open(page, flagged2);
    await revealWith(page, q2, 'c');
    await press(page, 'a');
    await expect(page.getByText(/press\s+a\s+again/i).first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('AC-32: the editor has no axe violations', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'e');
    await expect(page.getByRole('textbox')).toBeFocused();
    expect(await violations(page)).toEqual([]);
  });

  test('AC-32: the reason field has no axe violations', async ({ page }) => {
    await open(page, verified1);
    await revealWith(page, q1, 'c');
    await press(page, 'r');
    await expect(page.getByRole('textbox')).toBeFocused();
    expect(await violations(page)).toEqual([]);
  });

  test('AC-32: the empty page has no axe violations', async ({ page }) => {
    await open(page, draft({ id: 'd2-2.1-0001', slug: 'done', status: 'reviewed' }));
    await expect(page.getByText(/queue is empty/i)).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  const ACTIONS: [string, RegExp, RegExp][] = [
    ['approve', /approve/i, /\ba\b/i],
    ['edit', /edit/i, /\be\b/i],
    ['reject', /reject/i, /\br\b/i],
    ['next', /next/i, /\bn\b/i],
  ];

  for (const [action, name, key] of ACTIONS) {
    test(`AC-32: the ${action} button names its key and is reachable by Tab`, async ({ page }) => {
      await open(page, verified1);
      await revealWith(page, q1, 'c');
      const button = page.getByRole('button', { name });
      await expect(button).toBeVisible();
      await expect(button).toHaveAccessibleName(key);
      expect(await tabTo(page, button)).toBe(true);
    });
  }
});
