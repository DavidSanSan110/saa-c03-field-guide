// Spec 044, AC-17 and AC-18: the AI-draft marker in the reveal JSON of the review server, and its
// absence from the blind JSON.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { BROKEN_SIDECAR } from './__mocks__/round1-fixtures.ts';
import {
  dedupe,
  draft,
  filesOf,
  readLog,
  readText,
  sidecarYaml,
  snapshot,
  verification,
} from './__mocks__/review-fixtures.ts';
import {
  allKeys,
  etagOf,
  get,
  obj,
  post,
  queue,
  reveal,
  startOn,
  startWith,
  stopAll,
} from './__mocks__/server-fixtures.ts';

afterEach(stopAll);

const d = draft({ id: 'd1-1.3-0007', slug: 'sse-c-keys' });
const FOLDER_1 = 'zqaidraftone';
const FOLDER_2 = 'zqaidrafttwo';
const MARKED = { ai_draft: { sections: [FOLDER_1, FOLDER_2] } };

/** The reveal of the draft with the sidecar text (or no sidecar), as a plain object. */
async function revealed(sidecar: Record<string, unknown> | string | undefined) {
  const { server } = await startWith(sidecar === undefined ? d : { draft: d, sidecar });
  const reply = await reveal(server, d.id, ['C']);
  expect(reply.status).toBe(200);
  return obj(reply);
}

describe('reveal JSON: aiDraft', () => {
  test('AC-17: a marked sidecar gives the list of folders, in order', async () => {
    const body = await revealed(MARKED);

    expect(body['aiDraft']).toEqual([FOLDER_1, FOLDER_2]);
  });

  test('AC-17: the order of the folders is the order in the sidecar', async () => {
    const body = await revealed({ ai_draft: { sections: ['zz-last', 'aa-first'] } });

    expect(body['aiDraft']).toEqual(['zz-last', 'aa-first']);
  });

  test('AC-17: a marked sidecar next to verification and dedupe keeps all three in the reveal', async () => {
    const body = await revealed({
      verification: verification(d),
      dedupe: dedupe(),
      ...MARKED,
    });

    expect(body['aiDraft']).toEqual([FOLDER_1, FOLDER_2]);
    expect(body['state']).toBe('verified');
    expect(body['verification']).toEqual(verification(d));
    expect(body['dedupe']).toEqual(dedupe());
    expect(body['sidecarError']).toBeNull();
  });

  test('AC-17: no sidecar gives aiDraft: null, present in the JSON', async () => {
    const body = await revealed(undefined);

    expect(body['aiDraft']).toBeNull();
    expect(Object.keys(body)).toContain('aiDraft');
  });

  test('AC-17: a sidecar without the key gives aiDraft: null', async () => {
    const body = await revealed({ verification: verification(d), dedupe: dedupe() });

    expect(body['aiDraft']).toBeNull();
    expect(Object.keys(body)).toContain('aiDraft');
  });

  test('AC-17: an empty sidecar file gives aiDraft: null', async () => {
    const body = await revealed('');

    expect(body['aiDraft']).toBeNull();
  });

  test('AC-17: an unreadable sidecar gives aiDraft: null and still reports sidecarError', async () => {
    const body = await revealed(BROKEN_SIDECAR);

    expect(body['aiDraft']).toBeNull();
    expect(typeof body['sidecarError']).toBe('string');
    expect(body['sidecarError']).not.toBe('');
  });

  test('AC-17: a sidecar that is not a mapping gives aiDraft: null and reports sidecarError', async () => {
    const body = await revealed('- ai_draft\n');

    expect(body['aiDraft']).toBeNull();
    expect(typeof body['sidecarError']).toBe('string');
  });

  test.each([
    ['true', 'ai_draft: true\n'],
    ['an empty value', 'ai_draft:\n'],
    ['sections as a string', 'ai_draft:\n  sections: a\n'],
    ['sections with a number', 'ai_draft:\n  sections:\n    - a\n    - 1\n'],
    ['an empty mapping', 'ai_draft: {}\n'],
  ])('AC-17: ai_draft as %s gives [] (marked, no names)', async (_name, sidecar) => {
    const body = await revealed(sidecar);

    expect(body['aiDraft']).toEqual([]);
    expect(body['aiDraft']).not.toBeNull();
  });

  test('AC-17: the marker is read again on every reveal', async () => {
    const { server, dir } = await startWith({ draft: d, sidecar: MARKED });
    expect(obj(await reveal(server, d.id, ['C']))['aiDraft']).toEqual([FOLDER_1, FOLDER_2]);

    writeFileSync(join(dir, d.sidecar), sidecarYaml({ ai_draft: { sections: ['only-one'] } }));
    expect(obj(await reveal(server, d.id, ['C']))['aiDraft']).toEqual(['only-one']);

    writeFileSync(join(dir, d.sidecar), sidecarYaml({ verification: verification(d) }));
    expect(obj(await reveal(server, d.id, ['C']))['aiDraft']).toBeNull();
  });

  test('AC-17: each draft gets its own marker', async () => {
    const other = draft({ id: 'd1-1.3-0008', slug: 'other' });
    const { server } = await startWith(
      { draft: d, sidecar: MARKED },
      { draft: other, sidecar: { verification: verification(other) } },
    );

    expect(obj(await reveal(server, d.id, ['C']))['aiDraft']).toEqual([FOLDER_1, FOLDER_2]);
    expect(obj(await reveal(server, other.id, ['C']))['aiDraft']).toBeNull();
  });
});

describe('blind JSON and the queue', () => {
  const MARK_WORDS = ['aiDraft', 'ai_draft', FOLDER_1, FOLDER_2];

  test.each([
    ['a marked draft', MARKED],
    ['an unmarked draft', { verification: verification(d) }],
    ['a draft with no sidecar', undefined],
  ])(
    'AC-18: the blind JSON of %s has no aiDraft key and none of the folder names',
    async (_name, sidecar) => {
      const { server } = await startWith(sidecar === undefined ? d : { draft: d, sidecar });

      const reply = await get(server, `api/questions/${d.id}/blind`);

      expect(reply.status).toBe(200);
      expect(allKeys(reply.body)).not.toContain('aiDraft');
      expect(allKeys(reply.body)).not.toContain('ai_draft');
      for (const word of MARK_WORDS) expect(reply.text).not.toContain(word);
    },
  );

  test('AC-18: the blind JSON of a marked draft is the same as the one of the draft with no sidecar', async () => {
    const marked = await startWith({ draft: d, sidecar: MARKED });
    const plain = await startWith(d);

    const withMark = await get(marked.server, `api/questions/${d.id}/blind`);
    const without = await get(plain.server, `api/questions/${d.id}/blind`);

    expect(withMark.body).toEqual(without.body);
  });

  test('AC-18: asking for the blind JSON again after a reveal still shows no aiDraft', async () => {
    const { server } = await startWith({ draft: d, sidecar: MARKED });
    await reveal(server, d.id, ['C']);

    const reply = await get(server, `api/questions/${d.id}/blind`);

    expect(allKeys(reply.body)).not.toContain('aiDraft');
    expect(reply.text).not.toContain(FOLDER_1);
  });

  test('AC-18: the queue does not show the marker either', async () => {
    const { server } = await startWith({ draft: d, sidecar: MARKED });

    const reply = await queue(server);

    expect(reply.status).toBe(200);
    expect(allKeys(reply.body)).not.toContain('aiDraft');
    for (const word of MARK_WORDS) expect(reply.text).not.toContain(word);
  });

  test('AC-18: approving a marked draft writes the same log fields as before and leaves the sidecar alone', async () => {
    const sidecar = sidecarYaml({ verification: verification(d), ...MARKED });
    const { server, dir } = await startOn(filesOf({ draft: d, sidecar }));
    const etag = etagOf(await reveal(server, d.id, ['C']));
    const before = snapshot(dir);

    const reply = await post(server, `api/questions/${d.id}/approve`, { etag, answer: ['C'] });

    expect(reply.status).toBe(200);
    expect(readText(dir, d.sidecar)).toBe(sidecar);
    const [line, ...rest] = readLog(dir);
    expect(rest).toEqual([]);
    expect(Object.keys(line as object).sort()).toEqual(
      ['answer', 'at', 'by', 'correct', 'decision', 'id', 'path', 'state'].sort(),
    );
    expect(Object.keys(snapshot(dir)).sort()).toEqual(
      [...Object.keys(before), 'review-log.jsonl'].sort(),
    );
  });
});
