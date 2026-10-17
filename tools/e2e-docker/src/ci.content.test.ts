// Contract tests over the repository's real files: the pinned container image of CI (spec 014).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ciPlaywrightImage } from './image.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CI_YAML = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const INSTALLED_PLAYWRIGHT = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

interface CiStep {
  name?: string;
  run?: string;
  uses?: string;
}

interface CiYaml {
  jobs: Record<
    string,
    {
      container?: string | { image?: string; options?: string };
      env?: Record<string, unknown>;
      steps?: CiStep[];
    }
  >;
}

function e2eJob(): CiYaml['jobs'][string] {
  const job = (parse(CI_YAML) as CiYaml).jobs['e2e'];
  if (job === undefined) throw new Error('ci.yml has no e2e job');
  return job;
}

describe('the e2e job of ci.yml', () => {
  test('AC-6: the image is a pinned Playwright noble image with a sha256 digest', () => {
    expect(ciPlaywrightImage(CI_YAML)).toMatch(
      /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}$/,
    );
  });

  test('AC-6: the version of the image equals the installed @playwright/test version', () => {
    const image = ciPlaywrightImage(CI_YAML);

    const version = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@/.exec(image)?.[1];

    expect(version).toBe(INSTALLED_PLAYWRIGHT);
  });

  test('AC-7: the container has the option --ipc=host', () => {
    const container = e2eJob().container;

    expect(typeof container).toBe('object');
    const options = typeof container === 'object' ? container.options : undefined;
    expect(options).toContain('--ipc=host');
  });

  test("AC-7: the job env FIELD_GUIDE_VISUAL is the string '1'", () => {
    expect(e2eJob().env?.['FIELD_GUIDE_VISUAL']).toBe('1');
  });

  test('AC-7: no step installs Playwright (the image has the browsers)', () => {
    const steps = e2eJob().steps ?? [];

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => /playwright install/.test(step.run ?? ''))).toEqual([]);
  });
});
