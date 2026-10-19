// Spec 028: practice modes at /practice/ (AC-8 to AC-16).
// Every test reads the real bank from /practice/bank.json; a practice set is never saved, so the
// question shown is found in the bank by its stem and option texts.
import { expect, test, type Locator } from '@playwright/test';
import { emptyProgress, listServices, saveSession } from '../../packages/quiz-core/src/index.ts';
import { domains, tasks } from '../../packages/schema/src/index.ts';
import type { Question, TaskId } from '../../packages/schema/src/index.ts';
import {
  PROGRESS_KEY,
  SESSION_KEY,
  allCorrect,
  correctKeysOf,
  discardButton,
  expectedResults,
  fetchBank,
  listRows,
  mixed,
  newExamButton,
  normalise,
  optionCards,
  optionInputs,
  pageHeading,
  questionHeading,
  readStored,
  resumeButton,
  seedSavedExam,
  seededSession,
  startButton,
  timerLocator,
  flagButton,
  allNavButtons,
  endAndSubmit,
  wrongKeysOf,
} from './practice-support.ts';
import {
  DAY_MS,
  DOMAIN_2_SET,
  EMPTY_PROGRESS_TEXT,
  NOT_ANSWERED_FEEDBACK,
  NO_MATCH_TEXT,
  NO_WEAK_SPOTS_TEXT,
  PRACTICE_BY,
  answerAndCheck,
  checkAnswerButton,
  choiceSelect,
  domainOptionText,
  domainWithType,
  endPracticeButton,
  expectOptionsList,
  feedbackHeading,
  finishPracticeButton,
  localDate,
  newPracticeSetButton,
  nextOfType,
  nextPlainButton,
  openStartScreen,
  optionDisabledFlags,
  optionTexts,
  optionsOfShown,
  poolSize,
  practiceByGroup,
  practiceByRadio,
  previousPlainButton,
  readProgress,
  readQuestionId,
  routeBank,
  selectedText,
  serviceOptionText,
  setLineText,
  showAnswerButton,
  showAnswerOnly,
  shownQuestion,
  sizeSelect,
  startPractice,
  startPracticeButton,
  taskOptionText,
  termValue,
  viewProgressButton,
  waitForAttempts,
  finishSmallPractice,
  mainText,
} from './practice-modes-support.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

/** Visually hidden: no box at all, or one so small that no text can be seen. */
async function isVisuallyHidden(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  return box === null || (box.width <= 2 && box.height <= 2);
}

/* ====================================================================== AC-8: start screen */

test.describe('start screen', () => {
  test('AC-8: a fresh start screen still shows the Mock exam card with Start exam and no Last exam', async ({
    page,
  }) => {
    await openStartScreen(page);

    await expect(
      page.getByRole('heading', { level: 2, name: 'Mock exam', exact: true }),
    ).toBeVisible();
    await expect(startButton(page)).toBeEnabled();
    await expect(resumeButton(page)).toHaveCount(0);
    await expect(discardButton(page)).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText('Last exam');
  });

  test('AC-8: the Practice card has its title and text', async ({ page }) => {
    await openStartScreen(page);

    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Questions from one part of the exam, with the answer and the explanations after each one. No timer.',
        { exact: true },
      ),
    ).toBeVisible();
  });

  test('AC-8: "Practice by" offers Domain, Task, Service and Weak spots, with Domain checked', async ({
    page,
  }) => {
    await openStartScreen(page);

    await expect(practiceByGroup(page)).toBeVisible();
    const radios = page.getByRole('main').getByRole('radio');
    await expect(radios).toHaveCount(4);
    for (const [index, name] of PRACTICE_BY.entries()) {
      await expect(radios.nth(index)).toHaveAccessibleName(name);
    }
    await expect(practiceByRadio(page, 'Domain')).toBeChecked();
    for (const name of ['Task', 'Service', 'Weak spots'] as const) {
      await expect(practiceByRadio(page, name)).not.toBeChecked();
    }
  });

  test('AC-8: the "Domain" select lists the 4 domains with the counts of bank.json', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const select = choiceSelect(page, 'Domain');

    await expect(select).toBeVisible();
    const expected = domains.map(({ id }) => domainOptionText(bank, id));
    expect(await optionTexts(select)).toEqual(expected);
    expect(await selectedText(select)).toBe(expected[0]);
  });

  test('AC-8: "Number of questions" is 10 and offers 10, 20, 30 and All (n)', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const n = poolSize(bank, emptyProgress(), { kind: 'domain', domain: 1 });
    await openStartScreen(page);

    expect(await optionTexts(sizeSelect(page))).toEqual(['10', '20', '30', `All (${String(n)})`]);
    expect(await selectedText(sizeSelect(page))).toBe('10');
  });

  test('AC-8: the set line says how many questions the set has and Start practice is enabled', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const n = poolSize(bank, emptyProgress(), { kind: 'domain', domain: 1 });
    await openStartScreen(page);

    await expect(page.getByText(setLineText(Math.min(10, n)), { exact: true })).toBeVisible();
    await expect(startPracticeButton(page)).toBeEnabled();
  });

  test('AC-8: the Progress card shows the empty text and no View progress button', async ({
    page,
  }) => {
    await openStartScreen(page);

    await expect(
      page.getByRole('heading', { level: 2, name: 'Your progress', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(EMPTY_PROGRESS_TEXT, { exact: true })).toBeVisible();
    await expect(viewProgressButton(page)).toHaveCount(0);
  });
});

/* ====================================================================== AC-9: other choices */

test.describe('practice by task, service and weak spots', () => {
  test('AC-9: Task shows a "Task" select with the 14 tasks, their counts, and zero-count ones disabled', async ({
    page,
    request,
  }) => {
    // The same bank without the questions of the first and the last task, so that zero counts exist
    // and the default is not the first option.
    const emptied: TaskId[] = [tasks[0]?.id ?? '1.1', tasks[tasks.length - 1]?.id ?? '4.4'];
    const withoutTasks = (questions: Question[]): Question[] =>
      questions.filter((question) => !emptied.includes(question.task));
    const bank = withoutTasks(await fetchBank(request));
    await routeBank(page, withoutTasks);
    await openStartScreen(page);

    await practiceByRadio(page, 'Task').check();

    const select = choiceSelect(page, 'Task');
    await expect(select).toBeVisible();
    await expect(choiceSelect(page, 'Domain')).toHaveCount(0);
    const expected = tasks.map(({ id }) => taskOptionText(bank, id));
    expect(expected).toHaveLength(14);
    expect(await optionTexts(select)).toEqual(expected);
    const disabled = await optionDisabledFlags(select);
    expect(disabled).toEqual(
      tasks.map(({ id }) => poolSize(bank, emptyProgress(), { kind: 'task', task: id }) === 0),
    );
    expect(disabled.filter(Boolean)).toHaveLength(2);
    const firstEnabled = disabled.findIndex((flag) => !flag);
    expect(await selectedText(select)).toBe(expected[firstEnabled]);
  });

  test('AC-9: Service shows a "Service" select with the services and counts of listServices', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);

    await practiceByRadio(page, 'Service').check();

    const select = choiceSelect(page, 'Service');
    await expect(select).toBeVisible();
    const expected = listServices(bank).map(({ service, count }) =>
      serviceOptionText(service, count),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(await optionTexts(select)).toEqual(expected);
    expect(await selectedText(select)).toBe(expected[0]);
  });

  test('AC-9: a service option reads "<service> (n)" with the raw service id', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const first = listServices(bank)[0];
    expect(first).toBeDefined();
    await openStartScreen(page);

    await practiceByRadio(page, 'Service').check();

    await expect(
      choiceSelect(page, 'Service').getByRole('option', {
        name: `${first?.service ?? ''} (${String(first?.count ?? 0)})`,
        exact: true,
      }),
    ).toHaveCount(1);
  });

  test('AC-9: Weak spots on fresh progress shows the "No weak spots yet" text and a disabled Start practice', async ({
    page,
  }) => {
    await openStartScreen(page);

    await practiceByRadio(page, 'Weak spots').check();

    await expect(page.getByText(NO_WEAK_SPOTS_TEXT, { exact: true })).toBeVisible();
    for (const name of ['Domain', 'Task', 'Service'] as const) {
      await expect(choiceSelect(page, name)).toHaveCount(0);
    }
    await expect(page.getByText(NO_MATCH_TEXT, { exact: true })).toBeVisible();
    await expect(startPracticeButton(page)).toBeDisabled();
  });

  test('AC-9: changing "Number of questions" to All (n) says "<n> questions in this set."', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const n = poolSize(bank, emptyProgress(), { kind: 'domain', domain: 1 });
    expect(n, 'domain 1 has more than 10 questions').toBeGreaterThan(10);
    await openStartScreen(page);

    await sizeSelect(page).selectOption({ label: `All (${String(n)})` });

    await expect(page.getByText(setLineText(n), { exact: true })).toBeVisible();
  });

  test('AC-9: choosing 20 or 30 shows the smaller of that size and the pool', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const n = poolSize(bank, emptyProgress(), { kind: 'domain', domain: 1 });
    await openStartScreen(page);

    await sizeSelect(page).selectOption({ label: '20' });
    await expect(page.getByText(setLineText(Math.min(20, n)), { exact: true })).toBeVisible();

    await sizeSelect(page).selectOption({ label: '30' });
    await expect(page.getByText(setLineText(Math.min(30, n)), { exact: true })).toBeVisible();
  });

  test('AC-9: the set line follows the choice: a task with one question says "1 question in this set."', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const task: TaskId | undefined = tasks.find(
      ({ id }) => poolSize(bank, emptyProgress(), { kind: 'task', task: id }) > 0,
    )?.id;
    expect(task).toBeDefined();
    // The same bank with a single question left in that task.
    const keep = (questions: Question[]): Question[] => {
      const first = questions.find((question) => question.task === task);
      return questions.filter((question) => question.task !== task || question === first);
    };
    await routeBank(page, keep);
    const routed = keep(bank);
    await openStartScreen(page);

    await practiceByRadio(page, 'Task').check();
    await choiceSelect(page, 'Task').selectOption({ label: taskOptionText(routed, task ?? '1.1') });

    await expect(page.getByText('1 question in this set.', { exact: true })).toBeVisible();
    await expect(startPracticeButton(page)).toBeEnabled();
  });
});

/* ====================================================================== AC-10: practice screen */

test.describe('starting a practice set', () => {
  test('AC-10: Start practice (Domain 2, 10) shows "Question 1 of N" and the chip with the pool label', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);

    const set = await startPractice(page, bank, DOMAIN_2_SET);

    const n = poolSize(bank, emptyProgress(), { kind: 'domain', domain: 2 });
    expect(set.total).toBe(Math.min(10, n));
    await expect(questionHeading(page, 1, set.total)).toBeFocused();
    await expect(
      page.getByText('Practice · Domain 2: Design Resilient Architectures', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`0 of ${String(set.total)} checked`, { exact: true }),
    ).toBeVisible();
  });

  test('AC-10: the practice screen has no timer, Flag button, navigator or progress bar', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);

    await expect(timerLocator(page)).toHaveCount(0);
    await expect(flagButton(page)).toHaveCount(0);
    await expect(allNavButtons(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Question navigator' })).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
  });

  test('AC-10: the page h1 is visually hidden but stays in the accessibility tree', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await expect(pageHeading(page)).toBeVisible();
    expect(await isVisuallyHidden(pageHeading(page))).toBe(false);

    await startPractice(page, bank, DOMAIN_2_SET);

    await expect(page.locator('html')).toHaveAttribute('data-practice-screen', 'practice');
    await expect(pageHeading(page)).toHaveCount(1);
    expect(await isVisuallyHidden(pageHeading(page))).toBe(true);
  });

  test('AC-10: the question card is the exam card: type label, stem and lettered options', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);

    const shown = await shownQuestion(page, bank);

    const cards = (await optionCards(page).allTextContents()).map((text) => normalise(text));
    for (const [position, card] of cards.entries()) {
      expect(card.startsWith(String.fromCharCode(65 + position))).toBe(true);
    }
    const label =
      shown.question.type === 'single'
        ? 'Single answer'
        : `Choose ${String(correctKeysOf(shown.question).length)}`;
    await expect(page.getByRole('main').getByText(label, { exact: true })).toBeVisible();
    await expect(optionInputs(page, shown.question.type)).toHaveCount(
      shown.question.options.length,
    );
  });

  test('AC-10: every question of a Domain 2 set belongs to domain 2 (the id shown after each reveal)', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);

    const ids: string[] = [];
    for (let n = 1; n <= set.total; n += 1) {
      await expect(questionHeading(page, n, set.total)).toBeVisible();
      await showAnswerOnly(page);
      ids.push(await readQuestionId(page));
      if (n < set.total) await nextPlainButton(page).click();
    }

    expect(ids.every((id) => id.startsWith('d2-'))).toBe(true);
    expect(new Set(ids).size, 'no question twice').toBe(set.total);
  });
});

/* ====================================================================== AC-11: answering and revealing */

test.describe('check and show answer', () => {
  test('AC-11: with nothing selected the button reads Show answer, with an option selected Check answer', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);

    await expect(showAnswerButton(page)).toBeVisible();
    await expect(checkAnswerButton(page)).toHaveCount(0);

    await optionCards(page).nth(0).click();

    await expect(checkAnswerButton(page)).toBeVisible();
    await expect(showAnswerButton(page)).toHaveCount(0);
  });

  test('AC-11: clearing the only selected checkbox of a "Choose k" question brings Show answer back', async ({
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

    await optionCards(page).nth(0).click();
    await expect(checkAnswerButton(page)).toBeVisible();
    await optionCards(page).nth(0).click();

    await expect(showAnswerButton(page)).toBeVisible();
    await expect(checkAnswerButton(page)).toHaveCount(0);
  });

  test('AC-11: Check answer on a right answer shows "Correct" with focus on it and replaces the option cards', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await answerAndCheck(page, shown, correctKeysOf(shown.question));

    await expect(feedbackHeading(page, 'Correct')).toBeVisible();
    await expect(feedbackHeading(page, 'Correct')).toBeFocused();
    // The cards are replaced by the explanation: no radio or checkbox of the question is left.
    await expect(page.getByRole('main').getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(0);
    await expect(optionCards(page)).toHaveCount(0);
    await expect(checkAnswerButton(page)).toHaveCount(0);
    await expect(showAnswerButton(page)).toHaveCount(0);
  });

  test('AC-11: Check answer on a wrong answer shows "Incorrect"', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await answerAndCheck(page, shown, wrongKeysOf(shown.question));

    await expect(feedbackHeading(page, 'Incorrect')).toBeFocused();
    await expect(feedbackHeading(page, 'Correct')).toHaveCount(0);
  });

  test('AC-11: on a "Choose k" question all the right options give "Correct"', async ({
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
    const shown = await nextOfType(page, bank, 'multiple', set.total);
    await expect(page.getByText(/\d+ of \d+ selected/)).toBeVisible();

    await answerAndCheck(page, shown, correctKeysOf(shown.question));

    await expect(feedbackHeading(page, 'Correct')).toBeFocused();
    await expect(page.getByText(/\d+ of \d+ selected/)).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('checkbox')).toHaveCount(0);
  });

  test('AC-11: on a "Choose k" question only some of the right options give "Incorrect"', async ({
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
    const shown = await nextOfType(page, bank, 'multiple', set.total);
    const [onlyOne] = correctKeysOf(shown.question);

    await answerAndCheck(page, shown, [onlyOne ?? '']);

    await expect(feedbackHeading(page, 'Incorrect')).toBeFocused();
  });

  test('AC-11: the explanation lists every option in display order with its why and the Correct answer and Your answer tags', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    const picked = wrongKeysOf(shown.question);

    await answerAndCheck(page, shown, picked);

    await expectOptionsList(page, optionsOfShown(shown, picked));
  });

  test('AC-11: with the right answer selected the explanation tags it both "Correct answer" and "Your answer"', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    const picked = correctKeysOf(shown.question);

    await answerAndCheck(page, shown, picked);

    await expectOptionsList(page, optionsOfShown(shown, picked));
  });

  test('AC-11: Show answer with nothing selected says "Not answered: this counts as a miss." and tags no "Your answer"', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await showAnswerOnly(page);

    await expect(feedbackHeading(page, NOT_ANSWERED_FEEDBACK)).toBeFocused();
    await expect(page.getByRole('main').getByText('Your answer', { exact: true })).toHaveCount(0);
    await expectOptionsList(page, optionsOfShown(shown, []));
  });

  test('AC-11: the explanation shows the id of the question', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await showAnswerOnly(page);

    expect(await readQuestionId(page)).toBe(shown.question.id);
  });
});

/* ====================================================================== AC-12: moving and results */

test.describe('moving through the set and the results', () => {
  test('AC-12: Previous is disabled on question 1; Next and Previous move by one with focus on the heading', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    await expect(previousPlainButton(page)).toBeDisabled();

    await nextPlainButton(page).click();

    await expect(questionHeading(page, 2, set.total)).toBeFocused();
    await expect(previousPlainButton(page)).toBeEnabled();
    await previousPlainButton(page).click();
    await expect(questionHeading(page, 1, set.total)).toBeFocused();
  });

  test('AC-12: on question N the button reads Finish practice instead of Next', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    await expect(finishPracticeButton(page)).toHaveCount(0);

    for (let n = 2; n <= set.total; n += 1) await nextPlainButton(page).click();

    await expect(questionHeading(page, set.total, set.total)).toBeVisible();
    await expect(finishPracticeButton(page)).toBeVisible();
    await expect(nextPlainButton(page)).toHaveCount(0);
    await expect(previousPlainButton(page)).toBeEnabled();
    await expect(endPracticeButton(page)).toBeVisible();
  });

  test('AC-12: End practice is shown on every question', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);

    await expect(endPracticeButton(page)).toBeVisible();
    await nextPlainButton(page).click();
    await expect(endPracticeButton(page)).toBeVisible();
  });

  test('AC-12: Finish practice shows the Practice results with the pool label, percent, counts and the question list', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    // Question 1 right, question 2 wrong, question 3 revealed with no answer, the rest untouched.
    const first = await shownQuestion(page, bank);
    await answerAndCheck(page, first, correctKeysOf(first.question));
    await nextPlainButton(page).click();
    const second = await shownQuestion(page, bank);
    await answerAndCheck(page, second, wrongKeysOf(second.question));
    await nextPlainButton(page).click();
    await showAnswerOnly(page);
    for (let n = 4; n <= set.total; n += 1) await nextPlainButton(page).click();

    await finishPracticeButton(page).click();

    const heading = page.getByRole('heading', { level: 2, name: 'Practice results', exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByRole('main').getByText(set.label, { exact: true })).toBeVisible();
    const percent = Math.round(100 / set.total);
    await expect(termValue(page, 'Correct')).toContainText(`${String(percent)}%`);
    await expect(termValue(page, 'Correct')).toContainText(`1 of ${String(set.total)}`);
    await expect(termValue(page, 'Not answered')).toContainText(String(set.total - 2));
    await expect(termValue(page, 'Not answered')).toContainText('questions');
    await expect(
      page.getByText('Missed questions come back in Weak spots.', { exact: true }),
    ).toBeVisible();
  });

  test('AC-12: the results list has All and Incorrect with their counts and no Flagged filter', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, correctKeysOf(shown.question));

    await endPracticeButton(page).click();

    const all = page.getByRole('button', { name: /^All\b/ });
    const incorrect = page.getByRole('button', { name: /^Incorrect\b/ });
    await expect(all).toHaveAccessibleName(new RegExp(`^All\\D*${String(set.total)}\\D*$`));
    await expect(incorrect).toHaveAccessibleName(
      new RegExp(`^Incorrect\\D*${String(set.total - 1)}\\D*$`),
    );
    await expect(page.getByRole('button', { name: /^Flagged\b/ })).toHaveCount(0);
    await expect(listRows(page).filter({ hasText: /\bQuestion \d+\b/ })).toHaveCount(set.total);
    await incorrect.click();
    await expect(listRows(page).filter({ hasText: /\bQuestion \d+\b/ })).toHaveCount(set.total - 1);
  });

  test('AC-12: End practice on an earlier question shows the Practice results', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, correctKeysOf(shown.question));
    await nextPlainButton(page).click();
    await expect(questionHeading(page, 2, set.total)).toBeVisible();

    await endPracticeButton(page).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice results', exact: true }),
    ).toBeFocused();
    await expect(page.getByRole('main').getByText(set.label, { exact: true })).toBeVisible();
    await expect(termValue(page, 'Correct')).toContainText(`1 of ${String(set.total)}`);
    await expect(termValue(page, 'Not answered')).toContainText(String(set.total - 1));
  });

  test('AC-12: New practice set returns to the start screen with focus on Start practice', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await finishSmallPractice(page, bank);

    await newPracticeSetButton(page).click();

    await expect(startPracticeButton(page)).toBeFocused();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice', exact: true }),
    ).toBeVisible();
  });

  test('AC-12: New practice set keeps the "Practice by" choice that was used', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const service = listServices(bank)[0]?.service ?? '';
    await openStartScreen(page);
    await startPractice(page, bank, { by: 'Service', value: service, size: 10 });
    await endPracticeButton(page).click();

    await newPracticeSetButton(page).click();

    await expect(practiceByRadio(page, 'Service')).toBeChecked();
    await expect(practiceByRadio(page, 'Domain')).not.toBeChecked();
  });

  test('AC-12: the practice results show the h1 again', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await finishSmallPractice(page, bank);

    await expect(page.locator('html')).not.toHaveAttribute('data-practice-screen', 'practice');
    expect(await isVisuallyHidden(pageHeading(page))).toBe(false);
  });
});

/* ====================================================================== AC-13: recording */

test.describe('recording a practice set', () => {
  test('AC-13: finishing a set records one practice attempt and stats for the graded questions', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    // Question 1 right, question 2 wrong, question 3 revealed with no answer: three graded questions.
    const first = await shownQuestion(page, bank);
    await answerAndCheck(page, first, correctKeysOf(first.question));
    await nextPlainButton(page).click();
    const second = await shownQuestion(page, bank);
    await answerAndCheck(page, second, wrongKeysOf(second.question));
    await nextPlainButton(page).click();
    const third = await shownQuestion(page, bank);
    await showAnswerOnly(page);

    await endPracticeButton(page).click();

    const progress = await waitForAttempts(page, 1);
    expect(progress.attempts[0]).toMatchObject({
      mode: 'practice',
      size: set.total,
      total: set.total,
      answered: 2,
      correct: 1,
      submitReason: 'manual',
    });
    const ids = [first, second, third].map((shown) => shown.question.id);
    expect(Object.keys(progress.questions).sort()).toEqual([...ids].sort());
    expect(progress.questions[ids[0] ?? '']).toMatchObject({ answered: 1, correct: 1 });
    expect(progress.questions[ids[1] ?? '']).toMatchObject({ answered: 1, correct: 0, box: 1 });
    expect(progress.questions[ids[2] ?? '']).toMatchObject({ answered: 1, correct: 0, box: 1 });
  });

  test('AC-13: Finish practice on the last question records the set too', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    for (let n = 2; n <= set.total; n += 1) await nextPlainButton(page).click();
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, wrongKeysOf(shown.question));

    await finishPracticeButton(page).click();

    const progress = await waitForAttempts(page, 1);
    expect(progress.attempts[0]).toMatchObject({ mode: 'practice', total: set.total, answered: 1 });
    expect(Object.keys(progress.questions)).toEqual([shown.question.id]);
  });

  test('AC-13: a set where the only action was Show answer is recorded, and that question is a miss', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await showAnswerOnly(page);

    await endPracticeButton(page).click();

    const progress = await waitForAttempts(page, 1);
    expect(progress.attempts[0]).toMatchObject({ mode: 'practice', answered: 0, correct: 0 });
    expect(progress.questions[shown.question.id]).toMatchObject({
      answered: 1,
      correct: 0,
      box: 1,
    });
  });

  test('AC-13: a set with exactly one missed question makes Weak spots say "1 question is due for another try."', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, wrongKeysOf(shown.question));
    await endPracticeButton(page).click();
    await waitForAttempts(page, 1);

    await newPracticeSetButton(page).click();
    await practiceByRadio(page, 'Weak spots').check();

    await expect(
      page.getByText('1 question is due for another try.', { exact: true }),
    ).toBeVisible();
    await expect(startPracticeButton(page)).toBeEnabled();
    await expect(page.getByText(setLineText(1), { exact: true })).toBeVisible();
  });

  test('AC-13: a set ended with nothing answered and nothing revealed adds no attempt', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    // Moving around is not answering.
    await nextPlainButton(page).click();
    await expect(questionHeading(page, 2, set.total)).toBeVisible();
    await previousPlainButton(page).click();

    await endPracticeButton(page).click();

    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice results', exact: true }),
    ).toBeVisible();
    await newPracticeSetButton(page).click();
    await expect(page.getByText(EMPTY_PROGRESS_TEXT, { exact: true })).toBeVisible();
    await page.reload();
    await expect(startPracticeButton(page)).toBeVisible();
    await expect(page.getByText(EMPTY_PROGRESS_TEXT, { exact: true })).toBeVisible();
    expect((await readProgress(page))?.attempts ?? []).toEqual([]);
  });
});

/* ====================================================================== AC-14: weak spots */

test.describe('weak spots', () => {
  test('AC-14: after missing one question a Weak spots set holds exactly that question; answering it right moves its due date a day ahead', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const missed = await shownQuestion(page, bank);
    await answerAndCheck(page, missed, wrongKeysOf(missed.question));
    await endPracticeButton(page).click();
    await waitForAttempts(page, 1);
    await newPracticeSetButton(page).click();

    const weak = await startPractice(page, bank, { by: 'Weak spots' });

    expect(weak.total).toBe(1);
    await expect(questionHeading(page, 1, 1)).toBeVisible();
    await expect(page.getByText('Practice · Weak spots', { exact: true })).toBeVisible();
    const shown = await shownQuestion(page, bank);
    expect(shown.question.id).toBe(missed.question.id);
    await answerAndCheck(page, shown, correctKeysOf(shown.question));
    await expect(feedbackHeading(page, 'Correct')).toBeVisible();
    await expect(finishPracticeButton(page)).toBeVisible();
    await finishPracticeButton(page).click();
    const progress = await waitForAttempts(page, 2);
    await newPracticeSetButton(page).click();

    const submittedAt = progress.attempts[1]?.submittedAt ?? 0;
    const date = await localDate(page, submittedAt + DAY_MS);
    await practiceByRadio(page, 'Weak spots').check();
    await expect(
      page.getByText(`Nothing is due now. The next question is due on ${date}.`, { exact: true }),
    ).toBeVisible();
    await expect(startPracticeButton(page)).toBeDisabled();
  });
});

/* ====================================================================== AC-15: saved exam untouched */

test.describe('a saved exam while practising', () => {
  test('AC-15: a whole practice set leaves the saved exam byte for byte unchanged and Resume exam is still shown', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await seedSavedExam(page, seededSession(bank, mixed));
    await expect(resumeButton(page)).toBeVisible();
    const before = await readStored(page, SESSION_KEY);
    expect(before).not.toBeNull();

    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, correctKeysOf(shown.question));
    await nextPlainButton(page).click();
    await expect(questionHeading(page, 2, set.total)).toBeVisible();
    expect(await readStored(page, SESSION_KEY), 'during the set').toBe(before);
    await endPracticeButton(page).click();
    await waitForAttempts(page, 1);
    expect(await readStored(page, SESSION_KEY), 'on the results').toBe(before);
    await newPracticeSetButton(page).click();

    await expect(resumeButton(page)).toBeVisible();
    expect(await readStored(page, SESSION_KEY), 'after the set').toBe(before);
  });

  test('AC-15: with a saved exam, Start practice is still offered and the exam keeps its question and time', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await seedSavedExam(page, seededSession(bank, mixed));

    await expect(startPracticeButton(page)).toBeEnabled();
    await expect(resumeButton(page)).toBeVisible();
    await expect(discardButton(page)).toBeVisible();
  });

  test('AC-15: reloading during a practice set shows the start screen with no way to resume the set', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, correctKeysOf(shown.question));

    await page.reload();

    await expect(startPracticeButton(page)).toBeVisible();
    await expect(questionHeading(page, 1, set.total)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Resume/ })).toHaveCount(0);
    expect(await readStored(page, SESSION_KEY)).toBeNull();
    await expect(page.getByRole('main')).not.toContainText('Last exam');
  });

  test('AC-15: reloading during a practice set with a saved exam offers only that exam', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await seedSavedExam(page, seededSession(bank, mixed));
    const before = await readStored(page, SESSION_KEY);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    await expect(questionHeading(page, 1, set.total)).toBeVisible();

    await page.reload();

    await expect(resumeButton(page)).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Resume/ })).toHaveCount(1);
    await expect(startPracticeButton(page)).toBeVisible();
    expect(await readStored(page, SESSION_KEY)).toBe(before);
  });
});

/* ====================================================================== AC-16: last exam */

test.describe('Last exam line', () => {
  test('AC-16: after a mock exam and then a practice set, "Last exam" still shows the exam score', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, mixed);
    const expected = expectedResults(saveSession(session), bank);
    const last = `Last exam: ${String(expected.estimated)} (${expected.passed ? 'PASS' : 'FAIL'})`;
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);
    await waitForAttempts(page, 1);
    await newExamButton(page).click();
    await expect(page.getByRole('main')).toContainText(last);

    await finishSmallPractice(page, bank);
    await waitForAttempts(page, 2);
    await newPracticeSetButton(page).click();

    await expect(page.getByRole('main')).toContainText(last);
    await page.reload();
    await expect(page.getByRole('main')).toContainText(last);
  });

  test('AC-16: a practice set scoring lower than the exam does not replace "Last exam"', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, allCorrect);
    const expected = expectedResults(saveSession(session), bank);
    await seedSavedExam(page, session);
    await resumeButton(page).click();
    await endAndSubmit(page);
    await newExamButton(page).click();
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);
    await answerAndCheck(page, shown, wrongKeysOf(shown.question));
    await endPracticeButton(page).click();
    await waitForAttempts(page, 2);
    await newPracticeSetButton(page).click();

    const text = await mainText(page);
    expect(text).toContain(`Last exam: ${String(expected.estimated)} (PASS)`);
  });

  test('AC-16: with only practice attempts recorded, no "Last exam" line shows', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await finishSmallPractice(page, bank);
    await waitForAttempts(page, 1);

    await newPracticeSetButton(page).click();

    await expect(startPracticeButton(page)).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('Last exam');
    await page.reload();
    await expect(startPracticeButton(page)).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('Last exam');
    expect(await readStored(page, PROGRESS_KEY)).not.toBeNull();
  });
});
