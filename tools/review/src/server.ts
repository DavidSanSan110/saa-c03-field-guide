// HTTP server of the review tool (spec 023): serves the page and a small JSON API over a drafts
// folder, on 127.0.0.1 only. The folder is read again on every request; the logic is in review.ts.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { sidecarPath } from '@field-guide/questions/bank';
import type { BankEntry, FileMap } from '@field-guide/questions/bank';
import { formatIssues, getTask, questionSchema } from '@field-guide/schema';
import type { Question } from '@field-guide/schema';
import { parse } from 'yaml';
import { approvedText, buildQueue, checkEdit, isCorrect, verificationState } from './review.ts';
import type { VerificationState } from './review.ts';

export interface ReviewServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;
const REJECTED = 'rejected';
const LOG_FILE = 'review-log.jsonl';

const PAGE_DIR = new URL('../page/', import.meta.url);
const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** A refusal with its HTTP status; `details` are extra JSON fields (the list of errors). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The YAML files of the drafts folder: their bytes and the same bytes decoded as text. */
interface Folder {
  files: FileMap;
  bytes: Record<string, Buffer>;
}

/** Reads the drafts folder (no links, no rejected/); each file is read once. */
function readFolder(root: string): Folder {
  const folder: Folder = { files: {}, bytes: {} };
  const walk = (relative: string): void => {
    const dir = relative === '' ? root : join(root, relative);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (path !== REJECTED) walk(path);
      } else if (entry.isFile() && /\.ya?ml$/.test(path)) {
        const bytes = readFileSync(join(root, path));
        folder.bytes[path] = bytes;
        folder.files[path] = bytes.toString('utf8');
      }
    }
  };
  walk('');
  return folder;
}

interface Sidecar {
  value: Json | undefined;
  error?: string;
}

function readSidecar(root: string, draftPath: string): Sidecar {
  const file = join(root, sidecarPath(draftPath));
  if (!existsSync(file)) return { value: undefined };
  try {
    const value: unknown = parse(readFileSync(file, 'utf8'));
    if (value === null || value === undefined) return { value: undefined };
    if (isJson(value)) return { value };
    return { value: undefined, error: 'the check file must be a YAML mapping' };
  } catch (error) {
    return { value: undefined, error: errorText(error) };
  }
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > MAX_BODY) throw new HttpError(413, 'the request is too large');
    chunks.push(part);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
  if (!isJson(body)) throw new HttpError(400, 'the body must be a JSON object');
  return body;
}

function answerOf(body: Json): string[] {
  const { answer } = body;
  if (!Array.isArray(answer) || !answer.every((key) => typeof key === 'string')) {
    throw new HttpError(400, 'answer must be a list of option keys');
  }
  return [...new Set(answer.map((key) => key.toUpperCase()))].sort();
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

/** Moves a file without ever replacing the target (copy with exclusive create, then delete). */
function moveNew(from: string, to: string): void {
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  try {
    unlinkSync(from);
  } catch (error) {
    // The source stays where it was: no copy may be left behind.
    rmSync(to, { force: true });
    throw error;
  }
}

/** The id in a URL; a malformed escape is just an id that does not exist. */
function idOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Found {
  entry: BankEntry;
  etag: string;
}

function blindOf(question: Question): Json {
  return {
    id: question.id,
    task: question.task,
    taskTitle: getTask(question.task)?.title ?? '',
    type: question.type,
    k: question.options.filter((option) => option.correct).length,
    stem: question.stem,
    options: question.options.map(({ key, text }) => ({ key, text })),
  };
}

export function startServer(opts: {
  drafts: string;
  reviewer: string;
  port: number;
}): Promise<ReviewServer> {
  const root = opts.drafts;
  const token = randomBytes(24).toString('base64url');
  let port = 0;

  const allowedHosts = (): string[] => [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];

  /** The queued draft with that id; the etag is the hash of the bytes its text was read from. */
  function find(id: string): Found {
    const { files, bytes } = readFolder(root);
    const entry = buildQueue(files).items.find((item) => item.question.id === id);
    if (entry === undefined) throw new HttpError(404, `no draft in the queue has the id ${id}`);
    return { entry, etag: sha256(bytes[entry.path] as Buffer) };
  }

  function checkEtag(found: Found, body: Json): void {
    if (body['etag'] !== found.etag) {
      throw new HttpError(409, 'the draft changed on disk, reload');
    }
  }

  function stateOf(entry: BankEntry): { state: VerificationState; sidecar: Sidecar } {
    const sidecar = readSidecar(root, entry.path);
    return { state: verificationState(entry.question, sidecar.value), sidecar };
  }

  function log(
    entry: BankEntry,
    record: { decision: string; answer: string[]; state: VerificationState; reason?: string },
  ): void {
    const line = {
      at: new Date().toISOString(),
      id: entry.question.id,
      path: entry.path,
      decision: record.decision,
      by: opts.reviewer,
      answer: record.answer,
      correct: isCorrect(entry.question, record.answer),
      state: record.state,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    };
    appendFileSync(join(root, LOG_FILE), `${JSON.stringify(line)}\n`);
  }

  function reveal(found: Found, body: Json): Json {
    const answer = answerOf(body);
    const { question } = found.entry;
    const { state, sidecar } = stateOf(found.entry);
    return {
      ...blindOf(question),
      services: question.services,
      difficulty: question.difficulty,
      options: question.options.map(({ key, text, correct, why }) => ({ key, text, correct, why })),
      cue: question.cue ?? null,
      references: question.references,
      correct: isCorrect(question, answer),
      state,
      verification: sidecar.value?.['verification'] ?? null,
      dedupe: sidecar.value?.['dedupe'] ?? null,
      sidecarError: sidecar.error ?? null,
      etag: found.etag,
    };
  }

  function approve(found: Found, body: Json): Json {
    const answer = answerOf(body);
    checkEtag(found, body);
    const { state, sidecar } = stateOf(found.entry);
    if (state !== 'verified' && body['confirm'] !== true) {
      throw new HttpError(409, `the verification state is ${state}, confirm to approve anyway`);
    }
    const verification = sidecar.value?.['verification'];
    const verifier = isJson(verification) ? verification['verifier'] : undefined;
    let text: string;
    try {
      text = approvedText(found.entry.text, {
        reviewer: opts.reviewer,
        ...(state === 'verified' && typeof verifier === 'string' ? { verifier } : {}),
      });
    } catch (error) {
      throw new HttpError(422, errorText(error));
    }
    // A blank verifier in the check file, say, would make the approved draft invalid.
    const check = questionSchema.safeParse(parse(text));
    if (!check.success) {
      const issues = formatIssues(check.error.issues).join('; ');
      throw new HttpError(422, `approving would write an invalid question (${issues})`);
    }
    writeFileSync(join(root, found.entry.path), text);
    log(found.entry, { decision: 'approved', answer, state });
    return { ok: true };
  }

  function source(found: Found): Json {
    return { text: found.entry.text, etag: found.etag };
  }

  function edit(found: Found, body: Json): Json {
    checkEtag(found, body);
    if (typeof body['text'] !== 'string') throw new HttpError(400, 'text must be a string');
    const text = body['text'].replaceAll('\r\n', '\n');
    const result = checkEdit(found.entry.question, text);
    if (!result.ok) {
      throw new HttpError(422, 'the draft was not saved', { errors: result.errors });
    }
    writeFileSync(join(root, found.entry.path), text);
    return { ok: true };
  }

  function reject(found: Found, body: Json): Json {
    const answer = answerOf(body);
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (reason === '') throw new HttpError(400, 'a reason is required to reject a draft');
    checkEtag(found, body);
    const { state } = stateOf(found.entry);

    const { path } = found.entry;
    const moves = [path, sidecarPath(path)].map((relative) => ({
      from: join(root, relative),
      to: join(root, REJECTED, relative),
    }));
    const [draftMove, sidecarMove] = moves as [(typeof moves)[0], (typeof moves)[0]];
    mkdirSync(dirname(draftMove.to), { recursive: true });
    try {
      moveNew(draftMove.from, draftMove.to);
    } catch (error) {
      throw moveError(error);
    }
    if (existsSync(sidecarMove.from)) {
      try {
        moveNew(sidecarMove.from, sidecarMove.to);
      } catch (error) {
        try {
          renameSync(draftMove.to, draftMove.from);
        } catch {
          throw new HttpError(
            500,
            `the draft is now in ${REJECTED}/ but its check file could not be moved: ${errorText(error)}`,
          );
        }
        throw moveError(error);
      }
    }
    log(found.entry, { decision: 'rejected', answer, state, reason });
    return { ok: true };
  }

  function moveError(error: unknown): HttpError {
    const code = (error as NodeJS.ErrnoException).code;
    return new HttpError(
      code === 'EEXIST' ? 409 : 500,
      `nothing was rejected, the files could not be moved: ${errorText(error)}`,
    );
  }

  const actions: Record<string, (found: Found, body: Json) => Json> = {
    reveal,
    approve,
    edit,
    reject,
  };

  function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> | void {
    if (path === '/api/queue') {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET');
      const { items, waiting, problems } = buildQueue(readFolder(root).files);
      sendJson(res, 200, {
        items: items.map((item) => ({ id: item.question.id, path: item.path })),
        total: items.length,
        waiting,
        problems: problems.map((problem) => ({ path: problem.file, message: problem.message })),
      });
      return;
    }
    const match = /^\/api\/questions\/([^/]+)\/(blind|source|reveal|approve|edit|reject)$/.exec(
      path,
    );
    if (match === null) throw new HttpError(404, 'not found');
    const id = idOf(match[1] as string);
    const name = match[2] as string;

    if (name === 'blind' || name === 'source') {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET');
      const found = find(id);
      sendJson(res, 200, name === 'blind' ? blindOf(found.entry.question) : source(found));
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'use POST');
    const supplied = req.headers['x-review-token'];
    if (typeof supplied !== 'string' || !sameText(supplied, token)) {
      throw new HttpError(403, 'missing or wrong review token');
    }
    const action = actions[name] as (found: Found, body: Json) => Json;
    const found = find(id);
    return readBody(req).then((body) => {
      sendJson(res, 200, action(found, body));
    });
  }

  function route(req: IncomingMessage, res: ServerResponse): Promise<void> | void {
    if (!allowedHosts().includes(req.headers.host ?? '')) {
      throw new HttpError(403, 'unexpected Host header');
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path.startsWith('/api/')) return api(req, res, path);

    const asset = ASSETS[path];
    if (asset === undefined) throw new HttpError(404, 'not found');
    if (req.method !== 'GET') throw new HttpError(405, 'use GET');
    const text = readFileSync(new URL(asset.file, PAGE_DIR), 'utf8');
    send(res, 200, text.replaceAll('{{token}}', token), asset.type);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await route(req, res);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message, ...error.details });
        } else {
          sendJson(res, 500, { error: errorText(error) });
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${String(port)}/`,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            server.closeAllConnections();
          }),
      });
    });
  });
}
