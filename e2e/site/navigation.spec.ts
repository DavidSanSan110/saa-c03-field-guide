import { expect, test, type Page } from '@playwright/test';
import { domains, taskPath, tasksByDomain } from '../../packages/schema/src/index.ts';
import {
  DESKTOP_VIEWPORT,
  expectedGroups,
  expectedSidebarLinks,
  expectSidebarContent,
  pixel7,
  readLinks,
  sidebarNav,
} from './support.ts';

async function openMobileMenu(page: Page): Promise<void> {
  const menuButton = page.getByRole('button', { name: 'Menu' });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
}

test.describe('desktop navigation', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('AC-6: the sidebar shows the 4 domain groups and Practice tests, in order', async ({
    page,
  }) => {
    await page.goto('/d1/');

    await expectSidebarContent(page);
  });

  test('AC-6: pins the literal group labels and Practice tests link from the spec', async ({
    page,
  }) => {
    await page.goto('/practice-tests/');

    await expect(sidebarNav(page).locator('summary')).toHaveText([
      'Domain 1: Design Secure Architectures',
      'Domain 2: Design Resilient Architectures',
      'Domain 3: Design High-Performing Architectures',
      'Domain 4: Design Cost-Optimized Architectures',
    ]);
    await expect(
      sidebarNav(page).getByRole('link', { name: 'Practice tests', exact: true }),
    ).toHaveAttribute('href', '/practice-tests/');
  });

  for (const link of expectedSidebarLinks) {
    test(`AC-6: sidebar link "${link.label}" (${link.path}) answers 200, shows h1 "${link.h1}" and keeps the sidebar`, async ({
      page,
    }) => {
      const response = await page.goto(link.path);

      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(link.h1);
      await expectSidebarContent(page);
    });
  }

  test('AC-7: clicking "1.3 Data security" opens its task page and marks the link as current', async ({
    page,
  }) => {
    await page.goto('/d1/');

    const link = sidebarNav(page).getByRole('link', { name: '1.3 Data security', exact: true });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/d1\/1-3-data-security\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Task 1.3: Determine appropriate data security controls',
    );
    await expect(
      sidebarNav(page).getByRole('link', { name: '1.3 Data security', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  });

  for (const domain of domains) {
    const base = `/d${String(domain.id)}/`;

    test(`AC-8: domain ${String(domain.id)} page shows its weight and links to exactly its tasks in order`, async ({
      page,
    }) => {
      await page.goto(base);
      const main = page.getByRole('main');

      await expect(main.getByText(`${String(domain.weight)}% of the scored content`)).toBeVisible();

      // Links into this domain's tasks, outside Starlight's previous/next footer.
      const links = await readLinks(main.locator('a:not(footer a)'));
      const taskLinks = links.filter((link) => link.href.startsWith(base) && link.href !== base);

      expect(taskLinks).toEqual(
        tasksByDomain(domain.id).map((task) => ({
          href: taskPath(task.id),
          text: `${task.id} ${task.title}`,
        })),
      );
    });
  }

  test('AC-8: the domain 1 page lists the literal tasks from the spec', async ({ page }) => {
    await page.goto('/d1/');
    const main = page.getByRole('main');

    await expect(main.getByText('30% of the scored content')).toBeVisible();
    await expect(
      main.getByRole('link', { name: '1.3 Determine appropriate data security controls' }),
    ).toHaveAttribute('href', '/d1/1-3-data-security/');
  });

  for (const group of expectedGroups) {
    const domainPath = group.links[0]?.path ?? '';

    for (const task of group.links.slice(1)) {
      test(`AC-8: the page of task ${task.label} links back to its domain page ${domainPath}`, async ({
        page,
      }) => {
        await page.goto(task.path);
        const main = page.getByRole('main');

        await expect(main.locator(`a[href="${domainPath}"]:not(footer a)`).first()).toBeVisible();
      });
    }
  }
});

test.describe('mobile navigation', () => {
  test.use(pixel7);

  test('AC-14: the sidebar is behind the menu button', async ({ page }) => {
    await page.goto('/d2/');

    await expect(
      sidebarNav(page).getByRole('link', { name: '2.2 High availability', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  });

  test('AC-14: opening the menu shows the 4 domain groups', async ({ page }) => {
    await page.goto('/d2/');

    await openMobileMenu(page);

    await expect(sidebarNav(page).locator('summary')).toHaveText(
      expectedGroups.map((group) => group.label),
    );
  });

  test('AC-14: following "2.2 High availability" reaches /d2/2-2-high-availability/', async ({
    page,
  }) => {
    await page.goto('/d2/');

    await openMobileMenu(page);
    const link = sidebarNav(page).getByRole('link', { name: '2.2 High availability', exact: true });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/d2\/2-2-high-availability\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Task 2.2: Design highly available and/or fault-tolerant architectures',
    );
  });
});
