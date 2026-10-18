// Review round 1 regression tests (spec 023, AC-33 to AC-41): server side.
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BROKEN_SIDECAR,
  blankVerifier,
  parseErrorLine,
  withFlowProvenance,
} from './__mocks__/round1-fixtures.ts';
import {
  draft,
  filesOf,
  flagged,
  readLog,
  readText,
  snapshot,
  verification,
} from './__mocks__/review-fixtures.ts';
import {
  etagOf,
  get,
  obj,
  post,
  queueIds,
  rawRequest,
  reveal,
  startOn,
  startWith,
  stopAll,
} from './__mocks__/server-fixtures.ts';

afterEach(stopAll);

const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });

describe('approve that would write an invalid question', () => {
  test.each(['', '   '])(
    'AC-33: a verified sidecar with the verifier %j is refused with 422 and nothing changes',
    async (verifier) => {
      const { server, dir } = await startOn(filesOf(blankVerifier(d, verifier)));
      const revealed = await reveal(server, d.id, ['C']);
      expect(obj(revealed)['state']).toBe('verified');
      const before = snapshot(dir);
      const reply = await post(server, `api/questions/${d.id}/approve`, {
        etag: etagOf(revealed),
        answer: ['C'],
      });
      expect(reply.status).toBe(422);
      expect(snapshot(dir)).toEqual(before);
      expect(readLog(dir)).toEqual([]);
      expect(await queueIds(server)).toEqual([d.id]);
    },
  );

  test('AC-33: the refusal says why', async () => {
    const { server } = await startOn(filesOf(blankVerifier(d, '')));
    const etag = etagOf(await reveal(server, d.id, ['C']));
    const reply = await post(server, `api/questions/${d.id}/approve`, { etag, answer: ['C'] });
    expect(reply.text).toMatch(/verifier|verified_by/i);
  });
});

describe('reject that cannot remove the draft', () => {
  const sidecar = { verification: flagged(d) };
  const posixOnly = process.platform === 'win32' || process.getuid?.() === 0;

  test.skipIf(posixOnly)(
    'AC-34: when the draft cannot be unlinked, rejected/ holds no copy of it or its sidecar',
    async () => {
      const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
      const before = snapshot(dir);
      const etag = etagOf(await reveal(server, d.id, ['A']));
      const folder = join(dir, 'd1', '1.3');
      chmodSync(folder, 0o555); // files can be read and copied, but not unlinked
      const sent = post(server, `api/questions/${d.id}/reject`, {
        etag,
        answer: ['A'],
        reason: 'No.',
      });
      let status: number;
      try {
        status = (await sent).status;
      } finally {
        chmodSync(folder, 0o755);
      }
      expect(status).toBeGreaterThanOrEqual(400);
      expect(existsSync(join(dir, 'rejected', d.path))).toBe(false);
      expect(existsSync(join(dir, 'rejected', d.sidecar))).toBe(false);
      expect(snapshot(dir)).toEqual(before);
      expect(readLog(dir)).toEqual([]);
    },
  );
});

describe('approve of a flow-style provenance', () => {
  const flow = withFlowProvenance(d);

  test('AC-35: the draft is a valid question (control)', async () => {
    const { server } = await startWith(flow);
    expect((await get(server, `api/questions/${d.id}/blind`)).status).toBe(200);
  });

  test('AC-35: approving it is 422, the file is unchanged and nothing is logged', async () => {
    const { server, dir } = await startOn(
      filesOf({ draft: flow, sidecar: { verification: verification(flow) } }),
    );
    const revealed = await reveal(server, d.id, ['C']);
    expect(obj(revealed)['state']).toBe('verified');
    const before = snapshot(dir);
    const reply = await post(server, `api/questions/${d.id}/approve`, {
      etag: etagOf(revealed),
      answer: ['C'],
    });
    expect(reply.status).toBe(422);
    expect(readText(dir, flow.path)).toBe(flow.text);
    expect(snapshot(dir)).toEqual(before);
    expect(readLog(dir)).toEqual([]);
    expect(await queueIds(server)).toEqual([d.id]);
  });

  test('AC-35: a confirmed approve of the same draft is 422 too', async () => {
    const { server, dir } = await startOn(filesOf(flow));
    const before = snapshot(dir);
    const etag = etagOf(await reveal(server, d.id, ['C']));
    const reply = await post(server, `api/questions/${d.id}/approve`, {
      etag,
      answer: ['C'],
      confirm: true,
    });
    expect(reply.status).toBe(422);
    expect(snapshot(dir)).toEqual(before);
    expect(readLog(dir)).toEqual([]);
  });
});

describe('sidecar that is not valid YAML', () => {
  test('AC-36: the reveal reply holds the sidecar parse error', async () => {
    const { server } = await startWith({ draft: d, sidecar: BROKEN_SIDECAR });
    const reply = await reveal(server, d.id, ['C']);
    expect(reply.status).toBe(200);
    const line = parseErrorLine(BROKEN_SIDECAR);
    expect(line).not.toBe('');
    expect(reply.text).toContain(JSON.stringify(line).slice(1, -1));
  });

  test('AC-36: a valid sidecar adds no such error (control)', async () => {
    const { server } = await startWith({ draft: d, sidecar: { verification: verification(d) } });
    const reply = await reveal(server, d.id, ['C']);
    expect(reply.text).not.toContain(parseErrorLine(BROKEN_SIDECAR));
  });
});

describe('static assets', () => {
  function assets(html: string): string[] {
    const scripts = [...html.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/g)].map((m) => m[1]);
    const styles = [...html.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /rel=["']stylesheet["']/.test(tag))
      .map((tag) => /href=["']([^"']+)["']/.exec(tag)?.[1]);
    return [...scripts, ...styles].filter((url): url is string => url !== undefined);
  }

  test('AC-39: the page references a script and a stylesheet', async () => {
    const { server } = await startWith(d);
    const html = (await get(server, '')).text;
    const urls = assets(html);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<script\b/);
    expect(html).toMatch(/rel=["']stylesheet["']/);
  });

  test('AC-39: every asset the page references is served for a good Host (control)', async () => {
    const { server } = await startWith(d);
    const urls = assets((await get(server, '')).text);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) {
      const path = new URL(url, server.url).pathname;
      expect((await get(server, path.slice(1))).status, path).toBe(200);
    }
  });

  test('AC-39: every asset the page references is 403 for Host evil.example:<port>', async () => {
    const { server } = await startWith(d);
    const urls = assets((await get(server, '')).text);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    const port = new URL(server.url).port;
    for (const url of urls) {
      const target = new URL(url, server.url);
      const status = await rawRequest(server, {
        method: 'GET',
        path: target.pathname + target.search,
        host: `evil.example:${port}`,
      });
      expect(status, target.pathname).toBe(403);
    }
  });

  test('AC-39: the assets are also 403 for a Host with another port', async () => {
    const { server } = await startWith(d);
    const urls = assets((await get(server, '')).text);
    const other = String(Number(new URL(server.url).port) + 1);
    for (const url of urls) {
      const target = new URL(url, server.url);
      const status = await rawRequest(server, {
        method: 'GET',
        path: target.pathname,
        host: `127.0.0.1:${other}`,
      });
      expect(status, target.pathname).toBe(403);
    }
  });
});
