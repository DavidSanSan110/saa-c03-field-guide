// Helpers to run the review server in-process on temporary folders and to talk to its API.
import { request } from 'node:http';
import { startServer } from '../server.ts';
import type { ReviewServer } from '../server.ts';
import { cleanTemp, filesOf, tempFolder } from './review-fixtures.ts';
import type { Draft, Item } from './review-fixtures.ts';

export const REVIEWER = 'review-user';

const running: ReviewServer[] = [];

/** Starts a server on port 0 over a new temporary folder holding `files`. */
export async function startOn(
  files: Record<string, string>,
): Promise<{ server: ReviewServer; dir: string }> {
  const dir = tempFolder(files);
  const server = await startServer({ drafts: dir, reviewer: REVIEWER, port: 0 });
  running.push(server);
  return { server, dir };
}

/** Starts a server over the given drafts (and sidecars). */
export function startWith(
  ...items: (Draft | Item)[]
): Promise<{ server: ReviewServer; dir: string }> {
  return startOn(filesOf(...items));
}

/** Closes every server started by `startOn` and removes the temporary folders. */
export async function stopAll(): Promise<void> {
  await Promise.all(running.splice(0).map((server) => server.close()));
  cleanTemp();
}

export interface Reply {
  status: number;
  text: string;
  body: unknown;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function toReply(response: Response): Promise<Reply> {
  const text = await response.text();
  return { status: response.status, text, body: parseBody(text) };
}

export async function get(server: ReviewServer, path: string): Promise<Reply> {
  return toReply(await fetch(new URL(path, server.url)));
}

/**
 * POST with the run's token; `token: null` sends no token header, `raw` replaces the JSON body
 * (to send malformed JSON).
 */
export async function post(
  server: ReviewServer,
  path: string,
  body: unknown,
  opts: { token?: string | null; raw?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = opts.token === undefined ? server.token : opts.token;
  if (token !== null) headers['X-Review-Token'] = token;
  return toReply(
    await fetch(new URL(path, server.url), {
      method: 'POST',
      headers,
      body: opts.raw ?? JSON.stringify(body),
    }),
  );
}

/** A request with a chosen `Host` header (fetch does not let a script override it). */
export function rawRequest(
  server: ReviewServer,
  opts: {
    method: 'GET' | 'POST';
    path: string;
    host: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(new URL(server.url).port),
        method: opts.method,
        path: opts.path,
        headers: { ...opts.headers, Host: opts.host },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function queue(server: ReviewServer): Promise<Reply> {
  return get(server, 'api/queue');
}

export function reveal(server: ReviewServer, id: string, answer: string[]): Promise<Reply> {
  return post(server, `api/questions/${id}/reveal`, { answer });
}

/** The queue ids, in order. */
export async function queueIds(server: ReviewServer): Promise<string[]> {
  const { items } = (await queue(server)).body as { items: { id: string }[] };
  return items.map((item) => item.id);
}

export function obj(reply: Reply): Record<string, unknown> {
  return reply.body as Record<string, unknown>;
}

/** The etag of a reveal reply. */
export function etagOf(reply: Reply): string {
  return obj(reply)['etag'] as string;
}

/** The first value found under `key` anywhere in a JSON value (depth first). */
export function find(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (key in record) return record[key];
    for (const item of Object.values(record)) {
      const found = find(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Every object key used anywhere in a JSON value. */
export function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...allKeys(item)]);
  }
  return [];
}

/** A client error that is neither a token (403) nor a stale-etag (409) refusal. */
export function isRefusal(reply: Reply): boolean {
  return reply.status >= 400 && reply.status < 500 && reply.status !== 403 && reply.status !== 409;
}
