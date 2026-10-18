// Spec 027, review round 1 regression tests (AC-27 to AC-33).
// Appended after the first test commit: the locked practice-exam.spec.ts is not touched.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { domains } from '../../packages/schema/src/index.ts';
import type { Progress, SavedSession } from '../../packages/schema/src/index.ts';
import {
  NOT_RESTORED_TEXT,
  PROGRESS_KEY,
  SESSION_KEY,
  TIME_UP_TEXT,
  discardButton,
  endAndSubmit,
  endExamButton,
  fetchBank,
  goToQuestion,
  mixed,
  newExamButton,
  normalise,
  openStart,
  optionInputs,
  planOf,
  readStored,
  seedSavedExam,
  seededSession,
  startButton,
  startExam,
  submitExamButton,
  waitForSaved,
} from './practice-support.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

const T0 = new Date('2026-11-02T09:00:00Z');

/** The text shown for a saved exam that cannot be restored for any reason but changed questions. */
const GENERIC_NOT_RESTORED_TEXT = 'Your saved exam could not be restored.';

async function bankAndPlan(request: APIRequestContext) {
  const bank = await fetchBank(request);
  return { bank, plan: planOf(bank) };
}

async function mainText(page: Page): Promise<string> {
  return normalise(await page.getByRole('main').innerText()).replaceAll('’', "'");
}

async function storedProgress(page: Page): Promise<Progress> {
  await expect.poll(() => readStored(page, PROGRESS_KEY), { message: 'progress' }).not.toBeNull();
  return JSON.parse((await readStored(page, PROGRESS_KEY)) ?? 'null') as Progress;
}

/* ====================================================================== AC-27 */

test.describe('AC-27: focus after closing the submit confirmation', () => {
  async function openConfirmation(page: Page, request: APIRequestContext): Promise<void> {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    // Nothing is answered, so Submit exam opens the confirmation.
    await endExamButton(page).click();
    await submitExamButton(page).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
  }

  test('AC-27: Cancel closes the dialog and leaves focus on the Submit exam button', async ({
    page,
    request,
  }) => {
    await openConfirmation(page, request);

    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(submitExamButton(page)).toBeFocused();
  });

  test('AC-27: Cancel leaves document.activeElement on the Submit exam button, not on body', async ({
    page,
    request,
  }) => {
    await openConfirmation(page, request);

    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    const active = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        tag: element?.tagName ?? null,
        text: element?.textContent?.trim().slice(0, 30) ?? null,
      };
    });
    expect(active).toEqual({ tag: 'BUTTON', text: 'Submit exam' });
  });

  test('AC-27: Escape closes the dialog and leaves focus on the Submit exam button', async ({
    page,
    request,
  }) => {
    await openConfirmation(page, request);

    await page.keyboard.press('Escape');

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(submitExamButton(page)).toBeFocused();
  });

  test('AC-27: the exam is kept after closing the dialog', async ({ page, request }) => {
    await openConfirmation(page, request);

    await page.keyboard.press('Escape');

    await expect(submitExamButton(page)).toBeVisible();
    await expect(newExamButton(page)).toHaveCount(0);
  });
});

/* ====================================================================== AC-28 */

test.describe('AC-28: the short-exam notice', () => {
  const SENTENCE = (size: number) =>
    `This exam is shorter than the real one (${String(size)} of 65 questions): ` +
    "the question bank doesn't have enough questions yet to fill every domain's share. " +
    'Questions per domain:';

  test('AC-28: the notice reads exactly as specified, with one item per domain', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    const text = await mainText(page);

    if (plan.complete) {
      expect(text).not.toContain('This exam is shorter than the real one');
      return;
    }
    expect(text).toContain(SENTENCE(plan.size));
    const items = (await page.getByRole('main').getByRole('listitem').allInnerTexts()).map((item) =>
      normalise(item),
    );
    for (const { id, picked, quota } of plan.byDomain) {
      const title = domains.find((domain) => domain.id === id)?.title ?? '';
      const expected = `Domain ${String(id)}: ${title}: ${String(picked)} of ${String(quota)}`;
      expect(items, `item of domain ${String(id)}`).toContain(expected);
    }
  });

  test('AC-28: the notice lists the domain items right after the sentence, in domain order', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    test.skip(plan.complete, 'the bank fills all 65 questions: no notice');
    const text = await mainText(page);

    const expectedTail = [...plan.byDomain]
      .sort((a, b) => a.id - b.id)
      .map(({ id, picked, quota }) => {
        const title = domains.find((domain) => domain.id === id)?.title ?? '';
        return `Domain ${String(id)}: ${title}: ${String(picked)} of ${String(quota)}`;
      })
      .join(' ');
    expect(text).toContain(`${SENTENCE(plan.size)} ${expectedTail}`);
  });

  test('AC-28: the words "picked of quota" and "does not cover" never appear', async ({ page }) => {
    await openStart(page);
    const text = await mainText(page);

    expect(text).not.toMatch(/picked of quota/i);
    expect(text).not.toMatch(/does not cover/i);
  });
});

/* ====================================================================== AC-29 */

test.describe('AC-29: option accessible names carry the display letter', () => {
  for (const type of ['single', 'multiple'] as const) {
    test(`AC-29: every ${type}-answer option has a name starting with its display letter and a non-letter`, async ({
      page,
      request,
    }) => {
      const { bank, plan } = await bankAndPlan(request);
      await openStart(page);
      const saved = await startExam(page, plan);
      const index = saved.exam.items.findIndex((item) => {
        const question = bank.find((candidate) => candidate.id === item.id);
        return question?.type === type;
      });
      test.skip(index < 0, `the exam has no ${type}-answer question`);
      await goToQuestion(page, index + 1, plan.size);

      const inputs = optionInputs(page, type);
      const count = await inputs.count();
      expect(count).toBeGreaterThanOrEqual(2);
      for (let position = 0; position < count; position += 1) {
        const letter = 'ABCDEF'[position] ?? '?';
        await expect(inputs.nth(position), `option ${String(position + 1)}`).toHaveAccessibleName(
          new RegExp(`^${letter}[^A-Za-z]`),
        );
      }
    });
  }
});

/* ====================================================================== AC-30 */

test.describe('AC-30: focus returns to Start exam', () => {
  test('AC-30: after Discard keyboard focus is on the Start exam button', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    await seedSavedExam(page, seededSession(bank, mixed, { now: Date.now() }));
    await expect(discardButton(page)).toBeVisible();

    await discardButton(page).click();

    await expect(startButton(page)).toBeVisible();
    await expect(startButton(page)).toBeFocused();
  });

  test('AC-30: after Start a new exam keyboard focus is on the Start exam button', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await endAndSubmit(page);

    await newExamButton(page).click();

    await expect(startButton(page)).toBeVisible();
    await expect(startButton(page)).toBeFocused();
  });
});

/* ====================================================================== AC-31 */

test.describe('AC-31: the loading block keeps the reserved height', () => {
  test('AC-31: while bank.json loads the loading block is at least 40rem tall', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/practice/bank.json', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/practice/');
    const loading = page.getByText('Loading questions…').first();
    await expect(loading).toBeVisible();

    const { height, rem } = await loading.evaluate((element) => {
      // The tallest box from the loading text up to (excluding) the island or the main area.
      let node: Element | null = element;
      let tallest = 0;
      while (node !== null && node.tagName !== 'ASTRO-ISLAND' && node.tagName !== 'MAIN') {
        tallest = Math.max(tallest, node.getBoundingClientRect().height);
        node = node.parentElement;
      }
      const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { height: tallest, rem: rootSize };
    });
    release();

    expect(height).toBeGreaterThanOrEqual(40 * rem);
    await expect(startButton(page)).toBeVisible();
  });
});

/* ====================================================================== AC-32 */

test.describe('AC-32: a timeout is recorded', () => {
  async function expectTimeoutRecorded(page: Page): Promise<void> {
    await expect(newExamButton(page)).toBeVisible();
    await expect(page.getByText(TIME_UP_TEXT)).toBeVisible();

    const progress = await storedProgress(page);
    expect(progress.attempts).toHaveLength(1);
    expect(progress.attempts[0]?.mode).toBe('exam');
    expect(progress.attempts[0]?.submitReason).toBe('timeout');
    expect(await readStored(page, SESSION_KEY)).toBeNull();

    await newExamButton(page).click();
    await expect(startButton(page)).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Last exam:');
    await expect(page.getByRole('button', { name: /^Resume exam/ })).toHaveCount(0);
  }

  test('AC-32: a timeout on screen is recorded in progress and the saved exam is removed', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);

    await page.clock.fastForward(plan.limitMs + 2_000);

    await expectTimeoutRecorded(page);
  });

  test('AC-32: a timeout found on reload after the deadline is recorded in progress', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);
    await waitForSaved(page);

    await page.clock.setSystemTime(new Date(T0.getTime() + plan.limitMs + 60_000));
    await page.reload();

    await expectTimeoutRecorded(page);
  });

  test('AC-32: the "Last exam" line survives a reload after a timeout', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);
    await page.clock.fastForward(plan.limitMs + 2_000);
    await expect(newExamButton(page)).toBeVisible();
    await storedProgress(page);

    await page.reload();

    await expect(startButton(page)).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Last exam:');
  });
});

/* ====================================================================== AC-33 */

test.describe('AC-33: the unrestorable message depends on the reason', () => {
  async function storeAndReload(page: Page, value: string): Promise<void> {
    await page.evaluate(
      ([key, text]) => {
        window.localStorage.setItem(key as string, text as string);
      },
      [SESSION_KEY, value],
    );
    await page.reload();
    await expect(startButton(page)).toBeVisible();
  }

  async function expectGeneric(page: Page): Promise<void> {
    const text = await mainText(page);
    expect(text).toContain(GENERIC_NOT_RESTORED_TEXT);
    expect(text).not.toContain('because the questions changed');
    expect(await readStored(page, SESSION_KEY)).toBeNull();
  }

  async function expectChanged(page: Page): Promise<void> {
    const text = await mainText(page);
    expect(text).toContain(NOT_RESTORED_TEXT);
    expect(text).not.toContain(GENERIC_NOT_RESTORED_TEXT);
    expect(await readStored(page, SESSION_KEY)).toBeNull();
  }

  async function startedSaved(page: Page, request: APIRequestContext): Promise<SavedSession> {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    return startExam(page, plan);
  }

  test('AC-33: corrupt JSON in the saved exam shows the generic text', async ({
    page,
    request,
  }) => {
    await startedSaved(page, request);

    await storeAndReload(page, '{not json');

    await expectGeneric(page);
  });

  test('AC-33: JSON that is not a saved exam shows the generic text', async ({ page, request }) => {
    await startedSaved(page, request);

    await storeAndReload(page, JSON.stringify({ not: 'a saved exam' }));

    await expectGeneric(page);
  });

  test('AC-33: a saved exam of another version shows the generic text', async ({
    page,
    request,
  }) => {
    const saved = await startedSaved(page, request);

    await storeAndReload(page, JSON.stringify({ ...saved, version: 2 }));

    await expectGeneric(page);
  });

  test('AC-33: question ids that are not in the bank show "because the questions changed."', async ({
    page,
    request,
  }) => {
    const saved = await startedSaved(page, request);
    const missing = {
      ...saved,
      exam: {
        ...saved.exam,
        items: saved.exam.items.map((item, index) =>
          index === 0 ? { ...item, id: 'd1-1.1-9999' } : item,
        ),
      },
      answers: {},
      flagged: [],
      revealed: [],
    };

    await storeAndReload(page, JSON.stringify(missing));

    await expectChanged(page);
  });

  test('AC-33: an option order that no longer fits the question shows "because the questions changed."', async ({
    page,
    request,
  }) => {
    const saved = await startedSaved(page, request);
    const changed = {
      ...saved,
      exam: {
        ...saved.exam,
        items: saved.exam.items.map((item, index) => {
          if (index !== 0) return item;
          const spare = [...'ABCDEF'].find((key) => !item.optionOrder.includes(key)) ?? 'F';
          return { ...item, optionOrder: [...item.optionOrder.slice(0, -1), spare] };
        }),
      },
      answers: {},
      flagged: [],
      revealed: [],
    };

    await storeAndReload(page, JSON.stringify(changed));

    await expectChanged(page);
  });
});
