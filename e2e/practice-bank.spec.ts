// E2E for spec 026 (AC-14): the question bank the built site serves at /practice/bank.json.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { parse } from 'yaml';

const questionsDir = resolve(import.meta.dirname, '..', 'questions');

interface BankEntry {
  id: string;
  stem: string;
  status: string;
  options: { key: string }[];
}

interface YamlQuestion {
  id: string;
  stem: string;
  options: { key: string }[];
}

/** Every `*.yaml` file under `dir`, skipping names that start with a dot. */
function yamlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...yamlFiles(path));
    else if (entry.name.endsWith('.yaml')) files.push(path);
  }
  return files;
}

function readYamlQuestions(): YamlQuestion[] {
  return yamlFiles(questionsDir).map((file) => parse(readFileSync(file, 'utf8')) as YamlQuestion);
}

async function fetchBank(request: APIRequestContext): Promise<BankEntry[]> {
  const response = await request.get('/practice/bank.json');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { questions: BankEntry[] };
  return body.questions;
}

test.describe('practice question bank endpoint', () => {
  test('AC-14: GET /practice/bank.json is 200 with a JSON content type', async ({ request }) => {
    const response = await request.get('/practice/bank.json');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
  });

  test('AC-14: the body is an object with a questions array', async ({ request }) => {
    const response = await request.get('/practice/bank.json');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { questions?: unknown };

    expect(Array.isArray(body.questions)).toBe(true);
  });

  test('AC-14: there is one entry per question file in questions/', async ({ request }) => {
    const entries = await fetchBank(request);

    expect(yamlFiles(questionsDir).length).toBeGreaterThan(0);
    expect(entries).toHaveLength(yamlFiles(questionsDir).length);
  });

  test('AC-14: every entry has status reviewed', async ({ request }) => {
    const entries = await fetchBank(request);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.status)).toEqual(entries.map(() => 'reviewed'));
  });

  test('AC-14: ids are unique and sorted', async ({ request }) => {
    const ids = (await fetchBank(request)).map((entry) => entry.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test('AC-14: each entry has the id, stem and option keys of its YAML file', async ({
    request,
  }) => {
    const entries = await fetchBank(request);
    const fromYaml = readYamlQuestions();

    const summary = (question: YamlQuestion | BankEntry) => ({
      id: question.id,
      stem: question.stem,
      optionKeys: question.options.map((option) => option.key),
    });
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    expect(entries.map(summary).sort(byId)).toEqual(fromYaml.map(summary).sort(byId));
  });
});
