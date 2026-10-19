import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cleanTemp,
  draft,
  filesOf,
  snapshot,
  tempFolder,
  writeFiles,
} from './__mocks__/review-fixtures.ts';

// Every test spawns a real process (tsx), which is slow on a cold Windows machine.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.ts');
const ROOT = join(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
// The loader that lets plain `node` run the TypeScript CLI: one process, so a kill stops the server.
const TSX_LOADER = pathToFileURL(
  join(dirname(require.resolve('tsx/package.json')), 'dist', 'esm', 'index.mjs'),
).href;

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
    child.kill();
    await exited;
  }
  cleanTemp();
});

interface Run {
  status: number | null;
  output: string;
}

/** Runs the CLI to its end (for the cases that must not start a server). */
function runCli(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

interface Started {
  child: ChildProcess;
  url: string;
  /** Everything printed so far. */
  output: () => string;
}

/** Starts the CLI and waits for its `review: <url>` line. */
function startCli(cwd: string, args: string[]): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI, ...args], {
      cwd,
      windowsHide: true,
    });
    children.push(child);
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`no "review:" line after 30 s, output so far:\n${output}`));
    }, 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = /^review: (http:\/\/127\.0\.0\.1:\d+\/)\s*$/m.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve({ child, url: match[1], output: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`the CLI exited before printing its URL, output:\n${output}`));
    });
  });
}

describe('starting', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });

  test('AC-21: prints the review: URL line and serves the page', async () => {
    const dir = tempFolder(filesOf(d));
    const { url } = await startCli(dir, ['--reviewer', 'x', '--port', '0', '--drafts', dir]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  test('AC-21: the page is served for the drafts folder that was given', async () => {
    const dir = tempFolder(filesOf(d));
    const { url } = await startCli(dir, ['--reviewer', 'x', '--port', '0', '--drafts', dir]);
    const response = await fetch(new URL('api/queue', url));
    expect(await response.json()).toMatchObject({ items: [{ id: d.id, path: d.path }] });
  });

  test('AC-21: the reviewer is written to the approved drafts', async () => {
    const dir = tempFolder(filesOf(d));
    const { url } = await startCli(dir, ['--reviewer', 'ana-gh', '--port', '0', '--drafts', dir]);
    // The token is embedded in the page; try every long word of the page until one is accepted.
    const page = await (await fetch(url)).text();
    const candidates = [...new Set(page.match(/[A-Za-z0-9_-]{16,}/g) ?? [])];
    const send = (token: string, path: string, body: unknown): Promise<Response> =>
      fetch(new URL(path, url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Review-Token': token },
        body: JSON.stringify(body),
      });
    let accepted: { token: string; etag: string } | undefined;
    for (const token of candidates) {
      const reply = await send(token, `api/questions/${d.id}/reveal`, { answer: ['C'] });
      if (reply.status === 200) {
        accepted = { token, etag: ((await reply.json()) as { etag: string }).etag };
        break;
      }
    }
    expect(accepted, 'a token embedded in the page').toBeDefined();
    const approved = await send(accepted?.token ?? '', `api/questions/${d.id}/approve`, {
      etag: accepted?.etag,
      answer: ['C'],
      confirm: true,
    });
    expect(approved.status).toBe(200);
    expect(readFileSync(join(dir, d.path), 'utf8')).toMatch(/reviewed_by: ana-gh/);
  });

  test('AC-21: without --drafts it reads private/questions-drafts of the current directory', async () => {
    const cwd = tempFolder();
    writeFiles(join(cwd, 'private', 'questions-drafts'), filesOf(d));
    const { url } = await startCli(cwd, ['--reviewer', 'x', '--port', '0']);
    const response = await fetch(new URL('api/queue', url));
    expect(await response.json()).toMatchObject({ items: [{ id: d.id }] });
  });

  test('AC-21: it keeps running until it is stopped', async () => {
    const dir = tempFolder(filesOf(d));
    const { child, url } = await startCli(dir, ['--reviewer', 'x', '--port', '0', '--drafts', dir]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(child.exitCode).toBeNull();
    expect((await fetch(url)).status).toBe(200);
  });

  test('AC-21: it does not change any file by starting', async () => {
    const dir = tempFolder(filesOf(d));
    const before = snapshot(dir);
    const { url } = await startCli(dir, ['--reviewer', 'x', '--port', '0', '--drafts', dir]);
    await fetch(new URL('api/queue', url));
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('usage errors', () => {
  const USAGE_CASES: [string, string[]][] = [
    ['a missing --reviewer', ['--port', '0']],
    ['a --reviewer without a value', ['--reviewer']],
    ['a blank --reviewer', ['--reviewer', '   ', '--port', '0']],
    ['a non-numeric --port', ['--reviewer', 'x', '--port', 'abc']],
    ['a --port above 65535', ['--reviewer', 'x', '--port', '65536']],
    ['a negative --port', ['--reviewer', 'x', '--port', '-1']],
    ['a fractional --port', ['--reviewer', 'x', '--port', '1.5']],
    ['a --port without a value', ['--reviewer', 'x', '--port']],
    ['a --drafts without a value', ['--reviewer', 'x', '--drafts']],
    ['an unknown flag', ['--reviewer', 'x', '--port', '0', '--nope']],
    ['a stray argument', ['--reviewer', 'x', '--port', '0', 'extra']],
  ];

  test.each(USAGE_CASES)('AC-21: %s exits 2 with the usage text', (_name, args) => {
    const dir = tempFolder(filesOf(draft({ id: 'd1-1.3-0007' })));
    const run = runCli(dir, ['--drafts', dir, ...args]);
    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('--reviewer');
  });

  test('AC-21: a usage error does not start a server or touch a file', () => {
    const dir = tempFolder(filesOf(draft({ id: 'd1-1.3-0007' })));
    const before = snapshot(dir);
    const run = runCli(dir, ['--drafts', dir, '--port', '0']);
    expect(run.status).toBe(2);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-21: a missing drafts folder exits 1 with a message that names it', () => {
    const cwd = tempFolder();
    const missing = join(cwd, 'no-such-drafts');
    const run = runCli(cwd, ['--reviewer', 'x', '--port', '0', '--drafts', missing]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('no-such-drafts');
    expect(existsSync(missing)).toBe(false);
  });

  test('AC-21: the default drafts folder missing exits 1 and names it', () => {
    const cwd = tempFolder();
    const run = runCli(cwd, ['--reviewer', 'x', '--port', '0']);
    expect(run.status).toBe(1);
    expect(run.output).toContain('questions-drafts');
  });
});

describe('root package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  test('AC-22: has a review script that runs this CLI', () => {
    expect(pkg.scripts['review']).toMatch(/tsx\s+tools\/review\/src\/cli\.ts/);
  });

  test('AC-22: the script points at a file that exists', () => {
    expect(existsSync(join(ROOT, 'tools', 'review', 'src', 'cli.ts'))).toBe(true);
  });
});
describe('spec 025 --allow-host', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });

  /** GET / with a chosen `Host` header on the port of the printed url. */
  function statusAsHost(url: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: Number(new URL(url).port), path: '/', headers: { Host: host } },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /** Waits until the output has `count` lines starting with `review: also accepting Host`. */
  async function alsoLines(started: Started, count: number): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const lines = started
        .output()
        .split(/\r?\n/)
        .filter((line) => line.startsWith('review: also accepting Host'));
      if (lines.length >= count || Date.now() > deadline) return lines;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  test('AC-6: prints one "also accepting Host" line per --allow-host, after the URL line', async () => {
    const dir = tempFolder(filesOf(d));
    const started = await startCli(dir, [
      '--reviewer',
      'x',
      '--port',
      '0',
      '--drafts',
      dir,
      '--allow-host',
      'a.example',
      '--allow-host',
      'b.example:8443',
    ]);
    const lines = await alsoLines(started, 2);
    expect(lines).toEqual([
      'review: also accepting Host a.example',
      'review: also accepting Host b.example:8443',
    ]);
    const output = started.output();
    expect(output.indexOf('review: http://')).toBeGreaterThanOrEqual(0);
    expect(output.indexOf('review: http://')).toBeLessThan(
      output.indexOf('review: also accepting Host a.example'),
    );
  });

  test('AC-6: a request with Host a.example to the printed port gets 200', async () => {
    const dir = tempFolder(filesOf(d));
    const { url } = await startCli(dir, [
      '--reviewer',
      'x',
      '--port',
      '0',
      '--drafts',
      dir,
      '--allow-host',
      'a.example',
      '--allow-host',
      'b.example:8443',
    ]);
    expect(await statusAsHost(url, 'a.example')).toBe(200);
    expect(await statusAsHost(url, 'b.example:8443')).toBe(200);
  });

  test('AC-6: a Host that was not named is still 403', async () => {
    const dir = tempFolder(filesOf(d));
    const { url } = await startCli(dir, [
      '--reviewer',
      'x',
      '--port',
      '0',
      '--drafts',
      dir,
      '--allow-host',
      'a.example',
    ]);
    expect(await statusAsHost(url, 'evil.example')).toBe(403);
    expect(await statusAsHost(url, 'b.example')).toBe(403);
  });

  test('AC-6: without --allow-host no "also accepting" line is printed and the extra Host is 403', async () => {
    const dir = tempFolder(filesOf(d));
    const started = await startCli(dir, ['--reviewer', 'x', '--port', '0', '--drafts', dir]);
    expect(await statusAsHost(started.url, 'a.example')).toBe(403);
    expect(started.output()).not.toContain('also accepting');
  });

  test('AC-6: a host name with a hyphen, a digit and a dot, and an IPv4 address, are accepted', async () => {
    const dir = tempFolder(filesOf(d));
    const started = await startCli(dir, [
      '--reviewer',
      'x',
      '--port',
      '0',
      '--drafts',
      dir,
      '--allow-host',
      'desktop-1.tail1234.ts.net',
      '--allow-host',
      '100.64.0.7:443',
    ]);
    expect(await alsoLines(started, 2)).toEqual([
      'review: also accepting Host desktop-1.tail1234.ts.net',
      'review: also accepting Host 100.64.0.7:443',
    ]);
  });

  const BAD_VALUES: [string, string[]][] = [
    ['no value', ['--allow-host']],
    ['no value before another flag', ['--allow-host', '--port', '0']],
    ['an empty value', ['--allow-host', '']],
    ['a scheme', ['--allow-host', 'https://a.example']],
    ['a space', ['--allow-host', 'a b']],
    ['a slash', ['--allow-host', 'a/b']],
    ['an @', ['--allow-host', 'user@a.example']],
    ['an empty port', ['--allow-host', 'a.example:']],
    ['a port of six digits', ['--allow-host', 'a.example:123456']],
    ['a non-numeric port', ['--allow-host', 'a.example:http']],
    ['a second colon', ['--allow-host', 'a.example:80:80']],
    ['a bad value after a good one', ['--allow-host', 'a.example', '--allow-host', 'a b']],
  ];

  test.each(BAD_VALUES)('AC-7: --allow-host with %s exits 2 with the usage text', (_name, args) => {
    const dir = tempFolder(filesOf(d));
    const run = runCli(dir, ['--drafts', dir, '--reviewer', 'x', '--port', '0', ...args]);
    expect(run.status).toBe(2);
    expect(run.output).toMatch(/usage/i);
    expect(run.output).toContain('--allow-host');
  });

  test('AC-7: a bad --allow-host does not start a server or touch a file', () => {
    const dir = tempFolder(filesOf(d));
    const before = snapshot(dir);
    const run = runCli(dir, [
      '--drafts',
      dir,
      '--reviewer',
      'x',
      '--port',
      '0',
      '--allow-host',
      'a/b',
    ]);
    expect(run.status).toBe(2);
    expect(run.output).not.toContain('review: http');
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-7: the usage text of another usage error mentions --allow-host', () => {
    const dir = tempFolder(filesOf(d));
    const run = runCli(dir, ['--drafts', dir, '--port', '0']);
    expect(run.status).toBe(2);
    expect(run.output).toContain('--allow-host');
  });

  const UNDERSCORE_VALUES: [string, string[]][] = [
    ['an underscore in a host name', ['--allow-host', 'a_b']],
    ['an underscore in a host name with a port', ['--allow-host', 'a_b.example:8443']],
  ];

  test.each(UNDERSCORE_VALUES)(
    'AC-8: --allow-host with %s exits 2 with the usage text',
    (_name, args) => {
      const dir = tempFolder(filesOf(d));
      const run = runCli(dir, ['--drafts', dir, '--reviewer', 'x', '--port', '0', ...args]);
      expect(run.status).toBe(2);
      expect(run.output).toMatch(/usage/i);
      expect(run.output).toContain('--allow-host');
    },
  );

  test('AC-8: --allow-host a-b.example (a hyphen, no underscore) is accepted and served', async () => {
    const dir = tempFolder(filesOf(d));
    const started = await startCli(dir, [
      '--reviewer',
      'x',
      '--port',
      '0',
      '--drafts',
      dir,
      '--allow-host',
      'a-b.example',
    ]);
    expect(await alsoLines(started, 1)).toEqual(['review: also accepting Host a-b.example']);
    expect(await statusAsHost(started.url, 'a-b.example')).toBe(200);
  });
});
