import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Spec 034, section 3: `pnpm csp-hashes`. Every test spawns a real process (tsx apps/site/src/csp/cli.ts).
vi.setConfig({ testTimeout: 60_000 });

const CLI = join(import.meta.dirname, 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const RUN_LINE = 'run: pnpm --filter @field-guide/site build && pnpm csp-hashes';
const NO_PAGES = (dir: string): string =>
  `no built pages in ${dir}: run pnpm --filter @field-guide/site build first`;

function hashOf(content: string): string {
  return `sha256-${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('base64')}`;
}

// The inline scripts of the fixture site.
const THEME = 'window.StarlightThemeProvider = (() => {\n  return 1;\n})();';
const PICKERS = 'StarlightThemeProvider.updatePickers();';
const SCROLL = 'window.__scriptC = 1;\n  go();';
const SCROLL_SNIPPET = 'window.__scriptC = 1; go();';
const ISLAND = 'import("/_astro/island.js");';

const REQUIRED = [hashOf(THEME), hashOf(PICKERS), hashOf(SCROLL)].sort();
const STALE = hashOf('removed from starlight();');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together: the spec says what is printed, not on which stream. */
  output: string;
}

function runCli(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csp-hashes-cli-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** An HTML page with the meta CSP Astro writes (own hashes + the pinned ones) and inline scripts. */
function pageHtml(scripts: string[], metaHashes: string[]): string {
  const sources = ["'self'", "'wasm-unsafe-eval'", ...metaHashes.map((hash) => `'${hash}'`)];
  const meta = `<meta http-equiv="content-security-policy" content="script-src ${sources.join(' ')}; style-src 'self' 'unsafe-inline' ;">`;
  const body = scripts.map((script) => `<script>${script}</script>`).join('\n');
  return `<!doctype html><html><head>${meta}</head><body>${body}<script src="/_astro/page.js"></script></body></html>`;
}

/**
 * Writes a built site into `<project>/dist`, as if built from a hash file holding `pinned`
 * (the meta CSP of every page lists Astro's own hashes plus the pinned ones).
 * Needs exactly THEME, PICKERS and SCROLL pinned; SCROLL appears on one page only.
 */
function buildDist(project: string, pinned: string[], dist = join(project, 'dist')): string {
  const astro = hashOf(ISLAND);
  writeFile(join(dist, 'index.html'), pageHtml([THEME, ISLAND], [astro, ...pinned]));
  writeFile(join(dist, 'd1', 'index.html'), pageHtml([THEME, PICKERS], pinned));
  writeFile(
    join(dist, 'd1', 'guide', 'index.html'),
    pageHtml([THEME, SCROLL, ISLAND], [astro, ...pinned]),
  );
  writeFile(join(dist, '404.html'), pageHtml([PICKERS], pinned));
  // Not pages: never read as HTML.
  writeFile(join(dist, '_astro', 'app.js'), 'document.write("<script>other()</script>");');
  writeFile(join(dist, 'robots.txt'), '<script>other()</script>');
  return dist;
}

function fileText(scriptHashes: string[]): string {
  return JSON.stringify({ scriptHashes }, null, 2) + '\n';
}

/** A hash file in the format of the spec (sorted by the caller). */
function writeHashFile(path: string, scriptHashes: string[]): string {
  writeFile(path, fileText(scriptHashes));
  return path;
}

describe('write mode', () => {
  test('AC-12: writes the sorted required list in the spec format and exits 0', () => {
    const project = tempProject();
    const dist = buildDist(project, []);
    const file = join(project, 'csp-inline-hashes.json');

    const run = runCli(project, ['--dist', dist, '--file', file]);

    expect(run.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(fileText(REQUIRED));
  });

  test('AC-12: prints how many hashes it wrote and that the site must be rebuilt', () => {
    const project = tempProject();
    const dist = buildDist(project, []);
    const file = join(project, 'csp-inline-hashes.json');

    const run = runCli(project, ['--dist', dist, '--file', file]);

    expect(run.output).toMatch(
      /wrote 3 hashes to .*csp-inline-hashes\.json; rebuild the site so the meta CSP picks them up/,
    );
  });

  test('AC-12: reads every *.html under dist, nested folders included, and nothing else', () => {
    const project = tempProject();
    const dist = buildDist(project, []);
    writeFile(join(dist, 'a', 'b', 'c', 'deep', 'index.html'), pageHtml(['deep();'], []));
    const file = join(project, 'csp-inline-hashes.json');

    runCli(project, ['--dist', dist, '--file', file]);

    const written = JSON.parse(readFileSync(file, 'utf8')) as { scriptHashes: string[] };
    expect(written.scriptHashes).toEqual([...REQUIRED, hashOf('deep();')].sort());
    expect(written.scriptHashes).not.toContain(hashOf('other()'));
  });

  test('AC-12: running it again leaves the file byte-identical', () => {
    const project = tempProject();
    const dist = buildDist(project, []);
    const file = join(project, 'csp-inline-hashes.json');
    runCli(project, ['--dist', dist, '--file', file]);
    const first = readFileSync(file);

    const second = runCli(project, ['--dist', dist, '--file', file]);

    expect(second.status).toBe(0);
    expect(readFileSync(file).equals(first)).toBe(true);
  });

  test('AC-12: running it again on a rebuilt dist (pinned hashes in the meta) is byte-identical too', () => {
    const project = tempProject();
    const file = join(project, 'csp-inline-hashes.json');
    runCli(project, ['--dist', buildDist(project, []), '--file', file]);
    const first = readFileSync(file);
    const rebuilt = buildDist(project, REQUIRED, join(project, 'rebuilt'));

    const second = runCli(project, ['--dist', rebuilt, '--file', file]);

    expect(second.status).toBe(0);
    expect(readFileSync(file).equals(first)).toBe(true);
  });

  test('AC-12: without arguments it uses apps/site/dist and apps/site/csp-inline-hashes.json from the cwd', () => {
    const project = tempProject();
    buildDist(project, [], join(project, 'apps', 'site', 'dist'));

    const run = runCli(project, []);

    expect(run.status).toBe(0);
    expect(readFileSync(join(project, 'apps', 'site', 'csp-inline-hashes.json'), 'utf8')).toBe(
      fileText(REQUIRED),
    );
  });

  test('AC-12: relative --dist and --file are resolved against the cwd', () => {
    const project = tempProject();
    buildDist(project, [], join(project, 'build', 'out'));

    const run = runCli(project, ['--file', 'pinned.json', '--dist', join('build', 'out')]);

    expect(run.status).toBe(0);
    expect(readFileSync(join(project, 'pinned.json'), 'utf8')).toBe(fileText(REQUIRED));
  });

  test('AC-12: a site that needs no extra hash writes an empty list', () => {
    const project = tempProject();
    const dist = join(project, 'dist');
    writeFile(join(dist, 'index.html'), pageHtml([ISLAND], [hashOf(ISLAND)]));
    const file = join(project, 'csp-inline-hashes.json');

    const run = runCli(project, ['--dist', dist, '--file', file]);

    expect(run.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(fileText([]));
    expect(run.output).toContain('wrote 0 hashes to');
  });

  test('AC-13: creates the hash file when it does not exist', () => {
    const project = tempProject();
    const dist = buildDist(project, []);
    const file = join(project, 'csp-inline-hashes.json');
    expect(existsSync(file)).toBe(false);

    const run = runCli(project, ['--dist', dist, '--file', file]);

    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ scriptHashes: REQUIRED });
  });

  test('AC-13: with a stale file it drops the stale hash and adds the missing one', () => {
    const project = tempProject();
    // The file pins THEME, PICKERS and a stale hash; SCROLL is missing from it.
    const pinned = [hashOf(THEME), hashOf(PICKERS), STALE].sort();
    const dist = buildDist(project, pinned);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), pinned);

    const run = runCli(project, ['--dist', dist, '--file', file]);

    expect(run.status).toBe(0);
    const written = readFileSync(file, 'utf8');
    expect(written).toBe(fileText(REQUIRED));
    expect(written).not.toContain(STALE);
    expect(written).toContain(hashOf(SCROLL));
  });
});

describe('--check', () => {
  test('AC-14: with the right list prints ok and exits 0', () => {
    const project = tempProject();
    const dist = buildDist(project, REQUIRED);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), REQUIRED);

    const run = runCli(project, ['--check', '--dist', dist, '--file', file]);

    expect(run.status).toBe(0);
    expect(run.output).toContain('ok: 3 pinned inline-script hashes');
  });

  test('AC-14: does not modify the file (bytes and mtime)', () => {
    const project = tempProject();
    const dist = buildDist(project, REQUIRED);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), REQUIRED);
    const old = new Date('2020-01-02T03:04:05Z');
    utimesSync(file, old, old);
    const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };

    const run = runCli(project, ['--dist', dist, '--file', file, '--check']);

    expect(run.status).toBe(0);
    expect(readFileSync(file).equals(before.bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
  });

  test('AC-14: accepts the flags in any order and the default paths', () => {
    const project = tempProject();
    buildDist(project, REQUIRED, join(project, 'apps', 'site', 'dist'));
    writeHashFile(join(project, 'apps', 'site', 'csp-inline-hashes.json'), REQUIRED);

    const run = runCli(project, ['--check']);

    expect(run.status).toBe(0);
    expect(run.output).toContain('ok: 3 pinned inline-script hashes');
  });

  test('AC-14: an empty list is ok when no page needs a pinned hash', () => {
    const project = tempProject();
    const dist = join(project, 'dist');
    writeFile(join(dist, 'index.html'), pageHtml([ISLAND], [hashOf(ISLAND)]));
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), []);

    const run = runCli(project, ['--check', '--dist', dist, '--file', file]);

    expect(run.status).toBe(0);
    expect(run.output).toContain('ok: 0 pinned inline-script hashes');
  });

  test('AC-15: a missing hash exits 1 and prints the hash, its snippet, a page path and the run line', () => {
    const project = tempProject();
    // SCROLL is used by d1/guide/index.html only and is not pinned.
    const pinned = [hashOf(THEME), hashOf(PICKERS)].sort();
    const dist = buildDist(project, pinned);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), pinned);

    const run = runCli(project, ['--check', '--dist', dist, '--file', file]);

    expect(run.status).toBe(1);
    expect(run.output).toContain(hashOf(SCROLL));
    expect(run.output).toContain(SCROLL_SNIPPET);
    expect(run.output.replaceAll('\\', '/')).toContain('d1/guide/index.html');
    expect(run.output).toContain(RUN_LINE);
  });

  test('AC-15: the page path is relative to dist, not absolute', () => {
    const project = tempProject();
    const pinned = [hashOf(THEME), hashOf(PICKERS)].sort();
    const dist = buildDist(project, pinned);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), pinned);

    const run = runCli(project, ['--check', '--dist', dist, '--file', file]);

    const output = run.output.replaceAll('\\', '/');
    expect(output).toContain('d1/guide/index.html');
    expect(output).not.toContain(`${dist.replaceAll('\\', '/')}/d1/guide`);
  });

  test('AC-15: a missing hash does not modify nor create the file', () => {
    const project = tempProject();
    const pinned = [hashOf(THEME), hashOf(PICKERS)].sort();
    const dist = buildDist(project, pinned);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), pinned);
    const before = readFileSync(file);
    const absent = join(project, 'absent.json');

    const withFile = runCli(project, ['--check', '--dist', dist, '--file', file]);
    const withoutFile = runCli(project, ['--check', '--dist', dist, '--file', absent]);

    expect([withFile.status, withoutFile.status]).toEqual([1, 1]);
    expect(withFile.output).toContain(RUN_LINE);
    expect(withoutFile.output).toContain(RUN_LINE);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(absent)).toBe(false);
  });

  test('AC-15: a missing hash file is a missing-hash failure (exit 1)', () => {
    const project = tempProject();
    const dist = buildDist(project, []);

    const run = runCli(project, [
      '--check',
      '--dist',
      dist,
      '--file',
      join(project, 'absent.json'),
    ]);

    expect(run.status).toBe(1);
    expect(run.output).toContain(hashOf(THEME));
    expect(run.output).toContain(RUN_LINE);
  });

  test('AC-15: a stale hash exits 1, is printed, and nothing is written', () => {
    const project = tempProject();
    const pinned = [...REQUIRED, STALE].sort();
    const dist = buildDist(project, pinned);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), pinned);
    const before = readFileSync(file);

    const run = runCli(project, ['--check', '--dist', dist, '--file', file]);

    expect(run.status).toBe(1);
    expect(run.output).toContain(STALE);
    expect(run.output).toContain(RUN_LINE);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test('AC-15: a stale hash is not reported as missing and the right ones are not printed as stale', () => {
    const project = tempProject();
    const pinned = [...REQUIRED, STALE].sort();
    const dist = buildDist(project, pinned);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), pinned);

    const run = runCli(project, ['--check', '--dist', dist, '--file', file]);

    expect(run.status).toBe(1);
    expect(run.output).toContain(STALE);
    expect(run.output).not.toContain(hashOf(THEME));
    expect(run.output).not.toContain(hashOf(PICKERS));
    expect(run.output).not.toContain(hashOf(SCROLL));
  });
});

describe('errors', () => {
  test.each([
    ['write mode', []],
    ['--check', ['--check']],
  ])('AC-16: a missing dist exits 2 with the message (%s)', (_name, extra) => {
    const project = tempProject();
    const dist = join(project, 'no-such-dist');
    const file = join(project, 'csp-inline-hashes.json');

    const run = runCli(project, ['--dist', dist, '--file', file, ...extra]);

    expect(run.status).toBe(2);
    expect(run.output).toContain(NO_PAGES(dist));
    expect(existsSync(file)).toBe(false);
  });

  test.each([
    ['write mode', []],
    ['--check', ['--check']],
  ])('AC-16: a dist without any .html exits 2 with the message (%s)', (_name, extra) => {
    const project = tempProject();
    const dist = join(project, 'dist');
    writeFile(join(dist, '_astro', 'app.js'), 'console.log(1);');
    writeFile(join(dist, 'nested', 'robots.txt'), '<script>x()</script>');
    const file = join(project, 'csp-inline-hashes.json');

    const run = runCli(project, ['--dist', dist, '--file', file, ...extra]);

    expect(run.status).toBe(2);
    expect(run.output).toContain(NO_PAGES(dist));
    expect(existsSync(file)).toBe(false);
  });

  test('AC-16: an empty dist exits 2 and leaves an existing file untouched', () => {
    const project = tempProject();
    const dist = join(project, 'dist');
    mkdirSync(dist);
    const file = writeHashFile(join(project, 'csp-inline-hashes.json'), REQUIRED);
    const before = readFileSync(file);

    const run = runCli(project, ['--dist', dist, '--file', file]);

    expect(run.status).toBe(2);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test('AC-16: the default dist missing exits 2', () => {
    const project = tempProject();

    const run = runCli(project, []);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(
      /no built pages in .*dist: run pnpm --filter @field-guide\/site build first/,
    );
    expect(existsSync(join(project, 'apps', 'site', 'csp-inline-hashes.json'))).toBe(false);
  });

  test.each([
    ['an unknown flag', ['--bogus']],
    ['an unknown flag after --check', ['--check', '--bogus']],
    ['an unknown short flag', ['-x']],
    ['--dist without a value', ['--dist']],
    ['--file without a value', ['--file']],
    ['--check and --dist without a value', ['--check', '--dist']],
  ])('AC-16: %s exits 2 with a usage line and writes no file', (_name, args) => {
    const project = tempProject();
    buildDist(project, [], join(project, 'apps', 'site', 'dist'));

    const run = runCli(project, args);

    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(existsSync(join(project, 'apps', 'site', 'csp-inline-hashes.json'))).toBe(false);
  });

  test('AC-16: a flag without its value does not write the explicit file either', () => {
    const project = tempProject();
    buildDist(project, [], join(project, 'apps', 'site', 'dist'));
    const file = join(project, 'csp-inline-hashes.json');

    const run = runCli(project, ['--file', file, '--dist']);

    expect(run.status).toBe(2);
    expect(existsSync(file)).toBe(false);
  });
});
