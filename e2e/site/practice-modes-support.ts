// Helpers for the spec 028 e2e tests: practice modes, review screen, links and progress view.
// Questions come from /practice/bank.json. A practice set is never saved, so the question shown is
// found by matching its stem and option texts against the bank; the numbers expected are computed
// with the pure helpers and quiz-core, not typed in.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  buildExam,
  buildPracticeExam,
  emptyProgress,
  practicePool,
  recordSession,
  saveSession,
  sessionReducer,
  startSession,
} from '../../packages/quiz-core/src/index.ts';
import type { PoolFilter, Session } from '../../packages/quiz-core/src/index.ts';
import { domains, tasks } from '../../packages/schema/src/index.ts';
import type { DomainId, Progress, Question, TaskId } from '../../packages/schema/src/index.ts';
import {
  MS_PER_QUESTION,
  PRACTICE_PATH,
  PROGRESS_KEY,
  allCorrect,
  correctKeysOf,
  endAndSubmit,
  expectedResults,
  normalise,
  optionCards,
  questionHeading,
  readStored,
  resumeButton,
  seedSavedExam,
  seededSession,
  startButton,
  wrongKeysOf,
  type Scenario,
} from './practice-support.ts';
import type { ResultsView } from '../../apps/site/src/practice/results.ts';

export const DAY_MS = 86_400_000;
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/* ---------- plain helpers ---------- */

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The visible text of the main area, whitespace normalised. */
export async function mainText(page: Page): Promise<string> {
  return normalise(await page.getByRole('main').innerText());
}

/** A number that is not part of a longer number. */
export function numberRegex(n: number): string {
  return `(?<!\\d)${String(n)}(?!\\d)`;
}

/** "1 question in this set." or "<k> questions in this set." */
export function setLineText(k: number): string {
  return k === 1 ? '1 question in this set.' : `${String(k)} questions in this set.`;
}

/** Every question wrong: a single wrong key each. */
export const allWrong: Scenario = (question) => ({ keys: wrongKeysOf(question), flag: false });

/** Date as the browser formats it (the app uses toLocaleDateString in the browser). */
export async function localDate(page: Page, ms: number): Promise<string> {
  return page.evaluate((value) => new Date(value).toLocaleDateString(), ms);
}

/* ---------- locators: start screen ---------- */

export type PracticeBy = 'Domain' | 'Task' | 'Service' | 'Weak spots';
export const PRACTICE_BY: readonly PracticeBy[] = ['Domain', 'Task', 'Service', 'Weak spots'];

export function practiceByRadio(page: Page, by: PracticeBy): Locator {
  return page.getByRole('radio', { name: by, exact: true });
}

export function practiceByGroup(page: Page): Locator {
  return page
    .getByRole('group', { name: 'Practice by', exact: true })
    .or(page.getByRole('radiogroup', { name: 'Practice by', exact: true }));
}

export function choiceSelect(page: Page, by: 'Domain' | 'Task' | 'Service'): Locator {
  return page.getByRole('combobox', { name: by, exact: true });
}

export function sizeSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Number of questions', exact: true });
}

export function startPracticeButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Start practice', exact: true });
}

export function viewProgressButton(page: Page): Locator {
  return page.getByRole('button', { name: 'View progress', exact: true });
}

export function backToStartButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Back to the start', exact: true });
}

export async function optionTexts(select: Locator): Promise<string[]> {
  return (await select.locator('option').allInnerTexts()).map((text) => normalise(text));
}

export async function optionDisabledFlags(select: Locator): Promise<boolean[]> {
  return select
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).disabled));
}

export async function selectedText(select: Locator): Promise<string> {
  return select.evaluate((element) =>
    ((element as HTMLSelectElement).selectedOptions[0]?.text ?? '').replace(/\s+/g, ' ').trim(),
  );
}

export const EMPTY_PROGRESS_TEXT =
  'No answers yet. Take a mock exam or a practice set and your progress shows here.';
export const NO_WEAK_SPOTS_TEXT =
  'No weak spots yet. Questions you miss come back here at once, then 1, 3, 7 and 14 days after each right answer.';
export const NO_MATCH_TEXT = 'No questions match this choice yet.';
export const NOT_ANSWERED_FEEDBACK = 'Not answered: this counts as a miss.';
export const REPORT_LINK_NAME = 'Report a problem with this question';
/** The boxes of the Weak spots list: "Box 1 (due at once)", "Box 2 (1 day)"… */
export const LEITNER_BOX_LABELS: readonly string[] = [
  'due at once',
  '1 day',
  '3 days',
  '7 days',
  '14 days',
];
export const NEW_TAB_SUFFIX = '(opens in a new tab)';

/* ---------- expected start screen content ---------- */

export function poolSize(
  bank: readonly Question[],
  progress: Progress,
  filter: PoolFilter,
): number {
  return practicePool(bank, progress, filter).length;
}

export function domainTitle(id: DomainId): string {
  const found = domains.find((domain) => domain.id === id);
  if (found === undefined) throw new Error(`no domain ${String(id)}`);
  return found.title;
}

export function taskTitle(id: TaskId): string {
  const found = tasks.find((task) => task.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found.title;
}

/** The label of the pool of a filter: "Domain 2: …", "Task 1.3: …", "Service: s3", "Weak spots". */
export function labelOf(filter: PoolFilter): string {
  switch (filter.kind) {
    case 'domain':
      return `Domain ${String(filter.domain)}: ${domainTitle(filter.domain)}`;
    case 'task':
      return `Task ${filter.task}: ${taskTitle(filter.task)}`;
    case 'service':
      return `Service: ${filter.service}`;
    case 'weak':
      return 'Weak spots';
  }
}

export function domainOptionText(bank: readonly Question[], id: DomainId): string {
  const n = poolSize(bank, emptyProgress(), { kind: 'domain', domain: id });
  return `Domain ${String(id)}: ${domainTitle(id)} (${String(n)})`;
}

export function taskOptionText(bank: readonly Question[], id: TaskId): string {
  const n = poolSize(bank, emptyProgress(), { kind: 'task', task: id });
  return `${id} ${taskTitle(id)} (${String(n)})`;
}

export function serviceOptionText(service: string, count: number): string {
  return `${service} (${String(count)})`;
}

/* ---------- starting a practice set ---------- */

export interface SetChoice {
  by: PracticeBy;
  /** Domain id, task id or service, depending on `by`. */
  value?: number | string;
  /** 10, 20, 30 or 'all'; 10 when left out. */
  size?: number | 'all';
}

/** Domain 2 with 10 questions: the set of the spec's examples. */
export const DOMAIN_2_SET: SetChoice = { by: 'Domain', value: 2, size: 10 };

export function filterOf(choice: SetChoice): PoolFilter {
  switch (choice.by) {
    case 'Domain':
      return { kind: 'domain', domain: Number(choice.value ?? 1) as DomainId };
    case 'Task':
      return { kind: 'task', task: String(choice.value ?? '1.1') as TaskId };
    case 'Service':
      return { kind: 'service', service: String(choice.value ?? 'ec2') };
    case 'Weak spots':
      return { kind: 'weak', now: Date.now() };
  }
}

export interface ChosenSet {
  filter: PoolFilter;
  label: string;
  /** Questions that match the choice. */
  available: number;
  /** Questions in the set: min(size, available), or all of them. */
  total: number;
}

/** Sets the Practice card to `choice` (does not start). Progress is what the app has stored. */
export async function chooseSet(
  page: Page,
  bank: readonly Question[],
  choice: SetChoice,
): Promise<ChosenSet> {
  const progress = (await readProgress(page)) ?? emptyProgress();
  const filter = filterOf(choice);
  const available = poolSize(bank, progress, filter);
  await practiceByRadio(page, choice.by).check();
  if (choice.by === 'Domain') {
    const id = Number(choice.value) as DomainId;
    await choiceSelect(page, 'Domain').selectOption({ label: domainOptionText(bank, id) });
  } else if (choice.by === 'Task') {
    await choiceSelect(page, 'Task').selectOption({
      label: taskOptionText(bank, String(choice.value) as TaskId),
    });
  } else if (choice.by === 'Service') {
    await choiceSelect(page, 'Service').selectOption({
      label: serviceOptionText(String(choice.value), available),
    });
  }
  const size = choice.size ?? 10;
  await sizeSelect(page).selectOption({
    label: size === 'all' ? `All (${String(available)})` : String(size),
  });
  return {
    filter,
    label: labelOf(filter),
    available,
    total: size === 'all' ? available : Math.min(size, available),
  };
}

/** From the start screen: choose, press Start practice and wait for question 1. */
export async function startPractice(
  page: Page,
  bank: readonly Question[],
  choice: SetChoice = DOMAIN_2_SET,
): Promise<ChosenSet> {
  const set = await chooseSet(page, bank, choice);
  expect(set.total, 'the bank has questions for this choice').toBeGreaterThan(0);
  await startPracticeButton(page).click();
  await expect(questionHeading(page, 1, set.total)).toBeVisible();
  return set;
}

/** Opens /practice/ and waits for the Practice card. */
export async function openStartScreen(page: Page): Promise<void> {
  await page.goto(PRACTICE_PATH);
  await expect(startPracticeButton(page)).toBeVisible();
}

/* ---------- locators: practice screen and explanation ---------- */

export function checkAnswerButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Check answer', exact: true });
}

export function showAnswerButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Show answer', exact: true });
}

export function finishPracticeButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Finish practice', exact: true });
}

export function endPracticeButton(page: Page): Locator {
  return page.getByRole('button', { name: 'End practice', exact: true });
}

export function newPracticeSetButton(page: Page): Locator {
  return page.getByRole('button', { name: 'New practice set', exact: true });
}

export function feedbackHeading(page: Page, text: string): Locator {
  return page.getByRole('heading', { level: 3, name: text, exact: true });
}

export function explanationList(page: Page): Locator {
  return page.getByRole('list', { name: 'Answer options', exact: true });
}

export function reportLinks(page: Page): Locator {
  return page.getByRole('main').getByRole('link', { name: REPORT_LINK_NAME });
}

export function nextPlainButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Next', exact: true });
}

export function previousPlainButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Previous', exact: true });
}

/* ---------- locators: results and review ---------- */

export function reviewButton(page: Page, n: number): Locator {
  return page.getByRole('button', { name: `Review question ${String(n)}`, exact: true });
}

export function previousQuestionButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Previous question', exact: true });
}

export function nextQuestionButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Next question', exact: true });
}

export function backToResultsButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Back to results', exact: true });
}

export function filterButton(page: Page, name: 'All' | 'Incorrect' | 'Flagged'): Locator {
  return page.getByRole('button', { name: new RegExp(`^${name}\\b`) });
}

/** The value (dd) that follows a term (dt) in a description list. */
export function termValue(page: Page, term: string): Locator {
  return page
    .getByRole('main')
    .getByRole('term')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(term)}\\s*$`) })
    .locator('xpath=following-sibling::*[1]');
}

/** The table that has a column header called `header`. */
export function tableWith(page: Page, header: string): Locator {
  return page
    .getByRole('main')
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: header, exact: true }) });
}

/** The cells of the body rows of a table, as normalised texts. */
export async function tableRows(table: Locator): Promise<string[][]> {
  return table
    .locator('tr')
    .evaluateAll((rows) =>
      rows
        .filter((row) => row.querySelector('td') !== null)
        .map((row) =>
          Array.from(row.querySelectorAll('th, td')).map((cell) =>
            (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
          ),
        ),
    );
}

/* ---------- finding the question shown ---------- */

export interface Shown {
  question: Question;
  /** The original keys in display order. */
  order: string[];
}

/** Which bank question the screen shows, and in which option order. */
export async function shownQuestion(page: Page, bank: readonly Question[]): Promise<Shown> {
  const text = await mainText(page);
  const candidates = bank
    .filter((question) => text.includes(normalise(question.stem)))
    .sort((a, b) => b.stem.length - a.stem.length);
  const question = candidates[0];
  if (question === undefined) throw new Error('the question shown is not in the bank');
  const cards = (await optionCards(page).allTextContents()).map((card) => normalise(card));
  expect(cards, 'option cards of the question shown').toHaveLength(question.options.length);
  const order = cards.map((card) => {
    const matches = question.options
      .filter((option) => card.endsWith(normalise(option.text)))
      .sort((a, b) => b.text.length - a.text.length);
    const found = matches[0];
    if (found === undefined) throw new Error(`no option of ${question.id} matches "${card}"`);
    return found.key;
  });
  expect(new Set(order).size, 'each card is a different option').toBe(order.length);
  return { question, order };
}

/** The id printed on the explanation or report line ("Question ID d1-1.3-0007"). */
export async function readQuestionId(page: Page): Promise<string> {
  const match = /Question ID\s*(d[1-4]-[1-4]\.\d-\d{4})/.exec(await mainText(page));
  if (match?.[1] === undefined) throw new Error('no "Question ID" on the screen');
  return match[1];
}

/** Clicks the option cards of the original `keys` of the question shown. */
export async function selectKeys(page: Page, shown: Shown, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const position = shown.order.indexOf(key);
    expect(position, `key ${key} is shown`).toBeGreaterThanOrEqual(0);
    await optionCards(page).nth(position).click();
  }
}

/** Selects `keys` on the question shown and presses Check answer. */
export async function answerAndCheck(
  page: Page,
  shown: Shown,
  keys: readonly string[],
): Promise<void> {
  await selectKeys(page, shown, keys);
  await checkAnswerButton(page).click();
  await expect(explanationList(page)).toBeVisible();
}

/** Presses Show answer on a question with nothing selected. */
export async function showAnswerOnly(page: Page): Promise<void> {
  await showAnswerButton(page).click();
  await expect(explanationList(page)).toBeVisible();
}

/** The practice question shown, after pressing Next `times` times. */
export async function pressNext(page: Page, times: number): Promise<void> {
  for (let done = 0; done < times; done += 1) await nextPlainButton(page).click();
}

/** Finds a domain whose reviewed questions include one of `type`. */
export function domainWithType(bank: readonly Question[], type: Question['type']): DomainId {
  const found = bank.find((question) => question.status === 'reviewed' && question.type === type);
  if (found === undefined) throw new Error(`the bank has no ${type}-answer question`);
  return found.domain;
}

/** From a practice question, presses Next until a question of `type` is shown. */
export async function nextOfType(
  page: Page,
  bank: readonly Question[],
  type: Question['type'],
  total: number,
): Promise<Shown> {
  for (let n = 1; n <= total; n += 1) {
    const shown = await shownQuestion(page, bank);
    if (shown.question.type === type) return shown;
    if (n < total) {
      await nextPlainButton(page).click();
      await expect(questionHeading(page, n + 1, total)).toBeVisible();
    }
  }
  throw new Error(`no ${type}-answer question in the set`);
}

/* ---------- expected explanation ---------- */

export interface ExpectedOption {
  letter: string;
  text: string;
  why: string;
  correct: boolean;
  selected: boolean;
}

export function optionsOfShown(shown: Shown, selectedKeys: readonly string[]): ExpectedOption[] {
  return shown.order.map((key, position) => {
    const option = shown.question.options.find((candidate) => candidate.key === key);
    if (option === undefined) throw new Error(`no option ${key}`);
    return {
      letter: String.fromCharCode(65 + position),
      text: option.text,
      why: option.why,
      correct: option.correct,
      selected: selectedKeys.includes(key),
    };
  });
}

/** The options of question `index` of an attempt, in its display order, as answered. */
export function optionsOfSession(session: Session, index: number): ExpectedOption[] {
  const item = session.exam.items[index];
  if (item === undefined) throw new Error(`no question at index ${String(index)}`);
  const selected = session.answers[item.question.id] ?? [];
  return optionsOfShown({ question: item.question, order: item.optionOrder }, selected);
}

/** Checks the "Answer options" list: letter, text, why and the two tags of every option. */
export async function expectOptionsList(page: Page, expected: ExpectedOption[]): Promise<void> {
  const items = explanationList(page).getByRole('listitem');
  await expect(items).toHaveCount(expected.length);
  for (const [index, option] of expected.entries()) {
    const item = items.nth(index);
    const where = `option ${option.letter}`;
    const text = normalise(await item.innerText());
    expect(text.startsWith(option.letter), `${where} starts with its letter`).toBe(true);
    expect(text, `${where} text`).toContain(normalise(option.text));
    expect(text, `${where} why`).toContain(normalise(option.why));
    await expect(item.getByText('Correct answer', { exact: true }), `${where} tag`).toHaveCount(
      option.correct ? 1 : 0,
    );
    await expect(item.getByText('Your answer', { exact: true }), `${where} tag`).toHaveCount(
      option.selected ? 1 : 0,
    );
  }
}

export const STATUS_TEXT = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  unanswered: 'Not answered',
} as const;

export function typeLabelOf(question: Question): string {
  return question.type === 'single'
    ? 'Single answer'
    : `Choose ${String(correctKeysOf(question).length)}`;
}

/** Checks the head of the review screen: heading, status, domain and task, type label and stem. */
export async function expectReviewHead(
  page: Page,
  row: {
    number: number;
    status: keyof typeof STATUS_TEXT;
    domain: number;
    task: string;
    stem: string;
  },
  total: number,
  question: Question,
): Promise<void> {
  await expect(questionHeading(page, row.number, total)).toBeVisible();
  const text = await mainText(page);
  expect(text).toMatch(
    new RegExp(
      `${STATUS_TEXT[row.status]}\\W+Domain ${String(row.domain)} · Task ${escapeRegExp(row.task)}`,
    ),
  );
  expect(text).toContain(normalise(row.stem));
  await expect(
    page.getByRole('main').getByText(typeLabelOf(question), { exact: true }),
  ).toBeVisible();
}

/* ---------- storage ---------- */

export async function readProgress(page: Page): Promise<Progress | null> {
  const raw = await readStored(page, PROGRESS_KEY);
  return raw === null ? null : (JSON.parse(raw) as Progress);
}

/** Waits until the progress record holds `attempts` attempts, then returns it. */
export async function waitForAttempts(page: Page, attempts: number): Promise<Progress> {
  await expect
    .poll(async () => (await readProgress(page))?.attempts.length ?? 0, {
      message: `${String(attempts)} attempt(s) in the progress record`,
    })
    .toBe(attempts);
  const progress = await readProgress(page);
  if (progress === null) throw new Error('no progress stored');
  return progress;
}

/** Puts a progress record in localStorage and reloads the start screen. */
export async function seedProgress(page: Page, progress: Progress): Promise<void> {
  await page.goto(PRACTICE_PATH);
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [PROGRESS_KEY, JSON.stringify(progress)],
  );
  await page.reload();
  await expect(startPracticeButton(page)).toBeVisible();
}

export interface AttemptSpec {
  mode: 'exam' | 'practice';
  startedAt: number;
  scenario?: Scenario;
}

function played(session: Session, scenario: Scenario, startedAt: number): Session {
  let state = session;
  const now = startedAt + 1;
  session.exam.items.forEach((item, index) => {
    const pick = scenario(item.question, index);
    state = sessionReducer(state, { type: 'goTo', index, now });
    state = sessionReducer(state, { type: 'answer', selected: pick.keys, now });
  });
  return state;
}

/** A progress record with one submitted attempt per spec, recorded with quiz-core. */
export function buildProgress(bank: readonly Question[], specs: readonly AttemptSpec[]): Progress {
  let progress = emptyProgress();
  specs.forEach((spec, index) => {
    const seed = 1_000 + index;
    const scenario = spec.scenario ?? allCorrect;
    let session: Session;
    if (spec.mode === 'exam') {
      const exam = buildExam(bank, { seed });
      session = startSession(exam, {
        mode: 'exam',
        now: spec.startedAt,
        durationMs: exam.items.length * MS_PER_QUESTION,
      });
    } else {
      const pool = practicePool(bank, emptyProgress(), { kind: 'domain', domain: 2 });
      const exam = buildPracticeExam(pool, { seed, size: 10 });
      session = startSession(exam, { mode: 'practice', now: spec.startedAt });
    }
    session = played(session, scenario, spec.startedAt);
    session = sessionReducer(session, { type: 'submit', now: spec.startedAt + 60_000 });
    progress = recordSession(progress, session);
  });
  return progress;
}

/** `count` attempts, one a day, the last one an hour ago; modes and scenarios take turns. */
export function manyAttempts(
  count: number,
  modeOf: (index: number) => 'exam' | 'practice',
): AttemptSpec[] {
  const scenarios: Scenario[] = [allCorrect, allWrong];
  const last = Date.now() - 3_600_000;
  return Array.from({ length: count }, (_, index) => ({
    mode: modeOf(index),
    startedAt: last - (count - 1 - index) * DAY_MS,
    scenario: scenarios[index % scenarios.length] ?? allCorrect,
  }));
}

/* ---------- flows ---------- */

/** A seeded mock exam, resumed and submitted: the exam results screen. */
export async function openExamResults(
  page: Page,
  bank: readonly Question[],
  scenario: Scenario,
): Promise<{ session: Session; expected: ResultsView }> {
  const session = seededSession(bank, scenario);
  await seedSavedExam(page, session);
  await resumeButton(page).click();
  await endExamAndSubmit(page);
  return { session, expected: expectedResults(saveSession(session), bank) };
}

/**
 * Like `endAndSubmit`, for any width: on a phone "End exam" is inside the navigator disclosure
 * ("All questions"), which is collapsed until opened.
 */
export async function endExamAndSubmit(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^All questions/ });
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await endAndSubmit(page);
}

/**
 * From the start screen: a practice set with Q1 answered and checked (first option card), then End
 * practice. Ends on the practice results.
 */
export async function finishSmallPractice(
  page: Page,
  bank: readonly Question[],
  choice: SetChoice = DOMAIN_2_SET,
): Promise<{ set: ChosenSet; shown: Shown; selectedKeys: string[] }> {
  const set = await startPractice(page, bank, choice);
  const shown = await shownQuestion(page, bank);
  const selectedKeys = [shown.order[0] ?? ''];
  await answerAndCheck(page, shown, selectedKeys);
  await endPracticeButton(page).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Practice results', exact: true }),
  ).toBeVisible();
  return { set, shown, selectedKeys };
}

/* ---------- links and titles from the repository files ---------- */

export const LINKED_QUESTION_LINKS = {
  guide: '/d1/1-3-data-security',
  diagram: 's3-sse-kms-upload',
  lab: '00-site-hosting',
} as const;
export const LINKED_CUE =
  'Look for the word "least" in the requirement: it points to a minimal grant.';

/** The title in the frontmatter of a docs page, e.g. `d1/1-3-data-security`. */
export function guideTitle(pagePath: string): string {
  const file = resolve(REPO_ROOT, 'apps', 'site', 'src', 'content', 'docs', pagePath, 'index.mdx');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
  const front = parse(match?.[1] ?? '') as { title?: string };
  if (front.title === undefined) throw new Error(`${file} has no title`);
  return front.title;
}

/** The title of diagrams/<id>.yaml. */
export function diagramTitle(id: string): string {
  const data = parse(readFileSync(resolve(REPO_ROOT, 'diagrams', `${id}.yaml`), 'utf8')) as {
    title?: string;
  };
  if (data.title === undefined) throw new Error(`diagram ${id} has no title`);
  return data.title;
}

/** Serves bank.json with `transform` applied to the questions of the real one. */
export async function routeBank(
  page: Page,
  transform: (questions: Question[]) => Question[],
): Promise<void> {
  await page.route('**/practice/bank.json', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { questions: Question[] };
    await route.fulfill({ response, json: { questions: transform(body.questions) } });
  });
}

export function withLinks(question: Question): Question {
  return { ...question, cue: LINKED_CUE, links: { ...LINKED_QUESTION_LINKS } };
}

export function withoutLinks(question: Question): Question {
  const copy: Question = { ...question };
  delete copy.cue;
  delete copy.links;
  return copy;
}

/* ---------- accessibility, layout, keyboard ---------- */

export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export async function axeViolations(page: Page) {
  await page.waitForLoadState('load');
  const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

/** Presses Tab until the focus is on a radio or checkbox of a question; returns the presses used. */
export async function tabToOption(page: Page, limit = 80): Promise<number> {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab');
    const onOption = await page.evaluate(() => {
      const element = document.activeElement;
      return (
        element instanceof HTMLInputElement &&
        element.name.startsWith('q-') &&
        (element.type === 'radio' || element.type === 'checkbox')
      );
    });
    if (onOption) return presses;
  }
  return -1;
}

/** Presses Tab until the focus is on the button with this text (at most `limit` presses). */
export async function tabToButton(page: Page, text: string, limit = 40): Promise<boolean> {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab');
    const found = await page.evaluate((wanted) => {
      const element = document.activeElement;
      return element instanceof HTMLButtonElement && (element.textContent ?? '').trim() === wanted;
    }, text);
    if (found) return true;
  }
  return false;
}

/** The outline of the focused element, e.g. "solid 2px", "auto 1px" or "none 0px". */
export async function focusedOutline(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return 'none 0px';
    const style = window.getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
}

/** The outline of the card (label) around the focused input. */
export async function focusedCardOutline(page: Page): Promise<string> {
  return page.evaluate(() => {
    const card = document.activeElement?.closest('label');
    if (!card) return 'no card';
    const style = window.getComputedStyle(card);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
}

export function isVisibleOutline(outline: string): boolean {
  return !outline.startsWith('none') && !/^\S+ 0(px)?$/.test(outline) && outline !== 'no card';
}

/** The "x of N" fallback so a start screen without a saved exam can be asserted on. */
export async function expectStartScreen(page: Page): Promise<void> {
  await expect(startButton(page)).toBeVisible();
  await expect(startPracticeButton(page)).toBeVisible();
}
