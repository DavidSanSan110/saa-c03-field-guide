// `pnpm e2e:docker [playwright args]`: reads <repo>/.github/workflows/ci.yml, runs
// `docker ...dockerRunArgs(...)` with inherited stdio and exits with docker's exit code.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerRunArgs } from './docker.ts';
import { ciPlaywrightImage } from './image.ts';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ciYaml = readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
const args = dockerRunArgs({
  repoDir,
  image: ciPlaywrightImage(ciYaml),
  playwrightArgs: process.argv.slice(2),
});

const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error !== undefined) {
  console.error(`docker not found or could not start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
