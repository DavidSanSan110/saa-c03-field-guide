/// <reference lib="dom" />
// Screenshot baselines of the real diagrams (spec 014, AC-1…AC-4). The baselines are rendered in
// the pinned Linux container (`pnpm e2e:docker`); elsewhere the screenshot tests are skipped.
// Scenario ids and step counts are read from diagrams/<id>.yaml at test time.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { parse } from 'yaml';
import type { Diagram, DiagramScenario } from '../../packages/schema/src/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const DIAGRAMS_DIR = join(REPO_ROOT, 'diagrams');

/** Every diagram file with the guide page that embeds it. A new diagram file needs a new entry. */
const REGISTRY = [
  { id: 's3-sse-kms-upload', page: '/d1/1-3-data-security/' },
  { id: 'alb-asg-az-failure', page: '/d2/2-2-high-availability/' },
  { id: 'sg-vs-nacl', page: '/d1/1-2-secure-workloads/' },
  { id: 'vpc-nat-vs-gateway-endpoint', page: '/d1/1-2-secure-workloads/' },
  { id: 'cloudfront-oac', page: '/d1/1-2-secure-workloads/' },
  { id: 'kms-envelope-encryption', page: '/d1/1-3-data-security/' },
] as const;

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const SKIP_REASON = 'screenshots run in the pinned container (pnpm e2e:docker)';
const WIDE_VIEWPORT = { width: 1280, height: 800 };
const COMPACT_VIEWPORT = { width: 400, height: 900 };

// ---------------------------------------------------------------------------
// The expected data, read from the diagram files
// ---------------------------------------------------------------------------

function loadDiagram(id: string): Diagram {
  return parse(readFileSync(join(DIAGRAMS_DIR, `${id}.yaml`), 'utf8')) as Diagram;
}

/** The scenarios to build tests for; none while the file cannot be read (AC-1 then fails). */
function scenariosForTests(id: string): DiagramScenario[] {
  try {
    return loadDiagram(id).scenarios;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Sets the colour scheme and Starlight's stored theme before the page loads, and reduced motion. */
async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.addInitScript((value) => {
    window.localStorage.setItem('starlight-theme', value);
  }, theme);
}

interface Shot {
  id: string;
  pagePath: string;
  scenario: DiagramScenario;
  theme: Theme;
  layout: 'wide' | 'compact';
  /** The baseline name, without the extension. */
  name: string;
}

/** Opens the page and brings the island to the last step of the scenario; returns the island root. */
async function prepareShot(page: Page, shot: Shot): Promise<Locator> {
  await useTheme(page, shot.theme);
  await page.goto(shot.pagePath);
  const figure = page.locator(`figure[data-diagram="${shot.id}"]`);
  await figure.scrollIntoViewIfNeeded();
  const root = figure.locator('[data-diagram-view]');
  await expect(root).toHaveAttribute('data-hydrated', 'true');
  await expect(root).toHaveAttribute('data-layout', shot.layout);

  const tab = figure.getByRole('tab', { name: shot.scenario.label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(root).toHaveAttribute('data-scenario', shot.scenario.id);

  const forward = figure.getByRole('button', { name: 'Step forward' });
  for (let step = 0; step < shot.scenario.steps.length; step += 1) await forward.click();
  await expect(root).toHaveAttribute('data-step', String(shot.scenario.steps.length - 1));

  // The picture is of the island only: the site's sticky header and mobile table-of-contents bar
  // would be drawn over it when the island is taller than the viewport (compact).
  await page.evaluate(() => {
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const { position } = getComputedStyle(element);
      if (
        (position === 'fixed' || position === 'sticky') &&
        !element.closest('figure[data-diagram]')
      ) {
        element.style.visibility = 'hidden';
      }
    }
  });
  // No hover state from the last click in the picture.
  await page.mouse.move(0, 0);
  return root;
}

async function expectShot(page: Page, shot: Shot): Promise<void> {
  const root = await prepareShot(page, shot);

  await expect(root).toHaveScreenshot(`${shot.name}.png`, {
    animations: 'disabled',
    caret: 'hide',
  });
}

// ---------------------------------------------------------------------------
// AC-1 the registry
// ---------------------------------------------------------------------------

test.describe('the registry of diagrams', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('AC-1: the registry names exactly the files in diagrams/*.yaml', () => {
    const files = readdirSync(DIAGRAMS_DIR)
      .filter((file) => file.endsWith('.yaml'))
      .map((file) => basename(file, '.yaml'))
      .sort();

    expect(REGISTRY.map((entry) => entry.id).sort()).toEqual(files);
  });

  for (const entry of REGISTRY) {
    test(`AC-1: the page of "${entry.id}" embeds the diagram with its title`, async ({ page }) => {
      const diagram = loadDiagram(entry.id);
      await page.goto(entry.page);

      const island = page.locator(`figure[data-diagram="${entry.id}"] [data-diagram-view]`);

      await expect(island).toHaveCount(1);
      await expect(island).toHaveAttribute('aria-label', `Animated diagram: ${diagram.title}`);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-2 the gate
// ---------------------------------------------------------------------------

interface JsonTest {
  status: string;
  annotations: { type: string; description?: string }[];
}

interface JsonSuite {
  suites?: JsonSuite[];
  specs?: { title: string; tests: JsonTest[] }[];
}

function collectTests(suite: JsonSuite): { title: string; test: JsonTest }[] {
  const own = (suite.specs ?? []).flatMap((spec) =>
    spec.tests.map((found) => ({ title: spec.title, test: found })),
  );
  return [...own, ...(suite.suites ?? []).flatMap(collectTests)];
}

test.describe('the FIELD_GUIDE_VISUAL gate', () => {
  test('AC-2: without FIELD_GUIDE_VISUAL=1 every screenshot test is skipped with the reason', () => {
    test.setTimeout(180_000);
    // A nested run of the two screenshot groups (not of this test) without the gate. It needs no
    // web server: a skipped test never opens a page.
    mkdirSync(join(REPO_ROOT, 'test-results'), { recursive: true });
    const folder = mkdtempSync(join(REPO_ROOT, 'test-results', 'ac2-gate-'));
    try {
      const config = join(folder, 'playwright.config.ts');
      writeFileSync(
        config,
        [
          "import { defineConfig, devices } from '@playwright/test';",
          'export default defineConfig({',
          `  testDir: ${JSON.stringify(join(REPO_ROOT, 'e2e'))},`,
          `  outputDir: ${JSON.stringify(join(folder, 'output'))},`,
          "  reporter: [['json']],",
          "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],",
          '});',
        ].join('\n'),
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env['FIELD_GUIDE_VISUAL'];
      delete env['CI'];
      const cli = join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

      const result = spawnSync(
        process.execPath,
        [cli, 'test', '-c', config, 'diagram-screenshots', '--grep', 'AC-3|AC-4'],
        { cwd: REPO_ROOT, env, encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
      );

      const report = JSON.parse(result.stdout) as JsonSuite;
      const found = collectTests(report);
      const expectedCount = REGISTRY.reduce(
        (sum, entry) => sum + (scenariosForTests(entry.id).length + 1) * THEMES.length,
        0,
      );
      expect(found).toHaveLength(expectedCount);
      expect(
        found.filter(
          (entry) =>
            entry.test.status !== 'skipped' ||
            !entry.test.annotations.some(
              (annotation) => annotation.type === 'skip' && annotation.description === SKIP_REASON,
            ),
        ),
      ).toEqual([]);
      expect(result.status).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 wide, AC-4 compact (only in the pinned container)
// ---------------------------------------------------------------------------

test.describe('wide screenshots', () => {
  test.skip(process.env['FIELD_GUIDE_VISUAL'] !== '1', SKIP_REASON);
  test.use({ viewport: WIDE_VIEWPORT });

  for (const entry of REGISTRY) {
    for (const scenario of scenariosForTests(entry.id)) {
      for (const theme of THEMES) {
        test(`AC-3: ${entry.id} / ${scenario.id} / wide / ${theme}`, async ({ page }) => {
          await expectShot(page, {
            id: entry.id,
            pagePath: entry.page,
            scenario,
            theme,
            layout: 'wide',
            name: `${entry.id}--${scenario.id}--wide-${theme}`,
          });
        });
      }
    }
  }
});

test.describe('compact screenshots', () => {
  test.skip(process.env['FIELD_GUIDE_VISUAL'] !== '1', SKIP_REASON);
  test.use({ viewport: COMPACT_VIEWPORT });

  for (const entry of REGISTRY) {
    const first = scenariosForTests(entry.id)[0];
    if (first === undefined) continue;
    for (const theme of THEMES) {
      test(`AC-4: ${entry.id} / compact / ${theme}`, async ({ page }) => {
        await expectShot(page, {
          id: entry.id,
          pagePath: entry.page,
          scenario: first,
          theme,
          layout: 'compact',
          name: `${entry.id}--compact-${theme}`,
        });
      });
    }
  }
});
