// Spec 028, review round 1: regression tests for AC-27 to AC-38.
// Expected values come from the bank, the stored progress and the seeded attempts, as in the other
// spec 028 files; locators stay inside `main` or the practice island (`#practice-host`).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { emptyProgress } from '../../packages/quiz-core/src/index.ts';
import type { Progress, Question } from '../../packages/schema/src/index.ts';
import {
  correctKeysOf,
  fetchBank,
  mixed,
  normalise,
  pageHeading,
  questionHeading,
  readStored,
  PROGRESS_KEY,
  resumeButton,
  seedSavedExam,
  seededSession,
  wrongKeysOf,
} from './practice-support.ts';
import {
  DAY_MS,
  DOMAIN_2_SET,
  answerAndCheck,
  backToResultsButton,
  buildProgress,
  checkAnswerButton,
  domainWithType,
  endPracticeButton,
  feedbackHeading,
  explanationList,
  filterButton,
  localDate,
  manyAttempts,
  newPracticeSetButton,
  nextOfType,
  nextPlainButton,
  nextQuestionButton,
  openExamResults,
  openStartScreen,
  practiceByRadio,
  previousPlainButton,
  readProgress,
  reviewButton,
  routeBank,
  seedProgress,
  showAnswerOnly,
  shownQuestion,
  startPractice,
  startPracticeButton,
  viewProgressButton,
  waitForAttempts,
  withLinks,
  type Shown,
} from './practice-modes-support.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

/** Visually hidden: no box at all, or one so small that no text can be seen. */
async function isVisuallyHidden(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  return box === null || (box.width <= 2 && box.height <= 2);
}

/* ====================================================================== AC-27: no key in the DOM */

interface MainDom {
  text: string;
  html: string;
  values: string[];
}

/** The whole `main` DOM, hidden nodes and attributes included, and the values of its option inputs. */
async function mainDom(page: Page): Promise<MainDom> {
  return page.getByRole('main').evaluate((main) => ({
    text: (main.textContent ?? '').replace(/\s+/g, ' ').trim(),
    html: main.outerHTML,
    values: Array.from(main.querySelectorAll('input[type="radio"], input[type="checkbox"]')).map(
      (input) => (input as HTMLInputElement).value,
    ),
  }));
}

function expectNoKeyInDom(dom: MainDom, bank: readonly Question[]): void {
  for (const question of bank) {
    for (const option of question.options) {
      expect(dom.text.includes(normalise(option.why)), `why of ${question.id} ${option.key}`).toBe(
        false,
      );
    }
  }
  expect(dom.text).not.toContain('Correct answer');
  expect(dom.html).not.toContain('data-correct');
}

function expectLetterValues(dom: MainDom, optionCount: number): void {
  const letters = Array.from({ length: optionCount }, (_, index) =>
    String.fromCharCode(65 + index),
  );
  expect(dom.values).toEqual(letters);
}

/** Whether the options are shown in another order than the bank's (so a key is not its letter). */
function isShuffled(order: readonly string[]): boolean {
  return order.join('') !== [...order].sort().join('');
}

/**
 * From a practice question, presses Next until one is shown whose option order is shuffled (and of
 * `type`, when given): only then does an input value that is the key differ from the letter.
 */
async function nextShuffled(
  page: Page,
  bank: readonly Question[],
  total: number,
  type?: Question['type'],
): Promise<Shown> {
  for (let n = 1; n <= total; n += 1) {
    const shown = await shownQuestion(page, bank);
    if (isShuffled(shown.order) && (type === undefined || shown.question.type === type)) {
      return shown;
    }
    if (n < total) {
      await nextPlainButton(page).click();
      await expect(questionHeading(page, n + 1, total)).toBeVisible();
    }
  }
  throw new Error('no question with shuffled options in the set');
}

test.describe('no answer key in the page before the answer is shown', () => {
  test('AC-27: the practice screen has no why, "Correct answer" or data-correct, and each input value is its letter', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, { ...DOMAIN_2_SET, size: 'all' });
    const shown = await nextShuffled(page, bank, set.total);

    const dom = await mainDom(page);

    expectNoKeyInDom(dom, bank);
    expectLetterValues(dom, shown.question.options.length);
  });

  test('AC-27: the same holds for a "Choose k" practice question', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, {
      by: 'Domain',
      value: domainWithType(bank, 'multiple'),
      size: 'all',
    });
    const shown = await nextShuffled(page, bank, set.total, 'multiple');

    const dom = await mainDom(page);

    expectNoKeyInDom(dom, bank);
    expectLetterValues(dom, shown.question.options.length);
  });

  test('AC-27: selecting an option changes nothing about the values in the page', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, { ...DOMAIN_2_SET, size: 'all' });
    const shown = await nextShuffled(page, bank, set.total);

    await page.getByRole('main').locator('label').first().click();

    const dom = await mainDom(page);
    expectNoKeyInDom(dom, bank);
    expectLetterValues(dom, shown.question.options.length);
  });

  test('AC-27: the exam screen has no why, "Correct answer" or data-correct', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, mixed);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await expect(questionHeading(page, 1, session.exam.items.length)).toBeVisible();

    expectNoKeyInDom(await mainDom(page), bank);
  });

  test('AC-27: on the exam screen each input value is the letter shown, not the key, when the options are shuffled', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, mixed);
    const index = session.exam.items.findIndex((item) => isShuffled(item.optionOrder));
    expect(index, 'the seeded exam has a shuffled question').toBeGreaterThanOrEqual(0);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    const total = session.exam.items.length;
    for (let n = 0; n < index; n += 1) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await expect(questionHeading(page, index + 1, total)).toBeVisible();

    const dom = await mainDom(page);

    expectLetterValues(dom, session.exam.items[index]?.question.options.length ?? 0);
  });
});

/* ====================================================================== AC-28: Back to results focus */

test.describe('Back to results from a hidden question', () => {
  test('AC-28: with the Incorrect filter on, Back to results from a question the filter hides focuses the "Questions" heading', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const { expected } = await openExamResults(page, bank, mixed);
    const index = expected.items.findIndex(
      (item, at) => item.status !== 'correct' && expected.items[at + 1]?.status === 'correct',
    );
    expect(index, 'an incorrect question followed by a correct one').toBeGreaterThanOrEqual(0);
    await filterButton(page, 'Incorrect').click();
    await reviewButton(page, index + 1).click();
    await nextQuestionButton(page).click();
    await expect(questionHeading(page, index + 2, expected.total)).toBeVisible();

    await backToResultsButton(page).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Questions', exact: true }),
    ).toBeFocused();
    await expect(reviewButton(page, index + 2)).toHaveCount(0);
    await expect(reviewButton(page, index + 1)).toBeVisible();
  });
});

/* ====================================================================== AC-29: checked counter */

test.describe('the "checked" counter', () => {
  test('AC-29: it reads "1 of N checked" after the first Check answer and "2 of N checked" after the second', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const checked = (n: number) =>
      page.getByRole('main').getByText(`${String(n)} of ${String(set.total)} checked`, {
        exact: true,
      });
    await expect(checked(0)).toBeVisible();
    const first = await shownQuestion(page, bank);

    await answerAndCheck(page, first, wrongKeysOf(first.question));

    await expect(checked(1)).toBeVisible();
    await nextPlainButton(page).click();
    await expect(questionHeading(page, 2, set.total)).toBeVisible();
    await expect(checked(1)).toBeVisible();
    await showAnswerOnly(page);
    await expect(checked(2)).toBeVisible();
  });
});

/* ====================================================================== AC-30: back to a revealed question */

test.describe('going back to a revealed question', () => {
  test('AC-30: Previous shows the feedback and the "Answer options" list with no inputs, and focus is on the question heading', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const first = await shownQuestion(page, bank);
    await answerAndCheck(page, first, wrongKeysOf(first.question));
    await nextPlainButton(page).click();
    await expect(questionHeading(page, 2, set.total)).toBeFocused();

    await previousPlainButton(page).click();

    await expect(questionHeading(page, 1, set.total)).toBeFocused();
    await expect(feedbackHeading(page, 'Incorrect')).toBeVisible();
    await expect(feedbackHeading(page, 'Incorrect')).not.toBeFocused();
    await expect(explanationList(page)).toBeVisible();
    await expect(page.getByRole('main').getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(0);
    await expect(checkAnswerButton(page)).toHaveCount(0);
  });

  test('AC-30: a question revealed with no answer shows its feedback after going back too', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    await showAnswerOnly(page);
    await nextPlainButton(page).click();
    await expect(questionHeading(page, 2, set.total)).toBeVisible();

    await previousPlainButton(page).click();

    await expect(questionHeading(page, 1, set.total)).toBeFocused();
    await expect(feedbackHeading(page, 'Not answered: this counts as a miss.')).toBeVisible();
    await expect(explanationList(page)).toBeVisible();
  });
});

/* ====================================================================== AC-31: several due */

test.describe('weak spots with several questions due', () => {
  test('AC-31: with three questions due, Weak spots reads "3 questions are due for another try."', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    for (let n = 1; n <= 3; n += 1) {
      const shown = await shownQuestion(page, bank);
      await answerAndCheck(page, shown, wrongKeysOf(shown.question));
      if (n < 3) await nextPlainButton(page).click();
    }
    await endPracticeButton(page).click();
    await waitForAttempts(page, 1);

    await newPracticeSetButton(page).click();
    await practiceByRadio(page, 'Weak spots').check();

    await expect(
      page.getByText('3 questions are due for another try.', { exact: true }),
    ).toBeVisible();
    await expect(startPracticeButton(page)).toBeEnabled();
  });

  test('AC-31: with two questions due, the text is plural too', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const first = await shownQuestion(page, bank);
    await answerAndCheck(page, first, wrongKeysOf(first.question));
    await nextPlainButton(page).click();
    await showAnswerOnly(page);
    await endPracticeButton(page).click();
    await waitForAttempts(page, 1);

    await newPracticeSetButton(page).click();
    await practiceByRadio(page, 'Weak spots').check();

    await expect(
      page.getByText('2 questions are due for another try.', { exact: true }),
    ).toBeVisible();
  });
});

/* ====================================================================== AC-32: select then clear */

test.describe('selecting and clearing', () => {
  test('AC-32: selecting and then clearing the only selection, then End practice, adds no attempt', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, {
      by: 'Domain',
      value: domainWithType(bank, 'multiple'),
      size: 'all',
    });
    await nextOfType(page, bank, 'multiple', set.total);
    const card = page.getByRole('main').locator('label').first();
    await card.click();
    await expect(checkAnswerButton(page)).toBeVisible();
    await card.click();
    await expect(checkAnswerButton(page)).toHaveCount(0);

    await endPracticeButton(page).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice results', exact: true }),
    ).toBeVisible();
    await newPracticeSetButton(page).click();
    await page.reload();
    await expect(startPracticeButton(page)).toBeVisible();
    expect((await readProgress(page))?.attempts ?? []).toEqual([]);
    expect(await readStored(page, PROGRESS_KEY)).toBeNull();
  });
});

/* ====================================================================== AC-33 and AC-38: the score chart */

/** A progress view with four mock exams (scores alternate between 1000 and 100). */
async function progressViewWithExams(
  page: Page,
  request: Parameters<typeof fetchBank>[0],
  count: number,
): Promise<Progress> {
  const bank = await fetchBank(request);
  const progress = buildProgress(
    bank,
    manyAttempts(count, () => 'exam'),
  );
  await seedProgress(page, progress);
  await viewProgressButton(page).click();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Mock exam scores', exact: true }),
  ).toBeVisible();
  return progress;
}

function chart(page: Page): Locator {
  return page
    .getByRole('main')
    .locator('svg[aria-hidden="true"]')
    .filter({ has: page.locator('[data-score]') });
}

test.describe('the score chart geometry', () => {
  test('AC-33: the marks go left to right, oldest first, and a higher score is higher up', async ({
    page,
    request,
  }) => {
    await progressViewWithExams(page, request, 4);

    const marks = await chart(page)
      .locator('[data-score]')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          score: Number(element.getAttribute('data-score')),
          cx: Number(element.getAttribute('cx')),
          cy: Number(element.getAttribute('cy')),
        })),
      );

    expect(marks).toHaveLength(4);
    for (const mark of marks) {
      expect(Number.isFinite(mark.cx), 'cx').toBe(true);
      expect(Number.isFinite(mark.cy), 'cy').toBe(true);
    }
    for (let index = 1; index < marks.length; index += 1) {
      expect(marks[index]?.cx ?? 0).toBeGreaterThan(marks[index - 1]?.cx ?? 0);
    }
    for (const a of marks) {
      for (const b of marks) {
        if (a.score > b.score) expect(a.cy).toBeLessThan(b.cy);
      }
    }
  });

  test('AC-33: a line sits at 720, between the 100 and 1000 positions of the scale', async ({
    page,
    request,
  }) => {
    await progressViewWithExams(page, request, 4);

    const result = await chart(page).evaluate((svg) => {
      const marks = Array.from(svg.querySelectorAll('[data-score]')).map((element) => ({
        score: Number(element.getAttribute('data-score')),
        cy: Number(element.getAttribute('cy')),
      }));
      const lines = Array.from(svg.querySelectorAll('line'))
        .map((line) => ({
          y1: Number(line.getAttribute('y1')),
          y2: Number(line.getAttribute('y2')),
        }))
        .filter((line) => Math.abs(line.y1 - line.y2) < 0.01);
      return { marks, lines };
    });

    const high = result.marks.find((mark) => mark.score === 1000);
    const low = result.marks.find((mark) => mark.score === 100);
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    // The scale is linear: y at 720 follows from the marks at 100 and 1000.
    const y720 = (low?.cy ?? 0) + ((720 - 100) / 900) * ((high?.cy ?? 0) - (low?.cy ?? 0));
    expect(
      result.lines.some((line) => Math.abs(line.y1 - y720) <= 1),
      `a horizontal line at y=${String(y720)} (lines: ${JSON.stringify(result.lines)})`,
    ).toBe(true);
  });
});

test.describe('the hidden list of scores', () => {
  test('AC-38: a list named "Mock exam scores" holds one "<date>: <score> (PASS|FAIL)" item per charted attempt, oldest first', async ({
    page,
    request,
  }) => {
    const progress = await progressViewWithExams(page, request, 5);
    const exams = progress.attempts.filter((attempt) => attempt.mode === 'exam');
    const expected = await Promise.all(
      exams.map(
        async (attempt) =>
          `${await localDate(page, attempt.submittedAt)}: ${String(attempt.estimated)} (${attempt.estimated >= 720 ? 'PASS' : 'FAIL'})`,
      ),
    );

    const list = page
      .getByRole('main')
      .getByRole('list', { name: 'Mock exam scores', exact: true });

    await expect(list.getByRole('listitem')).toHaveCount(expected.length);
    const texts = (await list.getByRole('listitem').allTextContents()).map((text) =>
      normalise(text),
    );
    expect(texts).toEqual(expected);
  });

  test('AC-38: the list is visually hidden while the chart stays aria-hidden', async ({
    page,
    request,
  }) => {
    await progressViewWithExams(page, request, 3);

    const list = page
      .getByRole('main')
      .getByRole('list', { name: 'Mock exam scores', exact: true });

    await expect(list).toHaveCount(1);
    expect(await isVisuallyHidden(list)).toBe(true);
    await expect(chart(page)).toHaveCount(1);
    await expect(list.locator('svg')).toHaveCount(0);
  });

  test('AC-38: with 22 mock exams the list holds the last 20, like the chart', async ({
    page,
    request,
  }) => {
    const progress = await progressViewWithExams(page, request, 22);
    const expectedScores = progress.attempts.slice(-20).map((attempt) => String(attempt.estimated));

    const list = page
      .getByRole('main')
      .getByRole('list', { name: 'Mock exam scores', exact: true });

    await expect(list.getByRole('listitem')).toHaveCount(20);
    const texts = (await list.getByRole('listitem').allTextContents()).map((text) =>
      normalise(text),
    );
    expect(texts.map((text) => /: (\d+) \(/.exec(text)?.[1])).toEqual(expectedScores);
  });
});

/* ====================================================================== AC-34: figure ids */

test.describe('figure ids', () => {
  test('AC-34: on the diagram fixture page every figure id is "diagram-<id>" and no id is used twice', async ({
    page,
  }) => {
    await page.goto('/fixtures/diagram/');
    await expect(page.locator('figure[data-diagram]').first()).toBeAttached();

    const figures = await page.locator('figure[data-diagram]').evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute('id'),
        diagram: element.getAttribute('data-diagram'),
      })),
    );
    const allIds = await page.locator('[id]').evaluateAll((elements) => elements.map((e) => e.id));

    expect(figures.length).toBeGreaterThanOrEqual(2);
    for (const figure of figures) {
      expect(figure.id, `figure of ${String(figure.diagram)}`).toBe(
        `diagram-${String(figure.diagram)}`,
      );
    }
    const duplicates = allIds.filter((id, index) => allIds.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });
});

/* ====================================================================== AC-35: links.json 404 or not JSON */

const LINKED_GUIDE = 'a[href="/d1/1-3-data-security/"]';

const BROKEN_LINKS_JSON: [string, (page: Page) => Promise<void>][] = [
  [
    'a 404',
    async (page) => {
      await page.route('**/practice/links.json', (route) =>
        route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' }),
      );
    },
  ],
  [
    'a body that is not JSON',
    async (page) => {
      await page.route('**/practice/links.json', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'this is not json' }),
      );
    },
  ],
];

for (const [name, breakIt] of BROKEN_LINKS_JSON) {
  test.describe(`links.json answering with ${name}`, () => {
    test(`AC-35: practice still works and the guide link reads "Guide: <path>" (${name})`, async ({
      page,
      request,
    }) => {
      const bank = await fetchBank(request);
      await routeBank(page, (questions) => questions.map(withLinks));
      await breakIt(page);
      await openStartScreen(page);
      const set = await startPractice(page, bank, DOMAIN_2_SET);
      const shown = await shownQuestion(page, bank);

      await answerAndCheck(page, shown, correctKeysOf(shown.question));

      await expect(questionHeading(page, 1, set.total)).toBeVisible();
      await expect(feedbackHeading(page, 'Correct')).toBeVisible();
      const guide = page.getByRole('main').locator(LINKED_GUIDE);
      await expect(guide).toHaveCount(1);
      await expect(guide).toContainText('Guide: /d1/1-3-data-security');
      await expect(page.getByRole('link', { name: /^Diagram:/ })).toHaveCount(0);
    });

    test(`AC-35: the review still works and the guide link reads "Guide: <path>" (${name})`, async ({
      page,
      request,
    }) => {
      const bank = await fetchBank(request);
      await routeBank(page, (questions) => questions.map(withLinks));
      await breakIt(page);
      const { expected } = await openExamResults(page, bank, mixed);

      await reviewButton(page, 1).click();

      await expect(questionHeading(page, 1, expected.total)).toBeVisible();
      const guide = page.getByRole('main').locator(LINKED_GUIDE);
      await expect(guide).toHaveCount(1);
      await expect(guide).toContainText('Guide: /d1/1-3-data-security');
      await expect(page.getByRole('link', { name: /^Diagram:/ })).toHaveCount(0);
    });
  });
}

/* ====================================================================== AC-36: h1 on review and progress */

test.describe('the page title on the new views', () => {
  test('AC-36: the page h1 is visible on the question review screen', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openExamResults(page, bank, mixed);

    await reviewButton(page, 1).click();

    await expect(backToResultsButton(page)).toBeVisible();
    await expect(pageHeading(page)).toBeVisible();
    expect(await isVisuallyHidden(pageHeading(page))).toBe(false);
  });

  test('AC-36: the page h1 is visible on the progress view', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await seedProgress(
      page,
      buildProgress(
        bank,
        manyAttempts(2, () => 'exam'),
      ),
    );

    await viewProgressButton(page).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Your progress', exact: true }),
    ).toBeVisible();
    await expect(pageHeading(page)).toBeVisible();
    expect(await isVisuallyHidden(pageHeading(page))).toBe(false);
  });

  test('AC-36: the page h1 is visible on the practice results and hidden on the practice screen', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    expect(await isVisuallyHidden(pageHeading(page))).toBe(true);

    await endPracticeButton(page).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice results', exact: true }),
    ).toBeVisible();
    expect(await isVisuallyHidden(pageHeading(page))).toBe(false);
  });
});

/* ====================================================================== AC-37: the clock of the Practice card */

const T0 = new Date('2026-10-20T10:00:00Z');

/** Progress with one weak-spot question (box 2) that becomes due `inMs` after T0. */
function progressDueIn(
  bank: readonly Question[],
  inMs: number,
): { progress: Progress; id: string } {
  const id = bank.find((question) => question.status === 'reviewed')?.id ?? '';
  const progress: Progress = {
    ...emptyProgress(),
    questions: {
      [id]: {
        answered: 1,
        correct: 0,
        lastAnsweredAt: T0.getTime() - DAY_MS,
        box: 2,
        dueAt: T0.getTime() + inMs,
      },
    },
  };
  return { progress, id };
}

test.describe('the Practice card keeps a fresh clock', () => {
  test('AC-37: a weak-spot question that becomes due while the start screen is open is counted within a minute', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const { progress } = progressDueIn(bank, 30_000);
    await page.clock.install({ time: T0 });
    await seedProgress(page, progress);
    await practiceByRadio(page, 'Weak spots').check();
    const dueDate = await localDate(page, T0.getTime() + 30_000);
    await expect(
      page.getByText(`Nothing is due now. The next question is due on ${dueDate}.`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(startPracticeButton(page)).toBeDisabled();

    await page.clock.runFor(61_000);

    await expect(
      page.getByText('1 question is due for another try.', { exact: true }),
    ).toBeVisible();
    await expect(startPracticeButton(page)).toBeEnabled();
  });

  test('AC-37: after the refresh Start practice starts the weak-spots set without a reload', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const { progress, id } = progressDueIn(bank, 30_000);
    await page.clock.install({ time: T0 });
    await seedProgress(page, progress);
    await practiceByRadio(page, 'Weak spots').check();
    await page.clock.runFor(61_000);
    await expect(startPracticeButton(page)).toBeEnabled();

    await startPracticeButton(page).click();

    await expect(questionHeading(page, 1, 1)).toBeVisible();
    const shown: Shown = await shownQuestion(page, bank);
    expect(shown.question.id).toBe(id);
  });

  test('AC-37: a question that is not due yet stays out: nothing changes before its time', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const { progress } = progressDueIn(bank, 10 * 60_000);
    await page.clock.install({ time: T0 });
    await seedProgress(page, progress);
    await practiceByRadio(page, 'Weak spots').check();

    await page.clock.runFor(61_000);

    await expect(page.getByText(/^Nothing is due now\./)).toBeVisible();
    await expect(startPracticeButton(page)).toBeDisabled();
  });
});
