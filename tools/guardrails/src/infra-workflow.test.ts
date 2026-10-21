import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';

// Spec 033: contract tests over the real files (infra.yml, the smoke stack, CONTRIBUTING.md) and
// bash executions of the workflow's step scripts (the helper approach of terraform-ci.test.ts,
// spec 030 AC-25/AC-23, copied here).
//
// WHAT THE IMPLEMENTER MUST KEEP STABLE (the tests find steps by these properties, not by names):
//
//  * Step scripts get every GitHub value through `env:` with plain `${{ <context> }}` expressions
//    (or a `==`/`&&`/`||` ternary over them). The tests evaluate those expressions themselves, so
//    the env variable NAMES are free; the expressions they understand are:
//      github.event_name, github.ref, github.repository, github.actor, github.base_ref,
//      github.event.before, github.event.after, github.event.pull_request.number,
//      github.event.pull_request.head.repo.full_name, inputs.action, inputs.stack,
//      inputs.confirm, matrix.stack, needs.stacks.outputs.{stacks,mode,can_plan},
//      needs.changes.outputs.digests (via fromJSON(...)[matrix.stack]), steps.<id>.outputs.<name>,
//      join(needs.*.result, ' '), needs.<job>.result.
//    Builtins GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_ACTOR, GITHUB_OUTPUT,
//    GITHUB_WORKSPACE are set too, as on a runner.
//  * `stacks` job: the steps whose `run` mentions `lab-stacks`, `GITHUB_OUTPUT` or `CONFIRM`, or
//    whose `env` reads `inputs.action`/`inputs.confirm`/`pull_request.head.repo`, are
//    executed in order (a step with `if: github.event_name == '...'` is skipped when the event
//    differs; `shell: bash` means pipefail). Together they write the outputs `stacks=`, `mode=`
//    and `can_plan=` to $GITHUB_OUTPUT and call `pnpm guardrails lab-stacks ...`.
//  * `apply` job: the step whose env holds `needs.changes.outputs.digests` is the digest
//    comparison; the computed digest reaches it through an env value `${{ steps.<id>.outputs.<x> }}`
//    (so the digest CLI step must publish it as a step output).
//  * `tf-plan` job: the step whose env holds `join(needs.*.result, ' ')` (or `needs.<job>.result`)
//    is the gate; stacks and can_plan reach it as `needs.stacks.outputs.stacks` / `.can_plan`.
//  * Steps that run `terraform plan` (jobs `plan` and `apply`) are executed with a fake `terraform`
//    (and a fake `aws` printing an account id) to see whether `-destroy` is added.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

/** Reads a repo file; a missing file fails the test with a readable message. */
function readRepoFile(...segments: string[]): string {
  const path = repoPath(...segments);
  if (!existsSync(path)) throw new Error(`missing file: ${segments.join('/')}`);
  return readFileSync(path, 'utf8');
}

function readYaml(...segments: string[]): Dict {
  const doc: unknown = parse(readRepoFile(...segments));
  if (!isDict(doc)) throw new Error(`${segments.join('/')}: not a YAML mapping`);
  return doc;
}

/** The text without comments (whole-line and trailing), for "does not mention" assertions. */
function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

/** A YAML scalar as text; anything else (missing, mapping, list) is the empty string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function jobsOf(doc: Dict): Dict {
  const jobs = doc['jobs'];
  return isDict(jobs) ? jobs : {};
}

function jobOf(doc: Dict, id: string): Dict {
  const job = jobsOf(doc)[id];
  if (!isDict(job)) throw new Error(`no job "${id}"`);
  return job;
}

function stepsOf(job: Dict): Dict[] {
  const steps = job['steps'];
  return Array.isArray(steps) ? (steps as unknown[]).filter(isDict) : [];
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return (value as unknown[]).filter((v) => typeof v === 'string');
  return [];
}

/** Logical command lines of a step: `\` continuations joined, blank lines dropped. */
function commandLines(step: Dict): string[] {
  const run = step['run'];
  if (typeof run !== 'string') return [];
  return run
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function loadInfra(): Dict {
  return readYaml('.github', 'workflows', 'infra.yml');
}

function infraText(): string {
  return readRepoFile('.github', 'workflows', 'infra.yml');
}

function job(id: string): Dict {
  return jobOf(loadInfra(), id);
}

function permissionsOf(id: string): unknown {
  return job(id)['permissions'];
}

/** Every command line of a job, in order, with the step (and its index) it belongs to. */
function commandsOf(id: string): { line: string; step: Dict; index: number }[] {
  return stepsOf(job(id)).flatMap((step, index) =>
    commandLines(step).map((line) => ({ line, step, index })),
  );
}

/** The job's text as JSON (comments gone): for "mentions" assertions over a whole job. */
function jobJson(id: string): string {
  return JSON.stringify(job(id));
}

function usesStartingWith(id: string, prefix: string): Dict[] {
  return stepsOf(job(id)).filter((step) => str(step['uses']).startsWith(prefix));
}

const AWS_LOGIN = 'aws-actions/configure-aws-credentials@';

function allEnvText(step: Dict): string {
  return isDict(step['env']) ? Object.values(step['env']).map(String).join('\n') : '';
}

// ---- A tiny GitHub-expression evaluator, enough to render `env:` and simple `if:` -----------------

type Ctx = Record<string, string>;

function truthy(value: string): boolean {
  return !(value === '' || value === 'false' || value === '0' || value === 'null');
}

function operand(token: string, ctx: Ctx, mode: 'env' | 'cond'): string {
  const t = token.trim();
  const literal = /^'((?:[^']|'')*)'$/.exec(t);
  if (literal) return (literal[1] as string).replace(/''/g, "'");
  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(t);
  if (comparison) {
    const left = operand(comparison[1] as string, ctx, mode).toLowerCase();
    const right = operand(comparison[3] as string, ctx, mode).toLowerCase();
    return String((left === right) === (comparison[2] === '=='));
  }
  if (t === 'true' || t === 'false') return t;
  if (t in ctx) return ctx[t] as string;
  const joined = /^join\(\s*needs\.\*\.result\s*,\s*'([^']*)'\s*\)$/.exec(t);
  if (joined) {
    return (ctx['needs.*.result'] ?? '')
      .split(' ')
      .filter((part) => part !== '')
      .join(joined[1]);
  }
  if (/^fromJSON\(\s*needs\.changes\.outputs\.digests\s*\)/i.test(t)) return ctx['digests'] ?? '';
  if (/^steps\.[\w-]+\.outputs\.[\w-]+$/.test(t)) return ctx['steps.*.outputs'] ?? '';
  if (/^\w+\(.*\)$/.test(t)) return mode === 'cond' ? 'true' : '';
  return '';
}

function evalExpression(expression: string, ctx: Ctx, mode: 'env' | 'cond'): string {
  let last = '';
  for (const orPart of expression.split('||')) {
    let value = '';
    let holds = true;
    for (const andPart of orPart.split('&&')) {
      value = operand(andPart, ctx, mode);
      if (!truthy(value)) {
        holds = false;
        break;
      }
    }
    last = value;
    if (holds) return value;
  }
  return last;
}

function renderTemplate(value: unknown, ctx: Ctx): string {
  return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, inner: string) =>
    evalExpression(inner.trim(), ctx, 'env'),
  );
}

/** Whether a step runs: only simple conditions (==, !=, &&, ||) are understood, the rest holds. */
function stepRuns(step: Dict, ctx: Ctx): boolean {
  const condition = step['if'];
  if (condition === undefined) return true;
  if (typeof condition === 'boolean') return condition;
  const text = (typeof condition === 'string' ? condition : JSON.stringify(condition)).trim();
  const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(text)?.[1] ?? text;
  return truthy(evalExpression(inner.trim(), ctx, 'cond'));
}

// ---- Running step scripts with bash --------------------------------------------------------------

interface Sandbox {
  dir: string;
  work: string;
  logs: string;
  bin: string;
  output: string;
  counter: number;
}

const slash = (path: string): string => path.replace(/\\/g, '/');

/**
 * A temp directory with fake commands on PATH. A fake logs its arguments (one line per call) in
 * `logs/<name>.log`, then runs its body (a bash script).
 */
function withSandbox<T>(fakes: Record<string, string>, body: (box: Sandbox) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'infra-step-'));
  try {
    const box: Sandbox = {
      dir,
      work: join(dir, 'work'),
      logs: join(dir, 'logs'),
      bin: join(dir, 'bin'),
      output: join(dir, 'github-output'),
      counter: 0,
    };
    mkdirSync(box.work);
    mkdirSync(box.logs);
    mkdirSync(box.bin);
    writeFileSync(box.output, '');
    for (const [name, script] of Object.entries(fakes)) {
      writeFileSync(
        join(box.bin, name),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_LOG_DIR/${name}.log"\n${script}\n`,
        { mode: 0o755 },
      );
    }
    return body(box);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface StepResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a step's `run` with bash the way a runner does; env values are rendered with `ctx`. */
function runStepIn(box: Sandbox, step: Dict, ctx: Ctx, scopes: Dict[] = []): StepResult {
  box.counter += 1;
  const scriptPath = slash(join(box.dir, `step-${box.counter}.sh`));
  writeFileSync(scriptPath, str(step['run']));

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${box.bin}${delimiter}${env[pathKey] ?? ''}`;
  env['FAKE_LOG_DIR'] = slash(box.logs);
  env['GITHUB_OUTPUT'] = slash(box.output);
  env['GITHUB_WORKSPACE'] = slash(box.work);
  env['GITHUB_EVENT_NAME'] = ctx['github.event_name'] ?? '';
  env['GITHUB_REF'] = ctx['github.ref'] ?? '';
  env['GITHUB_REPOSITORY'] = ctx['github.repository'] ?? '';
  env['GITHUB_ACTOR'] = ctx['github.actor'] ?? '';
  for (const scope of [...scopes, isDict(step['env']) ? step['env'] : {}]) {
    for (const [key, value] of Object.entries(scope)) env[key] = renderTemplate(value, ctx);
  }

  let cwd = box.work;
  const workingDirectory = renderTemplate(step['working-directory'] ?? '', ctx);
  if (workingDirectory !== '' && !workingDirectory.startsWith('/')) {
    cwd = join(box.work, workingDirectory);
    mkdirSync(cwd, { recursive: true });
  }
  const flags = step['shell'] === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail'] : ['-e'];
  const result = spawnSync('bash', [...flags, scriptPath], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readLog(box: Sandbox, name: string): string[] {
  const path = join(box.logs, `${name}.log`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '');
}

/** `key=value` lines of $GITHUB_OUTPUT; the last write of a key wins. */
function parseOutputs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\w-]+)=(.*)$/.exec(line);
    if (match) result[match[1] as string] = match[2] as string;
  }
  return result;
}

/**
 * The steps of the stacks job that handle lab-stacks, the outputs and the dispatch guard: the ones
 * whose script mentions lab-stacks, GITHUB_OUTPUT or CONFIRM, or whose env reads the dispatch
 * inputs or the pull request head repository.
 */
function stacksScriptSteps(): Dict[] {
  return stepsOf(job('stacks')).filter(
    (step) =>
      /lab-stacks|GITHUB_OUTPUT|CONFIRM/.test(str(step['run'])) ||
      /inputs\.confirm|inputs\.action|pull_request\.head\.repo/.test(allEnvText(step)),
  );
}

// ---- Event contexts -------------------------------------------------------------------------------

const BEFORE = 'a1b2c3d4e5'.repeat(4);
const AFTER = 'f6e5d4c3b2'.repeat(4);
const ZEROS = '0'.repeat(40);

type EventName = 'pull_request' | 'push' | 'workflow_dispatch';

/** The values of a run of `event`, under the keys that `env:` expressions use. */
function eventCtx(event: EventName, overrides: Ctx = {}): Ctx {
  const common: Ctx = {
    'github.event_name': event,
    'github.repository': 'owner/repo',
    'github.actor': 'octocat',
    'matrix.stack': 'labs/00-a',
  };
  const perEvent: Record<EventName, Ctx> = {
    pull_request: {
      'github.ref': 'refs/pull/12/merge',
      'github.base_ref': 'main',
      'github.event.pull_request.head.repo.full_name': 'owner/repo',
      'github.event.pull_request.number': '12',
    },
    push: {
      'github.ref': 'refs/heads/main',
      'github.event.before': BEFORE,
      'github.event.after': AFTER,
    },
    workflow_dispatch: {
      'github.ref': 'refs/heads/main',
      'inputs.action': 'plan',
      'inputs.stack': 'labs/00-a',
      'inputs.confirm': '',
    },
  };
  return { ...common, ...perEvent[event], ...overrides };
}

// ---- Lab files ------------------------------------------------------------------------------------

/** `labs/<name>` directories that directly contain a *.tf file. */
function labStackDirs(): string[] {
  const labs = repoPath('labs');
  if (!existsSync(labs)) return [];
  return readdirSync(labs, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        readdirSync(join(labs, entry.name)).some((file) => file.endsWith('.tf')),
    )
    .map((entry) => `labs/${entry.name}`)
    .sort();
}

/** The .tf sources of a stack directory (top level), comments removed. */
function stackHcl(stack: string): string {
  const dir = repoPath(...stack.split('/'));
  return readdirSync(dir)
    .filter((file) => file.endsWith('.tf'))
    .sort()
    .map((file) =>
      readFileSync(join(dir, file), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/\s*(#|\/\/).*$/, ''))
        .join('\n'),
    )
    .join('\n');
}

/** Bodies of every block that starts with `header` (a regex source), braces matched. */
function blockBodies(hcl: string, header: string): string[] {
  const bodies: string[] = [];
  const opener = new RegExp(`${header}\\s*\\{`, 'g');
  for (const match of hcl.matchAll(opener)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (index < hcl.length && depth > 0) {
      if (hcl[index] === '{') depth += 1;
      if (hcl[index] === '}') depth -= 1;
      index += 1;
    }
    bodies.push(hcl.slice(start, index - 1));
  }
  return bodies;
}

// =================================================================================================
// Lab backend rule (AC-23)
// =================================================================================================

describe('lab backend rule (every lab)', () => {
  test('AC-23: every lab stack has exactly one backend "s3" block with region and use_lockfile only', () => {
    for (const lab of labStackDirs()) {
      const bodies = blockBodies(stackHcl(lab), 'backend\\s+"s3"');
      expect(bodies, `${lab}: exactly one backend "s3" block`).toHaveLength(1);
      const body = bodies[0] as string;
      expect(body, `${lab}: region`).toMatch(/^\s*region\s*=\s*"eu-west-1"\s*$/m);
      expect(body, `${lab}: use_lockfile`).toMatch(/^\s*use_lockfile\s*=\s*true\s*$/m);
      expect(body, `${lab}: bucket is passed by CI`).not.toMatch(/^\s*bucket\s*=/m);
      expect(body, `${lab}: key is passed by CI`).not.toMatch(/^\s*key\s*=/m);
    }
  });
});

// =================================================================================================
// Workflow contract (AC-25 ... AC-33)
// =================================================================================================

describe('infra.yml: triggers, permissions, concurrency', () => {
  const on = (): Dict => {
    const value = loadInfra()['on'];
    if (!isDict(value)) throw new Error('on: is not a mapping');
    return value;
  };

  test('AC-25: the workflow file exists', () => {
    expect(existsSync(repoPath('.github', 'workflows', 'infra.yml'))).toBe(true);
  });

  test('AC-25: it triggers on pull_request, push and workflow_dispatch only', () => {
    expect(Object.keys(on()).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
  });

  test('AC-25: pull_request has no paths or paths-ignore filter', () => {
    const pullRequest = on()['pull_request'];
    if (pullRequest === null || pullRequest === undefined) return;
    expect(isDict(pullRequest)).toBe(true);
    expect(Object.keys(pullRequest as Dict)).not.toContain('paths');
    expect(Object.keys(pullRequest as Dict)).not.toContain('paths-ignore');
  });

  test('AC-25: push is limited to main, without a paths filter', () => {
    const push = on()['push'];
    expect(isDict(push)).toBe(true);
    expect((push as Dict)['branches']).toEqual(['main']);
    expect(Object.keys(push as Dict)).not.toContain('paths');
    expect(Object.keys(push as Dict)).not.toContain('paths-ignore');
  });

  const inputs = (): Dict => {
    const dispatch = on()['workflow_dispatch'];
    const value = isDict(dispatch) ? dispatch['inputs'] : undefined;
    if (!isDict(value)) throw new Error('workflow_dispatch has no inputs');
    return value;
  };

  test('AC-25: workflow_dispatch input action is a choice of plan, apply, destroy, default plan', () => {
    const action = inputs()['action'] as Dict;
    expect(isDict(action)).toBe(true);
    expect(action['type']).toBe('choice');
    expect(action['options']).toEqual(['plan', 'apply', 'destroy']);
    expect(action['default']).toBe('plan');
  });

  test('AC-25: workflow_dispatch input stack is a required string', () => {
    const stack = inputs()['stack'] as Dict;
    expect(isDict(stack)).toBe(true);
    expect(stack['required']).toBe(true);
    expect(stack['type'] === undefined || stack['type'] === 'string').toBe(true);
  });

  test("AC-25: workflow_dispatch input confirm is a string defaulting to ''", () => {
    const confirm = inputs()['confirm'] as Dict;
    expect(isDict(confirm)).toBe(true);
    expect(confirm['default']).toBe('');
    expect(confirm['type'] === undefined || confirm['type'] === 'string').toBe(true);
  });

  test('AC-25: top-level permissions is an empty mapping', () => {
    expect(loadInfra()['permissions']).toEqual({});
  });

  test('AC-25: the concurrency group is infra- plus github.ref on pull requests, else github.run_id', () => {
    const concurrency = loadInfra()['concurrency'];
    expect(isDict(concurrency)).toBe(true);
    const group = str((concurrency as Dict)['group']);
    expect(group.startsWith('infra-')).toBe(true);
    expect(group).toContain('github.run_id');
    expect(group).toContain('github.ref');
  });

  test('AC-25: cancel-in-progress is true only for pull_request', () => {
    const concurrency = loadInfra()['concurrency'] as Dict;
    const cancel = concurrency['cancel-in-progress'];
    expect(typeof cancel).toBe('string');
    expect(str(cancel)).toContain("github.event_name == 'pull_request'");
  });

  test("AC-25: the workflow env sets TF_IN_AUTOMATION 'true' and TF_INPUT 'false'", () => {
    const env = loadInfra()['env'];
    expect(isDict(env)).toBe(true);
    expect(String((env as Dict)['TF_IN_AUTOMATION'])).toBe('true');
    expect(String((env as Dict)['TF_INPUT'])).toBe('false');
  });
});

describe('infra.yml: jobs and permissions', () => {
  test('AC-26: the jobs stacks, plan, changes, report, infracost, apply, verify and tf-plan exist', () => {
    expect(Object.keys(jobsOf(loadInfra()))).toEqual(
      expect.arrayContaining([
        'stacks',
        'plan',
        'changes',
        'report',
        'infracost',
        'apply',
        'verify',
        'tf-plan',
      ]),
    );
  });

  test.each([
    ['stacks', { contents: 'read' }],
    ['plan', { contents: 'read', 'id-token': 'write' }],
    ['apply', { contents: 'read', 'id-token': 'write' }],
    ['verify', { contents: 'read', 'id-token': 'write' }],
    ['changes', {}],
    ['report', { 'pull-requests': 'write' }],
    ['infracost', { contents: 'read', 'pull-requests': 'write' }],
    ['tf-plan', {}],
  ])('AC-26: job %s has exactly these permissions', (id, expected) => {
    expect(permissionsOf(id)).toEqual(expected);
  });

  test('AC-26: no other job requests id-token (and no job uses write-all or read-all)', () => {
    const withToken = Object.entries(jobsOf(loadInfra()))
      .filter(([, value]) => isDict(value) && isDict(value['permissions']))
      .filter(([, value]) => 'id-token' in ((value as Dict)['permissions'] as Dict))
      .map(([id]) => id)
      .sort();
    expect(withToken).toEqual(['apply', 'plan', 'verify']);
    expect(infraText()).not.toMatch(/\b(write-all|read-all)\b/);
  });

  test('AC-26: the plan job is a matrix over the stacks output, runs only for a non-empty list and can_plan', () => {
    const plan = job('plan');
    expect(stringList(plan['needs'])).toContain('stacks');
    const condition = str(plan['if']);
    expect(condition).toMatch(/needs\.stacks\.outputs\.stacks\s*!=\s*'\[\]'/);
    expect(condition).toMatch(/needs\.stacks\.outputs\.can_plan\s*==\s*'true'/);
    const strategy = plan['strategy'] as Dict;
    expect(strategy['fail-fast']).toBe(false);
    expect(String((strategy['matrix'] as Dict)['stack'])).toMatch(
      /fromjson\(\s*needs\.stacks\.outputs\.stacks\s*\)/i,
    );
  });

  test('AC-26: the stacks job outputs stacks, mode and can_plan', () => {
    const outputs = job('stacks')['outputs'];
    expect(isDict(outputs)).toBe(true);
    expect(Object.keys(outputs as Dict)).toEqual(
      expect.arrayContaining(['stacks', 'mode', 'can_plan']),
    );
  });

  test('AC-26: the changes job needs stacks and plan, downloads the plan-meta artifacts, outputs changed and digests', () => {
    const changes = job('changes');
    expect(stringList(changes['needs'])).toEqual(expect.arrayContaining(['stacks', 'plan']));
    expect(Object.keys(changes['outputs'] as Dict)).toEqual(
      expect.arrayContaining(['changed', 'digests']),
    );
    const download = usesStartingWith('changes', 'actions/download-artifact@');
    expect(download.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(download)).toContain('plan-meta-');
  });

  test('AC-26: no job is guarded by always() except tf-plan (nothing runs after a failure)', () => {
    for (const [id, value] of Object.entries(jobsOf(loadInfra()))) {
      if (id === 'tf-plan') continue;
      expect(str((value as Dict)['if']), `job ${id}`).not.toMatch(
        /always\(\)|failure\(\)|cancelled\(\)/,
      );
    }
  });

  test('AC-26: the stacks job checks out the full history without persisting credentials', () => {
    const checkout = usesStartingWith('stacks', 'actions/checkout@')[0];
    expect(checkout).toBeDefined();
    const inputs = (checkout as Dict)['with'] as Dict;
    expect(inputs['fetch-depth']).toBe(0);
    expect(inputs['persist-credentials']).toBe(false);
  });
});

describe('infra.yml: environment and concurrency of the jobs', () => {
  test('AC-27: only apply has an environment, and it is infra', () => {
    const withEnvironment = Object.entries(jobsOf(loadInfra()))
      .filter(([, value]) => isDict(value) && 'environment' in value)
      .map(([id]) => id);
    expect(withEnvironment).toEqual(['apply']);
    const environment = job('apply')['environment'];
    expect(isDict(environment) ? environment['name'] : environment).toBe('infra');
  });

  test('AC-27: plan and verify have no environment', () => {
    expect('environment' in job('plan')).toBe(false);
    expect('environment' in job('verify')).toBe(false);
  });

  test('AC-27: the infra environment is named nowhere but in the apply job', () => {
    const text = withoutComments(infraText());
    const mentions = [...text.matchAll(/^\s*environment:/gm)];
    expect(mentions).toHaveLength(1);
  });

  test('AC-27: apply has its own concurrency per stack that never cancels', () => {
    const concurrency = job('apply')['concurrency'];
    expect(isDict(concurrency)).toBe(true);
    expect(str((concurrency as Dict)['group'])).toContain('matrix.stack');
    expect((concurrency as Dict)['cancel-in-progress']).toBe(false);
  });
});

describe('infra.yml: secrets and AWS logins', () => {
  const loginsOf = (id: string): Dict[] => usesStartingWith(id, AWS_LOGIN);
  const roleOf = (step: Dict | undefined): string =>
    str(isDict(step?.['with']) ? step['with']['role-to-assume'] : undefined);

  test.each([
    ['plan', 'TF_PLAN_ROLE_ARN'],
    ['verify', 'TF_PLAN_ROLE_ARN'],
    ['apply', 'TF_APPLY_ROLE_ARN'],
  ])('AC-28: job %s has one AWS login that assumes secrets.%s', (id, secret) => {
    const logins = loginsOf(id);
    expect(logins).toHaveLength(1);
    expect(roleOf(logins[0])).toMatch(new RegExp(`^\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}$`));
  });

  test('AC-28: only plan, apply and verify log in to AWS', () => {
    const withLogin = Object.keys(jobsOf(loadInfra())).filter((id) => loginsOf(id).length > 0);
    expect(withLogin.sort()).toEqual(['apply', 'plan', 'verify']);
  });

  test('AC-28: secrets.TF_APPLY_ROLE_ARN appears once, in the apply job', () => {
    expect(withoutComments(infraText()).match(/secrets\.TF_APPLY_ROLE_ARN/g)).toHaveLength(1);
    expect(jobJson('apply')).toContain('secrets.TF_APPLY_ROLE_ARN');
  });

  test('AC-28: secrets.TF_PLAN_ROLE_ARN appears in plan and verify only', () => {
    const owners = Object.keys(jobsOf(loadInfra())).filter((id) =>
      jobJson(id).includes('secrets.TF_PLAN_ROLE_ARN'),
    );
    expect(owners.sort()).toEqual(['plan', 'verify']);
  });

  test('AC-28: every AWS login sets aws-region eu-west-1 and mask-aws-account-id true', () => {
    for (const id of ['plan', 'apply', 'verify']) {
      for (const login of loginsOf(id)) {
        const inputs = login['with'] as Dict;
        expect(inputs['aws-region'], id).toBe('eu-west-1');
        expect(String(inputs['mask-aws-account-id']), id).toBe('true');
      }
    }
  });

  test('AC-28: the workflow has no vars. reference', () => {
    expect(withoutComments(infraText())).not.toMatch(/\bvars\./);
  });

  test('AC-28: no state bucket name with an account id is written in the workflow', () => {
    expect(infraText()).not.toMatch(/field-guide-tfstate-\d/);
  });

  test('AC-28: no run of exactly 12 digits (an account id) is written in the workflow', () => {
    const withoutHashes = infraText().replace(/\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b/g, '');
    expect(withoutHashes).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  });
});

describe('infra.yml: the plan job', () => {
  type Matcher = { label: string; matches: (line: string) => boolean; sameLineOk?: boolean };

  const planMatchers: Matcher[] = [
    {
      label: 'terraform init -lockfile=readonly with bucket, key and region backend config',
      matches: (line) =>
        /\bterraform init\b/.test(line) &&
        /-lockfile=readonly\b/.test(line) &&
        /-backend-config[= ]["']?bucket=/.test(line) &&
        /-backend-config[= ]["']?key=/.test(line) &&
        /-backend-config[= ]["']?region=/.test(line),
    },
    {
      label: 'terraform plan -lock=false -out=',
      matches: (line) =>
        /\bterraform plan\b/.test(line) && /-lock=false\b/.test(line) && /-out=/.test(line),
    },
    { label: 'terraform show -json', matches: (line) => /\bterraform show\b.*-json\b/.test(line) },
    {
      label: 'node --experimental-strip-types terraform-plan-cli.ts digest',
      matches: (line) =>
        /\bnode\b.*--experimental-strip-types\b/.test(line) &&
        line.includes('tools/guardrails/src/terraform-plan-cli.ts') &&
        /\bdigest\b/.test(line),
    },
    {
      label: 'node --experimental-strip-types terraform-plan-cli.ts summary',
      matches: (line) =>
        /\bnode\b.*--experimental-strip-types\b/.test(line) &&
        line.includes('tools/guardrails/src/terraform-plan-cli.ts') &&
        /\bsummary\b/.test(line),
    },
    {
      label: 'a write to $GITHUB_STEP_SUMMARY',
      matches: (line) => line.includes('GITHUB_STEP_SUMMARY'),
      sameLineOk: true,
    },
  ];

  test('AC-29: the commands appear in the required order', () => {
    const commands = commandsOf('plan');
    let position = -1;
    for (const matcher of planMatchers) {
      let found = -1;
      for (let index = Math.max(position, 0); index < commands.length; index += 1) {
        if (index === position && matcher.sameLineOk !== true) continue;
        if (matcher.matches((commands[index] as { line: string }).line)) {
          found = index;
          break;
        }
      }
      expect(found, `"${matcher.label}" must come after the previous command`).toBeGreaterThan(-1);
      position = found;
    }
  });

  test('AC-29: the AWS login comes before terraform init, and init before the artifact upload', () => {
    const steps = stepsOf(job('plan'));
    const login = steps.findIndex((step) => str(step['uses']).startsWith(AWS_LOGIN));
    const init =
      commandsOf('plan').find(({ line }) => /\bterraform init\b/.test(line))?.index ?? -1;
    const upload = steps.findIndex((step) =>
      str(step['uses']).startsWith('actions/upload-artifact@'),
    );
    expect(login).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(login);
    expect(upload).toBeGreaterThan(init);
  });

  test('AC-29: the digest, changed and summary CLI calls all exist', () => {
    const lines = commandsOf('plan').map(({ line }) => line);
    for (const command of ['digest', 'changed', 'summary']) {
      expect(
        lines.some(
          (line) =>
            line.includes('--experimental-strip-types') &&
            line.includes('tools/guardrails/src/terraform-plan-cli.ts') &&
            new RegExp(`\\b${command}\\b`).test(line),
        ),
        command,
      ).toBe(true);
    }
  });

  test('AC-29: the artifact upload lists only meta.json and summary.md, kept at most 7 days', () => {
    const upload = usesStartingWith('plan', 'actions/upload-artifact@');
    expect(upload).toHaveLength(1);
    const inputs = (upload[0] as Dict)['with'] as Dict;
    const paths = str(inputs['path'])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(paths.map((path) => path.split('/').pop()).sort()).toEqual(['meta.json', 'summary.md']);
    expect(str(inputs['name'])).toContain('plan-meta-');
    const retention = Number(inputs['retention-days']);
    expect(retention).toBeGreaterThanOrEqual(1);
    expect(retention).toBeLessThanOrEqual(7);
  });

  test('AC-29: the last step always runs and deletes tfplan and plan.json', () => {
    const steps = stepsOf(job('plan'));
    const last = steps[steps.length - 1] as Dict;
    expect(str(last['if'])).toContain('always()');
    const run = str(last['run']);
    expect(run).toMatch(/\brm\b/);
    expect(run).toContain('tfplan');
    expect(run).toContain('plan.json');
  });

  test('AC-29: checkout does not persist credentials; Node comes from .nvmrc without a cache', () => {
    const checkout = usesStartingWith('plan', 'actions/checkout@')[0] as Dict;
    expect((checkout['with'] as Dict)['persist-credentials']).toBe(false);
    const node = usesStartingWith('plan', 'actions/setup-node@')[0] as Dict;
    const inputs = node['with'] as Dict;
    expect(inputs['node-version-file']).toBe('.nvmrc');
    expect(Object.keys(inputs)).not.toContain('cache');
  });

  test('AC-29: Terraform comes from .terraform-version and the wrapper is off', () => {
    const steps = stepsOf(job('plan'));
    const setup = steps.find((step) => str(step['uses']).startsWith('hashicorp/setup-terraform@'));
    expect(setup).toBeDefined();
    const inputs = (setup as Dict)['with'] as Dict;
    expect(String(inputs['terraform_version'])).toMatch(/\$\{\{.+\}\}/);
    expect(inputs['terraform_wrapper']).toBe(false);
    expect(JSON.stringify(steps)).toContain('.terraform-version');
  });
});

describe('infra.yml: plan files are never uploaded or printed', () => {
  test('AC-30: no upload-artifact path of any job mentions tfplan or plan.json', () => {
    for (const id of Object.keys(jobsOf(loadInfra()))) {
      for (const step of usesStartingWith(id, 'actions/upload-artifact@')) {
        const path = str(isDict(step['with']) ? step['with']['path'] : '');
        expect(path, `job ${id}`).not.toMatch(/tfplan|plan\.json/);
      }
    }
  });

  test('AC-30: no run prints tfplan or plan.json', () => {
    for (const id of Object.keys(jobsOf(loadInfra()))) {
      for (const { line } of commandsOf(id)) {
        expect(line, `job ${id}`).not.toMatch(
          /\b(cat|less|more|head|tail)\b[^|;&]*\b(tfplan|plan\.json)\b/,
        );
      }
    }
  });

  test('AC-30: every terraform show is the -json form', () => {
    const shows = Object.keys(jobsOf(loadInfra())).flatMap((id) =>
      commandsOf(id).filter(({ line }) => /\bterraform show\b/.test(line)),
    );
    expect(shows.length).toBeGreaterThanOrEqual(2);
    for (const { line } of shows) {
      expect(line).toMatch(/-json\b/);
      expect(line).toMatch(/>\s*\S*plan\.json/);
    }
  });

  test('AC-30: the plan and apply jobs delete the plan files in a final always() step', () => {
    for (const id of ['plan', 'apply']) {
      const steps = stepsOf(job(id));
      const last = steps[steps.length - 1] as Dict;
      expect(str(last['if']), id).toContain('always()');
      expect(str(last['run']), id).toMatch(
        /\brm\b[^\n]*tfplan[^\n]*plan\.json|\brm\b[^\n]*plan\.json[^\n]*tfplan/,
      );
    }
  });
});

describe('infra.yml: the apply job', () => {
  const needsApplyRole = (): number =>
    stepsOf(job('apply')).findIndex((step) => str(step['uses']).startsWith(AWS_LOGIN));

  /** The step whose env holds the approved digests (the comparison). */
  const compareIndex = (): number =>
    stepsOf(job('apply')).findIndex((step) =>
      allEnvText(step).includes('needs.changes.outputs.digests'),
    );

  test('AC-31: the steps appear in the required order', () => {
    const steps = stepsOf(job('apply'));
    const commands = commandsOf('apply');
    const find = (matches: (line: string) => boolean, from: number): number =>
      commands.find(({ index, line }) => index >= from && matches(line))?.index ?? -1;

    const login = needsApplyRole();
    const init = find((line) => /\bterraform init\b/.test(line), login + 1);
    const plan = find((line) => /\bterraform plan\b/.test(line) && /-out=/.test(line), init);
    const show = find((line) => /\bterraform show\b.*-json\b/.test(line), plan);
    const digest = find(
      (line) =>
        line.includes('tools/guardrails/src/terraform-plan-cli.ts') && /\bdigest\b/.test(line),
      show,
    );
    const compare = compareIndex();
    const apply = find((line) => /\bterraform apply\b/.test(line), 0);
    expect(login, 'AWS login').toBeGreaterThan(-1);
    expect(init, 'terraform init').toBeGreaterThan(login);
    expect(plan, 'terraform plan -out=').toBeGreaterThanOrEqual(init);
    expect(show, 'terraform show -json').toBeGreaterThanOrEqual(plan);
    expect(digest, 'digest CLI').toBeGreaterThanOrEqual(show);
    expect(compare, 'digest comparison').toBeGreaterThan(digest);
    expect(apply, 'terraform apply').toBeGreaterThan(compare);
    expect(steps.length).toBeGreaterThan(apply);
  });

  test('AC-31: the login uses the apply role secret', () => {
    expect(JSON.stringify(stepsOf(job('apply'))[needsApplyRole()])).toContain(
      'secrets.TF_APPLY_ROLE_ARN',
    );
  });

  test('AC-31: nothing in the apply job runs with -lock=false', () => {
    expect(jobJson('apply')).not.toContain('-lock=false');
  });

  test('AC-31: terraform apply applies the saved plan file, never -auto-approve', () => {
    const applies = commandsOf('apply').filter(({ line }) => /\bterraform apply\b/.test(line));
    expect(applies).toHaveLength(1);
    const line = (applies[0] as { line: string }).line;
    expect(line).toMatch(/\btfplan\b/);
    expect(line).not.toContain('-auto-approve');
  });

  test('AC-31: terraform apply is not in the comparison step (the comparison comes first)', () => {
    const compare = stepsOf(job('apply'))[compareIndex()] as Dict;
    expect(compare).toBeDefined();
    expect(str(compare['run'])).not.toMatch(/\bterraform apply\b/);
  });

  test('AC-31: the apply job has no pnpm, no cache and no artifact download', () => {
    const text = jobJson('apply');
    expect(text).not.toMatch(/pnpm/);
    expect(text).not.toMatch(/"cache"/);
    expect(text).not.toContain('download-artifact');
  });

  test('AC-31: the apply job needs stacks and changes and runs only for a mode, a push or dispatch and a non-empty changed list', () => {
    const apply = job('apply');
    expect(stringList(apply['needs'])).toEqual(expect.arrayContaining(['stacks', 'changes']));
    const condition = str(apply['if']);
    expect(condition).toContain('needs.stacks.outputs.mode');
    expect(condition).toMatch(/needs\.changes\.outputs\.changed\s*!=\s*'\[\]'/);
    const matrix = (apply['strategy'] as Dict)['matrix'] as Dict;
    expect(String(matrix['stack'])).toMatch(/fromjson\(\s*needs\.changes\.outputs\.changed\s*\)/i);
  });

  test('AC-31: the final step always deletes tfplan and plan.json', () => {
    const steps = stepsOf(job('apply'));
    const last = steps[steps.length - 1] as Dict;
    expect(str(last['if'])).toContain('always()');
    expect(str(last['run'])).toContain('plan.json');
  });
});

describe('infra.yml: the digest comparison, executed', () => {
  const GOOD = 'ab12'.repeat(16);

  function compare(expected: string, actual: string): StepResult {
    const step = stepsOf(job('apply')).find((candidate) =>
      allEnvText(candidate).includes('needs.changes.outputs.digests'),
    );
    if (step === undefined)
      throw new Error('no step of the apply job reads needs.changes.outputs.digests');
    const ctx = eventCtx('push', { digests: expected, 'steps.*.outputs': actual });
    return withSandbox({}, (box) => runStepIn(box, step, ctx));
  }

  test('AC-32: equal digests exit 0', () => {
    const run = compare(GOOD, GOOD);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('AC-32: different digests exit non-zero and print ::error::', () => {
    const run = compare(GOOD, 'cd34'.repeat(16));
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('::error::');
  });

  test('AC-32: an empty EXPECTED exits non-zero and prints ::error::', () => {
    const run = compare('', GOOD);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('::error::');
  });

  test('AC-32: an empty EXPECTED with an empty computed digest is still a failure', () => {
    const run = compare('', '');
    expect(run.status).not.toBe(0);
  });
});

describe('infra.yml: destroy mode and verify', () => {
  /** The `terraform plan` calls made by the plan steps of `jobId` in `mode`. */
  function planCalls(jobId: string, mode: string): string[] {
    const steps = stepsOf(job(jobId)).filter((step) => /\bterraform plan\b/.test(str(step['run'])));
    if (steps.length === 0) throw new Error(`job ${jobId} has no step that runs terraform plan`);
    const accountId = '1234' + '56789012';
    const fakes = { terraform: 'true', aws: `printf '%s\\n' ${accountId}` };
    const event: EventName = mode === 'apply' ? 'push' : 'workflow_dispatch';
    const ctx = eventCtx(event, {
      'needs.stacks.outputs.mode': mode,
      'needs.stacks.outputs.stacks': '["labs/00-a"]',
      'steps.*.outputs': accountId,
      'matrix.stack': 'labs/00-a',
    });
    return withSandbox(fakes, (box) => {
      for (const step of steps) {
        if (stepRuns(step, ctx))
          runStepIn(
            box,
            step,
            ctx,
            [loadInfra()['env'] as Dict, job(jobId)['env'] as Dict].filter(isDict),
          );
      }
      return readLog(box, 'terraform').filter((line) => /^plan\b/.test(line));
    });
  }

  test.each(['plan', 'apply'])('AC-33: the %s job runs terraform plan once per mode', (id) => {
    for (const mode of ['plan', 'apply', 'destroy']) {
      expect(planCalls(id, mode), `${id} in ${mode} mode`).toHaveLength(1);
    }
  });

  test.each(['plan', 'apply'])(
    'AC-33: the %s job adds -destroy to terraform plan in destroy mode',
    (id) => {
      expect(planCalls(id, 'destroy')[0]).toMatch(/(^|\s)-destroy(\s|$)/);
    },
  );

  test.each([
    ['plan', 'plan'],
    ['plan', 'apply'],
    ['apply', 'plan'],
    ['apply', 'apply'],
  ])('AC-33: the %s job leaves -destroy out of terraform plan in %s mode', (id, mode) => {
    // Precondition: the same step does add -destroy in destroy mode.
    expect(planCalls(id, 'destroy')[0]).toMatch(/-destroy/);
    expect(planCalls(id, mode)[0]).not.toMatch(/-destroy/);
  });

  test("AC-33: verify runs only when the stacks job's mode is apply", () => {
    const condition = str(job('verify')['if']);
    expect(condition).toMatch(/needs\.stacks\.outputs\.mode\s*==\s*'apply'/);
    expect(stringList(job('verify')['needs'])).toEqual(
      expect.arrayContaining(['stacks', 'changes', 'apply']),
    );
  });

  test('AC-33: verify runs verify.sh in the stack directory when it exists, else prints a notice', () => {
    const text = JSON.stringify(stepsOf(job('verify')).map((step) => step['run']));
    expect(text).toContain('verify.sh');
    expect(text).toContain('::notice::');
  });
});

// =================================================================================================
// The stacks job, executed (AC-34, AC-35, AC-36)
// =================================================================================================

describe('infra.yml: the stacks job scripts, executed', () => {
  /** pnpm prints a banner first, then whatever the command prints. */
  const banner = 'echo ""; echo "> saa-c03-field-guide@ guardrails /repo"; echo ""';
  const okPnpm = `${banner}\necho '["labs/00-a"]'`;

  interface StacksRun {
    status: number | null;
    stdout: string;
    stderr: string;
    outputs: Record<string, string>;
    outputText: string;
    pnpmCalls: string[];
  }

  /** Runs, in order, the stacks-job steps that handle lab-stacks, outputs and the dispatch guard. */
  function runStacks(ctx: Ctx, pnpm: string = okPnpm): StacksRun {
    const stacks = job('stacks');
    const steps = stacksScriptSteps();
    if (steps.length === 0) throw new Error('no step of the stacks job runs lab-stacks');
    const scopes = [loadInfra()['env'], stacks['env']].filter(isDict);
    return withSandbox({ pnpm }, (box) => {
      let status: number | null = 0;
      let stdout = '';
      let stderr = '';
      for (const step of steps) {
        if (!stepRuns(step, ctx)) continue;
        const run = runStepIn(box, step, ctx, scopes);
        stdout += run.stdout;
        stderr += run.stderr;
        if (run.status !== 0) {
          status = run.status;
          break;
        }
      }
      const outputText = readFileSync(box.output, 'utf8');
      return {
        status,
        stdout,
        stderr,
        outputs: parseOutputs(outputText),
        outputText,
        pnpmCalls: readLog(box, 'pnpm'),
      };
    });
  }

  const labStacksCalls = (run: StacksRun): string[] =>
    run.pnpmCalls.filter((call) => call.includes('lab-stacks'));

  test('AC-34: on a pull request it calls lab-stacks --base origin/<base_ref> and writes stacks=', () => {
    const run = runStacks(eventCtx('pull_request'));
    expect(run.status, run.stderr).toBe(0);
    const calls = labStacksCalls(run);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\blab-stacks --base origin\/main\s*$/);
    expect(run.outputs['stacks']).toBe('["labs/00-a"]');
  });

  test('AC-34: on push it calls lab-stacks --base <before> --head <after>', () => {
    const run = runStacks(eventCtx('push'));
    expect(run.status, run.stderr).toBe(0);
    const calls = labStacksCalls(run);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(`\\blab-stacks --base ${BEFORE} --head ${AFTER}\\s*$`));
    expect(run.outputs['stacks']).toBe('["labs/00-a"]');
  });

  test('AC-34: on the first push (before = 40 zeros) it calls lab-stacks --all', () => {
    const run = runStacks(eventCtx('push', { 'github.event.before': ZEROS }));
    expect(run.status, run.stderr).toBe(0);
    const calls = labStacksCalls(run);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\blab-stacks --all\s*$/);
    expect(calls[0]).not.toContain('--base');
    expect(run.outputs['stacks']).toBe('["labs/00-a"]');
  });

  test('AC-34: on dispatch it calls lab-stacks --stack <stack>', () => {
    const run = runStacks(eventCtx('workflow_dispatch', { 'inputs.stack': 'labs/00-a' }));
    expect(run.status, run.stderr).toBe(0);
    const calls = labStacksCalls(run);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\blab-stacks --stack labs\/00-a\s*$/);
    expect(run.outputs['stacks']).toBe('["labs/00-a"]');
  });

  test('AC-34: an empty list is written as stacks=[]', () => {
    const run = runStacks(eventCtx('pull_request'), `${banner}\necho '[]'`);
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs['stacks']).toBe('[]');
  });

  test.each<[string, EventName]>([
    ['pull_request', 'pull_request'],
    ['push', 'push'],
    ['workflow_dispatch', 'workflow_dispatch'],
  ])('AC-34: on %s a failing pnpm fails the step and writes no stacks=', (_name, event) => {
    const run = runStacks(eventCtx(event), `${banner}\necho "boom" >&2\nexit 1`);
    expect(run.status).not.toBe(0);
    expect(run.outputText).not.toMatch(/^stacks=/m);
  });

  test.each<[string, EventName]>([
    ['pull_request', 'pull_request'],
    ['push', 'push'],
    ['workflow_dispatch', 'workflow_dispatch'],
  ])(
    'AC-34: on %s an output that does not start with [ fails the step and writes no stacks=',
    (_name, event) => {
      const run = runStacks(eventCtx(event), `${banner}\necho "error: not json"`);
      expect(run.status).not.toBe(0);
      expect(run.outputText).not.toMatch(/^stacks=/m);
    },
  );

  test('AC-34: the stacks job pipes through bash with pipefail where it uses a pipe', () => {
    const piped = stepsOf(job('stacks')).filter((step) =>
      /lab-stacks[^\n]*[^|\n]\|[^|]/.test(withoutComments(str(step['run']))),
    );
    for (const step of piped) {
      const first =
        withoutComments(str(step['run']))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line !== '') ?? '';
      expect(step['shell'] === 'bash' || /^set\s+(-\S+\s+)*.*pipefail/.test(first)).toBe(true);
    }
  });

  test.each<[string, EventName, Ctx, string]>([
    ['a pull request', 'pull_request', {}, 'plan'],
    ['a push', 'push', {}, 'apply'],
    ['a dispatch of plan', 'workflow_dispatch', { 'inputs.action': 'plan' }, 'plan'],
    ['a dispatch of apply', 'workflow_dispatch', { 'inputs.action': 'apply' }, 'apply'],
    [
      'a dispatch of destroy',
      'workflow_dispatch',
      { 'inputs.action': 'destroy', 'inputs.confirm': 'destroy labs/00-a' },
      'destroy',
    ],
  ])('AC-34: the mode output on %s is %s', (_name, event, overrides, mode) => {
    const run = runStacks(eventCtx(event, overrides));
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs['mode']).toBe(mode);
  });
});

describe('infra.yml: the dispatch guard, executed', () => {
  const okPnpm = 'echo \'["labs/00-a"]\'';

  function guard(overrides: Ctx): number | null {
    const stacks = job('stacks');
    const steps = stacksScriptSteps();
    expect(steps.length).toBeGreaterThan(0);
    const ctx = eventCtx('workflow_dispatch', overrides);
    const scopes = [loadInfra()['env'], stacks['env']].filter(isDict);
    return withSandbox({ pnpm: okPnpm }, (box) => {
      for (const step of steps) {
        if (!stepRuns(step, ctx)) continue;
        const run = runStepIn(box, step, ctx, scopes);
        if (run.status !== 0) return run.status;
      }
      return 0;
    });
  }

  test('AC-35: a dispatch from a branch other than main fails', () => {
    // Precondition: the same dispatch from main passes.
    expect(guard({ 'github.ref': 'refs/heads/main' })).toBe(0);
    expect(guard({ 'github.ref': 'refs/heads/feature' })).not.toBe(0);
  });

  test('AC-35: destroy with the exact confirmation passes', () => {
    expect(
      guard({
        'inputs.action': 'destroy',
        'inputs.stack': 'labs/00-a',
        'inputs.confirm': 'destroy labs/00-a',
      }),
    ).toBe(0);
  });

  test.each([
    ['destroy labs/00-b'],
    ['labs/00-a'],
    ['destroy  labs/00-a'],
    ['DESTROY labs/00-a'],
    ['destroy labs/00-a '],
    [''],
  ])('AC-35: destroy with confirmation %j fails', (confirm) => {
    // Precondition: the exact confirmation passes.
    expect(
      guard({
        'inputs.action': 'destroy',
        'inputs.stack': 'labs/00-a',
        'inputs.confirm': 'destroy labs/00-a',
      }),
    ).toBe(0);
    expect(
      guard({ 'inputs.action': 'destroy', 'inputs.stack': 'labs/00-a', 'inputs.confirm': confirm }),
    ).not.toBe(0);
  });

  test.each(['apply', 'plan'])('AC-35: %s needs no confirmation', (action) => {
    expect(
      guard({ 'inputs.action': action, 'inputs.stack': 'labs/00-a', 'inputs.confirm': '' }),
    ).toBe(0);
  });

  test('AC-35: the guard only applies to dispatch (a pull request ref is fine)', () => {
    const stacks = job('stacks');
    const steps = stacksScriptSteps();
    const ctx = eventCtx('pull_request');
    const scopes = [loadInfra()['env'], stacks['env']].filter(isDict);
    const statuses = withSandbox({ pnpm: okPnpm }, (box) =>
      steps
        .filter((step) => stepRuns(step, ctx))
        .map((step) => runStepIn(box, step, ctx, scopes).status),
    );
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 0)).toBe(true);
  });
});

describe('infra.yml: can_plan, executed', () => {
  function canPlan(event: EventName, overrides: Ctx = {}): string | undefined {
    const stacks = job('stacks');
    const steps = stacksScriptSteps();
    const ctx = eventCtx(event, overrides);
    const scopes = [loadInfra()['env'], stacks['env']].filter(isDict);
    return withSandbox({ pnpm: 'echo \'["labs/00-a"]\'' }, (box) => {
      for (const step of steps) {
        if (!stepRuns(step, ctx)) continue;
        const run = runStepIn(box, step, ctx, scopes);
        expect(run.status, run.stderr).toBe(0);
      }
      return parseOutputs(readFileSync(box.output, 'utf8'))['can_plan'];
    });
  }

  test('AC-36: a pull request from this repository can be planned', () => {
    expect(canPlan('pull_request')).toBe('true');
  });

  test('AC-36: a pull request from another repository cannot', () => {
    expect(
      canPlan('pull_request', { 'github.event.pull_request.head.repo.full_name': 'fork/repo' }),
    ).toBe('false');
  });

  test('AC-36: a pull request opened by dependabot[bot] cannot', () => {
    expect(canPlan('pull_request', { 'github.actor': 'dependabot[bot]' })).toBe('false');
  });

  test('AC-36: a pull request from a fork by dependabot[bot] cannot either', () => {
    expect(
      canPlan('pull_request', {
        'github.actor': 'dependabot[bot]',
        'github.event.pull_request.head.repo.full_name': 'fork/repo',
      }),
    ).toBe('false');
  });

  test('AC-36: a push can be planned', () => {
    expect(canPlan('push')).toBe('true');
  });

  test('AC-36: a dispatch can be planned', () => {
    expect(canPlan('workflow_dispatch')).toBe('true');
  });
});

// =================================================================================================
// The tf-plan gate (AC-37)
// =================================================================================================

describe('infra.yml: the tf-plan gate', () => {
  test('AC-37: the job is named tf-plan, needs stacks and plan, runs with always()', () => {
    const gate = job('tf-plan');
    expect(gate['name']).toBe('tf-plan');
    expect(stringList(gate['needs'])).toEqual(expect.arrayContaining(['stacks', 'plan']));
    expect(str(gate['if'])).toContain('always()');
  });

  test('AC-37: infracost is not part of the gate', () => {
    expect(stringList(job('tf-plan')['needs'])).not.toContain('infracost');
  });

  function gateStep(): Dict {
    const step = stepsOf(job('tf-plan')).find((candidate) =>
      /needs\.(\*|[\w-]+)\.result/.test(allEnvText(candidate)),
    );
    if (step === undefined)
      throw new Error('no step of the tf-plan job gets needs.*.result through env');
    return step;
  }

  /** `results` = the result of `stacks` then of `plan`, as `join(needs.*.result, ' ')` gives them. */
  function gate(results: string, stacks: string, canPlanValue: string): StepResult {
    const [stacksResult = '', planResult = ''] = results.split(' ');
    const ctx: Ctx = {
      'needs.*.result': results,
      'needs.stacks.result': stacksResult,
      'needs.plan.result': planResult,
      'needs.stacks.outputs.stacks': stacks,
      'needs.stacks.outputs.can_plan': canPlanValue,
    };
    return withSandbox({}, (box) => runStepIn(box, gateStep(), ctx));
  }

  const SOME = '["labs/00-a"]';

  test('AC-37: success success passes', () => {
    const run = gate('success success', SOME, 'true');
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('AC-37: success skipped with no stacks passes', () => {
    const run = gate('success skipped', '[]', 'true');
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('AC-37: success success with no stacks passes', () => {
    expect(gate('success success', '[]', 'true').status).toBe(0);
  });

  test('AC-37: success skipped with stacks and can_plan=false fails', () => {
    // Precondition: the same results pass without stacks.
    expect(gate('success skipped', '[]', 'false').status).toBe(0);
    expect(gate('success skipped', SOME, 'false').status).not.toBe(0);
  });

  test.each([
    'failure skipped',
    'cancelled skipped',
    'success cancelled',
    'success failure',
    'failure failure',
  ])('AC-37: results "%s" fail', (results) => {
    expect(gate('success success', SOME, 'true').status).toBe(0);
    expect(gate(results, SOME, 'true').status).not.toBe(0);
    expect(gate(results, '[]', 'true').status).not.toBe(0);
  });
});

// =================================================================================================
// Injection, report, infracost, policy, docs (AC-38 ... AC-42)
// =================================================================================================

describe('infra.yml: untrusted values reach scripts through env only', () => {
  test('AC-38: no run contains a ${{ }} with github.event, inputs., github.head_ref or matrix.', () => {
    for (const id of Object.keys(jobsOf(loadInfra()))) {
      for (const step of stepsOf(job(id))) {
        const run = str(step['run']);
        for (const expression of run.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
          expect(expression[1], `job ${id}`).not.toMatch(
            /github\.event|inputs\.|github\.head_ref|matrix\./,
          );
        }
      }
    }
  });

  test.each(['report', 'infracost'])('AC-38: the %s job gets the PR number through env', (id) => {
    const envs = stepsOf(job(id)).map(allEnvText).join('\n');
    expect(envs + JSON.stringify(job(id)['env'] ?? {})).toMatch(
      /github\.event\.(pull_request\.)?number/,
    );
  });
});

describe('infra.yml: the report job', () => {
  const script = (): string =>
    stepsOf(job('report'))
      .map((step) => str(step['run']))
      .join('\n');

  test('AC-39: report runs only for pull requests, needs plan, has no checkout', () => {
    const report = job('report');
    expect(str(report['if'])).toContain("github.event_name == 'pull_request'");
    expect(stringList(report['needs'])).toContain('plan');
    expect(usesStartingWith('report', 'actions/checkout@')).toHaveLength(0);
    expect(jobJson('report')).not.toContain('checkout');
  });

  test('AC-39: the script writes a body that starts with the <!-- infra-plan --> marker', () => {
    const text = script();
    expect(text).toContain('<!-- infra-plan -->');
    expect(text).toContain('## Terraform plan');
    expect(text.indexOf('<!-- infra-plan -->')).toBeLessThan(text.indexOf('## Terraform plan'));
  });

  test('AC-39: the script finds the existing comment by marker and github-actions[bot] before PATCH', () => {
    const text = script();
    expect(text).toContain('github-actions[bot]');
    expect(text).toMatch(/\bPATCH\b/);
    expect(text).toMatch(/\bPOST\b/);
    const patch = text.search(/\bPATCH\b/);
    const lastMarker = text.lastIndexOf('<!-- infra-plan -->');
    expect(text.indexOf('github-actions[bot]')).toBeLessThan(patch);
    expect(lastMarker).toBeLessThan(patch);
    expect(text).toMatch(/\bgh api\b/);
  });

  test('AC-39: gh api gets GH_TOKEN from github.token and the body links the run', () => {
    const envs = stepsOf(job('report')).map(allEnvText).join('\n');
    expect(envs).toMatch(/github\.token/);
    expect(JSON.stringify(job('report'))).toContain('Full plans are in the job log of');
  });

  test('AC-39: report downloads the plan-meta artifacts', () => {
    const downloads = usesStartingWith('report', 'actions/download-artifact@');
    expect(downloads.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(downloads)).toContain('plan-meta-');
  });
});

describe('infra.yml: the infracost job', () => {
  const runText = (): string =>
    stepsOf(job('infracost'))
      .map((step) => str(step['run']))
      .join('\n');
  const envOf = (): Dict => {
    const merged: Dict = isDict(job('infracost')['env'])
      ? { ...(job('infracost')['env'] as Dict) }
      : {};
    for (const step of stepsOf(job('infracost'))) {
      if (isDict(step['env'])) Object.assign(merged, step['env']);
    }
    return merged;
  };

  test('AC-40: it downloads exactly infracost v0.10.46 linux amd64', () => {
    expect(runText()).toContain(
      'https://github.com/infracost/infracost/releases/download/v0.10.46/infracost-linux-amd64.tar.gz',
    );
  });

  test('AC-40: it checks a 64-hex SHA-256 with sha256sum -c before extracting', () => {
    const text = runText();
    expect(text).toMatch(/\b[0-9a-f]{64}\b/);
    const check = text.search(/\bsha256sum\b[^\n]*(-c\b|--check\b)/);
    const extract = text.search(/(^|\s)tar\s/m);
    expect(check).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(check);
  });

  test('AC-40: the environment holds the API key secret and turns the cloud and the update check off', () => {
    const env = envOf();
    expect(str(env['INFRACOST_API_KEY'])).toMatch(/^\$\{\{\s*secrets\.INFRACOST_API_KEY\s*\}\}$/);
    expect(String(env['INFRACOST_ENABLE_CLOUD'])).toBe('false');
    expect(String(env['INFRACOST_SKIP_UPDATE_CHECK'])).toBe('true');
  });

  test('AC-40: it runs infracost breakdown over each stack and comments with --behavior=update', () => {
    const text = runText();
    expect(text).toMatch(/\binfracost breakdown\b/);
    expect(text).toMatch(/--path\b/);
    expect(text).toMatch(/\binfracost comment github\b/);
    expect(text).toMatch(/--behavior(=|\s+)update\b/);
  });

  test("AC-40: it runs only on pull requests with can_plan == 'true', needs stacks", () => {
    const infracost = job('infracost');
    const condition = str(infracost['if']);
    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toMatch(/needs\.stacks\.outputs\.can_plan\s*==\s*'true'/);
    expect(condition).toMatch(/needs\.stacks\.outputs\.stacks\s*!=\s*'\[\]'/);
    expect(stringList(infracost['needs'])).toContain('stacks');
  });

  test('AC-40: it has no AWS login and no id-token, and its checkout keeps no credentials', () => {
    expect(usesStartingWith('infracost', AWS_LOGIN)).toHaveLength(0);
    expect(jobJson('infracost')).not.toContain('id-token');
    const checkout = usesStartingWith('infracost', 'actions/checkout@')[0] as Dict;
    expect((checkout['with'] as Dict)['persist-credentials']).toBe(false);
  });
});

describe('infra.yml: workflow policy (spec 004 + 030, for this file)', () => {
  test('AC-41: every action is pinned to a full SHA with a # vX.Y.Z comment', () => {
    const lines = infraText().split(/\r?\n/);
    const refs = Object.keys(jobsOf(loadInfra())).flatMap((id) =>
      stepsOf(job(id)).map((step) => str(step['uses'])),
    );
    const actions = refs.filter((ref) => ref !== '' && !ref.startsWith('./'));
    expect(actions.length).toBeGreaterThan(0);
    for (const ref of actions) {
      expect(ref, ref).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      const line = lines.find((candidate) => candidate.includes(ref)) ?? '';
      expect(line.slice(line.indexOf(ref) + ref.length), ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  test('AC-41: every job has timeout-minutes and a permissions mapping', () => {
    for (const [id, value] of Object.entries(jobsOf(loadInfra()))) {
      expect(typeof (value as Dict)['timeout-minutes'], `job ${id}`).toBe('number');
      expect(isDict((value as Dict)['permissions']), `job ${id}`).toBe(true);
    }
  });

  test('AC-41: no pull_request_target or workflow_run trigger', () => {
    const on = loadInfra()['on'] as Dict;
    expect(Object.keys(on)).not.toContain('pull_request_target');
    expect(Object.keys(on)).not.toContain('workflow_run');
  });

  test('AC-41: terraform.yml does not re-check every stack when infra.yml changes', () => {
    expect(readRepoFile('.github', 'workflows', 'terraform.yml')).not.toContain('infra.yml');
  });
});

describe('CONTRIBUTING.md: the Terraform section covers infra.yml', () => {
  /** The text of the Terraform section: from its heading to the next heading of the same level. */
  function terraformSection(): string {
    const text = readRepoFile('CONTRIBUTING.md');
    const heading = /^(#{1,6})\s+Terraform\b.*$/m.exec(text);
    if (heading === null) throw new Error('CONTRIBUTING.md has no Terraform heading');
    const start = (heading.index ?? 0) + heading[0].length;
    const level = (heading[1] as string).length;
    const rest = text.slice(start);
    const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest);
    return next === null ? rest : rest.slice(0, next.index);
  }

  test('AC-42: it mentions infra.yml', () => {
    expect(terraformSection()).toContain('infra.yml');
  });

  test('AC-42: it mentions the infra environment', () => {
    expect(terraformSection()).toMatch(
      /`infra`\s+environment|environment\s+`infra`|infra environment/i,
    );
  });

  test('AC-42: it mentions the destroy <stack> confirmation', () => {
    expect(terraformSection()).toContain('destroy <stack>');
  });

  test('AC-42: it mentions -lock=false', () => {
    expect(terraformSection()).toContain('-lock=false');
  });

  test('AC-42: it mentions path = "/lab/"', () => {
    expect(terraformSection()).toContain('path = "/lab/"');
  });

  test('AC-42: it says to destroy before deleting a lab directory', () => {
    expect(terraformSection()).toMatch(/before deleting/i);
  });
});

// =================================================================================================
// Review round 1 regressions (AC-43 ... AC-49)
//
// Contracts the implementer must keep (the tests find steps by these properties):
//  * apply, stale-run step: the step of `apply` whose `run` contains `ls-remote`. It runs `git`
//    (a fake on PATH prints `<sha><TAB>refs/heads/main`), compares the first field with
//    $GITHUB_SHA and fails with `::error::` (mentioning "dispatch") otherwise.
//  * changes, collect step: the step of `changes` whose `run` contains `meta.json`. It runs in the
//    job's working directory with the artifacts at `plan-meta/<artifact name>/meta.json`, uses the
//    real `jq`, and writes single-line `changed=<json>` and `digests=<json>` to $GITHUB_OUTPUT.
//  * report, comment step: the step of `report` whose `run` contains `gh api`. It reads the
//    summaries at `plan-meta/*/summary.md`, may use $RUNNER_TEMP, and lists the comments with
//    `gh api repos/<repo>/issues/<pr>/comments --paginate` WITHOUT --jq / -q / --template (the fake
//    gh prints the raw JSON array of each page, concatenated, as `gh --paginate` does; it fails when
//    it is asked to filter), filtering with `jq`. It writes with `gh api --method PATCH|POST <path>`
//    and passes the body as `body=@<file>` or `body=<text>` (-f, -F, --field or --raw-field).
//  * tf-plan gate: its `::error::` text for forks and Dependabot contains `pushes a commit`.
//  * The tests with the real jq are skipped locally when jq is missing, and FAIL when CI is set.
// =================================================================================================

const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
/** Runs with the real jq; skipped locally without it, but never skipped (so it fails) on CI. */
const jqTest = test.skipIf(!hasJq && !process.env['CI']);

/** Scope env a runner would provide besides the step's own `env:`. */
function runnerScope(box: Sandbox, extra: Record<string, string> = {}): Dict {
  const temp = join(box.dir, 'runner-temp');
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(box.dir, 'step-summary'), '');
  return {
    RUNNER_TEMP: slash(temp),
    GITHUB_STEP_SUMMARY: slash(join(box.dir, 'step-summary')),
    ...extra,
  };
}

function envScopes(jobId: string): Dict[] {
  return [loadInfra()['env'], job(jobId)['env']].filter(isDict);
}

describe('infra.yml: a stale run cannot apply (AC-43)', () => {
  const TIP = 'a1b2c3d4e5'.repeat(4);
  const OTHER = 'f6e5d4c3b2'.repeat(4);

  function staleStep(): Dict {
    const step = stepsOf(job('apply')).find((candidate) => /ls-remote/.test(str(candidate['run'])));
    if (step === undefined) throw new Error('no step of the apply job runs git ls-remote');
    return step;
  }

  /** `tip` = what the remote prints as the first field; null = ls-remote fails; '' = prints nothing. */
  function runStale(tip: string | null, sha: string): StepResult & { gitCalls: string[] } {
    const git =
      tip === null ? 'exit 1' : tip === '' ? 'true' : `printf '%s\\trefs/heads/main\\n' "${tip}"`;
    return withSandbox({ git }, (box) => {
      const scopes = [...envScopes('apply'), runnerScope(box, { GITHUB_SHA: sha })];
      const run = runStepIn(box, staleStep(), eventCtx('push'), scopes);
      return { ...run, gitCalls: readLog(box, 'git') };
    });
  }

  test('AC-43: the stale-run step comes after checkout and before the AWS login', () => {
    const steps = stepsOf(job('apply'));
    const checkout = steps.findIndex((step) => str(step['uses']).startsWith('actions/checkout@'));
    const stale = steps.findIndex((step) => /ls-remote/.test(str(step['run'])));
    const login = steps.findIndex((step) => str(step['uses']).startsWith(AWS_LOGIN));
    expect(checkout).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(checkout);
    expect(login).toBeGreaterThan(stale);
  });

  test('AC-43: the step has no if and no continue-on-error', () => {
    const step = staleStep();
    expect('if' in step).toBe(false);
    expect('continue-on-error' in step).toBe(false);
  });

  test('AC-43: it asks origin for refs/heads/main', () => {
    const run = runStale(TIP, TIP);
    expect(run.gitCalls).toHaveLength(1);
    expect(run.gitCalls[0]).toMatch(/\bls-remote\b.*\borigin\b.*\brefs\/heads\/main\b/);
  });

  test('AC-43: the tip of main equal to GITHUB_SHA passes', () => {
    const run = runStale(TIP, TIP);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('AC-43: a different tip fails with ::error:: telling to dispatch', () => {
    // Precondition: the same step passes with an equal SHA.
    expect(runStale(TIP, TIP).status).toBe(0);
    const run = runStale(OTHER, TIP);
    expect(run.status).not.toBe(0);
    const output = run.stdout + run.stderr;
    expect(output).toContain('::error::');
    expect(output).toMatch(/dispatch/i);
  });

  test('AC-43: a failing ls-remote fails the step', () => {
    expect(runStale(TIP, TIP).status).toBe(0);
    expect(runStale(null, TIP).status).not.toBe(0);
  });

  test('AC-43: an ls-remote that prints nothing fails the step', () => {
    expect(runStale(TIP, TIP).status).toBe(0);
    expect(runStale('', TIP).status).not.toBe(0);
  });

  test('AC-43: an empty GITHUB_SHA never matches an empty answer', () => {
    expect(runStale(TIP, TIP).status).toBe(0);
    expect(runStale('', '').status).not.toBe(0);
  });
});

describe('infra.yml: the digest mismatch message (AC-43)', () => {
  function mismatch(expected: string, actual: string): StepResult {
    const step = stepsOf(job('apply')).find((candidate) =>
      allEnvText(candidate).includes('needs.changes.outputs.digests'),
    );
    if (step === undefined) throw new Error('no step of the apply job reads the digests');
    const ctx = eventCtx('push', { digests: expected, 'steps.*.outputs': actual });
    return withSandbox({}, (box) => runStepIn(box, step, ctx, envScopes('apply')));
  }

  test('AC-43: a mismatch says to dispatch the stack and never to re-run', () => {
    // Precondition: equal digests pass.
    expect(mismatch('ab12'.repeat(16), 'ab12'.repeat(16)).status).toBe(0);
    const run = mismatch('ab12'.repeat(16), 'cd34'.repeat(16));
    expect(run.status).not.toBe(0);
    const output = run.stdout + run.stderr;
    expect(output).toContain('::error::');
    expect(output).toMatch(/dispatch/i);
    expect(output).not.toMatch(/re-?run/i);
  });

  test('AC-43: an empty EXPECTED gets the same message', () => {
    const output = (() => {
      const run = mismatch('', 'ab12'.repeat(16));
      expect(run.status).not.toBe(0);
      return run.stdout + run.stderr;
    })();
    expect(output).toMatch(/dispatch/i);
    expect(output).not.toMatch(/re-?run/i);
  });
});

// ---- CONTRIBUTING.md (AC-43, AC-49) --------------------------------------------------------------

/** The text of the Terraform section: from its heading to the next heading of the same level. */
function contributingTerraformSection(): string {
  const text = readRepoFile('CONTRIBUTING.md');
  const heading = /^(#{1,6})\s+Terraform\b.*$/m.exec(text);
  if (heading === null) throw new Error('CONTRIBUTING.md has no Terraform heading');
  const start = (heading.index ?? 0) + heading[0].length;
  const level = (heading[1] as string).length;
  const rest = text.slice(start);
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

describe('CONTRIBUTING.md: stale runs and documented limits', () => {
  // The assertion for "does not suggest re-running an old run": the Terraform section contains
  // no "re-run" / "rerun" at all (any case), and it does say to dispatch.
  test('AC-43: the Terraform section never suggests re-running a run', () => {
    expect(contributingTerraformSection()).not.toMatch(/re-?run/i);
  });

  test('AC-43: the Terraform section says to dispatch apply or destroy for a stale run', () => {
    const section = contributingTerraformSection();
    expect(section).toMatch(/dispatch/i);
    expect(section).toMatch(/tip of `?main|stale run|old run/i);
  });

  test('AC-49: it says output-only changes are not applied on their own', () => {
    const section = contributingTerraformSection();
    expect(section).toMatch(/output-only/i);
    expect(section).toMatch(/on their own/i);
  });

  test('AC-49: it warns against role-dependent values such as aws_caller_identity in arguments', () => {
    const section = contributingTerraformSection();
    expect(section).toContain('aws_caller_identity');
    expect(section).toMatch(/role-dependent/i);
  });

  test('AC-49: it says a maintainer pushes a commit for fork and Dependabot changes', () => {
    expect(contributingTerraformSection()).toContain('pushes a commit');
  });
});

describe('infra.yml: the tf-plan message for forks and Dependabot (AC-49)', () => {
  function gateRun(results: string, stacks: string, canPlanValue: string): StepResult {
    const step = stepsOf(job('tf-plan')).find((candidate) =>
      /needs\.(\*|[\w-]+)\.result/.test(allEnvText(candidate)),
    );
    if (step === undefined) throw new Error('no step of the tf-plan job gets needs.*.result');
    const [stacksResult = '', planResult = ''] = results.split(' ');
    const ctx: Ctx = {
      'needs.*.result': results,
      'needs.stacks.result': stacksResult,
      'needs.plan.result': planResult,
      'needs.stacks.outputs.stacks': stacks,
      'needs.stacks.outputs.can_plan': canPlanValue,
    };
    return withSandbox({}, (box) => runStepIn(box, step, ctx));
  }

  test('AC-49: the ::error:: for a fork or Dependabot change says a maintainer pushes a commit', () => {
    // Precondition: the same results pass without lab changes.
    expect(gateRun('success skipped', '[]', 'false').status).toBe(0);
    const run = gateRun('success skipped', '["labs/00-a"]', 'false');
    expect(run.status).not.toBe(0);
    const output = run.stdout + run.stderr;
    expect(output).toContain('::error::');
    expect(output).toContain('pushes a commit');
  });
});

// ---- AC-45 -----------------------------------------------------------------------------------------

describe('infra.yml: no way around a failing check (AC-45)', () => {
  const dispatchCheck = (condition: unknown): boolean => {
    const text = str(condition).trim();
    const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(text)?.[1] ?? text;
    return inner.replace(/\s+/g, '') === "github.event_name=='workflow_dispatch'";
  };

  test('AC-45: nothing in infra.yml has continue-on-error', () => {
    expect(withoutComments(infraText())).not.toMatch(/continue-on-error/);
    for (const id of Object.keys(jobsOf(loadInfra()))) {
      expect('continue-on-error' in job(id), `job ${id}`).toBe(false);
      for (const step of stepsOf(job(id))) {
        expect('continue-on-error' in step, `job ${id}`).toBe(false);
      }
    }
  });

  test('AC-45: in apply, the stale-run step, the digest comparison and terraform apply have no if', () => {
    const steps = stepsOf(job('apply'));
    const stale = steps.find((step) => /ls-remote/.test(str(step['run'])));
    const compare = steps.find((step) =>
      allEnvText(step).includes('needs.changes.outputs.digests'),
    );
    const apply = steps.find((step) => /\bterraform apply\b/.test(str(step['run'])));
    for (const [name, step] of [
      ['stale-run step', stale],
      ['digest comparison', compare],
      ['terraform apply', apply],
    ] as const) {
      expect(step, name).toBeDefined();
      expect('if' in (step as Dict), name).toBe(false);
    }
  });

  test('AC-45: in stacks, the select step has no if', () => {
    const select = stepsOf(job('stacks')).filter((step) => /lab-stacks/.test(str(step['run'])));
    expect(select.length).toBeGreaterThanOrEqual(1);
    for (const step of select) expect('if' in step).toBe(false);
  });

  test('AC-45: in stacks, a dispatch guard step is conditioned only on the dispatch event', () => {
    const guards = stepsOf(job('stacks')).filter(
      (step) => /CONFIRM/.test(str(step['run'])) || /inputs\.confirm/.test(allEnvText(step)),
    );
    expect(guards.length).toBeGreaterThanOrEqual(1);
    for (const step of guards) {
      if ('if' in step) expect(dispatchCheck(step['if']), JSON.stringify(step['if'])).toBe(true);
    }
  });
});

// ---- AC-46: the changes job, executed ----------------------------------------------------------------

describe('infra.yml: the changes job, executed with jq (AC-46)', () => {
  function collectStep(): Dict {
    const step = stepsOf(job('changes')).find((candidate) =>
      /meta\.json/.test(str(candidate['run'])),
    );
    if (step === undefined) throw new Error('no step of the changes job reads meta.json');
    return step;
  }

  interface Meta {
    stack: string;
    digest: string;
    changed: boolean;
  }

  function collect(metas: Meta[], event: EventName = 'push'): StepResult & { outputs: Dict } {
    return withSandbox({}, (box) => {
      for (const meta of metas) {
        const dir = join(box.work, 'plan-meta', `plan-meta-${meta.stack.replace('labs/', '')}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
      }
      const scopes = [...envScopes('changes'), runnerScope(box)];
      const ctx = eventCtx(event, { 'needs.stacks.outputs.mode': 'apply' });
      const run = runStepIn(box, collectStep(), ctx, scopes);
      const outputs: Dict = {};
      for (const [key, value] of Object.entries(parseOutputs(readFileSync(box.output, 'utf8')))) {
        try {
          outputs[key] = JSON.parse(value);
        } catch {
          outputs[key] = value;
        }
      }
      return { ...run, outputs };
    });
  }

  const metas: Meta[] = [
    { stack: 'labs/02-c', digest: 'd2'.repeat(32), changed: true },
    { stack: 'labs/00-a', digest: 'd0'.repeat(32), changed: false },
    { stack: 'labs/01-b', digest: 'd1'.repeat(32), changed: true },
  ];

  jqTest('AC-46: changed lists the changed stacks, sorted', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect(metas);
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs['changed']).toEqual(['labs/01-b', 'labs/02-c']);
  });

  jqTest('AC-46: digests is an object keyed by stack with each digest', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect(metas);
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs['digests']).toEqual({
      'labs/00-a': 'd0'.repeat(32),
      'labs/01-b': 'd1'.repeat(32),
      'labs/02-c': 'd2'.repeat(32),
    });
  });

  jqTest('AC-46: with only unchanged stacks changed is []', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect(metas.map((meta) => ({ ...meta, changed: false })));
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs['changed']).toEqual([]);
  });

  jqTest('AC-46: the outputs are single lines (usable in a matrix)', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect(metas, 'pull_request');
    expect(run.status, run.stderr).toBe(0);
    expect(run.outputs['changed']).toEqual(['labs/01-b', 'labs/02-c']);
    expect(Object.keys(run.outputs)).toEqual(expect.arrayContaining(['changed', 'digests']));
  });

  test('AC-46: the approved digest env of the apply comparison is exactly fromJSON(digests)[matrix.stack]', () => {
    const step = stepsOf(job('apply')).find((candidate) =>
      allEnvText(candidate).includes('needs.changes.outputs.digests'),
    );
    expect(step).toBeDefined();
    const values = Object.values((step as Dict)['env'] as Dict).map((value) =>
      String(value).replace(/\s+/g, ''),
    );
    expect(values).toContain('${{fromJSON(needs.changes.outputs.digests)[matrix.stack]}}');
  });
});

// ---- AC-47: the comment lookup, executed -----------------------------------------------------------

describe('infra.yml: the report comment lookup, executed with jq (AC-47)', () => {
  const MARKER = '<!-- infra-plan -->';

  function commentStep(): Dict {
    const step = stepsOf(job('report')).find((candidate) => /gh api/.test(str(candidate['run'])));
    if (step === undefined) throw new Error('no step of the report job runs gh api');
    return step;
  }

  /** gh api: GET prints the pages in $FAKE_GH_LIST; writes only log. Filtering flags are refused. */
  const fakeGh = [
    'for a in "$@"; do',
    '  case "$a" in',
    '    --jq|-q|--jq=*|--template|-t|--template=*)',
    '      echo "fake gh: filtering is not supported, pipe the JSON to jq" >&2; exit 1;;',
    '    body=@*) cp "${a#body=@}" "$FAKE_LOG_DIR/body.txt";;',
    '    body=*) printf "%s" "${a#body=}" > "$FAKE_LOG_DIR/body.txt";;',
    '  esac',
    'done',
    'case "$*" in',
    '  *PATCH*|*POST*) ;;',
    '  *) cat "$FAKE_GH_LIST";;',
    'esac',
  ].join('\n');

  const comment = (id: number, login: string, body: string): Dict => ({
    id,
    user: { login },
    body,
  });

  interface ReportRun {
    status: number | null;
    stderr: string;
    calls: string[];
    writes: { method: string; path: string }[];
    body: string;
  }

  /** `pages` = the comments of each page; `summaries` = file content per stack. */
  function report(pages: Dict[][], summaries: Record<string, string> = {}): ReportRun {
    return withSandbox({ gh: fakeGh }, (box) => {
      const list = join(box.dir, 'gh-list.json');
      writeFileSync(list, pages.map((page) => JSON.stringify(page)).join('\n'));
      const all =
        Object.keys(summaries).length > 0 ? summaries : { '00-a': '### <code>labs/00-a</code>\n' };
      for (const [id, text] of Object.entries(all)) {
        const dir = join(box.work, 'plan-meta', `plan-meta-${id}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'summary.md'), text);
      }
      const scopes = [...envScopes('report'), runnerScope(box, { FAKE_GH_LIST: slash(list) })];
      const ctx = eventCtx('pull_request', {
        'github.event.pull_request.number': '12',
        'github.repository': 'owner/repo',
        'github.token': 'fake-token',
      });
      const run = runStepIn(box, commentStep(), ctx, scopes);
      const calls = readLog(box, 'gh');
      const writes = calls.flatMap((call) => {
        const method = /(?:--method|-X)[ =](PATCH|POST)\b/.exec(call)?.[1];
        const path = call.split(/\s+/).find((token) => token.startsWith('repos/'));
        return method === undefined ? [] : [{ method, path: path ?? '' }];
      });
      const bodyPath = join(box.logs, 'body.txt');
      return {
        status: run.status,
        stderr: run.stderr,
        calls,
        writes,
        body: existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '',
      };
    });
  }

  const human = comment(7, 'octocat', `${MARKER} a human quoting the marker`);
  const botWithout = comment(9, 'github-actions[bot]', 'a bot comment without the marker');
  const botWith = (id: number): Dict =>
    comment(id, 'github-actions[bot]', `${MARKER}\n## Terraform plan`);

  jqTest('AC-47: the comments are listed with --paginate', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[human, botWithout, botWith(42)]]);
    expect(run.status, run.stderr).toBe(0);
    const list = run.calls.find(
      (call) => /issues\/12\/comments(\s|$)/.test(call) && !/PATCH|POST/.test(call),
    );
    expect(list, run.calls.join('\n')).toBeDefined();
    expect(list).toContain('--paginate');
  });

  jqTest('AC-47: the bot comment with the marker is updated with one PATCH and no POST', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[human, botWithout], [botWith(42)]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.path).toMatch(/^repos\/owner\/repo\/issues\/comments\/42$/);
  });

  jqTest('AC-47: without a bot comment holding the marker one POST creates it, no PATCH', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[human, botWithout]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('POST');
    expect(run.writes[0]?.path).toMatch(/^repos\/owner\/repo\/issues\/12\/comments$/);
  });

  jqTest('AC-47: with no comments at all one POST creates it', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.writes.map((write) => write.method)).toEqual(['POST']);
  });

  jqTest('AC-47: with two bot comments holding the marker the first one is patched', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[human, botWith(42)], [botWith(50)]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.method).toBe('PATCH');
    expect(run.writes[0]?.path).toMatch(/issues\/comments\/42$/);
  });

  jqTest('AC-47: the body starts with the marker and has the heading and the link', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.body.split(/\r?\n/)[0]).toBe(MARKER);
    expect(run.body).toContain('## Terraform plan');
    expect(run.body).toContain('Full plans are in the job log of');
  });

  jqTest(
    'AC-47: summaries are never truncated (60 000 bytes of summaries all reach the body)',
    () => {
      expect(hasJq, 'jq must be installed on CI runners').toBe(true);
      const big = (end: string): string => `${'x'.repeat(30_000)}${end}\n`;
      const run = report([[]], { '00-a': big('END-OF-A'), '01-b': big('END-OF-B') });
      expect(run.status, run.stderr).toBe(0);
      expect(run.body).toContain('END-OF-A');
      expect(run.body).toContain('END-OF-B');
      expect(run.body).not.toMatch(/left out|too long|truncated/i);
    },
  );

  jqTest('AC-47: the summaries come in stack order', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report([[]], { '01-b': 'SECOND-SUMMARY\n', '00-a': 'FIRST-SUMMARY\n' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.body.indexOf('FIRST-SUMMARY')).toBeGreaterThan(-1);
    expect(run.body.indexOf('FIRST-SUMMARY')).toBeLessThan(run.body.indexOf('SECOND-SUMMARY'));
  });
});

// ---- AC-48: one plan file ---------------------------------------------------------------------------

describe('infra.yml: one plan file name per job (AC-48)', () => {
  /** A shell word without its quotes. */
  const bare = (word: string): string => word.replace(/^["']|["']$/g, '');

  /** The words of a command line up to the first redirection. */
  function words(line: string): string[] {
    const beforeRedirect = line.split(/\s>{1,2}\s*/)[0] ?? line;
    return beforeRedirect
      .split(/\s+/)
      .filter((word) => word !== '')
      .map(bare);
  }

  function planFile(id: string): string {
    const line = commandsOf(id).find(({ line: candidate }) => /\bterraform plan\b/.test(candidate));
    const match = /(?:^|\s)-out=(\S+)/.exec(line?.line ?? '');
    return bare(match?.[1] ?? '');
  }

  function showFile(id: string): string {
    const line = commandsOf(id).find(({ line: candidate }) => /\bterraform show\b/.test(candidate));
    return words(line?.line ?? '').at(-1) ?? '';
  }

  function applyFile(): string {
    const line = commandsOf('apply').find(({ line: candidate }) =>
      /\bterraform apply\b/.test(candidate),
    );
    return words(line?.line ?? '').at(-1) ?? '';
  }

  /** Whether the always-run cleanup step removes `file` and plan.json as whole words. */
  function cleanupRemoves(id: string, file: string): boolean {
    const steps = stepsOf(job(id));
    const last = steps[steps.length - 1] as Dict;
    const cleanup = commandLines(last).filter((line) => /(^|\s)rm\s/.test(line));
    const tokens = cleanup.flatMap((line) => line.split(/[\s;&|]+/)).map(bare);
    return tokens.includes(file) && tokens.includes('plan.json');
  }

  test.each(['plan', 'apply'])('AC-48: %s plans, shows and cleans up the same file', (id) => {
    const file = planFile(id);
    expect(file, 'terraform plan -out=<file>').not.toBe('');
    expect(showFile(id), 'terraform show -json <file>').toBe(file);
    expect(cleanupRemoves(id, file), `the final step of ${id} removes ${file} and plan.json`).toBe(
      true,
    );
  });

  test('AC-48: apply applies the same file it planned', () => {
    const file = planFile('apply');
    expect(file).not.toBe('');
    expect(applyFile()).toBe(file);
  });
});

// ---- AC-50: decoy refs -----------------------------------------------------------------------------
// `git ls-remote origin refs/heads/main` also lists refs that merely end with that name (a branch
// `a/refs/heads/main`, sorted first). The stale-run step (the `apply` step whose run contains
// `ls-remote`) must take the SHA only from the line whose second field is exactly refs/heads/main.

describe('infra.yml: the stale-run step ignores decoy refs (AC-50)', () => {
  const OLD = 'f6e5d4c3b2'.repeat(4);
  const TIP = 'a1b2c3d4e5'.repeat(4);

  /** `lines` = what the fake `git ls-remote` prints, one `<sha>\t<ref>` per entry, in order. */
  function runDecoy(lines: [string, string][], sha: string): StepResult {
    const step = stepsOf(job('apply')).find((candidate) => /ls-remote/.test(str(candidate['run'])));
    if (step === undefined) throw new Error('no step of the apply job runs git ls-remote');
    const printed = lines.map(([id, ref]) => `printf '%s\\t%s\\n' "${id}" "${ref}"`).join('\n');
    return withSandbox({ git: printed === '' ? 'true' : printed }, (box) => {
      const scopes = [...envScopes('apply'), runnerScope(box, { GITHUB_SHA: sha })];
      return runStepIn(box, step, eventCtx('push'), scopes);
    });
  }

  const decoy: [string, string] = [OLD, 'refs/heads/a/refs/heads/main'];
  const exact: [string, string] = [TIP, 'refs/heads/main'];

  test('AC-50: a plain answer with the tip passes (precondition)', () => {
    const run = runDecoy([exact], TIP);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('AC-50: with a decoy printed first, GITHUB_SHA = the real tip passes', () => {
    const run = runDecoy([decoy, exact], TIP);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('AC-50: with a decoy printed first, GITHUB_SHA = the decoy SHA fails with ::error::', () => {
    // Precondition: the real tip passes with the same output.
    expect(runDecoy([decoy, exact], TIP).status).toBe(0);
    const run = runDecoy([decoy, exact], OLD);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('::error::');
  });

  test('AC-50: with only the decoy line the step fails, even for the decoy SHA', () => {
    expect(runDecoy([exact], TIP).status).toBe(0);
    const run = runDecoy([decoy], OLD);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('::error::');
  });

  test('AC-50: a decoy printed after the exact line does not matter either', () => {
    expect(runDecoy([exact, decoy], TIP).status).toBe(0);
    expect(runDecoy([exact, decoy], OLD).status).not.toBe(0);
  });
});

// =================================================================================================
// AC-51: one matching artifact is extracted straight into plan-meta/ (seen on PR #88)
//
// With several matches actions/download-artifact writes plan-meta/<artifact name>/meta.json; with
// exactly one it writes plan-meta/meta.json. The `changes` collect step and the `report` comment
// step (found as in AC-46 / AC-47) must read meta.json and summary.md at any depth under
// plan-meta/, in path order, and fail with ::error:: when there are none. How the files are found
// (find, globstar, ...) is not pinned. Tests with the real jq follow the AC-46 skip / CI rule.
// =================================================================================================

describe('infra.yml: the changes step reads any artifact layout (AC-51)', () => {
  function collectStep(): Dict {
    const step = stepsOf(job('changes')).find((candidate) =>
      /meta\.json/.test(str(candidate['run'])),
    );
    if (step === undefined) throw new Error('no step of the changes job reads meta.json');
    return step;
  }

  /** `files` = path under plan-meta/ -> content; an empty record leaves plan-meta/ empty. */
  function collect(files: Record<string, string>): StepResult & {
    outputText: string;
    outputs: Record<string, string>;
  } {
    return withSandbox({}, (box) => {
      mkdirSync(join(box.work, 'plan-meta'), { recursive: true });
      for (const [path, content] of Object.entries(files)) {
        const full = join(box.work, 'plan-meta', ...path.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      const scopes = [...envScopes('changes'), runnerScope(box)];
      const ctx = eventCtx('push', { 'needs.stacks.outputs.mode': 'apply' });
      const run = runStepIn(box, collectStep(), ctx, scopes);
      const outputText = readFileSync(box.output, 'utf8');
      return { ...run, outputText, outputs: parseOutputs(outputText) };
    });
  }

  const meta = (stack: string, digest: string, changed: boolean): string =>
    JSON.stringify({ stack, digest, changed });
  const DIGEST = 'ab12'.repeat(16);

  jqTest('AC-51: meta.json directly in plan-meta/ (one changed lab) is collected', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect({ 'meta.json': meta('labs/00-a', DIGEST, true) });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.outputs['changed'] ?? 'null')).toEqual(['labs/00-a']);
    expect(JSON.parse(run.outputs['digests'] ?? 'null')).toEqual({ 'labs/00-a': DIGEST });
  });

  jqTest('AC-51: a single unchanged lab directly in plan-meta/ gives changed=[]', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect({ 'meta.json': meta('labs/00-a', DIGEST, false) });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.outputs['changed'] ?? 'null')).toEqual([]);
  });

  jqTest('AC-51: the two-lab subdirectory layout still works', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = collect({
      'plan-meta-01-b/meta.json': meta('labs/01-b', 'd1'.repeat(32), true),
      'plan-meta-00-a/meta.json': meta('labs/00-a', 'd0'.repeat(32), true),
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.outputs['changed'] ?? 'null')).toEqual(['labs/00-a', 'labs/01-b']);
    expect(JSON.parse(run.outputs['digests'] ?? 'null')).toEqual({
      'labs/00-a': 'd0'.repeat(32),
      'labs/01-b': 'd1'.repeat(32),
    });
  });

  jqTest('AC-51: an empty plan-meta/ fails with ::error:: and writes no changed=', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    // Precondition: the same step succeeds with one file.
    expect(collect({ 'meta.json': meta('labs/00-a', DIGEST, true) }).status).toBe(0);
    const run = collect({});
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('::error::');
    expect(run.outputText).not.toMatch(/^changed=/m);
  });
});

describe('infra.yml: the report step reads any artifact layout (AC-51)', () => {
  const MARKER = '<!-- infra-plan -->';

  function commentStep(): Dict {
    const step = stepsOf(job('report')).find((candidate) => /gh api/.test(str(candidate['run'])));
    if (step === undefined) throw new Error('no step of the report job runs gh api');
    return step;
  }

  /** The fake gh of AC-47: GET prints $FAKE_GH_LIST, writes only log, filtering is refused. */
  const fakeGh = [
    'for a in "$@"; do',
    '  case "$a" in',
    '    --jq|-q|--jq=*|--template|-t|--template=*)',
    '      echo "fake gh: filtering is not supported, pipe the JSON to jq" >&2; exit 1;;',
    '    body=@*) cp "${a#body=@}" "$FAKE_LOG_DIR/body.txt";;',
    '    body=*) printf "%s" "${a#body=}" > "$FAKE_LOG_DIR/body.txt";;',
    '  esac',
    'done',
    'case "$*" in',
    '  *PATCH*|*POST*) ;;',
    '  *) cat "$FAKE_GH_LIST";;',
    'esac',
  ].join('\n');

  const botWithMarker = [
    { id: 42, user: { login: 'github-actions[bot]' }, body: `${MARKER}\n## Terraform plan` },
  ];

  /** `files` = path under plan-meta/ -> content; `comments` = the one page of existing comments. */
  function report(files: Record<string, string>, comments: unknown[] = []) {
    return withSandbox({ gh: fakeGh }, (box) => {
      const list = join(box.dir, 'gh-list.json');
      writeFileSync(list, JSON.stringify(comments));
      mkdirSync(join(box.work, 'plan-meta'), { recursive: true });
      for (const [path, content] of Object.entries(files)) {
        const full = join(box.work, 'plan-meta', ...path.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      const scopes = [...envScopes('report'), runnerScope(box, { FAKE_GH_LIST: slash(list) })];
      const ctx = eventCtx('pull_request', {
        'github.event.pull_request.number': '12',
        'github.repository': 'owner/repo',
        'github.token': 'fake-token',
      });
      const run = runStepIn(box, commentStep(), ctx, scopes);
      const methods = readLog(box, 'gh').flatMap((call) => {
        const method = /(?:--method|-X)[ =](PATCH|POST)\b/.exec(call)?.[1];
        return method === undefined ? [] : [method];
      });
      const bodyPath = join(box.logs, 'body.txt');
      return {
        ...run,
        methods,
        body: existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '',
      };
    });
  }

  jqTest('AC-51: summary.md directly in plan-meta/ reaches the body, and a POST creates it', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report({ 'summary.md': '### <code>labs/00-a</code>\nONLY-SUMMARY\n' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.body.split(/\r?\n/)[0]).toBe(MARKER);
    expect(run.body).toContain('ONLY-SUMMARY');
    expect(run.methods).toEqual(['POST']);
  });

  jqTest('AC-51: with the single layout an existing bot comment is patched', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report({ 'summary.md': 'ONLY-SUMMARY\n' }, botWithMarker);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.body).toContain('ONLY-SUMMARY');
    expect(run.methods).toEqual(['PATCH']);
  });

  jqTest('AC-51: the two-lab subdirectory layout still works, in path order', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    const run = report({
      'plan-meta-01-b/summary.md': 'SECOND-SUMMARY\n',
      'plan-meta-00-a/summary.md': 'FIRST-SUMMARY\n',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.body.indexOf('FIRST-SUMMARY')).toBeGreaterThan(-1);
    expect(run.body.indexOf('FIRST-SUMMARY')).toBeLessThan(run.body.indexOf('SECOND-SUMMARY'));
  });

  jqTest('AC-51: an empty plan-meta/ fails with ::error:: and writes no comment', () => {
    expect(hasJq, 'jq must be installed on CI runners').toBe(true);
    // Precondition: the same step succeeds with one summary.
    expect(report({ 'summary.md': 'ONLY-SUMMARY\n' }).status).toBe(0);
    const run = report({});
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('::error::');
    expect(run.methods).toEqual([]);
  });
});
