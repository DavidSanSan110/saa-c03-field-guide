import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { formatIssues, questionSchema } from '@field-guide/schema';
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  allMarks,
  approvedValue,
  dedupe,
  draft,
  etagOfFile,
  filesOf,
  flagged,
  mutated,
  readLog,
  readText,
  REFERENCES,
  replaceOnce,
  sidecarYaml,
  snapshot,
  stemToStatus,
  tempFolder,
  verification,
  writeFiles,
} from './__mocks__/review-fixtures.ts';
import type { Draft, Raw } from './__mocks__/review-fixtures.ts';
import {
  allKeys,
  etagOf,
  find,
  get,
  isRefusal,
  obj,
  post,
  queue,
  queueIds,
  rawRequest,
  REVIEWER,
  reveal,
  startOn,
  startWith,
  stopAll,
} from './__mocks__/server-fixtures.ts';
import { startServer } from './server.ts';

afterEach(stopAll);

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_CLI = join(HERE, '..', '..', 'questions', 'src', 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

function approve(server: Parameters<typeof post>[0], id: string, body: Raw) {
  return post(server, `api/questions/${id}/approve`, body);
}

function reject(server: Parameters<typeof post>[0], id: string, body: Raw) {
  return post(server, `api/questions/${id}/reject`, body);
}

function edit(server: Parameters<typeof post>[0], id: string, body: Raw) {
  return post(server, `api/questions/${id}/edit`, body);
}

/** True when a TCP connection to the host and port succeeds within two seconds. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

describe('listening', () => {
  test('AC-8: the url is http://127.0.0.1:<port>/ with the port that was picked', async () => {
    const { server } = await startWith(draft({ id: 'd1-1.3-0007' }));
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/);
  });

  test('AC-8: the server answers on that url', async () => {
    const { server } = await startWith(draft({ id: 'd1-1.3-0007' }));
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
  });

  test('AC-8: the server does not accept connections on ::1', async () => {
    const { server } = await startWith(draft({ id: 'd1-1.3-0007' }));
    expect(await canConnect('::1', Number(new URL(server.url).port))).toBe(false);
  });

  const external = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info?.family === 'IPv4' && !info.internal)
    .map((info) => info?.address ?? '');

  test.skipIf(external.length === 0)(
    'AC-8: the server does not accept connections on a non-loopback address of this machine',
    async () => {
      const { server } = await startWith(draft({ id: 'd1-1.3-0007' }));
      const port = Number(new URL(server.url).port);
      const results = await Promise.all(external.map((address) => canConnect(address, port)));
      expect(results).not.toContain(true);
    },
  );

  test('AC-8: close() stops the server', async () => {
    const server = await startServer({ drafts: tempFolder(), reviewer: REVIEWER, port: 0 });
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});

describe('GET /api/queue', () => {
  const alpha = draft({ id: 'd1-1.1-0003', slug: 'alpha' });
  const beta = draft({ id: 'd1-1.1-0001', slug: 'beta', status: 'verified' });
  const gamma = draft({ id: 'd1-1.3-0002', slug: 'gamma' });
  const done = draft({ id: 'd2-2.1-0001', slug: 'done', status: 'reviewed' });
  const old = draft({ id: 'd1-1.1-0009', slug: 'old' });

  const files = {
    ...filesOf(alpha, beta, gamma, done),
    [`rejected/${old.path}`]: old.text,
    'd1/1.1/broken.yaml': 'id: [unclosed\n',
  };

  test('AC-9: returns the items sorted by id, with path, and the total', async () => {
    const { server } = await startOn(files);
    const reply = await queue(server);
    expect(reply.status).toBe(200);
    const body = obj(reply);
    expect(body['items']).toEqual([
      { id: beta.id, path: beta.path },
      { id: alpha.id, path: alpha.path },
      { id: gamma.id, path: gamma.path },
    ]);
    expect(body['total']).toBe(3);
  });

  test('AC-9: returns the number of reviewed drafts waiting for promote', async () => {
    const { server } = await startOn(files);
    expect(obj(await queue(server))['waiting']).toBe(1);
  });

  test('AC-9: returns the problem files with path and message', async () => {
    const { server } = await startOn(files);
    const problems = obj(await queue(server))['problems'];
    expect(problems).toEqual([
      { path: 'd1/1.1/broken.yaml', message: expect.any(String) as string },
    ]);
    const first = (problems as { message: string }[])[0];
    expect(first?.message.trim()).not.toBe('');
  });

  test('AC-9: an empty folder gives an empty queue', async () => {
    const { server } = await startOn({});
    expect(obj(await queue(server))).toEqual({ items: [], total: 0, waiting: 0, problems: [] });
  });
});

describe('GET /api/questions/<id>/blind', () => {
  const single = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const multiple = draft({ id: 'd1-1.3-0008', slug: 'two-actions', type: 'multiple' });

  async function blind(d: Draft) {
    const { server } = await startWith(
      {
        draft: single,
        sidecar: { verification: verification(single), dedupe: dedupe() },
      },
      { draft: multiple, sidecar: { verification: flagged(multiple), dedupe: dedupe() } },
    );
    return get(server, `api/questions/${d.id}/blind`);
  }

  test('AC-10: returns id, task, task title, type, k, stem and the option keys and texts', async () => {
    const reply = await blind(single);
    expect(reply.status).toBe(200);
    expect(find(reply.body, 'id')).toBe(single.id);
    expect(find(reply.body, 'task')).toBe('1.3');
    expect(reply.text).toContain(single.taskTitle);
    expect(find(reply.body, 'type')).toBe('single');
    expect(find(reply.body, 'k')).toBe(1);
    expect(find(reply.body, 'stem')).toBe(single.stem);
    const options = find(reply.body, 'options') as { key: string; text: string }[];
    expect(options.map((option) => [option.key, option.text])).toEqual(
      single.optionTexts.map((text, index) => [String.fromCharCode(65 + index), text]),
    );
  });

  test('AC-10: k is the number of correct options of a multiple-answer question', async () => {
    const reply = await blind(multiple);
    expect(find(reply.body, 'type')).toBe('multiple');
    expect(find(reply.body, 'k')).toBe(2);
    expect((find(reply.body, 'options') as unknown[]).length).toBe(5);
  });

  test.each([['single'], ['multiple']] as const)(
    'AC-10: a %s question has no key field anywhere in the JSON',
    async (kind) => {
      const reply = await blind(kind === 'single' ? single : multiple);
      const keys = allKeys(reply.body);
      for (const forbidden of ['correct', 'why', 'cue', 'references', 'verification', 'dedupe']) {
        expect(keys).not.toContain(forbidden);
      }
    },
  );

  test('AC-10: the options carry only a key and a text', async () => {
    const reply = await blind(single);
    const options = find(reply.body, 'options') as Record<string, unknown>[];
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(['key', 'text']);
    }
  });

  test.each([['single'], ['multiple']] as const)(
    'AC-10: no marker text of the why, cue, references or sidecar is in the %s reply',
    async (kind) => {
      const reply = await blind(kind === 'single' ? single : multiple);
      for (const marker of [...allMarks(), 'claude-opus', 'docs.aws.amazon.com']) {
        expect(reply.text).not.toContain(marker);
      }
    },
  );
});

describe('POST /api/questions/<id>/reveal', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });

  test('AC-11: returns the full question with the key, the why of each option and the cue', async () => {
    const { server } = await startWith({
      draft: d,
      sidecar: { verification: verification(d), dedupe: dedupe() },
    });
    const reply = await reveal(server, d.id, ['C']);
    expect(reply.status).toBe(200);
    const options = find(reply.body, 'options') as Raw[];
    expect(options.map((option) => option['correct'])).toEqual([false, false, true, false]);
    expect(options.map((option) => option['why'])).toEqual(
      d.question.options.map((option) => option.why),
    );
    expect(find(reply.body, 'cue')).toBe(d.question.cue);
    expect(find(reply.body, 'references')).toEqual(REFERENCES);
    expect(find(reply.body, 'services')).toEqual(['s3', 'kms']);
    expect(find(reply.body, 'difficulty')).toBe('medium');
  });

  test('AC-11: returns correct for the answer sent', async () => {
    const { server } = await startWith(d);
    expect(obj(await reveal(server, d.id, ['C']))['correct']).toBe(true);
    expect(obj(await reveal(server, d.id, ['A']))['correct']).toBe(false);
    expect(obj(await reveal(server, d.id, []))['correct']).toBe(false);
  });

  test('AC-11: returns the verification state, and the verification and dedupe values', async () => {
    const { server } = await startWith({
      draft: d,
      sidecar: { verification: verification(d), dedupe: dedupe() },
    });
    const reply = await reveal(server, d.id, ['C']);
    expect(obj(reply)['state']).toBe('verified');
    expect(find(reply.body, 'verification')).toEqual(verification(d));
    expect(find(reply.body, 'dedupe')).toEqual(dedupe());
  });

  test('AC-11: returns the etag, the SHA-256 of the draft file', async () => {
    const { server, dir } = await startWith(d);
    const reply = await reveal(server, d.id, ['C']);
    expect(etagOf(reply)).toBe(etagOfFile(dir, d.path));
  });

  test('AC-11: a question without a sidecar has state none and no sidecar values', async () => {
    const { server } = await startWith(d);
    const reply = await reveal(server, d.id, ['C']);
    expect(reply.status).toBe(200);
    expect(obj(reply)['state']).toBe('none');
    expect(find(reply.body, 'verification') ?? null).toBeNull();
    expect(find(reply.body, 'dedupe') ?? null).toBeNull();
  });

  test('AC-11: a sidecar with a verification that is flagged gives the state flagged', async () => {
    const { server } = await startWith({ draft: d, sidecar: { verification: flagged(d) } });
    expect(obj(await reveal(server, d.id, ['C']))['state']).toBe('flagged');
  });

  test('AC-11: an unreadable sidecar does not break the reveal', async () => {
    const { server } = await startWith({ draft: d, sidecar: 'verification: [unclosed\n' });
    const reply = await reveal(server, d.id, ['C']);
    expect(reply.status).toBe(200);
    expect(obj(reply)['state']).toBe('none');
  });

  test('AC-11: reads the sidecar again on every reveal', async () => {
    const { server, dir } = await startWith({ draft: d, sidecar: { verification: flagged(d) } });
    expect(obj(await reveal(server, d.id, ['C']))['state']).toBe('flagged');
    writeFileSync(join(dir, d.sidecar), sidecarYaml({ verification: verification(d) }));
    expect(obj(await reveal(server, d.id, ['C']))['state']).toBe('verified');
  });
});

describe('POST /api/questions/<id>/approve', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const other = draft({ id: 'd1-1.3-0008', slug: 'other' });
  const done = draft({ id: 'd2-2.1-0001', slug: 'done', status: 'reviewed' });

  test('AC-12: a verified question is approved with the sidecar verifier as verified_by', async () => {
    const sidecar = sidecarYaml({ verification: verification(d), dedupe: dedupe() });
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }, other, done));
    const etag = etagOf(await reveal(server, d.id, ['C']));
    const reply = await approve(server, d.id, { etag, answer: ['C'] });
    expect(reply.status).toBe(200);
    expect(parse(readText(dir, d.path))).toEqual(approvedValue(d, 'claude-opus'));
  });

  test('AC-12: the approved draft keeps its comments, stem and options byte for byte', async () => {
    const { server, dir } = await startWith({
      draft: d,
      sidecar: { verification: verification(d) },
    });
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'] });
    const text = readText(dir, d.path);
    expect(text).toContain(stemToStatus(d.text));
    expect(text).toContain('# keep this distractor');
    expect(text).toContain('# Draft written by the question-writer');
  });

  test('AC-12: the sidecar is left unchanged', async () => {
    const sidecar = sidecarYaml({ verification: verification(d), dedupe: dedupe() });
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'] });
    expect(readText(dir, d.sidecar)).toBe(sidecar);
  });

  test('AC-12: the question leaves the queue and waiting grows by one', async () => {
    const { server } = await startWith(
      { draft: d, sidecar: { verification: verification(d) } },
      other,
      done,
    );
    const before = obj(await queue(server));
    expect(before['waiting']).toBe(1);
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'] });
    const after = obj(await queue(server));
    expect(await queueIds(server)).toEqual([other.id]);
    expect(after['total']).toBe(1);
    expect(after['waiting']).toBe(2);
  });

  test('AC-12: pnpm questions check still passes on the folder', async () => {
    const { server, dir } = await startWith(
      { draft: d, sidecar: { verification: verification(d) } },
      other,
    );
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'] });
    const bank = tempFolder();
    const run = spawnSync(
      process.execPath,
      [TSX_CLI, QUESTIONS_CLI, 'check', '--drafts', dir, '--bank', bank],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(run.status).toBe(0);
  }, 60_000);

  const STATES: [string, (q: Draft) => Raw | undefined][] = [
    ['changed', (q) => ({ verification: verification(q, { digest: '0000000000000000' }) })],
    ['flagged', (q) => ({ verification: flagged(q, 'mismatch') })],
    ['flagged', (q) => ({ verification: flagged(q, 'unsupported') })],
    ['none', () => undefined],
  ];

  test.each(STATES)(
    'AC-13: without confirm, a %s question is refused with 409',
    async (state, make) => {
      const sidecar = make(d);
      const { server, dir } = await startOn(
        filesOf(sidecar === undefined ? d : { draft: d, sidecar }, other),
      );
      const revealed = await reveal(server, d.id, ['C']);
      expect(obj(revealed)['state']).toBe(state);
      const before = snapshot(dir);
      const etag = etagOf(revealed);

      expect((await approve(server, d.id, { etag, answer: ['C'] })).status).toBe(409);
      expect((await approve(server, d.id, { etag, answer: ['C'], confirm: false })).status).toBe(
        409,
      );
      expect(snapshot(dir)).toEqual(before);
      expect(await queueIds(server)).toEqual([d.id, other.id]);
    },
  );

  test.each(STATES)(
    'AC-13: with confirm, a %s question is approved with the reviewer as verified_by',
    async (_state, make) => {
      const sidecar = make(d);
      const { server, dir } = await startOn(
        filesOf(sidecar === undefined ? d : { draft: d, sidecar }),
      );
      const etag = etagOf(await reveal(server, d.id, ['C']));
      const reply = await approve(server, d.id, { etag, answer: ['C'], confirm: true });
      expect(reply.status).toBe(200);
      expect(parse(readText(dir, d.path))).toEqual(approvedValue(d, REVIEWER));
    },
  );

  test('AC-13: a question edited after its verification needs a confirm', async () => {
    const { server, dir } = await startWith({
      draft: d,
      sidecar: { verification: verification(d) },
    });
    const edited = replaceOnce(d.text, 'Which option meets', 'Which single option meets');
    writeFileSync(join(dir, d.path), edited);
    const revealed = await reveal(server, d.id, ['C']);
    expect(obj(revealed)['state']).toBe('changed');
    const reply = await approve(server, d.id, { etag: etagOf(revealed), answer: ['C'] });
    expect(reply.status).toBe(409);
  });
});

describe('POST /api/questions/<id>/edit and GET /source', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });

  test('AC-14: GET source returns the file text and its etag', async () => {
    const { server, dir } = await startWith(d);
    const reply = await get(server, `api/questions/${d.id}/source`);
    expect(reply.status).toBe(200);
    expect(obj(reply)['text']).toBe(d.text);
    expect(obj(reply)['etag']).toBe(etagOfFile(dir, d.path));
  });

  test('AC-14: a valid text is written as typed, with LF line endings', async () => {
    const { server, dir } = await startWith(d);
    const etag = obj(await get(server, `api/questions/${d.id}/source`))['etag'];
    const typed = replaceOnce(d.text, 'owns the keys.', 'owns and rotates the keys.');
    const reply = await edit(server, d.id, { etag, text: typed.replaceAll('\n', '\r\n') });
    expect(reply.status).toBe(200);
    expect(readText(dir, d.path)).toBe(typed);
  });

  test('AC-14: the saved text is what the next reveal shows', async () => {
    const { server } = await startWith(d);
    const etag = obj(await get(server, `api/questions/${d.id}/source`))['etag'];
    const typed = replaceOnce(d.text, 'owns the keys.', 'owns and rotates the keys.');
    await edit(server, d.id, { etag, text: typed });
    const options = find((await reveal(server, d.id, ['C'])).body, 'options') as Raw[];
    expect(options[0]?.['why']).toContain('owns and rotates the keys.');
  });

  const BAD_SCHEMA = (q: Raw): void => {
    q['stem'] = 'too short';
  };

  const REFUSED: [string, (text: Draft) => string, RegExp][] = [
    ['invalid YAML', () => 'id: [unclosed\n', /\S/],
    ['a schema failure', (x) => mutated(x, BAD_SCHEMA), /stem/],
    [
      'a changed id',
      (x) =>
        mutated(x, (q) => {
          q['id'] = 'd1-1.3-0099';
        }),
      /\bid\b/,
    ],
    [
      'a changed domain',
      (x) =>
        mutated(x, (q) => {
          q['domain'] = 2;
        }),
      /\bdomain\b/,
    ],
    [
      'a changed task',
      (x) =>
        mutated(x, (q) => {
          q['task'] = '1.2';
        }),
      /\btask\b/,
    ],
    [
      'a changed status',
      (x) =>
        mutated(x, (q) => {
          q['status'] = 'verified';
          q['provenance'] = { generated_by: 'claude-sonnet', verified_by: 'claude-opus' };
        }),
      /\bstatus\b/,
    ],
    [
      'a changed provenance',
      (x) =>
        mutated(x, (q) => {
          q['provenance'] = { generated_by: 'someone-else' };
        }),
      /\bprovenance\b/,
    ],
  ];

  test.each(REFUSED)(
    'AC-14: %s is refused, with the reasons, and the file is untouched',
    async (_name, make, reason) => {
      const { server, dir } = await startWith(d);
      const before = snapshot(dir);
      const etag = obj(await get(server, `api/questions/${d.id}/source`))['etag'];
      const reply = await edit(server, d.id, { etag, text: make(d) });
      expect(isRefusal(reply)).toBe(true);
      expect(reply.text).toMatch(reason);
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test('AC-14: a schema failure returns the formatIssues messages', async () => {
    const { server } = await startWith(d);
    const broken = parse(d.text) as Raw;
    BAD_SCHEMA(broken);
    const result = questionSchema.safeParse(broken);
    const expected = result.success ? [] : formatIssues(result.error.issues);
    expect(expected.length).toBeGreaterThan(0);
    const etag = obj(await get(server, `api/questions/${d.id}/source`))['etag'];
    const reply = await edit(server, d.id, { etag, text: mutated(d, BAD_SCHEMA) });
    for (const message of expected) {
      expect(reply.text).toContain(JSON.stringify(message).slice(1, -1));
    }
  });

  test('AC-14: a refused edit leaves the draft in the queue', async () => {
    const { server } = await startWith(d);
    const etag = obj(await get(server, `api/questions/${d.id}/source`))['etag'];
    await edit(server, d.id, { etag, text: 'id: [unclosed\n' });
    expect(await queueIds(server)).toEqual([d.id]);
  });
});

describe('POST /api/questions/<id>/reject', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const other = draft({ id: 'd1-1.3-0008', slug: 'other' });
  const sidecar = sidecarYaml({ verification: flagged(d), dedupe: dedupe() });
  const reason = 'Not exam-style and a near-duplicate.';

  test('AC-15: moves the draft and its sidecar to rejected/<path>', async () => {
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }, other));
    const etag = etagOf(await reveal(server, d.id, ['A']));
    const reply = await reject(server, d.id, { etag, answer: ['A'], reason });
    expect(reply.status).toBe(200);
    expect(existsSync(join(dir, d.path))).toBe(false);
    expect(existsSync(join(dir, d.sidecar))).toBe(false);
    expect(readText(dir, `rejected/${d.path}`)).toBe(d.text);
    expect(readText(dir, `rejected/${d.sidecar}`)).toBe(sidecar);
  });

  test('AC-15: a draft without a sidecar moves alone', async () => {
    const { server, dir } = await startWith(d, other);
    const etag = etagOf(await reveal(server, d.id, ['A']));
    expect((await reject(server, d.id, { etag, answer: ['A'], reason })).status).toBe(200);
    expect(readText(dir, `rejected/${d.path}`)).toBe(d.text);
    expect(existsSync(join(dir, `rejected/${d.sidecar}`))).toBe(false);
  });

  test('AC-15: the rejected question leaves the queue and does not count as waiting', async () => {
    const { server } = await startWith({ draft: d, sidecar }, other);
    const etag = etagOf(await reveal(server, d.id, ['A']));
    await reject(server, d.id, { etag, answer: ['A'], reason });
    expect(await queueIds(server)).toEqual([other.id]);
    expect(obj(await queue(server))['waiting']).toBe(0);
  });

  test.each(['', '   ', '\n\t'])(
    'AC-15: a blank reason (%j) is 400 and nothing moves',
    async (blank) => {
      const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
      const before = snapshot(dir);
      const etag = etagOf(await reveal(server, d.id, ['A']));
      const reply = await reject(server, d.id, { etag, answer: ['A'], reason: blank });
      expect(reply.status).toBe(400);
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test('AC-15: an existing target refuses the reject and leaves both files in place', async () => {
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    writeFiles(dir, { [`rejected/${d.path}`]: 'an older rejected draft\n' });
    const before = snapshot(dir);
    const etag = etagOf(await reveal(server, d.id, ['A']));
    const reply = await reject(server, d.id, { etag, answer: ['A'], reason });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(snapshot(dir)).toEqual(before);
    expect(await queueIds(server)).toEqual([d.id]);
  });

  test('AC-15: a failed sidecar move puts the draft back', async () => {
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    // A folder where the sidecar must go makes the second move fail.
    mkdirSync(join(dir, `rejected/${d.sidecar}`), { recursive: true });
    const etag = etagOf(await reveal(server, d.id, ['A']));
    const reply = await reject(server, d.id, { etag, answer: ['A'], reason });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(readText(dir, d.path)).toBe(d.text);
    expect(readText(dir, d.sidecar)).toBe(sidecar);
    expect(existsSync(join(dir, `rejected/${d.path}`))).toBe(false);
    expect(await queueIds(server)).toEqual([d.id]);
  });

  test('AC-15: a failed reject writes nothing to the review log', async () => {
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    mkdirSync(join(dir, `rejected/${d.sidecar}`), { recursive: true });
    const etag = etagOf(await reveal(server, d.id, ['A']));
    await reject(server, d.id, { etag, answer: ['A'], reason });
    expect(readLog(dir)).toEqual([]);
  });
});

describe('review log', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const e = draft({ id: 'd1-1.3-0008', slug: 'other' });
  const f = draft({ id: 'd1-1.3-0009', slug: 'third' });

  test('AC-16: an approve appends one JSON line, created when missing', async () => {
    const { server, dir } = await startWith({
      draft: d,
      sidecar: { verification: verification(d) },
    });
    expect(existsSync(join(dir, 'review-log.jsonl'))).toBe(false);
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'] });
    const log = readLog(dir);
    expect(log).toHaveLength(1);
    const record = log[0] as Raw;
    expect(record).toMatchObject({
      id: d.id,
      path: d.path,
      decision: 'approved',
      by: REVIEWER,
      answer: ['C'],
      correct: true,
      state: 'verified',
    });
    expect(new Date(record['at'] as string).toISOString()).toBe(record['at']);
    expect('reason' in record).toBe(false);
  });

  test('AC-16: the record holds the answer sent and whether it was correct', async () => {
    const { server, dir } = await startWith({
      draft: d,
      sidecar: { verification: verification(d) },
    });
    const etag = etagOf(await reveal(server, d.id, ['B']));
    await approve(server, d.id, { etag, answer: ['B'] });
    expect(readLog(dir)[0]).toMatchObject({ answer: ['B'], correct: false });
  });

  test('AC-16: a confirmed approve of a flagged question logs the state flagged', async () => {
    const { server, dir } = await startWith({ draft: d, sidecar: { verification: flagged(d) } });
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'], confirm: true });
    expect(readLog(dir)[0]).toMatchObject({ decision: 'approved', state: 'flagged' });
  });

  test('AC-16: a reject appends one line with the reason', async () => {
    const { server, dir } = await startWith({ draft: d, sidecar: { verification: flagged(d) } });
    const etag = etagOf(await reveal(server, d.id, ['A']));
    await reject(server, d.id, { etag, answer: ['A'], reason: 'The key is arguable.' });
    const log = readLog(dir);
    expect(log).toHaveLength(1);
    const record = log[0] as Raw;
    expect(record).toMatchObject({
      id: d.id,
      decision: 'rejected',
      by: REVIEWER,
      answer: ['A'],
      correct: false,
      state: 'flagged',
      reason: 'The key is arguable.',
    });
    expect([d.path, `rejected/${d.path}`]).toContain(record['path']);
    expect(new Date(record['at'] as string).toISOString()).toBe(record['at']);
  });

  test('AC-16: later decisions are appended after the earlier lines', async () => {
    const { server, dir } = await startWith(d, e, f);
    const first = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag: first, answer: ['C'], confirm: true });
    const afterFirst = readText(dir, 'review-log.jsonl');
    const second = etagOf(await reveal(server, e.id, ['A']));
    await reject(server, e.id, { etag: second, answer: ['A'], reason: 'Too easy.' });
    const text = readText(dir, 'review-log.jsonl');
    expect(text.startsWith(afterFirst)).toBe(true);
    expect(readLog(dir).map((record) => record['id'])).toEqual([d.id, e.id]);
    expect(text.endsWith('\n')).toBe(true);
  });

  test('AC-16: the log is not a question and does not enter the queue or the problems', async () => {
    const { server } = await startWith(d, e);
    const etag = etagOf(await reveal(server, d.id, ['C']));
    await approve(server, d.id, { etag, answer: ['C'], confirm: true });
    expect(obj(await queue(server))['problems']).toEqual([]);
  });
});

describe('stale etag', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const sidecar = sidecarYaml({ verification: verification(d) });

  async function changedOnDisk() {
    const started = await startOn(filesOf({ draft: d, sidecar }));
    const etag = etagOf(await reveal(started.server, d.id, ['C']));
    appendFileSync(join(started.dir, d.path), '# edited by hand\n');
    return { ...started, etag, before: snapshot(started.dir) };
  }

  test('AC-17: an approve with a stale etag is 409 and changes nothing', async () => {
    const { server, dir, etag, before } = await changedOnDisk();
    expect((await approve(server, d.id, { etag, answer: ['C'] })).status).toBe(409);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-17: a confirmed approve with a stale etag is still 409', async () => {
    const { server, dir, etag, before } = await changedOnDisk();
    expect((await approve(server, d.id, { etag, answer: ['C'], confirm: true })).status).toBe(409);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-17: an edit with a stale etag is 409 and changes nothing', async () => {
    const { server, dir, etag, before } = await changedOnDisk();
    const text = replaceOnce(d.text, 'owns the keys.', 'owns and rotates the keys.');
    expect((await edit(server, d.id, { etag, text })).status).toBe(409);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-17: a reject with a stale etag is 409 and changes nothing', async () => {
    const { server, dir, etag, before } = await changedOnDisk();
    expect((await reject(server, d.id, { etag, answer: ['C'], reason: 'No.' })).status).toBe(409);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-17: a made-up etag is 409', async () => {
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    const before = snapshot(dir);
    const reply = await approve(server, d.id, { etag: 'not-an-etag', answer: ['C'] });
    expect(reply.status).toBe(409);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-17: a stale-etag refusal logs nothing', async () => {
    const { server, dir, etag } = await changedOnDisk();
    await approve(server, d.id, { etag, answer: ['C'] });
    expect(readLog(dir)).toEqual([]);
  });
});

describe('token and Host', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const sidecar = sidecarYaml({ verification: verification(d) });

  test('AC-18: GET / embeds the run token', async () => {
    const { server } = await startOn(filesOf({ draft: d, sidecar }));
    const reply = await get(server, '');
    expect(reply.status).toBe(200);
    expect(reply.text).toContain(server.token);
  });

  test('AC-18: every run has its own random token', async () => {
    const first = await startOn({});
    const second = await startOn({});
    expect(first.server.token).not.toBe(second.server.token);
    expect(first.server.token.length).toBeGreaterThanOrEqual(16);
  });

  test('AC-18: a read-only GET needs no token', async () => {
    const { server } = await startOn(filesOf({ draft: d, sidecar }));
    expect((await queue(server)).status).toBe(200);
    expect((await get(server, `api/questions/${d.id}/blind`)).status).toBe(200);
  });

  const POSTS: [string, (etag: string) => unknown][] = [
    ['reveal', () => ({ answer: ['C'] })],
    ['approve', (etag) => ({ etag, answer: ['C'], confirm: true })],
    ['edit', (etag) => ({ etag, text: replaceOnce(d.text, 'owns the keys.', 'owns all keys.') })],
    ['reject', (etag) => ({ etag, answer: ['C'], reason: 'No.' })],
  ];

  test.each(POSTS)(
    'AC-18: a %s POST without the token is 403 and changes nothing',
    async (name, body) => {
      const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
      const etag = etagOfFile(dir, d.path);
      const before = snapshot(dir);
      const reply = await post(server, `api/questions/${d.id}/${name}`, body(etag), {
        token: null,
      });
      expect(reply.status).toBe(403);
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test.each(POSTS)(
    'AC-18: a %s POST with a wrong token is 403 and changes nothing',
    async (name, body) => {
      const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
      const etag = etagOfFile(dir, d.path);
      const before = snapshot(dir);
      const reply = await post(server, `api/questions/${d.id}/${name}`, body(etag), {
        token: `${server.token}x`,
      });
      expect(reply.status).toBe(403);
      expect(snapshot(dir)).toEqual(before);
    },
  );

  test('AC-18: the token of another run is refused', async () => {
    const first = await startOn(filesOf({ draft: d, sidecar }));
    const second = await startOn({});
    const reply = await post(
      first.server,
      `api/questions/${d.id}/reveal`,
      { answer: ['C'] },
      {
        token: second.server.token,
      },
    );
    expect(reply.status).toBe(403);
  });

  test('AC-18: the right token is accepted (control)', async () => {
    const { server } = await startOn(filesOf({ draft: d, sidecar }));
    expect((await reveal(server, d.id, ['C'])).status).toBe(200);
  });

  test('AC-18: a request with Host evil.example:<port> is 403', async () => {
    const { server } = await startOn(filesOf({ draft: d, sidecar }));
    const port = new URL(server.url).port;
    for (const path of ['/', '/api/queue', `/api/questions/${d.id}/blind`]) {
      const status = await rawRequest(server, {
        method: 'GET',
        path,
        host: `evil.example:${port}`,
      });
      expect(status, path).toBe(403);
    }
  });

  test('AC-18: a POST with the right token but Host evil.example:<port> is 403 and changes nothing', async () => {
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    const before = snapshot(dir);
    const status = await rawRequest(server, {
      method: 'POST',
      path: `/api/questions/${d.id}/approve`,
      host: `evil.example:${new URL(server.url).port}`,
      headers: { 'Content-Type': 'application/json', 'X-Review-Token': server.token },
      body: JSON.stringify({ etag: etagOfFile(dir, d.path), answer: ['C'], confirm: true }),
    });
    expect(status).toBe(403);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-18: a Host with another port is 403', async () => {
    const { server } = await startOn(filesOf({ draft: d, sidecar }));
    const other = String(Number(new URL(server.url).port) + 1);
    expect(
      await rawRequest(server, { method: 'GET', path: '/api/queue', host: `127.0.0.1:${other}` }),
    ).toBe(403);
  });

  test.each(['127.0.0.1', 'localhost'])('AC-18: Host %s:<port> is allowed', async (name) => {
    const { server } = await startOn(filesOf({ draft: d, sidecar }));
    const port = new URL(server.url).port;
    expect(
      await rawRequest(server, { method: 'GET', path: '/api/queue', host: `${name}:${port}` }),
    ).toBe(200);
  });
});

describe('errors', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const old = draft({ id: 'd1-1.3-0009', slug: 'old' });
  const UNKNOWN = 'd1-1.3-4242';

  test.each([
    ['GET', 'blind'],
    ['GET', 'source'],
  ] as const)('AC-19: %s %s of an unknown id is 404', async (_method, name) => {
    const { server } = await startWith(d);
    expect((await get(server, `api/questions/${UNKNOWN}/${name}`)).status).toBe(404);
  });

  test.each([
    ['reveal', { answer: ['C'] }],
    ['approve', { etag: 'x', answer: ['C'], confirm: true }],
    ['edit', { etag: 'x', text: 'id: x\n' }],
    ['reject', { etag: 'x', answer: ['C'], reason: 'No.' }],
  ] as const)('AC-19: POST %s of an unknown id is 404 and changes nothing', async (name, body) => {
    const { server, dir } = await startWith(d);
    const before = snapshot(dir);
    expect((await post(server, `api/questions/${UNKNOWN}/${name}`, body)).status).toBe(404);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-19: a draft under rejected/ is an unknown id', async () => {
    const { server } = await startOn({ ...filesOf(d), [`rejected/${old.path}`]: old.text });
    expect((await get(server, `api/questions/${old.id}/blind`)).status).toBe(404);
  });

  test.each(['..%2F..%2Fx', '..%2Fd1%2F1.3%2Fsse-c-keys', encodeURIComponent(d.path)])(
    'AC-19: a path instead of an id (%s) is 404',
    async (id) => {
      const { server } = await startWith(d);
      expect((await get(server, `api/questions/${id}/blind`)).status).toBe(404);
      expect((await get(server, `api/questions/${id}/source`)).status).toBe(404);
    },
  );

  test.each(['reveal', 'approve', 'edit', 'reject'])(
    'AC-19: POST %s with a malformed JSON body is 400 and changes nothing',
    async (name) => {
      const { server, dir } = await startWith(d);
      const before = snapshot(dir);
      const reply = await post(server, `api/questions/${d.id}/${name}`, undefined, {
        raw: '{"answer": [',
      });
      expect(reply.status).toBe(400);
      expect(snapshot(dir)).toEqual(before);
    },
  );
});

describe('the folder is read on every request', () => {
  const a = draft({ id: 'd1-1.3-0007', slug: 'first' });
  const b = draft({ id: 'd1-1.3-0008', slug: 'second' });
  const c = draft({ id: 'd1-1.1-0001', slug: 'third' });

  test('AC-20: a file added after start shows up in the next queue', async () => {
    const { server, dir } = await startWith(a);
    expect(await queueIds(server)).toEqual([a.id]);
    writeFiles(dir, filesOf(b, c));
    expect(await queueIds(server)).toEqual([c.id, a.id, b.id]);
    expect(obj(await queue(server))['total']).toBe(3);
  });

  test('AC-20: a file removed after start leaves the next queue', async () => {
    const { server, dir } = await startWith(a, b);
    rmSync(join(dir, b.path));
    expect(await queueIds(server)).toEqual([a.id]);
  });

  test('AC-20: a changed file shows up in the next queue and the next reveal', async () => {
    const { server, dir } = await startWith(a, b);
    const edited = replaceOnce(a.text, 'owns the keys.', 'owns all the keys.');
    writeFileSync(join(dir, a.path), edited);
    const options = find((await reveal(server, a.id, ['C'])).body, 'options') as Raw[];
    expect(options[0]?.['why']).toContain('owns all the keys.');
  });

  test('AC-20: a file that turns invalid moves from the items to the problems', async () => {
    const { server, dir } = await startWith(a, b);
    writeFileSync(join(dir, b.path), 'id: [unclosed\n');
    const body = obj(await queue(server));
    expect((body['items'] as { id: string }[]).map((item) => item.id)).toEqual([a.id]);
    expect((body['problems'] as { path: string }[]).map((problem) => problem.path)).toEqual([
      b.path,
    ]);
  });

  test('AC-20: a draft marked reviewed by hand moves from the queue to waiting', async () => {
    const { server, dir } = await startWith(a, b);
    writeFileSync(join(dir, b.path), draft({ id: b.id, slug: 'second', status: 'reviewed' }).text);
    const body = obj(await queue(server));
    expect(await queueIds(server)).toEqual([a.id]);
    expect(body['waiting']).toBe(1);
  });

  test('AC-20: a folder that starts empty fills up', async () => {
    const dir = tempFolder();
    const server = await startServer({ drafts: dir, reviewer: REVIEWER, port: 0 });
    try {
      expect(await queueIds(server)).toEqual([]);
      writeFiles(dir, filesOf(a));
      expect(await queueIds(server)).toEqual([a.id]);
    } finally {
      await server.close();
    }
  });
});
describe('spec 025 allow extra Host', () => {
  const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
  const sidecar = sidecarYaml({ verification: verification(d) });
  const PHONE = 'phone.example.ts.net';

  const own: Awaited<ReturnType<typeof startServer>>[] = [];

  afterEach(async () => {
    await Promise.all(own.splice(0).map((server) => server.close()));
  });

  /** Starts a server over the draft with the given `allowHosts` (omitted when undefined). */
  async function startAllowing(allowHosts?: string[]) {
    const dir = tempFolder(filesOf({ draft: d, sidecar }));
    const server = await startServer({
      drafts: dir,
      reviewer: REVIEWER,
      port: 0,
      ...(allowHosts === undefined ? {} : { allowHosts }),
    });
    own.push(server);
    return { server, dir, port: new URL(server.url).port };
  }

  /** A request with a chosen `Host` header, returning the status and the body. */
  function asHost(
    server: { url: string },
    host: string,
    opts: {
      method?: 'GET' | 'POST';
      path?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(new URL(server.url).port),
          method: opts.method ?? 'GET',
          path: opts.path ?? '/',
          headers: { ...opts.headers, Host: host },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  function postAs(
    server: { url: string },
    host: string,
    action: string,
    body: unknown,
    token: string | null,
  ) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== null) headers['X-Review-Token'] = token;
    return asHost(server, host, {
      method: 'POST',
      path: `/api/questions/${d.id}/${action}`,
      headers,
      body: JSON.stringify(body),
    });
  }

  test('AC-1: GET / with the allowed Host is 200 and serves the page', async () => {
    const { server } = await startAllowing([PHONE]);
    const reply = await asHost(server, PHONE);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain(server.token);
  });

  test('AC-1: the allowed Host in another letter case is 200 too', async () => {
    const { server } = await startAllowing([PHONE]);
    const reply = await asHost(server, 'PHONE.Example.ts.net');
    expect(reply.status).toBe(200);
    expect(reply.text).toContain(server.token);
  });

  test('AC-1: an entry written in upper case matches a lower case Host', async () => {
    const { server } = await startAllowing(['PHONE.Example.TS.net']);
    expect((await asHost(server, PHONE)).status).toBe(200);
  });

  test('AC-1: the read-only API answers for the allowed Host', async () => {
    const { server } = await startAllowing([PHONE]);
    const reply = await asHost(server, PHONE, { path: '/api/queue' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toMatchObject({ items: [{ id: d.id }] });
  });

  test('AC-1: every entry of allowHosts is accepted', async () => {
    const { server } = await startAllowing([PHONE, 'tablet.example.ts.net', '100.64.0.7']);
    for (const host of [PHONE, 'tablet.example.ts.net', '100.64.0.7']) {
      expect((await asHost(server, host)).status, host).toBe(200);
    }
  });

  test('AC-2: a POST with the allowed Host and the right token succeeds', async () => {
    const { server } = await startAllowing([PHONE]);
    const reply = await postAs(server, PHONE, 'reveal', { answer: ['C'] }, server.token);
    expect(reply.status).toBe(200);
  });

  test('AC-2: an approve with the allowed Host and the right token is applied', async () => {
    const { server, dir } = await startAllowing([PHONE]);
    const revealed = await postAs(server, PHONE, 'reveal', { answer: ['C'] }, server.token);
    const etag = (JSON.parse(revealed.text) as { etag: string }).etag;
    const approved = await postAs(
      server,
      PHONE,
      'approve',
      { etag, answer: ['C'], confirm: true },
      server.token,
    );
    expect(approved.status).toBe(200);
    expect(readText(dir, d.path)).toMatch(new RegExp(`reviewed_by: ${REVIEWER}`));
  });

  test('AC-2: a POST with the allowed Host and a wrong token is 403 and changes nothing', async () => {
    const { server, dir } = await startAllowing([PHONE]);
    const before = snapshot(dir);
    const reply = await postAs(server, PHONE, 'reveal', { answer: ['C'] }, `${server.token}x`);
    expect(reply.status).toBe(403);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-2: a POST with the allowed Host and no token is 403', async () => {
    const { server } = await startAllowing([PHONE]);
    const reply = await postAs(server, PHONE, 'reveal', { answer: ['C'] }, null);
    expect(reply.status).toBe(403);
  });

  test('AC-3: Host evil.example is 403', async () => {
    const { server } = await startAllowing([PHONE]);
    expect((await asHost(server, 'evil.example')).status).toBe(403);
  });

  test('AC-3: the allowed name with a port the entry does not have is 403', async () => {
    const { server } = await startAllowing([PHONE]);
    expect((await asHost(server, `${PHONE}:4400`)).status).toBe(403);
    expect((await asHost(server, `${PHONE}:${new URL(server.url).port}`)).status).toBe(403);
  });

  test('AC-3: an entry with a port matches only that exact host and port', async () => {
    const { server } = await startAllowing(['phone.example.ts.net:8443']);
    expect((await asHost(server, 'phone.example.ts.net:8443')).status).toBe(200);
    expect((await asHost(server, 'PHONE.example.ts.net:8443')).status).toBe(200);
    expect((await asHost(server, 'phone.example.ts.net')).status).toBe(403);
    expect((await asHost(server, 'phone.example.ts.net:8444')).status).toBe(403);
  });

  test('AC-3: a Host that only contains or extends the allowed one is 403', async () => {
    const { server } = await startAllowing([PHONE]);
    for (const host of [`x${PHONE}`, `${PHONE}.evil.example`, 'example.ts.net']) {
      expect((await asHost(server, host)).status, host).toBe(403);
    }
  });

  test('AC-3: a POST with the right token but Host evil.example is 403 and changes nothing', async () => {
    const { server, dir } = await startAllowing([PHONE]);
    const before = snapshot(dir);
    const reply = await postAs(server, 'evil.example', 'reveal', { answer: ['C'] }, server.token);
    expect(reply.status).toBe(403);
    expect(snapshot(dir)).toEqual(before);
  });

  test.each(['127.0.0.1', 'localhost'])('AC-3: Host %s:<port> still works', async (name) => {
    const { server, port } = await startAllowing([PHONE]);
    expect((await asHost(server, `${name}:${port}`)).status).toBe(200);
  });

  test('AC-3: 127.0.0.1 with another port is still 403', async () => {
    const { server, port } = await startAllowing([PHONE]);
    expect((await asHost(server, `127.0.0.1:${String(Number(port) + 1)}`)).status).toBe(403);
  });

  test('AC-4: without allowHosts the extra Host is 403', async () => {
    const { server } = await startAllowing();
    expect((await asHost(server, PHONE)).status).toBe(403);
  });

  test('AC-4: with allowHosts: [] the extra Host is 403', async () => {
    const { server } = await startAllowing([]);
    expect((await asHost(server, PHONE)).status).toBe(403);
  });

  test('AC-4: without allowHosts a POST with the right token and the extra Host is 403', async () => {
    const { server, dir } = await startAllowing();
    const before = snapshot(dir);
    const reply = await postAs(server, PHONE, 'reveal', { answer: ['C'] }, server.token);
    expect(reply.status).toBe(403);
    expect(snapshot(dir)).toEqual(before);
  });

  test('AC-4: without allowHosts 127.0.0.1:<port> and localhost:<port> work', async () => {
    const { server, port } = await startAllowing();
    expect((await asHost(server, `127.0.0.1:${port}`)).status).toBe(200);
    expect((await asHost(server, `localhost:${port}`)).status).toBe(200);
  });

  test('AC-5: with allowHosts the url is still http://127.0.0.1:<port>/', async () => {
    const { server } = await startAllowing([PHONE]);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/);
  });

  test('AC-5: with allowHosts the server does not accept connections on ::1', async () => {
    const { server, port } = await startAllowing([PHONE]);
    expect(server.url).toContain('127.0.0.1');
    expect(await canConnect('::1', Number(port))).toBe(false);
  });

  const external = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info?.family === 'IPv4' && !info.internal)
    .map((info) => info?.address ?? '');

  test.skipIf(external.length === 0)(
    'AC-5: with allowHosts the server does not accept connections on a non-loopback address',
    async () => {
      const { port } = await startAllowing([PHONE, ...external]);
      const results = await Promise.all(
        external.map((address) => canConnect(address, Number(port))),
      );
      expect(results).not.toContain(true);
    },
  );
});
