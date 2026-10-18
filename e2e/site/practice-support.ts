// Helpers for the practice exam e2e tests (spec 027).
// The real bank comes from /practice/bank.json; saved sessions are read from localStorage and
// mapped to the keys of the bank with the quiz-core functions, so no test hard-codes a question.
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  buildExam,
  restoreSession,
  saveSession,
  sessionReducer,
  startSession,
} from '../../packages/quiz-core/src/index.ts';
import type { Session } from '../../packages/quiz-core/src/index.ts';
import type { Question, SavedSession } from '../../packages/schema/src/index.ts';
import { formatClock } from '../../apps/site/src/practice/format.ts';
import { resultsView } from '../../apps/site/src/practice/results.ts';
import type { ResultsView } from '../../apps/site/src/practice/results.ts';

export const SESSION_KEY = 'field-guide:practice:session';
export const PROGRESS_KEY = 'field-guide:practice:progress';

export const PRACTICE_PATH = '/practice/';
export const MS_PER_QUESTION = 120_000;

/** Phone viewport of the spec (AC-14), narrower than 72rem. */
export const PHONE_VIEWPORT = { width: 390, height: 844 };
/** Desktop viewport of the spec (AC-14), wider than 72rem. */
export const WIDE_VIEWPORT = { width: 1440, height: 900 };

export const TIME_UP_TEXT = 'Time is up: the exam was submitted automatically.';
export const FOOTNOTE_TEXT =
  'An estimate, not an official result: the real exam uses scaled scoring and includes unscored questions.';
export const NOT_SAVED_TEXT = /Progress can['’]t be saved in this browser\./;
export const NOT_RESTORED_TEXT =
  'Your saved exam could not be restored because the questions changed.';

/* ---------- bank and plan ---------- */

/** The reviewed questions the site serves. */
export async function fetchBank(request: APIRequestContext): Promise<Question[]> {
  const response = await request.get('/practice/bank.json');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { questions: Question[] };
  return body.questions;
}

export interface ExamPlan {
  /** Number of questions of the exam the bank allows (sum of picked, at most 65). */
  size: number;
  /** True when the bank fills all 65 questions. */
  complete: boolean;
  limitMs: number;
  byDomain: { id: number; quota: number; picked: number }[];
}

/** What `buildExam` with the 65-question quotas gives for this bank (any seed has the same plan). */
export function planOf(bank: readonly Question[]): ExamPlan {
  const exam = buildExam(bank, { seed: 1 });
  return {
    size: exam.items.length,
    complete: exam.complete,
    limitMs: exam.items.length * MS_PER_QUESTION,
    byDomain: Object.entries(exam.byDomain).map(([id, plan]) => ({
      id: Number(id),
      quota: plan.quota,
      picked: plan.picked,
    })),
  };
}

export function questionById(bank: readonly Question[], id: string): Question {
  const found = bank.find((question) => question.id === id);
  if (found === undefined) throw new Error(`question ${id} is not in the bank`);
  return found;
}

export function correctKeysOf(question: Question): string[] {
  return question.options.filter((option) => option.correct).map((option) => option.key);
}

/** One selection that is surely wrong: a single key that is not correct. */
export function wrongKeysOf(question: Question): string[] {
  const wrong = question.options.find((option) => !option.correct);
  if (wrong === undefined) throw new Error(`${question.id} has no wrong option`);
  return [wrong.key];
}

/* ---------- scenarios: which answers an attempt gives ---------- */

export interface Pick {
  /** Original option keys to select; [] leaves the question unanswered. */
  keys: string[];
  flag: boolean;
}
export type Scenario = (question: Question, index: number) => Pick;

/** Every question answered right, none flagged. */
export const allCorrect: Scenario = (question) => ({ keys: correctKeysOf(question), flag: false });

/** Right, wrong, unanswered in turn; every 4th question from the 2nd on is flagged. */
export const mixed: Scenario = (question, index) => ({
  keys: [correctKeysOf(question), wrongKeysOf(question), []][index % 3] ?? [],
  flag: index % 4 === 1,
});

/** A session in the state the scenario describes, built with quiz-core (fixed seed). */
export function seededSession(
  bank: readonly Question[],
  scenario: Scenario,
  options: { now: number; current?: number } = { now: Date.now() },
): Session {
  const exam = buildExam(bank, { seed: 20_261_018 });
  // Started a minute ago, so the deadline is far ahead.
  const startedAt = options.now - 60_000;
  let session = startSession(exam, {
    mode: 'exam',
    now: startedAt,
    durationMs: exam.items.length * MS_PER_QUESTION,
  });
  exam.items.forEach((item, index) => {
    const pick = scenario(item.question, index);
    session = sessionReducer(session, { type: 'goTo', index, now: startedAt + 1 });
    session = sessionReducer(session, { type: 'answer', selected: pick.keys, now: startedAt + 1 });
    if (pick.flag) {
      session = sessionReducer(session, { type: 'flag', flagged: true, now: startedAt + 1 });
    }
  });
  return sessionReducer(session, {
    type: 'goTo',
    index: options.current ?? 0,
    now: startedAt + 1,
  });
}

/** Puts a session in localStorage and reloads, so the start screen offers to resume it. */
export async function seedSavedExam(page: Page, session: Session): Promise<void> {
  await page.goto(PRACTICE_PATH);
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [SESSION_KEY, JSON.stringify(saveSession(session))],
  );
  await page.reload();
}

/* ---------- saved session ---------- */

export async function readStored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

export async function readSaved(page: Page): Promise<SavedSession> {
  const raw = await readStored(page, SESSION_KEY);
  if (raw === null) throw new Error('no saved exam in localStorage');
  return JSON.parse(raw) as SavedSession;
}

/** Waits until the exam has been saved at least once, then returns it. */
export async function waitForSaved(page: Page): Promise<SavedSession> {
  await expect.poll(() => readStored(page, SESSION_KEY), { message: 'saved exam' }).not.toBeNull();
  return readSaved(page);
}

/** The session as the app sees it (questions looked up in the bank). */
export function restore(saved: SavedSession, bank: readonly Question[]): Session {
  const result = restoreSession(saved, bank);
  if (!result.ok) throw new Error(`saved exam cannot be restored: ${result.errors.join('; ')}`);
  return result.session;
}

/** What `resultsView` says for the saved exam, submitted one second after its start. */
export function expectedResults(saved: SavedSession, bank: readonly Question[]): ResultsView {
  const submitted = sessionReducer(restore(saved, bank), {
    type: 'submit',
    now: saved.startedAt + 1_000,
  });
  return resultsView(submitted);
}

/* ---------- locators ---------- */

export function startButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Start exam', exact: true });
}

export function resumeButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Resume exam/ });
}

export function discardButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Discard', exact: true });
}

/** The "Question n of N" heading of the exam screen. */
export function questionHeading(page: Page, n: number, total: number): Locator {
  return page.getByRole('heading', {
    name: `Question ${String(n)} of ${String(total)}`,
    exact: true,
  });
}

export function pageHeading(page: Page): Locator {
  return page.getByRole('heading', { level: 1, name: 'Practice test' });
}

/** The navigator button of question `n`, whatever its state. */
export function navButton(page: Page, n: number): Locator {
  return page.getByRole('button', { name: new RegExp(`^Question ${String(n)}, `) });
}

export function allNavButtons(page: Page): Locator {
  return page.getByRole('button', { name: /^Question \d+, / });
}

export function nextButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Next', exact: true });
}

export function previousButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Previous', exact: true });
}

export function reviewAnswersButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Review answers', exact: true });
}

export function endExamButton(page: Page): Locator {
  return page.getByRole('button', { name: 'End exam', exact: true });
}

export function submitExamButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Submit exam', exact: true });
}

export function flagButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Flag for review', exact: true });
}

export function newExamButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Start a new exam', exact: true });
}

export function confirmDialog(page: Page): Locator {
  return page.getByRole('alertdialog');
}

/** The "x of N answered" text of the status strip. */
export function answeredText(page: Page, answered: number, total: number): Locator {
  return page
    .getByRole('main')
    .getByText(`${String(answered)} of ${String(total)} answered`, { exact: true });
}

/** The remaining-time text of the status strip (its own element, whose whole text is H:MM:SS). */
export function timerLocator(page: Page): Locator {
  return page
    .getByRole('main')
    .getByText(/^\d+:\d{2}:\d{2}$/)
    .first();
}

export function parseClock(text: string): number {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(text.trim());
  if (match === null) throw new Error(`not an H:MM:SS clock: ${text}`);
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
}

export async function readTimerMs(page: Page): Promise<number> {
  return parseClock((await timerLocator(page).textContent()) ?? '');
}

/**
 * The option cards of the question shown, in display order: the `label` that wraps each radio or
 * checkbox input.
 */
export function optionCards(page: Page): Locator {
  return page
    .getByRole('main')
    .locator('label')
    .filter({ has: page.locator('input[type="radio"], input[type="checkbox"]') });
}

export function optionInputs(page: Page, type: 'single' | 'multiple'): Locator {
  return page.getByRole('main').getByRole(type === 'single' ? 'radio' : 'checkbox');
}

export function normalise(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Expected `H:MM:SS` of the exam limit. */
export function limitClock(plan: ExamPlan): string {
  return formatClock(plan.limitMs);
}

/* ---------- flows ---------- */

/** Opens /practice/ and waits for the start screen. */
export async function openStart(page: Page): Promise<void> {
  await page.goto(PRACTICE_PATH);
  await expect(startButton(page)).toBeVisible();
}

/** From the start screen: Start exam, question 1 shown. Returns the saved exam. */
export async function startExam(page: Page, plan: ExamPlan): Promise<SavedSession> {
  await startButton(page).click();
  await expect(questionHeading(page, 1, plan.size)).toBeVisible();
  return waitForSaved(page);
}

/** The position (0-based) of option `key` among the cards of question `index` of the saved exam. */
export function positionOf(saved: SavedSession, index: number, key: string): number {
  const item = saved.exam.items[index];
  if (item === undefined) throw new Error(`no question at index ${String(index)}`);
  const position = item.optionOrder.indexOf(key);
  if (position < 0) throw new Error(`key ${key} is not an option of ${item.id}`);
  return position;
}

/** Clicks the cards of the given original keys on the question shown. */
export async function choose(
  page: Page,
  saved: SavedSession,
  index: number,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys)
    await optionCards(page)
      .nth(positionOf(saved, index, key))
      .click();
}

/** The index of the first question of the saved exam with the type wanted. */
export function firstOfType(
  saved: SavedSession,
  bank: readonly Question[],
  type: 'single' | 'multiple',
): number {
  const index = saved.exam.items.findIndex((item) => questionById(bank, item.id).type === type);
  if (index < 0) throw new Error(`the exam has no ${type}-answer question`);
  return index;
}

/** Click the navigator button of question `n` (1-based) and wait for its heading. */
export async function goToQuestion(page: Page, n: number, total: number): Promise<void> {
  await navButton(page, n).click();
  await expect(questionHeading(page, n, total)).toBeVisible();
}

/**
 * Plays a scenario on a started exam: for each question selects the keys and flags as told, then
 * Next (or Review answers on the last one). Ends on the review list. Returns the saved exam as
 * it was stored after the last action.
 */
export async function playScenario(
  page: Page,
  bank: readonly Question[],
  plan: ExamPlan,
  scenario: Scenario,
): Promise<SavedSession> {
  const first = await waitForSaved(page);
  const expectedAnswers: Record<string, string[]> = {};
  const expectedFlagged: string[] = [];
  for (const [index, item] of first.exam.items.entries()) {
    const question = questionById(bank, item.id);
    const pick = scenario(question, index);
    await expect(questionHeading(page, index + 1, plan.size)).toBeVisible();
    await choose(page, first, index, pick.keys);
    if (pick.flag) {
      await flagButton(page).click();
      expectedFlagged.push(item.id);
    }
    if (pick.keys.length > 0) {
      expectedAnswers[item.id] = question.options
        .map((option) => option.key)
        .filter((key) => pick.keys.includes(key));
    }
    if (index === plan.size - 1) await reviewAnswersButton(page).click();
    else await nextButton(page).click();
  }
  await expect(submitExamButton(page)).toBeVisible();
  await expect
    .poll(async () => {
      const saved = await readSaved(page);
      return { answers: saved.answers, flagged: [...saved.flagged].sort() };
    })
    .toEqual({ answers: expectedAnswers, flagged: expectedFlagged.sort() });
  return readSaved(page);
}

/** Submits from the review list; confirms the dialog when it opens. */
export async function submitFromReview(page: Page): Promise<void> {
  await submitExamButton(page).click();
  const dialog = confirmDialog(page);
  // With unanswered or flagged questions a confirmation opens; otherwise the results show at once.
  await expect(dialog.or(newExamButton(page))).toBeVisible();
  if (await dialog.isVisible())
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(newExamButton(page)).toBeVisible();
}

/** From an exam question: End exam, then Submit exam (and confirm), ending on the results. */
export async function endAndSubmit(page: Page): Promise<void> {
  await endExamButton(page).click();
  await expect(submitExamButton(page)).toBeVisible();
  await submitFromReview(page);
}

/* ---------- misc ---------- */

/** Sets the colour scheme and Starlight's stored theme before the page loads. */
export async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => {
    window.localStorage.setItem('starlight-theme', value);
  }, theme);
}

/** True when the page scrolls sideways. */
export async function scrollsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

/** The rows of the results lists (domain rows and question rows are list items). */
export function listRows(page: Page): Locator {
  return page.getByRole('main').getByRole('listitem');
}

/** Whether `text` says that `label` has the count `n` ("3 unanswered", "Unanswered 3", "Unanswered: 3"). */
export function mentionsCount(text: string, label: string, n: number): boolean {
  const count = String(n);
  const before = new RegExp(`(?<!\\d)${count}\\s+${label}\\b`, 'i');
  const after = new RegExp(`\\b${label}\\W+${count}(?!\\d)`, 'i');
  return before.test(text) || after.test(text);
}

/** The letters after "Your answer" and after the answer label "Correct" in the text of a question row. */
export function lettersOfRow(rowText: string): { yours: string[]; correct: string[] } {
  const text = normalise(rowText);
  const read = (label: string): string[] => {
    const match = new RegExp(`${label}:?\\s*([A-F]\\b(?:[,\\s]+[A-F]\\b)*)`).exec(text);
    return match?.[1]?.match(/[A-F]/g) ?? [];
  };
  return { yours: read('Your answer'), correct: read('Correct') };
}
