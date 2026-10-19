// Spec 028: question review, guide links and the report link (AC-17 to AC-21).
// Exam attempts are seeded with the same helpers as the spec 027 tests; practice sets are played in
// the browser. Expected texts come from the bank, the saved answers and the files of the repository.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Session } from '../../packages/quiz-core/src/index.ts';
import type { Question } from '../../packages/schema/src/index.ts';
import { REPO_URL } from '../../apps/site/src/practice/links.ts';
import type { ResultsView } from '../../apps/site/src/practice/results.ts';
import {
  correctKeysOf,
  endAndSubmit,
  fetchBank,
  listRows,
  mixed,
  nextButton,
  questionHeading,
  resumeButton,
  seedSavedExam,
  seededSession,
  wrongKeysOf,
} from './practice-support.ts';
import {
  DOMAIN_2_SET,
  LINKED_CUE,
  LINKED_QUESTION_LINKS,
  NEW_TAB_SUFFIX,
  REPORT_LINK_NAME,
  answerAndCheck,
  backToResultsButton,
  checkAnswerButton,
  diagramTitle,
  endPracticeButton,
  escapeRegExp,
  expectOptionsList,
  expectReviewHead,
  feedbackHeading,
  filterButton,
  guideTitle,
  mainText,
  nextPlainButton,
  nextQuestionButton,
  openExamResults,
  openStartScreen,
  optionsOfSession,
  optionsOfShown,
  previousQuestionButton,
  readQuestionId,
  reportLinks,
  reviewButton,
  routeBank,
  showAnswerButton,
  showAnswerOnly,
  shownQuestion,
  startPractice,
  withLinks,
  withoutLinks,
} from './practice-modes-support.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

test.use({ viewport: DESKTOP_VIEWPORT });

/** The links of the practice island (the page footer, which is inside main, is left out). */
function islandLinks(page: Page): Locator {
  return page.locator('#practice-host').getByRole('link');
}

/** The new-issue URL of a question, built from the spec (not from the code under test). */
function expectedReportHref(id: string): string {
  const query = new URLSearchParams([
    ['template', 'question-report.yml'],
    ['title', `question: ${id}`],
    ['question', id],
  ]).toString();
  return `${REPO_URL}/issues/new?${query}`;
}

async function expectReportLinksFor(page: Page, id: string): Promise<void> {
  const links = reportLinks(page);
  await expect(links.first()).toBeVisible();
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    await expect(link).toHaveAttribute('href', expectedReportHref(id));
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAccessibleName(
      new RegExp(`^${escapeRegExp(REPORT_LINK_NAME)}.*${escapeRegExp(NEW_TAB_SUFFIX)}$`),
    );
  }
}

/** The mixed exam seeded, resumed, submitted: the exam results, with what was expected of them. */
async function examResults(
  page: Page,
  request: APIRequestContext,
): Promise<{ bank: Question[]; session: Session; expected: ResultsView }> {
  const bank = await fetchBank(request);
  const { session, expected } = await openExamResults(page, bank, mixed);
  return { bank, session, expected };
}

/* ====================================================================== AC-17: the review screen */

test.describe('Review buttons and the review screen', () => {
  test('AC-17: every row of the exam results has a "Review question n" button with the text "Review"', async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);

    await expect(page.getByRole('button', { name: /^Review question \d+$/ })).toHaveCount(
      expected.counts.all,
    );
    for (const item of expected.items) {
      await expect(reviewButton(page, item.number)).toBeVisible();
      await expect(reviewButton(page, item.number)).toHaveText(/^Review/);
    }
  });

  test('AC-17: the result rows stay single list items, one per question', async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);

    await expect(listRows(page).filter({ hasText: /\bQuestion \d+\b/ })).toHaveCount(
      expected.counts.all,
    );
    for (const item of expected.items) {
      await expect(listRows(page).filter({ has: reviewButton(page, item.number) })).toHaveCount(1);
    }
  });

  for (const status of ['correct', 'incorrect', 'unanswered'] as const) {
    test(`AC-17: Review question n opens "Question n of N" with status, domain and task, type label and stem (${status})`, async ({
      page,
      request,
    }) => {
      const { session, expected } = await examResults(page, request);
      const rows = expected.items.filter((item) => item.status === status);
      // A "Choose k" question when there is one, so both kinds of label are covered over the three runs.
      const row =
        rows.find((item) => session.exam.items[item.number - 1]?.question.type === 'multiple') ??
        rows[0];
      expect(row, `the exam has a ${status} question`).toBeDefined();
      if (row === undefined) return;

      await reviewButton(page, row.number).click();

      await expect(questionHeading(page, row.number, expected.total)).toBeFocused();
      const question = session.exam.items[row.number - 1]?.question as Question;
      await expectReviewHead(page, row, expected.total, question);
    });

    test(`AC-17: the review lists the options in this attempt's display order with why and tags as answered (${status})`, async ({
      page,
      request,
    }) => {
      const { session, expected } = await examResults(page, request);
      const rows = expected.items.filter((item) => item.status === status);
      const row =
        rows.find((item) => session.exam.items[item.number - 1]?.question.type === 'multiple') ??
        rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;
      const options = optionsOfSession(session, row.number - 1);
      // The saved order is shuffled: letters are not the keys.
      const order = session.exam.items[row.number - 1]?.optionOrder ?? [];
      expect(order.join('')).not.toBe([...order].sort().join(''));

      await reviewButton(page, row.number).click();

      await expect(questionHeading(page, row.number, expected.total)).toBeVisible();
      await expectOptionsList(page, options);
    });
  }

  test('AC-17: Previous question is disabled on question 1 and Next question moves by one', async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);

    await reviewButton(page, 1).click();

    await expect(questionHeading(page, 1, expected.total)).toBeVisible();
    await expect(previousQuestionButton(page)).toBeDisabled();
    await expect(nextQuestionButton(page)).toBeEnabled();
    await nextQuestionButton(page).click();
    await expect(questionHeading(page, 2, expected.total)).toBeVisible();
    await expect(previousQuestionButton(page)).toBeEnabled();
    await previousQuestionButton(page).click();
    await expect(questionHeading(page, 1, expected.total)).toBeVisible();
  });

  test('AC-17: Next question is disabled on the last question and Previous question moves back by one', async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);

    await reviewButton(page, expected.total).click();

    await expect(questionHeading(page, expected.total, expected.total)).toBeVisible();
    await expect(nextQuestionButton(page)).toBeDisabled();
    await expect(previousQuestionButton(page)).toBeEnabled();
    await previousQuestionButton(page).click();
    await expect(questionHeading(page, expected.total - 1, expected.total)).toBeVisible();
    await expect(nextQuestionButton(page)).toBeEnabled();
  });

  test('AC-17: Next question goes through all the questions, whatever the results filter', async ({
    page,
    request,
  }) => {
    const { session, expected } = await examResults(page, request);
    const index = expected.items.findIndex(
      (item, at) => item.status !== 'correct' && expected.items[at + 1]?.status === 'correct',
    );
    expect(index, 'an incorrect question followed by a correct one').toBeGreaterThanOrEqual(0);
    await filterButton(page, 'Incorrect').click();

    await reviewButton(page, index + 1).click();
    await nextQuestionButton(page).click();

    const next = expected.items[index + 1];
    expect(next).toBeDefined();
    if (next === undefined) return;
    await expectReviewHead(
      page,
      next,
      expected.total,
      session.exam.items[index + 1]?.question as Question,
    );
  });

  test("AC-17: Back to results shows the results with the filter that was active and focus on that question's Review button", async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);
    const row = expected.items.find((item) => item.status !== 'correct');
    expect(row).toBeDefined();
    if (row === undefined) return;
    await filterButton(page, 'Incorrect').click();
    await reviewButton(page, row.number).click();
    await expect(questionHeading(page, row.number, expected.total)).toBeVisible();

    await backToResultsButton(page).click();

    await expect(reviewButton(page, row.number)).toBeFocused();
    await expect(listRows(page).filter({ hasText: /\bQuestion \d+\b/ })).toHaveCount(
      expected.counts.incorrect,
    );
    await expect(
      page.getByRole('heading', { level: 2, name: 'Questions', exact: true }),
    ).toBeVisible();
  });

  test('AC-17: Back to results with the Flagged filter keeps the Flagged rows', async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);
    const row = expected.items.find((item) => item.flagged);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await filterButton(page, 'Flagged').click();
    await reviewButton(page, row.number).click();

    await backToResultsButton(page).click();

    await expect(reviewButton(page, row.number)).toBeFocused();
    await expect(listRows(page).filter({ hasText: /\bQuestion \d+\b/ })).toHaveCount(
      expected.counts.flagged,
    );
  });

  test('AC-17: practice results rows open the same review screen', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const first = await shownQuestion(page, bank);
    const firstKeys = [first.order[0] ?? ''];
    await answerAndCheck(page, first, firstKeys);
    await nextPlainButton(page).click();
    const second = await shownQuestion(page, bank);
    await showAnswerOnly(page);
    await endPracticeButton(page).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Practice results' })).toBeVisible();

    await reviewButton(page, 2).click();

    await expect(questionHeading(page, 2, set.total)).toBeFocused();
    await expectReviewHead(
      page,
      {
        number: 2,
        status: 'unanswered',
        domain: second.question.domain,
        task: second.question.task,
        stem: second.question.stem,
      },
      set.total,
      second.question,
    );
    await expectOptionsList(page, optionsOfShown(second, []));
    await backToResultsButton(page).click();
    await expect(reviewButton(page, 2)).toBeFocused();
    await reviewButton(page, 1).click();
    const sameSet = new Set(correctKeysOf(first.question));
    const right = firstKeys.length === sameSet.size && firstKeys.every((key) => sameSet.has(key));
    await expectReviewHead(
      page,
      {
        number: 1,
        status: right ? 'correct' : 'incorrect',
        domain: first.question.domain,
        task: first.question.task,
        stem: first.question.stem,
      },
      set.total,
      first.question,
    );
    await expectOptionsList(page, optionsOfShown(first, firstKeys));
  });
});

/* ====================================================================== AC-18: links in the explanation */

const GUIDE_PATH = 'd1/1-3-data-security';

/**
 * The mixed exam seeded, with bank.json routed so that question 1 has a cue and all three links and
 * question 2 has neither. Ends on the exam results.
 */
async function linkedExamResults(
  page: Page,
  request: APIRequestContext,
  options: { abortLinksJson?: boolean } = {},
): Promise<{ linked: Question; plain: Question; total: number }> {
  const bank = await fetchBank(request);
  const session = seededSession(bank, mixed);
  const firstId = session.exam.items[0]?.question.id ?? '';
  const secondId = session.exam.items[1]?.question.id ?? '';
  const transform = (questions: Question[]): Question[] =>
    questions.map((question) =>
      question.id === firstId
        ? withLinks(question)
        : question.id === secondId
          ? withoutLinks(question)
          : question,
    );
  await routeBank(page, transform);
  if (options.abortLinksJson === true) {
    await page.route('**/practice/links.json', (route) => route.abort());
  }
  await seedSavedExam(page, session);
  await resumeButton(page).click();
  await endAndSubmit(page);
  const routed = transform(bank);
  return {
    linked: routed.find((question) => question.id === firstId) as Question,
    plain: routed.find((question) => question.id === secondId) as Question,
    total: session.exam.items.length,
  };
}

test.describe('links in the explanation', () => {
  test('AC-18: a question with a cue shows the "Exam cue" heading and the cue', async ({
    page,
    request,
  }) => {
    const { total } = await linkedExamResults(page, request);

    await reviewButton(page, 1).click();

    await expect(questionHeading(page, 1, total)).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 3, name: 'Exam cue', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(LINKED_CUE, { exact: true })).toBeVisible();
  });

  test('AC-18: "AWS documentation" lists one link per reference, in order, with the URL as text and href', async ({
    page,
    request,
  }) => {
    const { linked } = await linkedExamResults(page, request);

    await reviewButton(page, 1).click();

    await expect(
      page.getByRole('heading', { level: 3, name: 'AWS documentation', exact: true }),
    ).toBeVisible();
    const hrefs = await page
      .getByRole('main')
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    expect(hrefs.filter((href) => linked.references.includes(href))).toEqual(linked.references);
    for (const url of linked.references) {
      const link = page.getByRole('main').locator(`a[href="${url}"]`);
      await expect(link).toHaveCount(1);
      await expect(link).toContainText(url);
      await expect(link).toHaveAccessibleName(
        new RegExp(`^${escapeRegExp(url)}.*${escapeRegExp(NEW_TAB_SUFFIX)}$`),
      );
    }
  });

  test('AC-18: "In this guide" has the Guide, Diagram and Lab links of the question', async ({
    page,
    request,
  }) => {
    await linkedExamResults(page, request);
    const guide = `Guide: ${guideTitle(GUIDE_PATH)}`;
    const diagram = `Diagram: ${diagramTitle(LINKED_QUESTION_LINKS.diagram)}`;
    const lab = `Lab: ${LINKED_QUESTION_LINKS.lab}`;

    await reviewButton(page, 1).click();

    await expect(
      page.getByRole('heading', { level: 3, name: 'In this guide', exact: true }),
    ).toBeVisible();
    const main = page.getByRole('main');
    const expectedLinks = [
      { text: guide, href: '/d1/1-3-data-security/' },
      {
        text: diagram,
        href: `/d1/1-3-data-security/#diagram-${LINKED_QUESTION_LINKS.diagram}`,
      },
      { text: lab, href: `${REPO_URL}/tree/main/labs/${LINKED_QUESTION_LINKS.lab}` },
    ];
    for (const { text, href } of expectedLinks) {
      const link = main.locator(`a[href="${href}"]`);
      await expect(link, text).toHaveCount(1);
      await expect(link, text).toContainText(text);
      await expect(link, text).toHaveAccessibleName(
        new RegExp(`^${escapeRegExp(text)}.*${escapeRegExp(NEW_TAB_SUFFIX)}$`),
      );
    }
  });

  test('AC-18: the guide, diagram and lab links come in this order', async ({ page, request }) => {
    await linkedExamResults(page, request);

    await reviewButton(page, 1).click();

    const names = await islandLinks(page).evaluateAll((links) =>
      links.map((link) => (link.textContent ?? '').trim()),
    );
    const guideAt = names.findIndex((name) => name.startsWith('Guide: '));
    const diagramAt = names.findIndex((name) => name.startsWith('Diagram: '));
    const labAt = names.findIndex((name) => name.startsWith('Lab: '));
    expect(guideAt).toBeGreaterThanOrEqual(0);
    expect(diagramAt).toBeGreaterThan(guideAt);
    expect(labAt).toBeGreaterThan(diagramAt);
  });

  test('AC-18: every link in the block opens in a new tab and says so in its name', async ({
    page,
    request,
  }) => {
    const { linked } = await linkedExamResults(page, request);

    await reviewButton(page, 1).click();

    const links = islandLinks(page);
    // Report link + references + guide, diagram and lab.
    await expect(links).toHaveCount(1 + linked.references.length + 3);
    const count = await links.count();
    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveAccessibleName(new RegExp(`${escapeRegExp(NEW_TAB_SUFFIX)}$`));
    }
  });

  test('AC-18: a question without links has no "In this guide" heading, no cue, and still has its references', async ({
    page,
    request,
  }) => {
    const { plain, total } = await linkedExamResults(page, request);

    await reviewButton(page, 2).click();

    await expect(questionHeading(page, 2, total)).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 3, name: 'AWS documentation', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'In this guide' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'Exam cue' })).toHaveCount(0);
    for (const url of plain.references) {
      await expect(page.getByRole('main').locator(`a[href="${url}"]`)).toHaveCount(1);
    }
  });

  test('AC-18: the explanation block on the practice screen has the same links after the reveal', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await routeBank(page, (questions) => questions.map(withLinks));
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await showAnswerOnly(page);

    await expect(
      page.getByRole('heading', { level: 3, name: 'Exam cue', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 3, name: 'AWS documentation', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 3, name: 'In this guide', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('main').locator(`a[href="${shown.question.references[0] ?? ''}"]`),
    ).toHaveCount(1);
    await expect(page.getByRole('main').locator('a[href="/d1/1-3-data-security/"]')).toHaveCount(1);
    const links = islandLinks(page);
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await expect(links.nth(index)).toHaveAttribute('target', '_blank');
      await expect(links.nth(index)).toHaveAttribute('rel', /noopener/);
    }
  });
});

/* ====================================================================== AC-19: figure id and links.json */

interface LinksJson {
  pages: Record<string, string>;
  diagrams: Record<string, { title: string; page: string | null }>;
}

async function fetchLinksIndex(request: APIRequestContext): Promise<LinksJson> {
  const response = await request.get('/practice/links.json');
  expect(response.status(), '/practice/links.json').toBe(200);
  return (await response.json()) as LinksJson;
}

test.describe('the guide pages and links.json', () => {
  test('AC-19: the 1.3 guide page has a figure with id "diagram-s3-sse-kms-upload"', async ({
    page,
  }) => {
    const response = await page.goto('/d1/1-3-data-security/');

    expect(response?.status()).toBe(200);
    await expect(page.locator('figure[id="diagram-s3-sse-kms-upload"]')).toHaveCount(1);
  });

  test('AC-19: the 2.2 guide page has a figure with id "diagram-alb-asg-az-failure"', async ({
    page,
  }) => {
    await page.goto('/d2/2-2-high-availability/');

    await expect(page.locator('figure[id="diagram-alb-asg-az-failure"]')).toHaveCount(1);
  });

  test('AC-19: page#diagram-<id> scrolls to the figure', async ({ page }) => {
    await page.goto('/d1/1-3-data-security/#diagram-s3-sse-kms-upload');

    await expect(page.locator('figure[id="diagram-s3-sse-kms-upload"]')).toBeInViewport();
  });

  test('AC-19: /practice/links.json maps the 1.3 page path to the title of that page', async ({
    request,
  }) => {
    const index = await fetchLinksIndex(request);

    expect(index.pages['/d1/1-3-data-security']).toBe(guideTitle(GUIDE_PATH));
  });

  test('AC-19: /practice/links.json maps s3-sse-kms-upload to its title and the 1.3 page', async ({
    request,
  }) => {
    const index = await fetchLinksIndex(request);

    expect(index.diagrams['s3-sse-kms-upload']).toEqual({
      title: diagramTitle('s3-sse-kms-upload'),
      page: '/d1/1-3-data-security',
    });
    expect(index.diagrams['alb-asg-az-failure']).toEqual({
      title: diagramTitle('alb-asg-az-failure'),
      page: '/d2/2-2-high-availability',
    });
  });

  test('AC-19: page paths start with "/", have no trailing slash, and the home page is not listed', async ({
    request,
  }) => {
    const index = await fetchLinksIndex(request);

    const paths = Object.keys(index.pages);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).not.toContain('/');
    for (const path of paths) {
      expect(path.startsWith('/'), path).toBe(true);
      expect(path.endsWith('/'), path).toBe(false);
    }
  });
});

/* ====================================================================== AC-20: links.json fails */

test.describe('when links.json fails to load', () => {
  test('AC-20: the review still works and the guide link shows its path, with no diagram link', async ({
    page,
    request,
  }) => {
    const { total } = await linkedExamResults(page, request, { abortLinksJson: true });

    await reviewButton(page, 1).click();

    await expect(questionHeading(page, 1, total)).toBeVisible();
    const guide = page.getByRole('main').locator('a[href="/d1/1-3-data-security/"]');
    await expect(guide).toHaveCount(1);
    await expect(guide).toContainText('Guide: /d1/1-3-data-security');
    await expect(guide).not.toContainText(guideTitle(GUIDE_PATH));
    await expect(page.getByRole('link', { name: /^Diagram:/ })).toHaveCount(0);
    await expect(
      page.getByRole('main').locator(`a[href="/d1/1-3-data-security/#diagram-s3-sse-kms-upload"]`),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { level: 3, name: 'AWS documentation', exact: true }),
    ).toBeVisible();
  });

  test('AC-20: a practice set still works and its explanation shows the guide path', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await routeBank(page, (questions) => questions.map(withLinks));
    await page.route('**/practice/links.json', (route) => route.abort());
    await openStartScreen(page);
    const set = await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await answerAndCheck(page, shown, correctKeysOf(shown.question));

    await expect(questionHeading(page, 1, set.total)).toBeVisible();
    await expect(feedbackHeading(page, 'Correct')).toBeVisible();
    await expect(page.getByRole('main').locator('a[href="/d1/1-3-data-security/"]')).toContainText(
      'Guide: /d1/1-3-data-security',
    );
    await expect(page.getByRole('link', { name: /^Diagram:/ })).toHaveCount(0);
  });
});

/* ====================================================================== AC-21: the report link */

test.describe('report a problem with this question', () => {
  test('AC-21: the exam screen has the link, with the href of the question shown', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, mixed);
    await seedSavedExam(page, session);

    await resumeButton(page).click();

    await expect(questionHeading(page, 1, session.exam.items.length)).toBeVisible();
    await expectReportLinksFor(page, session.exam.items[0]?.question.id ?? '');
    await expect(reportLinks(page)).toHaveCount(1);
  });

  test('AC-21: on the exam screen the link follows the question when you move on', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, mixed);
    await seedSavedExam(page, session);
    await resumeButton(page).click();

    await page.getByRole('button', { name: 'Next', exact: true }).click();

    await expect(questionHeading(page, 2, session.exam.items.length)).toBeVisible();
    await expectReportLinksFor(page, session.exam.items[1]?.question.id ?? '');
  });

  test('AC-21: on the exam screen the link sits in the question card under the buttons', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const session = seededSession(bank, mixed);
    await seedSavedExam(page, session);
    await resumeButton(page).click();

    const link = await reportLinks(page).first().boundingBox();
    const next = await nextButton(page).boundingBox();

    expect(link).not.toBeNull();
    expect(next).not.toBeNull();
    expect(link?.y ?? 0).toBeGreaterThan((next?.y ?? 0) + (next?.height ?? 0) - 1);
  });

  test('AC-21: the practice screen has the link before the reveal', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await expect(showAnswerButton(page)).toBeVisible();

    await expectReportLinksFor(page, shown.question.id);
  });

  test('AC-21: the practice screen has the link after the reveal, and the explanation shows the question id', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    const shown = await shownQuestion(page, bank);

    await answerAndCheck(page, shown, wrongKeysOf(shown.question));

    await expectReportLinksFor(page, shown.question.id);
    expect(await readQuestionId(page)).toBe(shown.question.id);
    await expect(checkAnswerButton(page)).toHaveCount(0);
  });

  test('AC-21: the review screen has the link of the question reviewed, and its id', async ({
    page,
    request,
  }) => {
    const { session, expected } = await examResults(page, request);
    const row = expected.items[2];
    expect(row).toBeDefined();
    if (row === undefined) return;

    await reviewButton(page, row.number).click();

    await expect(questionHeading(page, row.number, expected.total)).toBeVisible();
    await expectReportLinksFor(page, row.id);
    expect(row.id).toBe(session.exam.items[2]?.question.id);
    expect(await mainText(page)).toMatch(new RegExp(`Question ID\\s*${escapeRegExp(row.id)}`));
  });

  test('AC-21: the link on the review screen changes with the question', async ({
    page,
    request,
  }) => {
    const { expected } = await examResults(page, request);
    await reviewButton(page, 1).click();
    await expectReportLinksFor(page, expected.items[0]?.id ?? '');

    await nextQuestionButton(page).click();

    await expect(questionHeading(page, 2, expected.total)).toBeVisible();
    await expectReportLinksFor(page, expected.items[1]?.id ?? '');
  });
});
