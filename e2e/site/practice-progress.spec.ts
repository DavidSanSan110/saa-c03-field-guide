// Spec 028: the Progress card, the progress view and the mock exam chart (AC-22, AC-23).
// A mock exam is seeded and submitted, a practice set is played in the browser, and the numbers on
// the screen are compared with `dashboardView` computed from the bank and the stored progress.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dashboardView } from '../../apps/site/src/practice/dashboard.ts';
import type { DashboardView } from '../../apps/site/src/practice/dashboard.ts';
import type { Progress, Question } from '../../packages/schema/src/index.ts';
import { fetchBank, listRows, mixed, newExamButton, normalise } from './practice-support.ts';
import {
  EMPTY_PROGRESS_TEXT,
  LEITNER_BOX_LABELS,
  backToStartButton,
  buildProgress,
  escapeRegExp,
  finishSmallPractice,
  localDate,
  manyAttempts,
  newPracticeSetButton,
  numberRegex,
  openExamResults,
  seedProgress,
  tableRows,
  tableWith,
  termValue,
  viewProgressButton,
  waitForAttempts,
  type AttemptSpec,
} from './practice-modes-support.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

const PROGRESS_HEADING = (page: Page) =>
  page.getByRole('heading', { level: 2, name: 'Your progress', exact: true });

interface Played {
  bank: Question[];
  progress: Progress;
  view: DashboardView;
}

/** One mock exam (seeded, submitted) and then one practice set: the start screen afterwards. */
async function examThenPractice(page: Page, request: APIRequestContext): Promise<Played> {
  const bank = await fetchBank(request);
  await openExamResults(page, bank, mixed);
  await waitForAttempts(page, 1);
  await newExamButton(page).click();
  await finishSmallPractice(page, bank);
  const progress = await waitForAttempts(page, 2);
  await newPracticeSetButton(page).click();
  return { bank, progress, view: dashboardView(bank, progress, Date.now()) };
}

async function openProgressView(page: Page): Promise<void> {
  await viewProgressButton(page).click();
  await expect(PROGRESS_HEADING(page)).toBeFocused();
  await expect(backToStartButton(page)).toBeVisible();
}

/** A progress record with `specs` attempts, seeded, and the progress view opened. */
async function seededProgressView(
  page: Page,
  request: APIRequestContext,
  specs: (bank: Question[]) => AttemptSpec[],
): Promise<{ bank: Question[]; progress: Progress }> {
  const bank = await fetchBank(request);
  const progress = buildProgress(bank, specs(bank));
  await seedProgress(page, progress);
  await openProgressView(page);
  return { bank, progress };
}

/* ====================================================================== AC-22: progress card and view */

test.describe('after a mock exam and a practice set', () => {
  test('AC-22: the Progress card shows what was seen and the share of right answers, and View progress', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);

    expect(view.overall.percent).not.toBeNull();
    await expect(
      page.getByText(
        `Seen ${String(view.overall.seen)} of ${String(view.overall.questions)} questions · ${String(view.overall.percent)}% of answers correct`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(viewProgressButton(page)).toBeVisible();
    await expect(page.getByText(EMPTY_PROGRESS_TEXT)).toHaveCount(0);
  });

  test('AC-22: View progress opens the progress view with focus on its heading', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await examThenPractice(page, request);

    await openProgressView(page);

    await expect(
      page.getByText('Progress is kept in this browser only.', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-practice-screen', /./);
    await expect(page.getByRole('heading', { level: 1, name: 'Practice test' })).toBeVisible();
  });

  test('AC-22: the overview shows questions seen, correct answers, questions due and attempts', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);

    await openProgressView(page);

    const { overall, attempts } = view;
    // The value and its unit may be separate inline elements, so the space between them is optional.
    await expect(termValue(page, 'Questions seen')).toHaveText(
      `${String(overall.seen)} of ${String(overall.questions)}`,
    );
    await expect(termValue(page, 'Correct answers')).toHaveText(
      new RegExp(
        `^${String(overall.percent)}%\\s*${String(overall.correct)} of ${String(overall.answered)}$`,
      ),
    );
    await expect(termValue(page, 'Due for another try')).toHaveText(
      new RegExp(`^${String(overall.due)}\\s*questions$`),
    );
    await expect(termValue(page, 'Attempts')).toHaveText(
      new RegExp(
        `^${String(attempts.total)}\\s*${String(attempts.exam)} mock exams · ${String(attempts.practice)} practice sets$`,
      ),
    );
  });

  test('AC-22: "Recent attempts" lists the practice set first, then the mock exam with its score and verdict', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);
    expect(view.recent.map((row) => row.mode)).toEqual(['practice', 'exam']);

    await openProgressView(page);

    await expect(
      page.getByRole('heading', { level: 3, name: 'Recent attempts', exact: true }),
    ).toBeVisible();
    const table = tableWith(page, 'Mode');
    for (const name of ['Date', 'Mode', 'Correct', 'Score']) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    const rows = await tableRows(table);
    const expected = await Promise.all(
      view.recent.map(async (row) => [
        await localDate(page, row.submittedAt),
        row.mode === 'exam' ? 'Mock exam' : 'Practice',
        `${String(row.correct)} of ${String(row.total)}`,
        row.estimated === null
          ? '—'
          : `${String(row.estimated)} (${row.passed === true ? 'PASS' : 'FAIL'})`,
      ]),
    );
    expect(rows).toEqual(expected);
  });

  test('AC-22: "By domain" has the four domains with percent, seen and weak numbers and "Needs work"', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);

    await openProgressView(page);

    await expect(
      page.getByRole('heading', { level: 3, name: 'By domain', exact: true }),
    ).toBeVisible();
    for (const row of view.domains) {
      const element = listRows(page).filter({ hasText: new RegExp(escapeRegExp(row.title)) });
      await expect(element, row.title).toHaveCount(1);
      const text = normalise(await element.innerText());
      expect(text, row.title).toContain(`Domain ${String(row.id)}`);
      if (row.percent === null) expect(text, row.title).toContain('—');
      else expect(text, row.title).toMatch(new RegExp(`${numberRegex(row.percent)}\\s*%`));
      expect(text, row.title).toContain(
        `${String(row.seen)} of ${String(row.questions)} questions seen · ${String(row.weak)} in weak spots`,
      );
      if (row.needsWork) expect(text, row.title).toContain('Needs work');
      else expect(text, row.title).not.toContain('Needs work');
    }
    expect(
      view.domains.some((row) => row.needsWork),
      'a domain needs work in this scenario',
    ).toBe(true);
  });

  test('AC-22: "By task" is a table of the 14 tasks in catalog order with seen, correct and weak', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);

    await openProgressView(page);

    await expect(
      page.getByRole('heading', { level: 3, name: 'By task', exact: true }),
    ).toBeVisible();
    const table = tableWith(page, 'Task');
    for (const name of ['Task', 'Seen', 'Correct', 'In weak spots']) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    const rows = await tableRows(table);
    expect(rows).toHaveLength(14);
    expect(rows).toEqual(
      view.tasks.map((row) => [
        `${row.id} ${row.title}`,
        `${String(row.seen)} of ${String(row.questions)}`,
        row.percent === null ? '—' : `${String(row.percent)}%`,
        String(row.weak),
      ]),
    );
  });

  test('AC-22: "Weak spots" shows the five boxes, the questions due now, the next due date and the rule', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);

    await openProgressView(page);

    await expect(
      page.getByRole('heading', { level: 3, name: 'Weak spots', exact: true }),
    ).toBeVisible();
    for (const [index, label] of LEITNER_BOX_LABELS.entries()) {
      const box = (index + 1) as 1 | 2 | 3 | 4 | 5;
      const item = listRows(page).filter({ hasText: new RegExp(`^\\s*Box ${String(box)}\\b`) });
      await expect(item, `box ${String(box)}`).toHaveCount(1);
      expect(normalise(await item.innerText())).toMatch(
        new RegExp(
          `^Box ${String(box)} \\(${escapeRegExp(label)}\\):?\\s*${String(view.leitner.boxes[box])}$`,
        ),
      );
    }
    await expect(
      page.getByText(`${String(view.leitner.due)} due now.`, { exact: true }),
    ).toBeVisible();
    if (view.leitner.nextDueAt !== null) {
      const date = await localDate(page, view.leitner.nextDueAt);
      await expect(page.getByText(`Next due: ${date}.`, { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText(/^Next due:/)).toHaveCount(0);
    }
    await expect(
      page.getByText(
        'Questions you miss go to box 1. Each right answer moves a question up one box and waits longer; a right answer in box 5 takes it out.',
        { exact: true },
      ),
    ).toBeVisible();
  });

  test('AC-22: Back to the start returns to the start screen with focus on View progress', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await examThenPractice(page, request);
    await openProgressView(page);

    await backToStartButton(page).click();

    await expect(viewProgressButton(page)).toBeFocused();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Mock exam', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice', exact: true }),
    ).toBeVisible();
  });

  test('AC-22: the progress survives a reload and shows the same Progress card', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { view } = await examThenPractice(page, request);

    await page.reload();

    await expect(
      page.getByText(
        `Seen ${String(view.overall.seen)} of ${String(view.overall.questions)} questions · ${String(view.overall.percent)}% of answers correct`,
        { exact: true },
      ),
    ).toBeVisible();
  });
});

test.describe('the progress view with many attempts', () => {
  test('AC-22: "Recent attempts" holds the last 20 attempts, newest first', async ({
    page,
    request,
  }) => {
    const { bank, progress } = await seededProgressView(page, request, () =>
      manyAttempts(23, (index) => (index % 3 === 0 ? 'practice' : 'exam')),
    );
    const view = dashboardView(bank, progress, Date.now());

    const rows = await tableRows(tableWith(page, 'Mode'));

    expect(view.attempts.total).toBe(23);
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row[1])).toEqual(
      view.recent.map((row) => (row.mode === 'exam' ? 'Mock exam' : 'Practice')),
    );
    expect(rows.map((row) => row[3])).toEqual(
      view.recent.map((row) =>
        row.estimated === null
          ? '—'
          : `${String(row.estimated)} (${row.passed === true ? 'PASS' : 'FAIL'})`,
      ),
    );
  });
});

/* ====================================================================== AC-23: the exam score chart */

function chartMarks(page: Page) {
  return page.getByRole('main').locator('[data-score]');
}

test.describe('mock exam scores chart', () => {
  test('AC-23: after one mock exam the chart is aria-hidden and has one mark with the stored score', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const { progress } = await examThenPractice(page, request);
    const exams = progress.attempts.filter((attempt) => attempt.mode === 'exam');
    expect(exams).toHaveLength(1);

    await openProgressView(page);

    await expect(
      page.getByRole('heading', { level: 3, name: 'Mock exam scores', exact: true }),
    ).toBeVisible();
    await expect(chartMarks(page)).toHaveCount(1);
    await expect(chartMarks(page).first()).toHaveAttribute(
      'data-score',
      String(exams[0]?.estimated),
    );
    await expect(
      page
        .getByRole('main')
        .locator('svg[aria-hidden="true"]')
        .filter({ has: page.locator('[data-score]') }),
    ).toHaveCount(1);
    await expect(page.getByText('No mock exams yet.', { exact: true })).toHaveCount(0);
  });

  test('AC-23: one mark per exam attempt, oldest first, practice sets left out', async ({
    page,
    request,
  }) => {
    const { progress } = await seededProgressView(page, request, () =>
      manyAttempts(6, (index) => (index === 2 ? 'practice' : 'exam')),
    );
    const scores = progress.attempts
      .filter((attempt) => attempt.mode === 'exam')
      .map((attempt) => String(attempt.estimated));
    expect(scores).toHaveLength(5);

    const marks = await chartMarks(page).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-score')),
    );

    expect(marks).toEqual(scores);
  });

  test('AC-23: with 22 mock exams the chart shows the last 20, oldest first', async ({
    page,
    request,
  }) => {
    const { progress } = await seededProgressView(page, request, () =>
      manyAttempts(22, () => 'exam'),
    );
    const scores = progress.attempts.slice(-20).map((attempt) => String(attempt.estimated));

    const marks = await chartMarks(page).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-score')),
    );

    expect(marks).toHaveLength(20);
    expect(marks).toEqual(scores);
  });

  test('AC-23: with only practice attempts it says "No mock exams yet." and has no chart', async ({
    page,
    request,
  }) => {
    await seededProgressView(page, request, () => manyAttempts(3, () => 'practice'));

    await expect(
      page.getByRole('heading', { level: 3, name: 'Mock exam scores', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('No mock exams yet.', { exact: true })).toBeVisible();
    await expect(chartMarks(page)).toHaveCount(0);
    const rows = await tableRows(tableWith(page, 'Mode'));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row[1] === 'Practice' && row[3] === '—')).toBe(true);
  });
});
