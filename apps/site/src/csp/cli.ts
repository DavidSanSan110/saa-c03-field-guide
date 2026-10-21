// `pnpm csp-hashes` CLI: arguments, file I/O, output and exit codes only; the logic is in inline-hashes.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadInlineHashes } from './hash-file.ts';
import { inlineScripts, requiredExtraHashes, scriptHash, snippetOf } from './inline-hashes.ts';

const DEFAULT_DIST = 'apps/site/dist';
const DEFAULT_FILE = 'apps/site/csp-inline-hashes.json';
const RUN_LINE = 'run: pnpm --filter @field-guide/site build && pnpm csp-hashes';
const USAGE = 'usage: csp-hashes [--check] [--dist <dir>] [--file <path>]';

interface Options {
  check: boolean;
  dist: string;
  file: string;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false, dist: DEFAULT_DIST, file: DEFAULT_FILE };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
    } else if (flag === '--dist' || flag === '--file') {
      const value = argv[(index += 1)];
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      options[flag === '--dist' ? 'dist' : 'file'] = value;
    } else {
      throw new UsageError(`unknown argument ${String(flag)}`);
    }
  }
  return options;
}

/** Every `*.html` under `dist` (relative paths), or [] when the folder does not exist. */
function htmlFiles(dist: string): string[] {
  if (!existsSync(dist)) return [];
  return readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.html'))
    .sort();
}

function run(options: Options): number {
  const dist = resolve(options.dist);
  const file = resolve(options.file);
  const paths = htmlFiles(dist);
  if (paths.length === 0) {
    console.error(
      `no built pages in ${options.dist}: run pnpm --filter @field-guide/site build first`,
    );
    return 2;
  }
  const pages = paths.map((path) => readFileSync(join(dist, path), 'utf8'));
  const pinned: string[] = existsSync(file) ? loadInlineHashes(file) : [];
  const required = requiredExtraHashes(pages, pinned);

  if (!options.check) {
    writeFileSync(file, JSON.stringify({ scriptHashes: required }, null, 2) + '\n');
    console.log(
      `wrote ${String(required.length)} hashes to ${options.file}; rebuild the site so the meta CSP picks them up`,
    );
    return 0;
  }

  const missing = required.filter((hash) => !pinned.includes(hash));
  const stale = pinned.filter((hash) => !required.includes(hash));
  if (missing.length === 0 && stale.length === 0) {
    console.log(`ok: ${String(pinned.length)} pinned inline-script hashes`);
    return 0;
  }
  for (const hash of missing) {
    const index = pages.findIndex((html) =>
      inlineScripts(html).some((s) => scriptHash(s) === hash),
    );
    const script = inlineScripts(pages[index] ?? '').find((s) => scriptHash(s) === hash) ?? '';
    console.error(`missing: ${hash} (${snippetOf(script)}) in ${paths[index] ?? ''}`);
  }
  for (const hash of stale) console.error(`stale: ${hash}`);
  console.error(RUN_LINE);
  return 1;
}

try {
  process.exitCode = run(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error((error as Error).message);
  if (error instanceof UsageError) console.error(USAGE);
  process.exitCode = 2;
}
