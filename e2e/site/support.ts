import { devices, expect, type Locator, type Page } from '@playwright/test';
import { domains, taskPath, tasks, tasksByDomain } from '../../packages/schema/src/index.ts';

export const BANNER_TEXT =
  '🚧 Under construction, launching November 2026. Things will move, break and change until then.';

export const DISCLAIMER_TEXT =
  'Not affiliated with, endorsed by or sponsored by Amazon Web Services, Inc.';

export const REPO_BLOB_URL = 'https://github.com/DavidSanSan110/saa-c03-field-guide/blob/main';
export const LICENSE_URL = `${REPO_BLOB_URL}/LICENSE`;
export const LICENSE_CONTENT_URL = `${REPO_BLOB_URL}/LICENSE-CONTENT.md`;

export const SITE_DESCRIPTION =
  'Interactive study guide for the AWS Certified Solutions Architect – Associate exam: animated architecture diagrams, deployable Terraform labs and free practice tests. Not affiliated with AWS.';

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

const pixel7Device = devices['Pixel 7'];
/** The Pixel 7 emulation, minus `defaultBrowserType` (not allowed inside a describe group). */
export const pixel7 = {
  viewport: pixel7Device.viewport,
  userAgent: pixel7Device.userAgent,
  deviceScaleFactor: pixel7Device.deviceScaleFactor,
  isMobile: pixel7Device.isMobile,
  hasTouch: pixel7Device.hasTouch,
};

/** Pages the layout checks (banner, footer) run on: one of each kind. */
export const LAYOUT_PAGES = [
  { name: 'home page', path: '/' },
  { name: 'domain page', path: '/d1/' },
  { name: 'task page', path: '/d1/1-3-data-security/' },
  { name: 'practice tests page', path: '/practice/' },
] as const;

export function domainTitle(domainId: number): string {
  const domain = domains.find((candidate) => candidate.id === domainId);
  if (domain === undefined) throw new Error(`unknown domain ${String(domainId)}`);
  return `Domain ${String(domain.id)}: ${domain.title}`;
}

export interface SidebarLinkExpectation {
  label: string;
  path: string;
  /** The h1 of the page the link leads to. */
  h1: string;
}

export interface SidebarGroupExpectation {
  label: string;
  links: SidebarLinkExpectation[];
}

/** The sidebar of AC-1 / AC-2, derived from the exam catalog. */
export const expectedGroups: SidebarGroupExpectation[] = domains.map((domain) => ({
  label: domainTitle(domain.id),
  links: [
    { label: 'Overview', path: `/${domain.slug}/`, h1: domainTitle(domain.id) },
    ...tasksByDomain(domain.id).map((task) => ({
      label: `${task.id} ${task.shortTitle}`,
      path: taskPath(task.id),
      h1: `Task ${task.id}: ${task.title}`,
    })),
  ],
}));

export const practiceTestsLink: SidebarLinkExpectation = {
  label: 'Practice tests',
  path: '/practice/',
  h1: 'Practice test',
};

/** Every link of the sidebar (18 in the groups, then "Practice tests"), in order. */
export const expectedSidebarLinks: SidebarLinkExpectation[] = [
  ...expectedGroups.flatMap((group) => group.links),
  practiceTestsLink,
];

export const taskCount = tasks.length;

/** The main sidebar navigation (the one Starlight labels "Main"). */
export function sidebarNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

/** Reads the `href` and the whitespace-normalised text of every link a locator matches. */
export async function readLinks(links: Locator): Promise<{ href: string; text: string }[]> {
  const found: { href: string; text: string }[] = [];
  for (const link of await links.all()) {
    found.push({
      href: (await link.getAttribute('href')) ?? '',
      text: ((await link.textContent()) ?? '').replace(/\s+/g, ' ').trim(),
    });
  }
  return found;
}

/** Asserts the sidebar shows the 4 domain groups and "Practice tests", in order (AC-1 / AC-2). */
export async function expectSidebarContent(page: Page): Promise<void> {
  const nav = sidebarNav(page);
  const groups = nav.locator('details');

  await expect(groups).toHaveCount(expectedGroups.length);
  await expect(nav.locator('summary')).toHaveText(expectedGroups.map((group) => group.label));

  for (const [index, expected] of expectedGroups.entries()) {
    const links = groups.nth(index).getByRole('link');
    await expect(links).toHaveText(expected.links.map((link) => link.label));
    const found = await readLinks(links);
    expect(found.map((link) => link.href)).toEqual(expected.links.map((link) => link.path));
  }

  const practice = nav.getByRole('link', { name: practiceTestsLink.label, exact: true });
  await expect(practice).toHaveAttribute('href', practiceTestsLink.path);

  // All groups are expanded: every one of the 19 links is visible, "Practice tests" comes last.
  const visibleLinks = nav.getByRole('link');
  await expect(visibleLinks).toHaveCount(expectedSidebarLinks.length);
  await expect(visibleLinks.last()).toHaveText(practiceTestsLink.label);
}
