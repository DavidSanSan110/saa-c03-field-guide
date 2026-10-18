// Spec 027: the practice exam at /practice/ (AC-6 to AC-25).
// Every test reads the real bank from /practice/bank.json and the exam the app saved in
// localStorage, so nothing here depends on which questions the bank holds.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { domains } from '../../packages/schema/src/index.ts';
import { saveSession } from '../../packages/quiz-core/src/index.ts';
import { formatClock } from '../../apps/site/src/practice/format.ts';
import type { ResultsView } from '../../apps/site/src/practice/results.ts';
import {
  FOOTNOTE_TEXT,
  NOT_RESTORED_TEXT,
  NOT_SAVED_TEXT,
  PHONE_VIEWPORT,
  PRACTICE_PATH,
  PROGRESS_KEY,
  SESSION_KEY,
  TIME_UP_TEXT,
  WIDE_VIEWPORT,
  allCorrect,
  allNavButtons,
  answeredText,
  choose,
  confirmDialog,
  correctKeysOf,
  discardButton,
  endAndSubmit,
  endExamButton,
  expectedResults,
  fetchBank,
  firstOfType,
  flagButton,
  goToQuestion,
  lettersOfRow,
  listRows,
  mentionsCount,
  mixed,
  navButton,
  newExamButton,
  nextButton,
  normalise,
  openStart,
  optionCards,
  optionInputs,
  pageHeading,
  planOf,
  playScenario,
  previousButton,
  questionById,
  questionHeading,
  readSaved,
  readStored,
  readTimerMs,
  resumeButton,
  reviewAnswersButton,
  scrollsHorizontally,
  seedSavedExam,
  seededSession,
  startButton,
  startExam,
  submitExamButton,
  submitFromReview,
  timerLocator,
  useTheme,
  waitForSaved,
  type Scenario,
} from './practice-support.ts';
import { DESKTOP_VIEWPORT, sidebarNav } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

async function bankAndPlan(request: APIRequestContext) {
  const bank = await fetchBank(request);
  return { bank, plan: planOf(bank) };
}

/** The visible text of the main area, whitespace normalised. */
async function mainText(page: Page): Promise<string> {
  return normalise(await page.getByRole('main').innerText());
}

function numberRegex(n: number): string {
  return `(?<!\\d)${String(n)}(?!\\d)`;
}

/* ====================================================================== AC-6: start screen */

test.describe('start screen', () => {
  test('AC-6: /practice/ is a Starlight page titled "Practice test" with the sidebar and no "On this page" panel', async ({
    page,
  }) => {
    const response = await page.goto(PRACTICE_PATH);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Practice test/);
    await expect(pageHeading(page)).toBeVisible();
    await expect(
      sidebarNav(page).getByRole('link', { name: 'Practice tests', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);
  });

  test('AC-6: the start screen shows the number of questions the bank allows', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);

    expect(mentionsCount(await mainText(page), 'questions', plan.size)).toBe(true);
  });

  test('AC-6: the start screen shows "2 minutes per question" and the limit as H:MM:SS or minutes', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    const text = await mainText(page);

    expect(text).toMatch(/2 minutes per question/i);
    const asClock = formatClock(plan.limitMs);
    const asMinutes = `${numberRegex(plan.size * 2)}\\s*(minutes|min)\\b`;
    expect(text.includes(asClock) || new RegExp(asMinutes, 'i').test(text)).toBe(true);
  });

  test('AC-6: the start screen shows the pass mark 720, the weighting and that the score is an estimate', async ({
    page,
  }) => {
    await openStart(page);
    const text = await mainText(page);

    expect(text).toMatch(new RegExp(numberRegex(720)));
    expect(text).toMatch(/estimate/i);
    for (const { weight } of domains) {
      expect(text, `weight ${String(weight)}`).toMatch(new RegExp(numberRegex(weight)));
    }
  });

  test('AC-6: the short-exam notice with "picked of quota" per domain shows exactly when the bank cannot fill 65', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    const text = await mainText(page);

    if (plan.complete) {
      expect(plan.size).toBe(65);
      expect(text).not.toMatch(/shorter/i);
      expect(text).not.toMatch(/\d+ of \d+/);
    } else {
      expect(plan.size).toBeLessThan(65);
      expect(text).toMatch(/shorter/i);
      for (const { id, picked, quota } of plan.byDomain) {
        expect(text, `domain ${String(id)}`).toMatch(
          new RegExp(`${numberRegex(picked)} of ${numberRegex(quota)}`),
        );
      }
    }
  });

  test('AC-6: a fresh start screen has no Resume, no "Last exam" and no storage warning', async ({
    page,
  }) => {
    await openStart(page);

    await expect(resumeButton(page)).toHaveCount(0);
    await expect(discardButton(page)).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText('Last exam');
    await expect(page.getByText(NOT_SAVED_TEXT)).toHaveCount(0);
  });
});

/* ====================================================================== AC-7: bank load failure */

test.describe('loading the bank', () => {
  test('AC-7: when bank.json fails the error and Retry show, and Retry after the route is restored shows the start screen', async ({
    page,
  }) => {
    await page.route('**/practice/bank.json', (route) => route.abort());
    await page.goto(PRACTICE_PATH);

    await expect(page.getByText('The questions could not be loaded.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(startButton(page)).toHaveCount(0);

    await page.unroute('**/practice/bank.json');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();

    await expect(startButton(page)).toBeVisible();
    await expect(page.getByText('The questions could not be loaded.')).toHaveCount(0);
  });

  test('AC-7: while bank.json is loading the page says "Loading questions…"', async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/practice/bank.json', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(PRACTICE_PATH);

    await expect(page.getByText('Loading questions…')).toBeVisible();
    await expect(startButton(page)).toHaveCount(0);

    release();
    await expect(startButton(page)).toBeVisible();
    await expect(page.getByText('Loading questions…')).toHaveCount(0);
  });
});

/* ====================================================================== AC-8: starting */

test.describe('starting an exam', () => {
  test('AC-8: Start exam shows "Question 1 of N" and the timer at the limit', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await expect(questionHeading(page, 1, plan.size)).toBeVisible();
    await expect(timerLocator(page)).toBeVisible();
    const left = await readTimerMs(page);
    expect(Math.abs(left - plan.limitMs)).toBeLessThanOrEqual(2_000);
  });

  test('AC-8: the exam screen has N navigator buttons and "0 of N answered"', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await expect(allNavButtons(page)).toHaveCount(plan.size);
    await expect(answeredText(page, 0, plan.size)).toBeVisible();
  });

  test('AC-8: the saved exam is an exam-mode session of N questions with a limit of N x 2 minutes', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);

    expect(saved.mode).toBe('exam');
    expect(saved.status).toBe('active');
    expect(saved.exam.items).toHaveLength(plan.size);
    expect(saved.deadline).toBe(saved.startedAt + plan.size * 120_000);
    expect(saved.current).toBe(0);
  });

  test('AC-8: each exam gets its own random 32-bit seed', async ({ baseURL, browser, request }) => {
    const { plan } = await bankAndPlan(request);
    const seeds: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = await browser.newContext({
        viewport: DESKTOP_VIEWPORT,
        ...(baseURL === undefined ? {} : { baseURL }),
      });
      const page = await context.newPage();
      await openStart(page);
      const saved = await startExam(page, plan);
      seeds.push(saved.exam.seed);
      await context.close();
    }

    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
    expect(seeds[0]).not.toBe(seeds[1]);
  });
});

/* ====================================================================== AC-9: options */

test.describe('question and options', () => {
  test('AC-9: every question shows its type label, the right kind of input and the options lettered by display position', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);

    // The orders really are shuffled (otherwise a letter by key would pass).
    expect(
      saved.exam.items.some(
        (item) => item.optionOrder.join('') !== [...item.optionOrder].sort().join(''),
      ),
    ).toBe(true);

    for (const [index, item] of saved.exam.items.entries()) {
      const question = questionById(bank, item.id);
      const correct = correctKeysOf(question);
      await expect(questionHeading(page, index + 1, plan.size)).toBeVisible();

      const label =
        question.type === 'single' ? 'Single answer' : `Choose ${String(correct.length)}`;
      await expect(page.getByRole('main').getByText(label, { exact: true }), item.id).toBeVisible();

      const other = question.type === 'single' ? 'multiple' : 'single';
      await expect(optionInputs(page, question.type), item.id).toHaveCount(question.options.length);
      await expect(optionInputs(page, other), item.id).toHaveCount(0);

      const cards = (await optionCards(page).allTextContents()).map((text) => normalise(text));
      expect(cards, item.id).toHaveLength(question.options.length);
      for (const [position, key] of item.optionOrder.entries()) {
        const card = cards[position] ?? '';
        const option = question.options.find((candidate) => candidate.key === key);
        expect(
          card.startsWith(String.fromCharCode(65 + position)),
          `${item.id} letter ${String(position)}`,
        ).toBe(true);
        expect(card, `${item.id} text at ${String(position)}`).toContain(
          normalise(option?.text ?? '<missing>'),
        );
      }

      if (index < plan.size - 1) await nextButton(page).click();
    }
  });

  test('AC-9: a single-answer question has one checked radio at a time', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'single');
    await goToQuestion(page, index + 1, plan.size);
    const radios = optionInputs(page, 'single');

    await optionCards(page).nth(0).click();
    await expect(radios.nth(0)).toBeChecked();
    await optionCards(page).nth(2).click();

    await expect(radios.nth(2)).toBeChecked();
    await expect(radios.nth(0)).not.toBeChecked();
    await expect(page.getByRole('main').getByRole('radio', { checked: true })).toHaveCount(1);
  });

  test('AC-9: a "Choose k" question lets several checkboxes be checked', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'multiple');
    await goToQuestion(page, index + 1, plan.size);

    await optionCards(page).nth(0).click();
    await optionCards(page).nth(1).click();

    await expect(optionInputs(page, 'multiple').nth(0)).toBeChecked();
    await expect(optionInputs(page, 'multiple').nth(1)).toBeChecked();
    await expect(page.getByRole('main').getByRole('checkbox', { checked: true })).toHaveCount(2);
  });
});

/* ====================================================================== AC-10: answering */

test.describe('answering', () => {
  test('AC-10: answering a single-answer question updates "x of N answered" and the navigator name', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'single');
    const n = index + 1;
    await goToQuestion(page, n, plan.size);
    await expect(navButton(page, n)).toHaveAccessibleName(
      `Question ${String(n)}, not answered, current`,
    );

    await optionCards(page).nth(0).click();

    await expect(answeredText(page, 1, plan.size)).toBeVisible();
    await expect(navButton(page, n)).toHaveAccessibleName(
      `Question ${String(n)}, answered, current`,
    );
  });

  test('AC-10: changing the answer of a single-answer question does not count it twice', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'single');
    await goToQuestion(page, index + 1, plan.size);

    await optionCards(page).nth(0).click();
    await optionCards(page).nth(1).click();

    await expect(answeredText(page, 1, plan.size)).toBeVisible();
  });

  test('AC-10: every change is saved: the stored answer follows the selection', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'single');
    const id = saved.exam.items[index]?.id ?? '';
    const secondKey = saved.exam.items[index]?.optionOrder[1] ?? '';
    await goToQuestion(page, index + 1, plan.size);

    await optionCards(page).nth(1).click();

    await expect.poll(async () => (await readSaved(page)).answers[id]).toEqual([secondKey]);
  });

  test('AC-10: an answer stays when you leave the question and come back', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await optionCards(page).nth(0).click();
    await nextButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await previousButton(page).click();

    await expect(questionHeading(page, 1, plan.size)).toBeVisible();
    await expect(optionCards(page).nth(0).locator('input')).toBeChecked();
    await expect(answeredText(page, 1, plan.size)).toBeVisible();
  });

  test('AC-10: clearing a checkbox selection makes the question "not answered" again', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'multiple');
    const n = index + 1;
    const need = correctKeysOf(questionById(bank, saved.exam.items[index]?.id ?? '')).length;
    await goToQuestion(page, n, plan.size);

    await optionCards(page).nth(0).click();
    await expect(page.getByRole('main').getByText(`1 of ${String(need)} selected`)).toBeVisible();
    await expect(navButton(page, n)).toHaveAccessibleName(
      `Question ${String(n)}, answered, current`,
    );
    await optionCards(page).nth(1).click();
    await expect(page.getByRole('main').getByText(`2 of ${String(need)} selected`)).toBeVisible();
    await optionCards(page).nth(0).click();
    await optionCards(page).nth(1).click();

    await expect(page.getByRole('main').getByText(`0 of ${String(need)} selected`)).toBeVisible();
    await expect(navButton(page, n)).toHaveAccessibleName(
      `Question ${String(n)}, not answered, current`,
    );
    await expect(answeredText(page, 0, plan.size)).toBeVisible();
    const id = saved.exam.items[index]?.id ?? '';
    await expect.poll(async () => Object.keys((await readSaved(page)).answers)).not.toContain(id);
  });
});

/* ====================================================================== AC-11: moving */

test.describe('moving between questions', () => {
  test('AC-11: Previous is disabled on question 1 and enabled after it', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await expect(previousButton(page)).toBeDisabled();
    await nextButton(page).click();

    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await expect(previousButton(page)).toBeEnabled();
  });

  test('AC-11: Next and Previous move by one and put focus on the "Question n of N" heading', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await nextButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeFocused();
    await nextButton(page).click();
    await expect(questionHeading(page, 3, plan.size)).toBeFocused();
    await previousButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeFocused();
  });

  test('AC-11: on question N the button reads "Review answers" and opens the review list', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await goToQuestion(page, plan.size, plan.size);

    await expect(nextButton(page)).toHaveCount(0);
    await expect(reviewAnswersButton(page)).toBeVisible();
    await reviewAnswersButton(page).click();

    await expect(submitExamButton(page)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: new RegExp(`^Question \\d+ of ${String(plan.size)}$`) }),
    ).toHaveCount(0);
  });

  test('AC-11: before question N the button is Next, not Review answers', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await expect(nextButton(page)).toBeVisible();
    await expect(reviewAnswersButton(page)).toHaveCount(0);
  });
});

/* ====================================================================== AC-12: flag */

test.describe('flag for review', () => {
  test('AC-12: Flag sets aria-pressed and the navigator name says "flagged"; pressing again clears it', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'false');
    await flagButton(page).click();

    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(navButton(page, 1)).toHaveAccessibleName(
      'Question 1, not answered, flagged, current',
    );

    await flagButton(page).click();

    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(navButton(page, 1)).toHaveAccessibleName('Question 1, not answered, current');
  });

  test('AC-12: the flag belongs to its question and survives moving away and back', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await flagButton(page).click();

    await nextButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(navButton(page, 1)).toHaveAccessibleName('Question 1, not answered, flagged');
    await previousButton(page).click();

    await expect(questionHeading(page, 1, plan.size)).toBeVisible();
    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('AC-12: an answered and flagged question is named "answered, flagged"', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await optionCards(page).nth(0).click();
    await flagButton(page).click();

    await expect(navButton(page, 1)).toHaveAccessibleName('Question 1, answered, flagged, current');
  });
});

/* ====================================================================== AC-13: navigator */

test.describe('navigator', () => {
  test('AC-13: activating navigator button n shows question n and marks it "current"', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const n = Math.min(7, plan.size);

    await navButton(page, n).click();

    await expect(questionHeading(page, n, plan.size)).toBeVisible();
    await expect(navButton(page, n)).toHaveAccessibleName(
      `Question ${String(n)}, not answered, current`,
    );
    await expect(navButton(page, 1)).toHaveAccessibleName('Question 1, not answered');
    await expect(page.getByRole('button', { name: /, current$/ })).toHaveCount(1);
  });

  test('AC-13: the last navigator button goes to question N', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await navButton(page, plan.size).click();

    await expect(questionHeading(page, plan.size, plan.size)).toBeVisible();
  });

  test('AC-13: End exam goes to the review list', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await endExamButton(page).click();

    await expect(submitExamButton(page)).toBeVisible();
  });

  test('AC-13: the legend names answered, not answered, flagged and current', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const legend = page.getByRole('list', { name: 'Legend' });

    await expect(legend).toContainText('Answered');
    await expect(legend).toContainText('Not answered');
    await expect(legend).toContainText('Flagged');
    await expect(legend).toContainText('Current');
  });
});

/* ====================================================================== AC-14: layout */

/** The buttons of the navigator that sit on the same row as button 1. */
async function firstRowCount(page: Page): Promise<number> {
  const boxes = await Promise.all(
    (await allNavButtons(page).all()).map((button) => button.boundingBox()),
  );
  const top = boxes[0]?.y ?? 0;
  return boxes.filter((box) => box !== null && Math.abs(box.y - top) < 3).length;
}

async function expectNoSidewaysScroll(page: Page, screen: string): Promise<void> {
  expect(await scrollsHorizontally(page), `${screen} scrolls sideways`).toBe(false);
}

/** Walks start, exam, review, results with a saved mixed exam and checks that no screen scrolls sideways. */
async function walkScreens(page: Page, request: APIRequestContext, phone: boolean) {
  const { bank, plan } = await bankAndPlan(request);
  await openStart(page);
  await expectNoSidewaysScroll(page, 'start screen');
  await seedSavedExam(page, seededSession(bank, mixed, { now: Date.now() }));
  await expect(resumeButton(page)).toBeVisible();
  await expectNoSidewaysScroll(page, 'start screen with a saved exam');
  await resumeButton(page).click();
  await expect(questionHeading(page, 1, plan.size)).toBeVisible();
  await expectNoSidewaysScroll(page, 'exam screen');
  if (phone) {
    await page.getByRole('button', { name: /^All questions/ }).click();
    await expectNoSidewaysScroll(page, 'exam screen with the navigator open');
  }
  await endExamButton(page).click();
  await expect(submitExamButton(page)).toBeVisible();
  await expectNoSidewaysScroll(page, 'review list');
  await submitExamButton(page).click();
  await expect(confirmDialog(page)).toBeVisible();
  await expectNoSidewaysScroll(page, 'confirmation dialog');
  await confirmDialog(page).getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(newExamButton(page)).toBeVisible();
  await expectNoSidewaysScroll(page, 'results screen');
}

test.describe('layout on a wide screen', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('AC-14: at 1440x900 the navigator is a side panel with 10 buttons in its first row', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);

    await expect(navButton(page, 1)).toBeVisible();
    expect(await firstRowCount(page)).toBe(Math.min(10, plan.size));
    const first = await navButton(page, 1).boundingBox();
    const eleventh = await navButton(page, 11).boundingBox();
    const card = await optionCards(page).first().boundingBox();
    expect(first).not.toBeNull();
    expect(eleventh).not.toBeNull();
    expect(card).not.toBeNull();
    // Rows of ten: the 11th button starts the second row.
    expect(eleventh?.y ?? 0).toBeGreaterThan((first?.y ?? 0) + 5);
    // Beside the question: to the right of the options and starting above their bottom edge.
    expect(first?.x ?? 0).toBeGreaterThan((card?.x ?? 0) + (card?.width ?? 0) - 1);
    expect(first?.y ?? 0).toBeLessThan((card?.y ?? 0) + (card?.height ?? 0));
  });

  test('AC-14: at 1440x900 no screen scrolls sideways', async ({ page, request }) => {
    test.setTimeout(90_000);
    await walkScreens(page, request, false);
  });
});

test.describe('layout on a phone', () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test('AC-14: at 390x844 the navigator is below the question, collapsed, and opens with 8 buttons in its first row', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const toggle = page.getByRole('button', { name: /^All questions/ });

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navButton(page, 1)).toBeHidden();

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(navButton(page, 1)).toBeVisible();
    expect(await firstRowCount(page)).toBe(Math.min(8, plan.size));
    const ninth = await navButton(page, 9).boundingBox();
    const first = await navButton(page, 1).boundingBox();
    expect(ninth?.y ?? 0).toBeGreaterThan((first?.y ?? 0) + 5);
    // Below the question: under the last option.
    const last = await optionCards(page).last().boundingBox();
    expect(first?.y ?? 0).toBeGreaterThanOrEqual((last?.y ?? 0) + (last?.height ?? 0) - 1);
  });

  test('AC-14: at 390x844 the navigator can be closed again', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const toggle = page.getByRole('button', { name: /^All questions/ });

    await toggle.click();
    await expect(navButton(page, 1)).toBeVisible();
    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(navButton(page, 1)).toBeHidden();
  });

  test('AC-14: at 390x844 no screen scrolls sideways', async ({ page, request }) => {
    test.setTimeout(90_000);
    await walkScreens(page, request, true);
  });
});

/* ====================================================================== AC-15: compact header */

/** Visually hidden: no box at all, or one so small that no text can be seen. */
async function isVisuallyHidden(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  return box === null || (box.width <= 2 && box.height <= 2);
}

test.describe('compact header', () => {
  test('AC-15: the page h1 is visible on the start screen', async ({ page }) => {
    await openStart(page);
    const h1 = page.getByRole('heading', { level: 1 });

    await expect(h1).toHaveCount(1);
    await expect(h1).toBeVisible();
    expect(await isVisuallyHidden(h1)).toBe(false);
  });

  test('AC-15: on the exam screen the h1 is visually hidden but stays in the accessibility tree', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const h1 = page.getByRole('heading', { level: 1, name: 'Practice test' });

    await expect(h1).toHaveCount(1);
    expect(await isVisuallyHidden(h1)).toBe(true);
  });

  test('AC-15: on the review list the h1 is visually hidden but stays in the accessibility tree', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await endExamButton(page).click();
    await expect(submitExamButton(page)).toBeVisible();
    const h1 = page.getByRole('heading', { level: 1, name: 'Practice test' });

    await expect(h1).toHaveCount(1);
    expect(await isVisuallyHidden(h1)).toBe(true);
  });

  test('AC-15: on the results screen the h1 is visible again', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await endAndSubmit(page);
    const h1 = page.getByRole('heading', { level: 1, name: 'Practice test' });

    await expect(h1).toHaveCount(1);
    await expect(h1).toBeVisible();
    expect(await isVisuallyHidden(h1)).toBe(false);
  });
});

/* ====================================================================== AC-16: review and submit */

test.describe('review list and submit', () => {
  test('AC-16: the review list shows the unanswered and flagged counts and a button per question', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await optionCards(page).nth(0).click();
    await nextButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await flagButton(page).click();
    await endExamButton(page).click();
    await expect(submitExamButton(page)).toBeVisible();
    const text = await mainText(page);

    expect(mentionsCount(text, 'unanswered', plan.size - 1)).toBe(true);
    expect(mentionsCount(text, 'flagged', 1)).toBe(true);
    // At least one button per question (the names are not fixed by the spec).
    expect(
      await page.getByRole('button', { name: /\bquestion \d+\b/i }).count(),
    ).toBeGreaterThanOrEqual(plan.size);
  });

  test('AC-16: a review row takes you back to its question', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await endExamButton(page).click();
    await expect(submitExamButton(page)).toBeVisible();
    const n = Math.min(5, plan.size);

    await page
      .getByRole('button', { name: new RegExp(`\\bquestion ${String(n)}\\b`, 'i') })
      .first()
      .click();

    await expect(questionHeading(page, n, plan.size)).toBeVisible();
    await expect(submitExamButton(page)).toHaveCount(0);
  });

  test('AC-16: Submit with unanswered questions opens the alertdialog; Cancel closes it and keeps the exam; Submit in the dialog shows the results', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await optionCards(page).nth(0).click();
    await nextButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await flagButton(page).click();
    await endExamButton(page).click();
    await submitExamButton(page).click();

    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      `You have ${String(plan.size - 1)} unanswered and 1 flagged questions. Submit anyway?`,
    );

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(submitExamButton(page)).toBeVisible();
    await expect(newExamButton(page)).toHaveCount(0);
    expect((await readSaved(page)).status).toBe('active');

    await submitExamButton(page).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click();

    await expect(newExamButton(page)).toBeVisible();
    await expect(confirmDialog(page)).toHaveCount(0);
  });

  test('AC-16: the dialog also opens when only questions are flagged ("0 unanswered and 1 flagged")', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    const flagOne: Scenario = (question, index) => ({
      keys: correctKeysOf(question),
      flag: index === 2,
    });
    await seedSavedExam(page, seededSession(bank, flagOne));
    await resumeButton(page).click();
    await endExamButton(page).click();

    await submitExamButton(page).click();

    await expect(confirmDialog(page)).toContainText(
      'You have 0 unanswered and 1 flagged questions. Submit anyway?',
    );
  });

  test('AC-16: the dialog also opens when only questions are unanswered ("1 unanswered and 0 flagged")', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    const skipOne: Scenario = (question, index) => ({
      keys: index === 2 ? [] : correctKeysOf(question),
      flag: false,
    });
    await seedSavedExam(page, seededSession(bank, skipOne));
    await resumeButton(page).click();
    await endExamButton(page).click();

    await submitExamButton(page).click();

    await expect(confirmDialog(page)).toContainText(
      'You have 1 unanswered and 0 flagged questions. Submit anyway?',
    );
  });

  test('AC-16: with every question answered and none flagged, Submit goes straight to the results', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    await seedSavedExam(page, seededSession(bank, allCorrect));
    await resumeButton(page).click();
    await endExamButton(page).click();

    await submitExamButton(page).click();

    await expect(newExamButton(page)).toBeVisible();
    await expect(confirmDialog(page)).toHaveCount(0);
  });

  test('AC-16: answering every question in the browser and submitting needs no confirmation', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await playScenario(page, bank, plan, allCorrect);

    await submitExamButton(page).click();

    await expect(newExamButton(page)).toBeVisible();
    await expect(confirmDialog(page)).toHaveCount(0);
  });
});

/* ====================================================================== AC-17 / AC-21: deadline */

const T0 = new Date('2026-11-02T09:00:00Z');

test.describe('time limit', () => {
  test('AC-17: after the time limit the results show without a click, with the "Time is up" text', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);

    // Ten seconds before the deadline the exam is still running.
    await page.clock.fastForward(plan.limitMs - 10_000);
    await expect(questionHeading(page, 1, plan.size)).toBeVisible();
    await expect.poll(() => readTimerMs(page)).toBeLessThanOrEqual(10_000);
    await expect(newExamButton(page)).toHaveCount(0);

    await page.clock.fastForward(11_000);

    await expect(newExamButton(page)).toBeVisible();
    await expect(page.getByText(TIME_UP_TEXT)).toBeVisible();
  });

  test('AC-17: a normal manual submit does not say "Time is up"', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await endAndSubmit(page);

    await expect(page.getByText(TIME_UP_TEXT)).toHaveCount(0);
  });

  test('AC-17: the timer counts down every second and shows H:MM:SS', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);
    await expect(timerLocator(page)).toHaveText(/^\d:\d{2}:\d{2}$/);

    await page.clock.runFor(5_000);

    await expect.poll(() => readTimerMs(page)).toBeLessThanOrEqual(plan.limitMs - 4_000);
    await expect.poll(() => readTimerMs(page)).toBeGreaterThanOrEqual(plan.limitMs - 7_000);
  });

  test('AC-21: reloading after the deadline passed while away shows the results with "Time is up"', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);
    await optionCards(page).nth(0).click();
    await waitForSaved(page);

    await page.clock.setSystemTime(new Date(T0.getTime() + plan.limitMs + 60_000));
    await page.reload();

    await expect(newExamButton(page)).toBeVisible();
    await expect(page.getByText(TIME_UP_TEXT)).toBeVisible();
    await expect(resumeButton(page)).toHaveCount(0);
    expect(await readStored(page, SESSION_KEY)).toBeNull();
  });

  test('AC-21: the deadline decides: reloading just before it still offers Resume', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);
    await waitForSaved(page);

    await page.clock.setSystemTime(new Date(T0.getTime() + plan.limitMs - 60_000));
    await page.reload();

    await expect(resumeButton(page)).toBeVisible();
    await expect(page.getByText(TIME_UP_TEXT)).toHaveCount(0);
  });
});

/* ====================================================================== AC-18: results */

/** Checks the numbers of the results screen against `resultsView` for the same exam. */
async function expectResultsScreen(page: Page, expected: ResultsView) {
  const text = await mainText(page);

  expect(text).toMatch(new RegExp(`${numberRegex(expected.estimated)}\\s*/\\s*1000`));
  expect(text).toMatch(expected.passed ? /\bPASS\b/ : /\bFAIL\b/);
  expect(text).not.toMatch(expected.passed ? /\bFAIL\b/ : /\bPASS\b/);
  expect(text).toMatch(/pass mark 720/);
  expect(text).toMatch(new RegExp(`${numberRegex(expected.percent)}\\s*%`));
  expect(text).toMatch(
    new RegExp(`${numberRegex(expected.correct)} of ${numberRegex(expected.total)}`),
  );
  expect(text).toMatch(
    new RegExp(`\\d+:\\d{2}:\\d{2}\\s*of\\s*${formatClock(expected.timeLimitMs)}`),
  );
  expect(mentionsCount(text, 'flagged', expected.flagged)).toBe(true);
  expect(mentionsCount(text, 'unanswered', expected.unanswered)).toBe(true);
  await expect(page.getByText(FOOTNOTE_TEXT)).toBeVisible();

  for (const row of expected.domains) {
    const element = listRows(page).filter({ hasText: row.title });
    await expect(element, row.title).toHaveCount(1);
    const rowText = normalise(await element.innerText());
    expect(rowText, row.title).toContain(`Domain ${String(row.id)}`);
    expect(rowText, row.title).toMatch(new RegExp(`${numberRegex(row.weight)}\\s*%`));
    expect(rowText, row.title).toContain(`${String(row.correct)} of ${String(row.total)} correct`);
    if (row.raw === null) expect(rowText, row.title).toContain('\u2014');
    else
      expect(rowText, row.title).toMatch(
        new RegExp(`${numberRegex(Math.round(row.raw * 100))}\\s*%`),
      );
    if (row.needsWork) expect(rowText, row.title).toContain('Needs work');
    else expect(rowText, row.title).not.toContain('Needs work');
  }
}

test.describe('results', () => {
  test('AC-18: a mix of right, wrong and skipped answers gives the score, verdict, percent, domain numbers and "Needs work" flags that resultsView computes', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const saved = await playScenario(page, bank, plan, mixed);
    const expected = expectedResults(saved, bank);
    // The scenario is a fail with weak domains, so the flags are really exercised.
    expect(expected.passed).toBe(false);
    expect(expected.domains.some((row) => row.needsWork)).toBe(true);

    await submitFromReview(page);

    await expectResultsScreen(page, expected);
  });

  test('AC-18: answering every question right gives 1000, PASS and no "Needs work"', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const saved = await playScenario(page, bank, plan, allCorrect);
    const expected = expectedResults(saved, bank);
    expect(expected.estimated).toBe(1000);

    await submitFromReview(page);

    await expectResultsScreen(page, expected);
    await expect(page.getByRole('main').getByText('Needs work')).toHaveCount(0);
  });

  test('AC-18: the footnote and the pass mark show on every result', async ({ page, request }) => {
    const { bank } = await bankAndPlan(request);
    await seedSavedExam(page, seededSession(bank, mixed));
    await resumeButton(page).click();
    await endAndSubmit(page);

    await expect(page.getByText(FOOTNOTE_TEXT)).toBeVisible();
    expect(await mainText(page)).toMatch(/pass mark 720/);
  });

  test('AC-18: a seeded exam shows the same numbers as resultsView', async ({ page, request }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    await expectResultsScreen(page, expectedResults(saveSession(session), bank));
  });
});

/* ====================================================================== AC-19: results filter */

test.describe('results question list', () => {
  test('AC-19: the filter shows All / Incorrect / Flagged with the right counts', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    const control = (name: string) =>
      page
        .getByRole('button', { name: new RegExp(`^${name}\\b`) })
        .or(page.getByRole('radio', { name: new RegExp(`^${name}\\b`) }))
        .or(page.getByRole('tab', { name: new RegExp(`^${name}\\b`) }));
    await expect(control('All')).toHaveAccessibleName(
      new RegExp(`^All\\D*${String(expected.counts.all)}\\D*$`),
    );
    await expect(control('Incorrect')).toHaveAccessibleName(
      new RegExp(`^Incorrect\\D*${String(expected.counts.incorrect)}\\D*$`),
    );
    await expect(control('Flagged')).toHaveAccessibleName(
      new RegExp(`^Flagged\\D*${String(expected.counts.flagged)}\\D*$`),
    );
  });

  test('AC-19: All lists every question with its status and domain and task', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    const rows = listRows(page).filter({ hasText: /\bQuestion \d+\b/ });
    await expect(rows).toHaveCount(expected.counts.all);
    const texts = (await rows.allInnerTexts()).map((text) => normalise(text));
    for (const [index, item] of expected.items.entries()) {
      const text = texts[index] ?? '';
      expect(text, `row ${String(item.number)}`).toMatch(
        new RegExp(`\\bQuestion ${String(item.number)}\\b`),
      );
      expect(text, `row ${String(item.number)}`).toContain(
        `Domain ${String(item.domain)} \u00b7 Task ${item.task}`,
      );
      if (item.status === 'correct') {
        expect(text, `row ${String(item.number)}`).not.toMatch(/Incorrect|Not answered/);
        expect(text, `row ${String(item.number)}`).toMatch(/\bCorrect\b/);
      } else if (item.status === 'incorrect') {
        expect(text, `row ${String(item.number)}`).toContain('Incorrect');
      } else {
        expect(text, `row ${String(item.number)}`).toContain('Not answered');
        expect(text, `row ${String(item.number)}`).not.toContain('Incorrect');
      }
    }
  });

  test('AC-19: Incorrect shows the wrong and the unanswered questions; wrong rows show both "Your answer" and "Correct" letters', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    await page.getByRole('button', { name: /^Incorrect\b/ }).click();

    const rows = listRows(page).filter({ hasText: /\bQuestion \d+\b/ });
    await expect(rows).toHaveCount(expected.counts.incorrect);
    const texts = (await rows.allInnerTexts()).map((text) => normalise(text));
    const shown = expected.items.filter((item) => item.status !== 'correct');
    expect(shown).toHaveLength(texts.length);
    for (const [index, item] of shown.entries()) {
      const text = texts[index] ?? '';
      expect(text, `row ${String(item.number)}`).toMatch(
        new RegExp(`\\bQuestion ${String(item.number)}\\b`),
      );
      if (item.status === 'incorrect') {
        const letters = lettersOfRow(text);
        expect(letters.yours, `your answer, question ${String(item.number)}`).toEqual(
          item.yourLetters,
        );
        expect(letters.correct, `correct answer, question ${String(item.number)}`).toEqual(
          item.correctLetters,
        );
      }
    }
  });

  test('AC-19: the letters are the ones of this attempt (display positions), not the option keys', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    const wrong = expected.items.filter((item) => item.status === 'incorrect');
    // Sanity of the fixture: for some wrong row the display letters differ from the keys.
    const differs = wrong.some((item) => {
      const entry = session.exam.items[item.number - 1];
      const correctKeys = entry?.question.options.filter((o) => o.correct).map((o) => o.key) ?? [];
      return correctKeys.join() !== item.correctLetters.join();
    });
    expect(differs).toBe(true);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);
    await page.getByRole('button', { name: /^Incorrect\b/ }).click();

    const first = wrong[0];
    expect(first).toBeDefined();
    const row = listRows(page).filter({
      hasText: new RegExp(`\\bQuestion ${String(first?.number ?? 0)}\\b`),
    });
    await expect(row).toHaveCount(1);
    expect(lettersOfRow(await row.innerText()).correct).toEqual(first?.correctLetters);
  });

  test('AC-19: Flagged shows exactly the flagged questions', async ({ page, request }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    await page.getByRole('button', { name: /^Flagged\b/ }).click();

    const rows = listRows(page).filter({ hasText: /\bQuestion \d+\b/ });
    await expect(rows).toHaveCount(expected.counts.flagged);
    const texts = (await rows.allInnerTexts()).map((text) => normalise(text));
    const flagged = expected.items.filter((item) => item.flagged);
    for (const [index, item] of flagged.entries()) {
      expect(texts[index] ?? '', `row ${String(item.number)}`).toMatch(
        new RegExp(`\\bQuestion ${String(item.number)}\\b`),
      );
    }
  });

  test('AC-19: going back to All lists every question again', async ({ page, request }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    await page.getByRole('button', { name: /^Flagged\b/ }).click();
    await page.getByRole('button', { name: /^All\b/ }).click();

    await expect(listRows(page).filter({ hasText: /\bQuestion \d+\b/ })).toHaveCount(
      expected.counts.all,
    );
  });
});

/* ====================================================================== AC-20: resume */

test.describe('saved exam', () => {
  test('AC-20: reloading mid-exam offers Resume with the right question number and the time left', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    await startExam(page, plan);
    await goToQuestion(page, Math.min(3, plan.size), plan.size);
    await expect.poll(async () => (await readSaved(page)).current).toBe(Math.min(3, plan.size) - 1);

    await page.reload();

    await expect(resumeButton(page)).toBeVisible();
    await expect(discardButton(page)).toBeVisible();
    const text = await mainText(page);
    expect(text).toContain(`Question ${String(Math.min(3, plan.size))} of ${String(plan.size)}`);
    expect(text).toMatch(/\d+:\d{2}:\d{2}[^.]*left|left[^.]*\d+:\d{2}:\d{2}/);
  });

  test('AC-20: Resume returns to that question with the answers and flags kept and the timer still counting from the original start', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await page.clock.install({ time: T0 });
    await openStart(page);
    const saved = await startExam(page, plan);
    // Answer question 1 (whatever its type), then flag question 3 and stay there.
    await choose(page, saved, 0, [saved.exam.items[0]?.optionOrder[0] ?? 'A']);
    const here = Math.min(3, plan.size);
    await goToQuestion(page, here, plan.size);
    await flagButton(page).click();
    await expect.poll(async () => (await readSaved(page)).flagged.length).toBe(1);

    // Ten minutes pass while the page is closed.
    await page.clock.setSystemTime(new Date(T0.getTime() + 600_000));
    await page.reload();
    await resumeButton(page).click();

    await expect(questionHeading(page, here, plan.size)).toBeVisible();
    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(answeredText(page, 1, plan.size)).toBeVisible();
    await expect(navButton(page, 1)).toHaveAccessibleName('Question 1, answered');
    await expect(navButton(page, here)).toHaveAccessibleName(
      `Question ${String(here)}, not answered, flagged, current`,
    );
    const left = await readTimerMs(page);
    expect(left).toBeLessThanOrEqual(plan.limitMs - 600_000 + 1_000);
    expect(left).toBeGreaterThanOrEqual(plan.limitMs - 600_000 - 5_000);
  });

  test('AC-20: Discard removes the saved exam', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await page.reload();

    await discardButton(page).click();

    await expect(resumeButton(page)).toHaveCount(0);
    await expect(startButton(page)).toBeVisible();
    expect(await readStored(page, SESSION_KEY)).toBeNull();
    await page.reload();
    await expect(startButton(page)).toBeVisible();
    await expect(resumeButton(page)).toHaveCount(0);
  });

  test('AC-20: a saved exam whose question ids are not in the bank shows "could not be restored" and is removed', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const broken = {
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
    await page.evaluate(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string);
      },
      [SESSION_KEY, JSON.stringify(broken)],
    );

    await page.reload();

    await expect(page.getByText(NOT_RESTORED_TEXT)).toBeVisible();
    await expect(resumeButton(page)).toHaveCount(0);
    await expect(startButton(page)).toBeVisible();
    expect(await readStored(page, SESSION_KEY)).toBeNull();
  });

  test('AC-20: the "could not be restored" text shows only once', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await page.evaluate((key) => {
      window.localStorage.setItem(key, '{"not":"a saved exam"}');
    }, SESSION_KEY);
    await page.reload();
    // Invalid data gets the generic text (AC-33), not the "questions changed" one.
    await expect(page.getByText('Your saved exam could not be restored.')).toBeVisible();

    await page.reload();

    await expect(startButton(page)).toBeVisible();
    await expect(page.getByText('Your saved exam could not be restored')).toHaveCount(0);
  });
});

/* ====================================================================== AC-22: last exam */

test.describe('after submitting', () => {
  const scenarios: [string, Scenario][] = [
    ['all right', allCorrect],
    ['a mix of answers', mixed],
  ];

  for (const [name, scenario] of scenarios) {
    test(`AC-22: after submitting (${name}) a reload shows "Last exam: <score> (PASS|FAIL)" and no Resume`, async ({
      page,
      request,
    }) => {
      const { bank } = await bankAndPlan(request);
      const session = seededSession(bank, scenario);
      const expected = expectedResults(saveSession(session), bank);
      await seedSavedExam(page, session);
      await resumeButton(page).click();
      await endAndSubmit(page);
      const last = new RegExp(
        `Last exam: ${String(expected.estimated)} \\(${expected.passed ? 'PASS' : 'FAIL'}\\)`,
      );

      await newExamButton(page).click();
      await expect(startButton(page)).toBeVisible();
      await expect(page.getByRole('main')).toContainText(last);
      await page.reload();

      await expect(startButton(page)).toBeVisible();
      await expect(page.getByRole('main')).toContainText(last);
      await expect(resumeButton(page)).toHaveCount(0);
      expect(await readStored(page, SESSION_KEY)).toBeNull();
    });
  }

  test('AC-22: the attempt is recorded in the progress record', async ({ page, request }) => {
    const { bank } = await bankAndPlan(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);

    await expect.poll(() => readStored(page, PROGRESS_KEY)).not.toBeNull();
    const progress = JSON.parse((await readStored(page, PROGRESS_KEY)) ?? '{}') as {
      attempts: { estimated: number; mode: string; submitReason: string }[];
    };
    expect(progress.attempts).toHaveLength(1);
    expect(progress.attempts[0]?.estimated).toBe(expected.estimated);
    expect(progress.attempts[0]?.mode).toBe('exam');
    expect(progress.attempts[0]?.submitReason).toBe('manual');
  });

  test('AC-22: Start a new exam returns to the start screen with a fresh exam possible', async ({
    page,
    request,
  }) => {
    const { bank } = await bankAndPlan(request);
    await seedSavedExam(page, seededSession(bank, allCorrect));
    await resumeButton(page).click();
    await endAndSubmit(page);

    await newExamButton(page).click();

    await expect(startButton(page)).toBeVisible();
    await expect(newExamButton(page)).toHaveCount(0);
    await expect(resumeButton(page)).toHaveCount(0);
  });
});

/* ====================================================================== AC-23: storage that throws */

test.describe('storage that throws', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
        Storage.prototype[method] = () => {
          throw new DOMException('Storage is blocked', 'SecurityError');
        };
      }
    });
  });

  test('AC-23: the start screen says "Progress can\'t be saved in this browser."', async ({
    page,
  }) => {
    await openStart(page);

    await expect(page.getByText(NOT_SAVED_TEXT)).toBeVisible();
    await expect(resumeButton(page)).toHaveCount(0);
  });

  test('AC-23: the exam works end to end without saving', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);

    await startButton(page).click();
    await expect(questionHeading(page, 1, plan.size)).toBeVisible();
    await optionCards(page).nth(0).click();
    await expect(answeredText(page, 1, plan.size)).toBeVisible();
    await flagButton(page).click();
    await expect(flagButton(page)).toHaveAttribute('aria-pressed', 'true');
    await nextButton(page).click();
    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await endExamButton(page).click();
    await expect(submitExamButton(page)).toBeVisible();
    await submitExamButton(page).click();
    await confirmDialog(page).getByRole('button', { name: 'Submit', exact: true }).click();

    await expect(newExamButton(page)).toBeVisible();
    await expect(page.getByText(FOOTNOTE_TEXT)).toBeVisible();
    await newExamButton(page).click();
    await expect(startButton(page)).toBeVisible();
    await expect(page.getByText(NOT_SAVED_TEXT)).toBeVisible();
  });

  test('AC-23: a reload starts again from the start screen (nothing was saved)', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startButton(page).click();
    await expect(questionHeading(page, 1, plan.size)).toBeVisible();

    await page.reload();

    await expect(startButton(page)).toBeVisible();
    await expect(resumeButton(page)).toHaveCount(0);
  });
});

/* ====================================================================== AC-24: accessibility */

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function violations(page: Page) {
  await page.waitForLoadState('load');
  const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
    });

    test(`AC-24: axe finds no violations on the start screen (${theme})`, async ({ page }) => {
      await openStart(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      expect(await violations(page)).toEqual([]);
    });

    test(`AC-24: axe finds no violations on the start screen with a saved exam (${theme})`, async ({
      page,
      request,
    }) => {
      const { bank } = await bankAndPlan(request);
      await seedSavedExam(page, seededSession(bank, mixed));
      await expect(resumeButton(page)).toBeVisible();

      expect(await violations(page)).toEqual([]);
    });

    test(`AC-24: axe finds no violations on the exam screen (${theme})`, async ({
      page,
      request,
    }) => {
      const { bank, plan } = await bankAndPlan(request);
      await seedSavedExam(page, seededSession(bank, mixed, { now: Date.now(), current: 1 }));
      await resumeButton(page).click();
      await expect(questionHeading(page, 2, plan.size)).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      expect(await violations(page)).toEqual([]);
    });

    test(`AC-24: axe finds no violations on a multiple-answer question (${theme})`, async ({
      page,
      request,
    }) => {
      const { bank, plan } = await bankAndPlan(request);
      const session = seededSession(bank, mixed);
      const index = session.exam.items.findIndex((item) => item.question.type === 'multiple');
      expect(index, 'the seeded exam has a multiple-answer question').toBeGreaterThanOrEqual(0);
      await seedSavedExam(page, seededSession(bank, mixed, { now: Date.now(), current: index }));
      await resumeButton(page).click();
      await expect(questionHeading(page, index + 1, plan.size)).toBeVisible();
      await optionCards(page).nth(0).click();

      expect(await violations(page)).toEqual([]);
    });

    test(`AC-24: axe finds no violations on the review list and its confirmation (${theme})`, async ({
      page,
      request,
    }) => {
      const { bank } = await bankAndPlan(request);
      await seedSavedExam(page, seededSession(bank, mixed));
      await resumeButton(page).click();
      await endExamButton(page).click();
      await expect(submitExamButton(page)).toBeVisible();

      expect(await violations(page)).toEqual([]);

      await submitExamButton(page).click();
      await expect(confirmDialog(page)).toBeVisible();

      expect(await violations(page)).toEqual([]);
    });

    test(`AC-24: axe finds no violations on the results screen (${theme})`, async ({
      page,
      request,
    }) => {
      const { bank } = await bankAndPlan(request);
      await seedSavedExam(page, seededSession(bank, mixed));
      await resumeButton(page).click();
      await endAndSubmit(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      expect(await violations(page)).toEqual([]);

      await page.getByRole('button', { name: /^Incorrect\b/ }).click();

      expect(await violations(page)).toEqual([]);
    });
  });
}

/* ====================================================================== AC-25: keyboard */

/** Presses Tab until the focus is on a radio or checkbox (at most `limit` times); returns the presses used. */
async function tabToOption(page: Page, limit = 80): Promise<number> {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab');
    const onOption = await page.evaluate(() => {
      const element = document.activeElement;
      return (
        element instanceof HTMLInputElement &&
        (element.type === 'radio' || element.type === 'checkbox')
      );
    });
    if (onOption) return presses;
  }
  return -1;
}

/** The outline of the card (label) around the focused input, e.g. "solid 2px". */
async function focusedCardOutline(page: Page): Promise<string> {
  return page.evaluate(() => {
    const card = document.activeElement?.closest('label');
    if (!card) return 'no card';
    const style = window.getComputedStyle(card);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
}

/** The outline of option card `position`, e.g. "none 0px" when it has none. */
async function cardOutline(page: Page, position: number): Promise<string> {
  return optionCards(page)
    .nth(position)
    .evaluate((card) => {
      const style = window.getComputedStyle(card);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
}

function isVisibleOutline(outline: string): boolean {
  return !outline.startsWith('none') && !/^S+ 0(px)?$/.test(outline) && outline !== 'no card';
}

test.describe('keyboard', () => {
  test('AC-25: Tab reaches the radios of a single-answer question, Space selects and the arrow keys move the selection', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'single');
    const n = index + 1;
    // Enter on a navigator button moves (AC-25), and puts us on the question to test.
    await navButton(page, n).focus();
    await page.keyboard.press('Enter');
    await expect(questionHeading(page, n, plan.size)).toBeVisible();
    await questionHeading(page, n, plan.size).focus();

    expect(await tabToOption(page)).toBeGreaterThan(0);
    const radios = optionInputs(page, 'single');
    await expect(radios.nth(0)).toBeFocused();
    expect(isVisibleOutline(await focusedCardOutline(page))).toBe(true);
    expect(isVisibleOutline(await cardOutline(page, 1))).toBe(false);

    await page.keyboard.press('Space');
    await expect(radios.nth(0)).toBeChecked();
    await expect(answeredText(page, 1, plan.size)).toBeVisible();

    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(1)).toBeChecked();
    await expect(radios.nth(0)).not.toBeChecked();
    await expect(radios.nth(1)).toBeFocused();
    expect(isVisibleOutline(await focusedCardOutline(page))).toBe(true);
    await expect(answeredText(page, 1, plan.size)).toBeVisible();
  });

  test('AC-25: Tab reaches the checkboxes of a "Choose k" question and Space toggles each one', async ({
    page,
    request,
  }) => {
    const { bank, plan } = await bankAndPlan(request);
    await openStart(page);
    const saved = await startExam(page, plan);
    const index = firstOfType(saved, bank, 'multiple');
    const n = index + 1;
    await navButton(page, n).focus();
    await page.keyboard.press('Enter');
    await expect(questionHeading(page, n, plan.size)).toBeVisible();
    await questionHeading(page, n, plan.size).focus();

    expect(await tabToOption(page)).toBeGreaterThan(0);
    const boxes = optionInputs(page, 'multiple');
    await expect(boxes.nth(0)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(boxes.nth(0)).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(boxes.nth(1)).toBeFocused();
    await page.keyboard.press('Space');

    await expect(boxes.nth(1)).toBeChecked();
    await expect(page.getByRole('main').getByRole('checkbox', { checked: true })).toHaveCount(2);

    await page.keyboard.press('Space');
    await expect(boxes.nth(1)).not.toBeChecked();
    await expect(boxes.nth(0)).toBeChecked();
  });

  test('AC-25: the focused option card shows a focus ring that unfocused cards do not have', async ({
    page,
    request,
  }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    await questionHeading(page, 1, plan.size).focus();

    expect(await tabToOption(page)).toBeGreaterThan(0);

    expect(isVisibleOutline(await focusedCardOutline(page))).toBe(true);
    const last = (await optionCards(page).count()) - 1;
    expect(isVisibleOutline(await cardOutline(page, last))).toBe(false);
  });

  test('AC-25: Enter on a navigator button moves to that question', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);
    await startExam(page, plan);
    const n = Math.min(4, plan.size);

    await navButton(page, n).focus();
    await page.keyboard.press('Enter');

    await expect(questionHeading(page, n, plan.size)).toBeVisible();
    await expect(navButton(page, n)).toHaveAccessibleName(
      `Question ${String(n)}, not answered, current`,
    );
  });

  test('AC-25: Start exam and Next work with Enter', async ({ page, request }) => {
    const { plan } = await bankAndPlan(request);
    await openStart(page);

    await startButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(questionHeading(page, 1, plan.size)).toBeVisible();
    await nextButton(page).focus();
    await page.keyboard.press('Enter');

    await expect(questionHeading(page, 2, plan.size)).toBeVisible();
    await expect(questionHeading(page, 2, plan.size)).toBeFocused();
  });
});
