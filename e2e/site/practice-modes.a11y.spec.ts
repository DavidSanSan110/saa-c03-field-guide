// Spec 028: accessibility, layout and keyboard use of the new screens (AC-24 to AC-26).
// The progress view can only be reached once an attempt is recorded, so it is checked with data;
// the empty Progress card is part of the start screen.
import { expect, test, type Page } from '@playwright/test';
import { emptyProgress } from '../../packages/quiz-core/src/index.ts';
import type { Question } from '../../packages/schema/src/index.ts';
import {
  PHONE_VIEWPORT,
  WIDE_VIEWPORT,
  fetchBank,
  mixed,
  optionCards,
  questionHeading,
  scrollsHorizontally,
  useTheme,
} from './practice-support.ts';
import {
  DOMAIN_2_SET,
  PRACTICE_BY,
  answerAndCheck,
  axeViolations,
  backToResultsButton,
  buildProgress,
  checkAnswerButton,
  choiceSelect,
  domainOptionText,
  endPracticeButton,
  finishSmallPractice,
  focusedCardOutline,
  focusedOutline,
  isVisibleOutline,
  manyAttempts,
  nextPlainButton,
  openExamResults,
  openStartScreen,
  poolSize,
  practiceByRadio,
  reviewButton,
  seedProgress,
  setLineText,
  showAnswerOnly,
  shownQuestion,
  sizeSelect,
  selectedText,
  startPractice,
  startPracticeButton,
  tabToButton,
  tabToOption,
  viewProgressButton,
  type PracticeBy,
} from './practice-modes-support.ts';
import { wrongKeysOf } from './practice-support.ts';
import { DESKTOP_VIEWPORT } from './support.ts';

/* ====================================================================== AC-24: axe */

type Screen = {
  name: string;
  open: (page: Page, bank: Question[]) => Promise<void>;
};

const SCREENS: Screen[] = [
  ...PRACTICE_BY.map((by: PracticeBy): Screen => ({
    name: `the start screen with "${by}" chosen`,
    open: async (page) => {
      await openStartScreen(page);
      await practiceByRadio(page, by).check();
    },
  })),
  {
    name: 'the start screen with progress recorded',
    open: async (page, bank) => {
      await seedProgress(
        page,
        buildProgress(
          bank,
          manyAttempts(3, (index) => (index === 1 ? 'practice' : 'exam')),
        ),
      );
      await expect(viewProgressButton(page)).toBeVisible();
    },
  },
  {
    name: 'a practice question before the reveal',
    open: async (page, bank) => {
      await openStartScreen(page);
      await startPractice(page, bank, DOMAIN_2_SET);
    },
  },
  {
    name: 'a practice question after Check answer',
    open: async (page, bank) => {
      await openStartScreen(page);
      await startPractice(page, bank, DOMAIN_2_SET);
      const shown = await shownQuestion(page, bank);
      await answerAndCheck(page, shown, wrongKeysOf(shown.question));
    },
  },
  {
    name: 'a practice question after Show answer',
    open: async (page, bank) => {
      await openStartScreen(page);
      await startPractice(page, bank, DOMAIN_2_SET);
      await showAnswerOnly(page);
    },
  },
  {
    name: 'the practice results',
    open: async (page, bank) => {
      await openStartScreen(page);
      await finishSmallPractice(page, bank);
    },
  },
  {
    name: 'the question review screen',
    open: async (page, bank) => {
      const { expected } = await openExamResults(page, bank, mixed);
      const row = expected.items.find((item) => item.status === 'incorrect') ?? expected.items[0];
      await reviewButton(page, row?.number ?? 1).click();
      await expect(backToResultsButton(page)).toBeVisible();
    },
  },
  {
    name: 'the progress view with data',
    open: async (page, bank) => {
      await seedProgress(
        page,
        buildProgress(
          bank,
          manyAttempts(4, (index) => (index === 1 ? 'practice' : 'exam')),
        ),
      );
      await viewProgressButton(page).click();
      await expect(
        page.getByRole('button', { name: 'Back to the start', exact: true }),
      ).toBeVisible();
    },
  },
];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility in the ${theme} theme`, () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
    });

    for (const screen of SCREENS) {
      test(`AC-24: axe finds no violations on ${screen.name} (${theme})`, async ({
        page,
        request,
      }) => {
        test.setTimeout(60_000);
        const bank = await fetchBank(request);

        await screen.open(page, bank);

        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await axeViolations(page)).toEqual([]);
      });
    }

    test(`AC-24: axe finds no violations on the practice results with the Incorrect filter (${theme})`, async ({
      page,
      request,
    }) => {
      const bank = await fetchBank(request);
      await openStartScreen(page);
      await finishSmallPractice(page, bank);
      await page.getByRole('button', { name: /^Incorrect\b/ }).click();

      expect(await axeViolations(page)).toEqual([]);
    });
  });
}

/* ====================================================================== AC-25: no sideways scroll */

for (const [label, viewport] of [
  ['390x844', PHONE_VIEWPORT],
  ['1440x900', WIDE_VIEWPORT],
] as const) {
  test.describe(`layout at ${label}`, () => {
    test.use({ viewport });

    const WIDTH_SCREENS: Screen[] = [
      ...SCREENS,
      {
        name: 'the start screen with the longest task titles',
        open: async (page) => {
          await openStartScreen(page);
          await practiceByRadio(page, 'Task').check();
          await expect(choiceSelect(page, 'Task')).toBeVisible();
        },
      },
    ];

    for (const screen of WIDTH_SCREENS) {
      test(`AC-25: ${screen.name} does not scroll sideways at ${label}`, async ({
        page,
        request,
      }) => {
        test.setTimeout(60_000);
        const bank = await fetchBank(request);

        await screen.open(page, bank);

        expect(await scrollsHorizontally(page)).toBe(false);
      });
    }
  });
}

/* ====================================================================== AC-26: keyboard */

test.describe('keyboard', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-26: the arrow keys change "Practice by"', async ({ page }) => {
    await openStartScreen(page);
    await practiceByRadio(page, 'Domain').focus();

    await page.keyboard.press('ArrowRight');
    await expect(practiceByRadio(page, 'Task')).toBeChecked();
    await expect(practiceByRadio(page, 'Task')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(practiceByRadio(page, 'Service')).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(practiceByRadio(page, 'Weak spots')).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(practiceByRadio(page, 'Service')).toBeChecked();
    await page.keyboard.press('ArrowUp');
    await expect(practiceByRadio(page, 'Task')).toBeChecked();
    await expect(choiceSelect(page, 'Task')).toBeVisible();
    await expect(practiceByRadio(page, 'Domain')).not.toBeChecked();
  });

  test('AC-26: Tab goes from the checked choice to the select, the size and Start practice', async ({
    page,
  }) => {
    await openStartScreen(page);
    await practiceByRadio(page, 'Domain').focus();

    await page.keyboard.press('Tab');
    await expect(choiceSelect(page, 'Domain')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sizeSelect(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(startPracticeButton(page)).toBeFocused();
  });

  test('AC-26: the selects change with the arrow keys and Start practice starts with Enter', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    const second = poolSize(bank, emptyProgress(), { kind: 'domain', domain: 2 });
    await openStartScreen(page);
    await practiceByRadio(page, 'Domain').focus();
    await page.keyboard.press('Tab');
    await expect(choiceSelect(page, 'Domain')).toBeFocused();

    await page.keyboard.press('ArrowDown');

    expect(await selectedText(choiceSelect(page, 'Domain'))).toBe(domainOptionText(bank, 2));
    await expect(page.getByText(setLineText(Math.min(10, second)), { exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(sizeSelect(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    expect(await selectedText(sizeSelect(page))).toBe('20');
    await page.keyboard.press('Tab');
    await expect(startPracticeButton(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(questionHeading(page, 1, Math.min(20, second))).toBeFocused();
  });

  test('AC-26: Space on Start practice starts the set too', async ({ page, request }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    const total = Math.min(10, poolSize(bank, emptyProgress(), { kind: 'domain', domain: 1 }));

    await startPracticeButton(page).focus();
    await page.keyboard.press('Space');

    await expect(questionHeading(page, 1, total)).toBeVisible();
  });

  test('AC-26: Space selects an option, Enter on Check answer reveals, and the answer is checked', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    await questionHeading(
      page,
      1,
      Math.min(10, poolSize(bank, emptyProgress(), { kind: 'domain', domain: 2 })),
    ).focus();

    expect(await tabToOption(page)).toBeGreaterThan(0);
    await page.keyboard.press('Space');
    await expect(optionCards(page).first().locator('input')).toBeChecked();
    expect(await tabToButton(page, 'Check answer')).toBe(true);
    await expect(checkAnswerButton(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('heading', { level: 3, name: /^(Correct|Incorrect)$/ }),
    ).toBeFocused();
    await expect(checkAnswerButton(page)).toHaveCount(0);
  });

  test('AC-26: Enter on Show answer reveals a question with nothing selected', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);

    expect(await tabToButton(page, 'Show answer')).toBe(true);
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('heading', {
        level: 3,
        name: 'Not answered: this counts as a miss.',
        exact: true,
      }),
    ).toBeFocused();
  });

  test('AC-26: the focused option card shows a focus outline that the other cards do not have', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    await questionHeading(
      page,
      1,
      Math.min(10, poolSize(bank, emptyProgress(), { kind: 'domain', domain: 2 })),
    ).focus();

    expect(await tabToOption(page)).toBeGreaterThan(0);

    expect(isVisibleOutline(await focusedCardOutline(page))).toBe(true);
    const last = (await optionCards(page).count()) - 1;
    const outline = await optionCards(page)
      .nth(last)
      .evaluate((card) => {
        const style = window.getComputedStyle(card);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
    expect(isVisibleOutline(outline)).toBe(false);
  });

  test('AC-26: Start practice, Check answer and Next show a visible focus outline when reached with Tab', async ({
    page,
  }) => {
    await openStartScreen(page);
    await practiceByRadio(page, 'Domain').focus();
    expect(await tabToButton(page, 'Start practice')).toBe(true);
    expect(isVisibleOutline(await focusedOutline(page)), 'Start practice').toBe(true);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { level: 2, name: /^Question 1 of \d+$/ }),
    ).toBeFocused();
    expect(await tabToOption(page)).toBeGreaterThan(0);
    await page.keyboard.press('Space');

    expect(await tabToButton(page, 'Check answer')).toBe(true);
    expect(isVisibleOutline(await focusedOutline(page)), 'Check answer').toBe(true);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { level: 3, name: /^(Correct|Incorrect)$/ }),
    ).toBeFocused();

    expect(await tabToButton(page, 'Next')).toBe(true);
    expect(isVisibleOutline(await focusedOutline(page)), 'Next').toBe(true);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { level: 2, name: /^Question 2 of \d+$/ }),
    ).toBeFocused();
  });

  test('AC-26: End practice and New practice set work with the keyboard and show a focus outline', async ({
    page,
    request,
  }) => {
    const bank = await fetchBank(request);
    await openStartScreen(page);
    await startPractice(page, bank, DOMAIN_2_SET);
    await nextPlainButton(page).focus();

    expect(await tabToButton(page, 'End practice')).toBe(true);
    expect(isVisibleOutline(await focusedOutline(page)), 'End practice').toBe(true);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Practice results', exact: true }),
    ).toBeFocused();

    expect(await tabToButton(page, 'New practice set')).toBe(true);
    expect(isVisibleOutline(await focusedOutline(page)), 'New practice set').toBe(true);
    await page.keyboard.press('Enter');
    await expect(startPracticeButton(page)).toBeFocused();
    await expect(endPracticeButton(page)).toHaveCount(0);
  });
});
