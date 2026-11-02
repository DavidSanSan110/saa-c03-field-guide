import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

// Spec 043, "Workflow": .github/workflows/janitor.yml. It is read as text and as parsed YAML. The
// general rules every workflow must pass are enforced for all files by workflows.test.ts; the strict
// ones are checked again here, directly on janitor.yml.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const FILE = 'janitor.yml';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(name: string): string {
  const path = join(WORKFLOWS_DIR, name);
  if (!existsSync(path)) throw new Error(`missing file: .github/workflows/${name}`);
  return readFileSync(path, 'utf8');
}

function docOf(name: string): Dict {
  const doc: unknown = parse(textOf(name));
  if (!isDict(doc)) throw new Error(`${name}: not a YAML mapping`);
  return doc;
}

const janitorText = (): string => textOf(FILE);
const janitor = (): Dict => docOf(FILE);

function jobsOf(doc: Dict): [string, Dict][] {
  const jobs = doc['jobs'];
  if (!isDict(jobs)) return [];
  return Object.entries(jobs).filter((entry): entry is [string, Dict] => isDict(entry[1]));
}

/** The `scan` job, or a clear failure when it is missing. */
function scanJob(): Dict {
  const job = jobsOf(janitor()).find(([id]) => id === 'scan');
  if (job === undefined) throw new Error('janitor.yml has no job named scan');
  return job[1];
}

function stepsOf(): Dict[] {
  const steps = scanJob()['steps'];
  if (!Array.isArray(steps)) throw new Error('the scan job has no steps');
  return (steps as unknown[]).filter(isDict);
}

/** Step `index` (0-based), or a clear failure. */
function step(index: number): Dict {
  const found = stepsOf()[index];
  if (found === undefined) throw new Error(`the scan job has no step number ${index + 1}`);
  return found;
}

/** The `with` mapping of a step. */
function withOf(index: number): Dict {
  const value = step(index)['with'];
  if (!isDict(value)) throw new Error(`step ${index + 1} has no with mapping`);
  return value;
}

function triggersOf(doc: Dict): string[] {
  const on = doc['on'];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((item): item is string => typeof item === 'string');
  if (isDict(on)) return Object.keys(on);
  return [];
}

/** The `on` mapping, or a clear failure. */
function onOf(): Dict {
  const on = janitor()['on'];
  if (!isDict(on)) throw new Error('janitor.yml: on must be a mapping');
  return on;
}

/** Every `uses:` of a workflow file as `<action>@<sha> # <comment>`, whitespace collapsed. */
function usesLinesOf(name: string): string[] {
  const pattern = /^\s*(?:-\s+)?uses:\s*(\S+)[ \t]*(#.*)?$/gm;
  return [...textOf(name).matchAll(pattern)].map((match) =>
    `${match[1] ?? ''} ${match[2] ?? ''}`.replace(/\s+/g, ' ').trim(),
  );
}

const actionOf = (line: string): string => line.split('@')[0] ?? '';
const shaOf = (line: string): string => (line.split('@')[1] ?? '').split(' ')[0] ?? '';

/** The `uses:` line of one action in a workflow file. */
function usesLineFor(name: string, action: string): string {
  const line = usesLinesOf(name).find((candidate) => actionOf(candidate) === action);
  if (line === undefined) throw new Error(`${name} has no uses: ${action}`);
  return line;
}

const OTHER_WORKFLOWS = (): string[] =>
  readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith('.yml') && name !== FILE);

// ---- AC-29 -------------------------------------------------------------------------------------

describe('AC-29: janitor.yml passes the workflow policy', () => {
  test('AC-29: the workflow is named Lab janitor', () => {
    expect(janitor()['name']).toBe('Lab janitor');
  });

  test('AC-29: the file opens with a comment on what the job does, that it writes nothing to AWS, and that the session policy limits it', () => {
    const lines = janitorText().split(/\r?\n/);
    expect(lines[0]?.startsWith('#')).toBe(true);
    const comment = lines
      .slice(
        0,
        lines.findIndex((line) => !line.startsWith('#')),
      )
      .join('\n')
      .toLowerCase();
    expect(comment).toContain('writes nothing to aws');
    expect(comment).toContain('session policy');
  });

  test('AC-29: top-level permissions is an empty mapping', () => {
    const top = janitor()['permissions'];
    expect(isDict(top)).toBe(true);
    expect(Object.keys(top as Dict)).toEqual([]);
  });

  test('AC-29: every job has a permissions mapping of its own', () => {
    const jobs = jobsOf(janitor());
    expect(jobs.length).toBeGreaterThan(0);
    for (const [, job] of jobs) expect(isDict(job['permissions'])).toBe(true);
  });

  test('AC-29: there is no workflow_run trigger', () => {
    expect(triggersOf(janitor())).not.toContain('workflow_run');
  });

  test('AC-29: there is no pull_request_target trigger', () => {
    expect(triggersOf(janitor())).not.toContain('pull_request_target');
  });

  test('AC-29: concurrency uses the group lab-janitor and does not cancel a running scan', () => {
    expect(janitor()['concurrency']).toEqual({ group: 'lab-janitor', 'cancel-in-progress': false });
  });

  test('AC-29: every job sets a positive timeout-minutes', () => {
    for (const [, job] of jobsOf(janitor())) {
      expect(typeof job['timeout-minutes']).toBe('number');
      expect(job['timeout-minutes'] as number).toBeGreaterThan(0);
    }
  });

  test('AC-29: every uses: is pinned to a full commit SHA with a # vX.Y.Z comment', () => {
    const lines = usesLinesOf(FILE);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^[^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    }
  });
});

// ---- AC-30 -------------------------------------------------------------------------------------

describe('AC-30: triggers', () => {
  test('AC-30: the triggers are exactly schedule and workflow_dispatch', () => {
    expect(Object.keys(onOf()).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  test('AC-30: schedule has one cron, 17 6 * * *', () => {
    expect(onOf()['schedule']).toEqual([{ cron: '17 6 * * *' }]);
  });

  test('AC-30: workflow_dispatch has one input, max_age_hours', () => {
    const dispatch = onOf()['workflow_dispatch'];
    expect(isDict(dispatch)).toBe(true);
    const inputs = (dispatch as Dict)['inputs'];
    expect(isDict(inputs)).toBe(true);
    expect(Object.keys(inputs as Dict)).toEqual(['max_age_hours']);
  });

  test('AC-30: max_age_hours is an optional string with a description and no default', () => {
    const dispatch = onOf()['workflow_dispatch'] as Dict;
    const input = (dispatch['inputs'] as Dict)['max_age_hours'];
    expect(isDict(input)).toBe(true);
    const spec = input as Dict;
    expect(spec['type'] ?? 'string').toBe('string');
    expect(spec['required'] ?? false).toBe(false);
    expect(typeof spec['description']).toBe('string');
    expect((spec['description'] as string).trim()).not.toBe('');
    expect(Object.keys(spec)).not.toContain('default');
  });

  test('AC-30: there is no push trigger', () => {
    expect(triggersOf(janitor())).not.toContain('push');
  });

  test('AC-30: there is no pull_request trigger', () => {
    expect(triggersOf(janitor())).not.toContain('pull_request');
  });
});

// ---- AC-31 -------------------------------------------------------------------------------------

describe('AC-31: the scan job', () => {
  test('AC-31: scan is the only job, named scan, on ubuntu-latest', () => {
    expect(jobsOf(janitor()).map(([id]) => id)).toEqual(['scan']);
    expect(scanJob()['name']).toBe('scan');
    expect(scanJob()['runs-on']).toBe('ubuntu-latest');
  });

  test('AC-31: it has exactly contents: read, id-token: write and issues: write', () => {
    expect(scanJob()['permissions']).toEqual({
      contents: 'read',
      'id-token': 'write',
      issues: 'write',
    });
  });

  test('AC-31: it sets no environment, which would change the OIDC subject', () => {
    expect(Object.keys(scanJob())).not.toContain('environment');
  });

  test('AC-31: timeout-minutes is 15', () => {
    expect(scanJob()['timeout-minutes']).toBe(15);
  });
});

// ---- AC-32 -------------------------------------------------------------------------------------

describe('AC-32: the AWS login and its session policy', () => {
  /** The statements of the inline session policy, whether it holds a list or one object. */
  function statements(): unknown[] {
    const text = withOf(2)['inline-session-policy'];
    expect(typeof text).toBe('string');
    const policy: unknown = JSON.parse(text as string);
    expect(isDict(policy)).toBe(true);
    const statement = (policy as Dict)['Statement'];
    return Array.isArray(statement) ? (statement as unknown[]) : [statement];
  }

  test('AC-32: the session policy parses as JSON', () => {
    const text = withOf(2)['inline-session-policy'];
    expect(typeof text).toBe('string');
    expect(() => {
      JSON.parse(text as string);
    }).not.toThrow();
  });

  test('AC-32: the session policy has one statement', () => {
    expect(statements()).toHaveLength(1);
  });

  test('AC-32: the statement allows exactly tag:GetResources and cloudtrail:LookupEvents on *', () => {
    expect(statements()[0]).toEqual({
      Effect: 'Allow',
      Action: ['tag:GetResources', 'cloudtrail:LookupEvents'],
      Resource: '*',
    });
  });

  test('AC-32: the policy holds nothing but a version and the statement', () => {
    const policy = JSON.parse(withOf(2)['inline-session-policy'] as string) as Dict;
    expect(Object.keys(policy).filter((key) => key !== 'Version')).toEqual(['Statement']);
  });

  test('AC-32: mask-aws-account-id is true', () => {
    expect(String(withOf(2)['mask-aws-account-id'])).toBe('true');
  });

  test('AC-32: the role is secrets.TF_PLAN_ROLE_ARN', () => {
    expect(withOf(2)['role-to-assume']).toBe('${{ secrets.TF_PLAN_ROLE_ARN }}');
  });

  test('AC-32: the Region is us-east-1', () => {
    expect(withOf(2)['aws-region']).toBe('us-east-1');
  });

  test('AC-32: the login takes exactly these inputs and no others', () => {
    expect(Object.keys(withOf(2)).sort()).toEqual([
      'aws-region',
      'inline-session-policy',
      'mask-aws-account-id',
      'role-to-assume',
    ]);
  });

  test('AC-32: TF_PLAN_ROLE_ARN is the only secret the file refers to', () => {
    const secrets = [...janitorText().matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(['TF_PLAN_ROLE_ARN']));
  });
});

// ---- AC-33 -------------------------------------------------------------------------------------

describe('AC-33: shared actions are pinned like the other workflows', () => {
  test('AC-33: the job uses checkout, setup-node and configure-aws-credentials, in that order', () => {
    expect(usesLinesOf(FILE).map(actionOf)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'aws-actions/configure-aws-credentials',
    ]);
  });

  test('AC-33: checkout has the SHA and comment used in security.yml', () => {
    expect(usesLineFor(FILE, 'actions/checkout')).toBe(
      usesLineFor('security.yml', 'actions/checkout'),
    );
  });

  test('AC-33: setup-node has the SHA and comment used in ci.yml', () => {
    expect(usesLineFor(FILE, 'actions/setup-node')).toBe(
      usesLineFor('ci.yml', 'actions/setup-node'),
    );
  });

  test('AC-33: configure-aws-credentials has the SHA and comment used in infra.yml', () => {
    expect(usesLineFor(FILE, 'aws-actions/configure-aws-credentials')).toBe(
      usesLineFor('infra.yml', 'aws-actions/configure-aws-credentials'),
    );
  });

  test('AC-33: every other workflow that uses the same action uses the same SHA', () => {
    for (const line of usesLinesOf(FILE)) {
      const action = actionOf(line);
      const others = OTHER_WORKFLOWS().flatMap((name) =>
        usesLinesOf(name)
          .filter((candidate) => actionOf(candidate) === action)
          .map(shaOf),
      );
      expect(others.length).toBeGreaterThan(0);
      expect(new Set(others)).toEqual(new Set([shaOf(line)]));
    }
  });
});

// ---- AC-34 -------------------------------------------------------------------------------------

describe('AC-34: nothing is installed, and the scan step is exact', () => {
  test('AC-34: no step mentions pnpm, npm, npx, corepack or install', () => {
    for (const each of stepsOf()) {
      expect(JSON.stringify(each)).not.toMatch(/pnpm|npm|npx|corepack|install/i);
    }
  });

  test('AC-34: no run holds ${{', () => {
    const runs = stepsOf().filter((each) => each['run'] !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const each of runs) expect(String(each['run'])).not.toContain('${{');
  });

  test('AC-34: the run line is exact', () => {
    expect(String(step(3)['run']).trim()).toBe(
      'node --experimental-strip-types "$GITHUB_WORKSPACE/tools/guardrails/src/janitor-cli.ts"',
    );
  });

  test('AC-34: the env holds exactly the five names and values', () => {
    expect(step(3)['env']).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GH_REPO: '${{ github.repository }}',
      JANITOR_MAX_AGE_HOURS: '${{ inputs.max_age_hours }}',
      AWS_RETRY_MODE: 'adaptive',
      AWS_MAX_ATTEMPTS: '10',
    });
  });
});

// ---- AC-35 -------------------------------------------------------------------------------------

describe('AC-35: step order', () => {
  test('AC-35: there are exactly four steps', () => {
    expect(stepsOf()).toHaveLength(4);
  });

  test('AC-35: the first step checks out, without persisting credentials', () => {
    expect(String(step(0)['uses'])).toMatch(/^actions\/checkout@/);
    expect(String(withOf(0)['persist-credentials'])).toBe('false');
  });

  test('AC-35: the second step sets up Node from .nvmrc, with no cache', () => {
    expect(String(step(1)['uses'])).toMatch(/^actions\/setup-node@/);
    expect(withOf(1)['node-version-file']).toBe('.nvmrc');
    expect(Object.keys(withOf(1))).not.toContain('cache');
  });

  test('AC-35: the third step logs in to AWS', () => {
    expect(String(step(2)['uses'])).toMatch(/^aws-actions\/configure-aws-credentials@/);
  });

  test('AC-35: the fourth step runs the scan and uses no action', () => {
    expect(typeof step(3)['run']).toBe('string');
    expect(Object.keys(step(3))).not.toContain('uses');
  });
});
