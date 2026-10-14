// Contract test over the repo's real `diagrams/` folder (spec 013, AC-12): a broken diagram fails `pnpm test`.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { checkDiagramFiles } from './files.ts';

// The checks compile the layout with elkjs, which loads lazily and can be slow on a cold machine.
vi.setConfig({ testTimeout: 60_000 });

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const diagramsDir = join(repoRoot, 'diagrams');
const publicDir = join(repoRoot, 'apps', 'site', 'public');

describe('diagrams/ contract', () => {
  test('AC-12: every file in the repo diagrams/ folder is valid and its icons exist in apps/site/public/', async () => {
    const problems = await checkDiagramFiles(diagramsDir, {
      iconExists: (publicPath) => existsSync(join(publicDir, publicPath)),
    });

    expect(problems).toEqual([]);
  });
});
