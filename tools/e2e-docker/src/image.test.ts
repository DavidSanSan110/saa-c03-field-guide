import { describe, expect, test } from 'vitest';
import { ciPlaywrightImage } from './image.ts';

const IMAGE =
  'mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f';
const OTHER_IMAGE = 'node:22-bookworm';

/** A ci.yml with a `verify` job (with its own container) and an `e2e` job with the given lines. */
function ciWith(e2eLines: string): string {
  return [
    'name: CI',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    container:',
    `      image: ${OTHER_IMAGE}`,
    '    steps:',
    '      - run: pnpm coverage',
    '  e2e:',
    '    name: e2e',
    '    runs-on: ubuntu-latest',
    e2eLines,
    '    steps:',
    '      - run: pnpm e2e',
  ].join('\n');
}

describe('ciPlaywrightImage', () => {
  test('AC-5: returns the container of the e2e job when it is a string', () => {
    const ci = ciWith(`    container: ${IMAGE}`);

    expect(ciPlaywrightImage(ci)).toBe(IMAGE);
  });

  test('AC-5: returns the image when the container is an object with image and options', () => {
    const ci = ciWith(
      ['    container:', `      image: ${IMAGE}`, '      options: --ipc=host'].join('\n'),
    );

    expect(ciPlaywrightImage(ci)).toBe(IMAGE);
  });

  test('AC-5: takes the image of the e2e job, not the one of another job', () => {
    const ci = ciWith(`    container: ${IMAGE}`);

    expect(ciPlaywrightImage(ci)).not.toBe(OTHER_IMAGE);
  });

  test('AC-5: throws a message naming jobs.e2e.container when there is no e2e job', () => {
    const ci = ['jobs:', '  verify:', '    runs-on: ubuntu-latest', '    steps: []'].join('\n');

    expect(() => ciPlaywrightImage(ci)).toThrow(/jobs\.e2e\.container/);
  });

  test('AC-5: throws a message naming jobs.e2e.container when there is no jobs section', () => {
    expect(() => ciPlaywrightImage('name: CI\n')).toThrow(/jobs\.e2e\.container/);
  });

  test('AC-5: throws a message naming jobs.e2e.container when the e2e job has no container', () => {
    expect(() => ciPlaywrightImage(ciWith('    timeout-minutes: 20'))).toThrow(
      /jobs\.e2e\.container/,
    );
  });

  test('AC-5: throws a message naming jobs.e2e.container when the container has no image', () => {
    const ci = ciWith(['    container:', '      options: --ipc=host'].join('\n'));

    expect(() => ciPlaywrightImage(ci)).toThrow(/jobs\.e2e\.container/);
  });
});
