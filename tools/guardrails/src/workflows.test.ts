import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Workflow {
  name: string;
  text: string;
}

/** Reads every `.github/workflows/*.yml`; fails with a clear message if there are none. */
function loadWorkflows(): Workflow[] {
  if (!existsSync(WORKFLOWS_DIR)) {
    throw new Error(`workflow directory is missing: ${WORKFLOWS_DIR}`);
  }
  const names = readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith('.yml'))
    .sort();
  if (names.length === 0) {
    throw new Error(`workflow directory has no *.yml workflow files: ${WORKFLOWS_DIR}`);
  }
  return names.map((name) => ({ name, text: readFileSync(join(WORKFLOWS_DIR, name), 'utf8') }));
}

function parseWorkflow(workflow: Workflow): Dict {
  const doc: unknown = parse(workflow.text);
  if (!isDict(doc)) throw new Error(`${workflow.name}: not a YAML mapping`);
  return doc;
}

function jobsOf(doc: Dict): [string, Dict][] {
  const jobs = doc['jobs'];
  if (!isDict(jobs)) return [];
  return Object.entries(jobs).filter((entry): entry is [string, Dict] => isDict(entry[1]));
}

function triggersOf(doc: Dict): string[] {
  const on = doc['on'];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((item): item is string => typeof item === 'string');
  if (isDict(on)) return Object.keys(on);
  return [];
}

/** Every `uses:` value (job level and step level) in a parsed workflow. */
function usesOf(doc: Dict): string[] {
  const found: string[] = [];
  for (const [, job] of jobsOf(doc)) {
    if (typeof job['uses'] === 'string') found.push(job['uses']);
    const steps = job['steps'];
    if (!Array.isArray(steps)) continue;
    for (const step of steps as unknown[]) {
      if (isDict(step) && typeof step['uses'] === 'string') found.push(step['uses']);
    }
  }
  return found;
}

const FULL_SHA_REF = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*v\d+\.\d+\.\d+/;

function permissionsProblems(doc: Dict): string[] {
  const problems: string[] = [];
  const top = doc['permissions'];
  if (top === undefined) {
    problems.push('no top-level permissions');
  } else if (!isDict(top)) {
    problems.push(`top-level permissions must be a mapping, found ${JSON.stringify(top)}`);
  } else {
    for (const [scope, level] of Object.entries(top)) {
      const allowed = scope === 'contents' ? ['read', 'none'] : ['none'];
      if (!allowed.includes(String(level))) {
        problems.push(`top-level permissions grants ${scope}: ${String(level)}`);
      }
    }
  }
  for (const [id, job] of jobsOf(doc)) {
    const level = job['permissions'];
    if (level === 'write-all' || level === 'read-all') {
      problems.push(`job ${id} uses permissions: ${level}`);
    }
  }
  return problems;
}

function pinningProblems(doc: Dict, text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of usesOf(doc)) {
    const ref = raw.trim();
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    if (!FULL_SHA_REF.test(ref)) {
      problems.push(`uses: ${ref} is not pinned to a full 40-character commit SHA`);
      continue;
    }
    const line = lines.find((candidate) => candidate.includes(ref));
    if (line === undefined || !VERSION_COMMENT.test(line.slice(line.indexOf(ref) + ref.length))) {
      problems.push(`uses: ${ref} has no "# vX.Y.Z" comment after the SHA`);
    }
  }
  return problems;
}

function workflowProblems(workflow: Workflow): string[] {
  const doc = parseWorkflow(workflow);
  const problems = [...permissionsProblems(doc), ...pinningProblems(doc, workflow.text)];
  if (!isDict(doc['concurrency']) && typeof doc['concurrency'] !== 'string') {
    problems.push('no top-level concurrency');
  }
  if (triggersOf(doc).includes('pull_request_target')) {
    problems.push('uses the pull_request_target trigger');
  }
  const jobs = jobsOf(doc);
  if (jobs.length === 0) problems.push('declares no jobs');
  for (const [id, job] of jobs) {
    // A job that calls a reusable workflow cannot set timeout-minutes (GitHub rejects it).
    if (typeof job['uses'] === 'string') continue;
    const timeout = job['timeout-minutes'];
    if (typeof timeout !== 'number' || timeout <= 0) {
      problems.push(`job ${id} has no timeout-minutes`);
    }
  }
  return problems.map((problem) => `${workflow.name}: ${problem}`);
}

function allProblems(filter: (problem: string) => boolean): string[] {
  return loadWorkflows().flatMap(workflowProblems).filter(filter);
}

const SHA = '0123456789abcdef0123456789abcdef01234567';

const GOOD = `
name: ci
on:
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@${SHA} # v6.0.0
      - uses: ./.github/actions/local
      - run: echo ok
`;

describe('workflow policy: the repository workflows', () => {
  test('AC-10: the workflows directory exists and holds at least one *.yml file', () => {
    expect(loadWorkflows().length).toBeGreaterThan(0);
  });

  test('AC-10: every workflow declares top-level permissions of at most contents: read', () => {
    expect(allProblems((problem) => /permissions/.test(problem))).toEqual([]);
  });

  test('AC-10: every external uses: is pinned to a full commit SHA with a # vX.Y.Z comment', () => {
    expect(allProblems((problem) => problem.includes('uses:'))).toEqual([]);
  });

  test('AC-10: every workflow sets top-level concurrency', () => {
    expect(allProblems((problem) => problem.includes('concurrency'))).toEqual([]);
  });

  test('AC-10: no workflow uses pull_request_target', () => {
    expect(allProblems((problem) => problem.includes('pull_request_target'))).toEqual([]);
  });

  test('AC-10: every job sets timeout-minutes', () => {
    expect(allProblems((problem) => problem.includes('timeout-minutes'))).toEqual([]);
  });

  test('AC-10: every workflow passes the whole policy', () => {
    expect(allProblems(() => true)).toEqual([]);
  });
});

describe('workflow policy: the checker itself', () => {
  const check = (text: string): string[] => workflowProblems({ name: 'sample.yml', text });

  test('AC-10: a compliant workflow has no problems', () => {
    expect(check(GOOD)).toEqual([]);
  });

  test('AC-10: missing top-level permissions is a problem', () => {
    expect(check(GOOD.replace('permissions:\n  contents: read\n', ''))).not.toEqual([]);
  });

  test('AC-10: top-level contents: write is a problem', () => {
    expect(check(GOOD.replace('contents: read', 'contents: write'))).not.toEqual([]);
  });

  test('AC-10: a job with permissions: write-all is a problem', () => {
    const text = GOOD.replace('    runs-on:', '    permissions: write-all\n    runs-on:');
    expect(check(text)).not.toEqual([]);
  });

  test('AC-10: a tag instead of a SHA is a problem', () => {
    expect(check(GOOD.replace(`@${SHA} # v6.0.0`, '@v6'))).not.toEqual([]);
  });

  test('AC-10: a SHA without the version comment is a problem', () => {
    expect(check(GOOD.replace(' # v6.0.0', ''))).not.toEqual([]);
  });

  test('AC-10: missing concurrency is a problem', () => {
    const text = GOOD.replace(/concurrency:\n {2}group:.*\n {2}cancel-in-progress: true\n/, '');
    expect(check(text)).not.toEqual([]);
  });

  test('AC-10: pull_request_target is a problem', () => {
    expect(check(GOOD.replace('pull_request:', 'pull_request_target:'))).not.toEqual([]);
  });

  test('AC-10: a job without timeout-minutes is a problem', () => {
    expect(check(GOOD.replace('    timeout-minutes: 15\n', ''))).not.toEqual([]);
  });
});
