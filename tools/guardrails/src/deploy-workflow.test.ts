import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { ASSET_CACHE_CONTROL, HTML_CACHE_CONTROL } from '../../smoke/src/cache.ts';

// Spec 036: contract tests over the real files (.github/workflows/deploy.yml, package.json,
// apps/site/package.json, labs/00-site-hosting/README.md) and bash executions of the workflow's
// step scripts with stub binaries on PATH (the approach of infra-workflow.test.ts).
//
// WHAT THE IMPLEMENTER MUST KEEP STABLE (the tests find steps by these properties):
//
//  * build job: the step with id `resolve` (name "Resolve the commit to deploy").
//  * deploy job: the steps named "Check the artifact" and "Upload and invalidate", the one with id
//    `aws` (configure-aws-credentials) and the download-artifact one.
//  * smoke job: the step whose script calls `pnpm smoke`.
//  * Step scripts get every GitHub value through `env:` with a plain `${{ <context> }}` expression
//    (or `a || 'literal'`). The tests evaluate those expressions themselves, so the env variable
//    NAMES are free; the contexts they understand are: github.event_name, github.ref,
//    github.ref_name, github.sha, github.repository, inputs.ref, github.event.inputs.ref,
//    needs.build.outputs.sha, steps.aws.outputs.aws-account-id, steps.resolve.outputs.sha,
//    vars.SITE_URL, vars.SITE_CLOUDFRONT_DOMAIN, vars.SITE_DISTRIBUTION_ID.
//    The runner builtins GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REF_NAME, GITHUB_SHA,
//    GITHUB_REPOSITORY, GITHUB_OUTPUT and GITHUB_WORKSPACE are set too, as on a runner.
//  * A step without `shell:` runs as `bash -e`, with `shell: bash` as `bash -eo pipefail`.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

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

function readJson(...segments: string[]): Dict {
  const doc: unknown = JSON.parse(readRepoFile(...segments));
  if (!isDict(doc)) throw new Error(`${segments.join('/')}: not a JSON object`);
  return doc;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return (value as unknown[]).filter((v) => typeof v === 'string');
  return [];
}

const DEPLOY = ['.github', 'workflows', 'deploy.yml'] as const;

function loadDeploy(): Dict {
  return readYaml(...DEPLOY);
}

function deployText(): string {
  return readRepoFile(...DEPLOY);
}

function jobsOf(doc: Dict): Dict {
  const jobs = doc['jobs'];
  return isDict(jobs) ? jobs : {};
}

function job(id: string): Dict {
  const found = jobsOf(loadDeploy())[id];
  if (!isDict(found)) throw new Error(`deploy.yml has no job "${id}"`);
  return found;
}

function stepsOf(jobDict: Dict): Dict[] {
  const steps = jobDict['steps'];
  return Array.isArray(steps) ? (steps as unknown[]).filter(isDict) : [];
}

function steps(jobId: string): Dict[] {
  return stepsOf(job(jobId));
}

function stepIndex(jobId: string, matches: (step: Dict) => boolean): number {
  return steps(jobId).findIndex(matches);
}

function stepWhere(jobId: string, what: string, matches: (step: Dict) => boolean): Dict {
  const found = steps(jobId).find(matches);
  if (found === undefined) throw new Error(`job ${jobId} has no step ${what}`);
  return found;
}

const byId =
  (id: string) =>
  (step: Dict): boolean =>
    step['id'] === id;
const byName =
  (name: string) =>
  (step: Dict): boolean =>
    step['name'] === name;
const usesPrefix =
  (prefix: string) =>
  (step: Dict): boolean =>
    str(step['uses']).startsWith(prefix);

function withOf(step: Dict): Dict {
  return isDict(step['with']) ? step['with'] : {};
}

function envOf(step: Dict): Dict {
  return isDict(step['env']) ? step['env'] : {};
}

/** True when `value` is exactly the expression `${{ <expression> }}` (inner spaces free). */
function isExpression(value: unknown, expression: string): boolean {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\$\\{\\{\\s*${escaped}\\s*\\}\\}$`).test(str(value).trim());
}

function runsOf(jobId: string): string[] {
  return steps(jobId)
    .map((step) => str(step['run']))
    .filter((run) => run !== '');
}

function jobJson(jobId: string): string {
  return JSON.stringify(job(jobId));
}

function ciUses(action: string): string {
  const ci = readYaml('.github', 'workflows', 'ci.yml');
  for (const value of Object.values(jobsOf(ci))) {
    if (!isDict(value)) continue;
    for (const step of stepsOf(value)) {
      if (str(step['uses']).startsWith(`${action}@`)) return str(step['uses']);
    }
  }
  throw new Error(`ci.yml has no step that uses ${action}`);
}

// ---- A tiny GitHub-expression evaluator, enough for `env:` ---------------------------------------

type Ctx = Record<string, string>;

const SHA_A = 'a'.repeat(40);

function baseCtx(overrides: Ctx = {}): Ctx {
  return {
    'github.event_name': 'push',
    'github.ref': 'refs/heads/main',
    'github.ref_name': 'main',
    'github.sha': SHA_A,
    'github.repository': 'owner/repo',
    'inputs.ref': '',
    'github.event.inputs.ref': '',
    'needs.build.outputs.sha': SHA_A,
    'steps.resolve.outputs.sha': SHA_A,
    'steps.aws.outputs.aws-account-id': '111122223333',
    'vars.SITE_DISTRIBUTION_ID': 'E2EXAMPLE',
    'vars.SITE_URL': 'https://saa-c03.example.org',
    'vars.SITE_CLOUDFRONT_DOMAIN': 'd111111abcdef8.cloudfront.net',
    ...overrides,
  };
}

function evaluate(expression: string, ctx: Ctx): string {
  let last = '';
  for (const part of expression.split('||')) {
    const token = part.trim();
    const literal = /^'((?:[^']|'')*)'$/.exec(token);
    let value: string;
    if (literal) {
      value = (literal[1] as string).replace(/''/g, "'");
    } else if (token in ctx) {
      value = ctx[token] as string;
    } else {
      throw new Error(
        `unsupported expression in a step env: "${token}" (supported: ${Object.keys(ctx).join(', ')})`,
      );
    }
    last = value;
    if (value !== '') return value;
  }
  return last;
}

function render(value: unknown, ctx: Ctx): string {
  return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, inner: string) =>
    evaluate(inner.trim(), ctx),
  );
}

// ---- Running step scripts with bash --------------------------------------------------------------

const slash = (path: string): string => path.replace(/\\/g, '/');

interface Sandbox {
  dir: string;
  work: string;
  logs: string;
  bin: string;
  output: string;
  counter: number;
}

const LOG_ARGS = `{ printf '%s' NAME; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG_DIR/calls.log"`;

/**
 * A temp directory with fake commands on PATH. Every fake appends one line to `logs/calls.log`
 * (its name, then each argument, tab separated), then runs its body (a bash script).
 */
function withSandbox<T>(fakes: Record<string, string>, body: (box: Sandbox) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-step-'));
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
        `#!/usr/bin/env bash\n${LOG_ARGS.replace('NAME', name)}\n${script}\n`,
        { mode: 0o755 },
      );
    }
    return body(box);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp dir (read-only git objects on Windows) must not fail a test.
    }
  }
}

interface StepResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

/** Runs a step's `run` with bash the way a runner does; env values are rendered with `ctx`. */
function runStep(
  box: Sandbox,
  step: Dict,
  ctx: Ctx,
  extraEnv: Record<string, string> = {},
): StepResult {
  box.counter += 1;
  const scriptPath = slash(join(box.dir, `step-${box.counter}.sh`));
  writeFileSync(scriptPath, str(step['run']));

  const env = cleanEnv();
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${box.bin}${delimiter}${env[pathKey] ?? ''}`;
  env['FAKE_LOG_DIR'] = slash(box.logs);
  env['GITHUB_OUTPUT'] = slash(box.output);
  env['GITHUB_WORKSPACE'] = slash(box.work);
  env['GITHUB_EVENT_NAME'] = ctx['github.event_name'] ?? '';
  env['GITHUB_REF'] = ctx['github.ref'] ?? '';
  env['GITHUB_REF_NAME'] = ctx['github.ref_name'] ?? '';
  env['GITHUB_SHA'] = ctx['github.sha'] ?? '';
  env['GITHUB_REPOSITORY'] = ctx['github.repository'] ?? '';
  for (const [key, value] of Object.entries(envOf(step))) env[key] = render(value, ctx);
  for (const [key, value] of Object.entries(extraEnv)) env[key] = value;

  let cwd = box.work;
  const workingDirectory = render(step['working-directory'] ?? '', ctx);
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
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
  };
}

/** Every call a fake logged, in order: [name, ...arguments]. */
function callsOf(box: Sandbox): string[][] {
  const path = join(box.logs, 'calls.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
}

// =================================================================================================
// AC-1 ... AC-4, AC-13, AC-15: contract over deploy.yml
// =================================================================================================

const PATHS = [
  'apps/site/**',
  'packages/**',
  'tools/questions/**',
  'diagrams/**',
  'questions/**',
  'tools/smoke/**',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.nvmrc',
  '.github/workflows/deploy.yml',
];

describe('deploy.yml: triggers', () => {
  const on = (): Dict => {
    const value = loadDeploy()['on'];
    if (!isDict(value)) throw new Error('on: is not a mapping');
    return value;
  };

  test('AC-1: the triggers are exactly push and workflow_dispatch', () => {
    expect(Object.keys(on()).sort()).toEqual(['push', 'workflow_dispatch']);
  });

  test('AC-1: push has exactly branches [main] and paths, nothing else', () => {
    const push = on()['push'];
    expect(isDict(push)).toBe(true);
    expect(Object.keys(push as Dict).sort()).toEqual(['branches', 'paths']);
    expect((push as Dict)['branches']).toEqual(['main']);
  });

  test('AC-1: the paths filter is exactly the list of the spec', () => {
    const paths = stringList((on()['push'] as Dict)['paths']);
    expect([...paths].sort()).toEqual([...PATHS].sort());
  });

  test('AC-1: workflow_dispatch has one input, ref, a non-required string defaulting to the empty string', () => {
    const dispatch = on()['workflow_dispatch'];
    expect(isDict(dispatch)).toBe(true);
    const inputs = (dispatch as Dict)['inputs'];
    expect(isDict(inputs)).toBe(true);
    expect(Object.keys(inputs as Dict)).toEqual(['ref']);
    const ref = (inputs as Dict)['ref'] as Dict;
    expect(isDict(ref)).toBe(true);
    expect(ref['type']).toBe('string');
    expect(ref['required'] === undefined || ref['required'] === false).toBe(true);
    expect(ref['default']).toBe('');
  });
});

describe('deploy.yml: permissions, jobs, concurrency', () => {
  test('AC-2: top-level permissions is an empty mapping', () => {
    expect(loadDeploy()['permissions']).toEqual({});
  });

  test('AC-2: build and smoke have exactly contents: read', () => {
    expect(job('build')['permissions']).toEqual({ contents: 'read' });
    expect(job('smoke')['permissions']).toEqual({ contents: 'read' });
  });

  test('AC-2: deploy has exactly id-token: write', () => {
    expect(job('deploy')['permissions']).toEqual({ 'id-token': 'write' });
  });

  test.each(['build', 'smoke'])('AC-2: job %s has no id-token, environment or secrets', (id) => {
    const text = jobJson(id);
    expect(text).not.toContain('id-token');
    expect('environment' in job(id)).toBe(false);
    expect(text).not.toMatch(/secrets\./);
  });

  test.each(['build', 'smoke'])('AC-2: job %s has no AWS action or command', (id) => {
    for (const step of steps(id)) {
      expect(str(step['uses']), id).not.toMatch(/aws-actions\//);
    }
    for (const run of runsOf(id)) {
      expect(run, id).not.toMatch(/(^|[\s;&|(`])aws\s/m);
    }
  });

  test('AC-2: the secrets context appears only in the deploy job', () => {
    const doc = loadDeploy();
    for (const [id, value] of Object.entries(jobsOf(doc))) {
      if (id === 'deploy') continue;
      expect(JSON.stringify(value), id).not.toMatch(/secrets\./);
    }
    expect(JSON.stringify(doc['concurrency'])).not.toMatch(/secrets\./);
  });

  test('AC-3: the jobs are build, deploy and smoke', () => {
    expect(Object.keys(jobsOf(loadDeploy())).sort()).toEqual(['build', 'deploy', 'smoke']);
  });

  test('AC-3: deploy needs build and smoke needs deploy; build needs nothing', () => {
    expect(stringList(job('deploy')['needs'])).toEqual(['build']);
    expect(stringList(job('smoke')['needs'])).toEqual(['deploy']);
    expect(job('build')['needs']).toBeUndefined();
  });

  test.each([
    ['build', 20],
    ['deploy', 20],
    ['smoke', 10],
  ])('AC-3: job %s has timeout-minutes %i', (id, minutes) => {
    expect(job(id)['timeout-minutes']).toBe(minutes);
  });

  test('AC-3: top-level concurrency is group deploy-production without cancelling', () => {
    expect(loadDeploy()['concurrency']).toEqual({
      group: 'deploy-production',
      'cancel-in-progress': false,
    });
  });

  test('AC-3: no job has its own concurrency', () => {
    for (const id of ['build', 'deploy', 'smoke']) {
      expect('concurrency' in job(id), id).toBe(false);
    }
  });

  test('AC-3: deploy is the only job with an environment: production, with the SITE_URL variable as url', () => {
    const withEnvironment = Object.entries(jobsOf(loadDeploy()))
      .filter(([, value]) => isDict(value) && 'environment' in value)
      .map(([id]) => id);
    expect(withEnvironment).toEqual(['deploy']);
    const environment = job('deploy')['environment'];
    expect(isDict(environment)).toBe(true);
    expect((environment as Dict)['name']).toBe('production');
    expect(isExpression((environment as Dict)['url'], 'vars.SITE_URL')).toBe(true);
  });
});

describe('deploy.yml: injection and pinning rules', () => {
  test('AC-4: no run block contains ${{', () => {
    for (const id of ['build', 'deploy', 'smoke']) {
      for (const run of runsOf(id)) expect(run, id).not.toContain('${{');
    }
  });

  test('AC-4: every uses is pinned to a 40-hex SHA with a version comment', () => {
    const text = deployText();
    const lines = text.split(/\r?\n/);
    const refs = ['build', 'deploy', 'smoke'].flatMap((id) =>
      steps(id)
        .map((step) => str(step['uses']))
        .filter((uses) => uses !== ''),
    );
    expect(refs.length).toBeGreaterThanOrEqual(8);
    for (const ref of refs) {
      expect(ref).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      const line = lines.find((candidate) => candidate.includes(ref));
      expect(line, ref).toBeDefined();
      expect((line as string).slice((line as string).indexOf(ref) + ref.length), ref).toMatch(
        /#\s*v\d+\.\d+\.\d+/,
      );
    }
  });

  test('AC-4: every checkout has persist-credentials: false (one in build, one in smoke)', () => {
    const checkouts = ['build', 'deploy', 'smoke'].flatMap((id) =>
      steps(id).filter(usesPrefix('actions/checkout@')),
    );
    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) {
      expect(withOf(checkout)['persist-credentials']).toBe(false);
    }
  });

  // The policy of tools/guardrails/src/workflows.test.ts (locked, not edited) applied to this file:
  // the same rules, so a violation shows up here with the file name.
  test('AC-4: the file passes the policy of workflows.test.ts', () => {
    const doc = loadDeploy();
    const permissions = doc['permissions'];
    expect(isDict(permissions)).toBe(true);
    for (const [scope, level] of Object.entries(permissions as Dict)) {
      expect(scope === 'contents' ? ['read', 'none'] : ['none']).toContain(String(level));
    }
    expect(isDict(doc['concurrency']) || typeof doc['concurrency'] === 'string').toBe(true);
    expect(Object.keys(doc['on'] as Dict)).not.toContain('pull_request_target');
    for (const [id, value] of Object.entries(jobsOf(doc))) {
      const jobDict = value as Dict;
      expect(['write-all', 'read-all'], id).not.toContain(jobDict['permissions']);
      expect(typeof jobDict['timeout-minutes'], id).toBe('number');
      expect(jobDict['timeout-minutes'] as number, id).toBeGreaterThan(0);
    }
  });
});

describe('deploy.yml: no resource names in the file', () => {
  test('AC-13: no bucket name with an account id is written', () => {
    expect(deployText()).not.toMatch(/field-guide-site-\d/);
  });

  test('AC-13: no run of exactly 12 digits (an account id) is written', () => {
    const withoutHashes = deployText().replace(/\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b/g, '');
    expect(withoutHashes).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  });

  test('AC-13: no role ARN is written', () => {
    expect(deployText()).not.toMatch(/arn:aws[\w-]*:/);
  });

  test('AC-13: no CloudFront distribution id is written', () => {
    expect(deployText()).not.toMatch(/\bE(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/);
  });

  test('AC-13: the account id comes from steps.aws.outputs.aws-account-id through env', () => {
    const step = stepWhere(
      'deploy',
      'named "Upload and invalidate"',
      byName('Upload and invalidate'),
    );
    const values = Object.values(envOf(step));
    expect(values.some((value) => isExpression(value, 'steps.aws.outputs.aws-account-id'))).toBe(
      true,
    );
  });

  test('AC-13: the distribution id comes from vars.SITE_DISTRIBUTION_ID through env', () => {
    const step = stepWhere(
      'deploy',
      'named "Upload and invalidate"',
      byName('Upload and invalidate'),
    );
    const values = Object.values(envOf(step));
    expect(values.some((value) => isExpression(value, 'vars.SITE_DISTRIBUTION_ID'))).toBe(true);
  });
});

// =================================================================================================
// AC-5, AC-6: the resolve step, executed against temporary git repos
// =================================================================================================

interface Repo {
  template: string;
  sha: Record<'c1' | 'c2' | 's1' | 's2' | 'c3' | 'merge' | 'c4' | 'w1', string>;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    env: cleanEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * main:  c1 - c2 - c3 -- merge - c4      (origin/main = c4)
 *                \      /
 * side:           s1 - s2                (merged: only reachable through the merge's second parent)
 * wip:   c4 - w1                         (never merged)
 */
function buildRepo(root: string): Repo {
  const template = join(root, 'template');
  const origin = join(root, 'origin.git');
  mkdirSync(template);
  git(template, 'init', '-q', '-b', 'main');
  git(template, 'config', 'user.name', 'Test');
  git(template, 'config', 'user.email', 'test@example.org');
  git(template, 'config', 'commit.gpgsign', 'false');
  const commit = (message: string): string => {
    git(template, 'commit', '-q', '--allow-empty', '-m', message);
    return git(template, 'rev-parse', 'HEAD');
  };
  const c1 = commit('c1');
  const c2 = commit('c2');
  git(template, 'checkout', '-q', '-b', 'side');
  const s1 = commit('s1');
  const s2 = commit('s2');
  git(template, 'checkout', '-q', 'main');
  const c3 = commit('c3');
  git(template, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const merge = git(template, 'rev-parse', 'HEAD');
  const c4 = commit('c4');
  git(template, 'checkout', '-q', '-b', 'wip');
  const w1 = commit('w1');
  git(template, 'checkout', '-q', 'main');
  git(root, 'init', '-q', '--bare', origin);
  git(template, 'remote', 'add', 'origin', origin);
  git(template, 'push', '-q', 'origin', 'main', 'wip');
  return { template, sha: { c1, c2, s1, s2, c3, merge, c4, w1 } };
}

interface ResolveRun {
  result: StepResult;
  outputs: string;
  head: string;
  detached: boolean;
}

function resolveStep(): Dict {
  return stepWhere('build', 'with id "resolve"', byId('resolve'));
}

function runResolve(
  repo: Repo,
  event: 'push' | 'workflow_dispatch',
  options: { githubSha: string; ref?: string; githubRef?: string },
): ResolveRun {
  const step = resolveStep();
  const githubRef = options.githubRef ?? 'refs/heads/main';
  const ref = options.ref ?? '';
  const ctx = baseCtx({
    'github.event_name': event,
    'github.ref': githubRef,
    'github.ref_name': githubRef.replace(/^refs\/(heads|tags)\//, ''),
    'github.sha': options.githubSha,
    'inputs.ref': ref,
    'github.event.inputs.ref': ref,
  });
  return withSandbox({}, (box) => {
    cpSync(repo.template, box.work, { recursive: true });
    const result = runStep(box, step, ctx);
    const head = git(box.work, 'rev-parse', 'HEAD');
    const detached =
      spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
        cwd: box.work,
        env: cleanEnv(),
        windowsHide: true,
      }).status !== 0;
    return { result, outputs: readFileSync(box.output, 'utf8'), head, detached };
  });
}

function shaOutputs(outputs: string): string[] {
  return outputs
    .split(/\r?\n/)
    .filter((line) => line.startsWith('sha='))
    .map((line) => line.slice('sha='.length));
}

describe('the resolve step, executed', () => {
  let root = '';
  let repo: Repo;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'deploy-resolve-'));
    repo = buildRepo(root);
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Leftover read-only git objects must not fail the run.
    }
  });

  test('AC-5: the step is named "Resolve the commit to deploy" and comes after the checkout', () => {
    const index = stepIndex('build', byId('resolve'));
    expect(resolveStep()['name']).toBe('Resolve the commit to deploy');
    expect(index).toBeGreaterThan(stepIndex('build', usesPrefix('actions/checkout@')));
    expect(stepIndex('build', usesPrefix('actions/checkout@'))).toBeGreaterThan(-1);
  });

  test.each<[string, () => string]>([
    ['an older first-parent commit', () => repo.sha.c3],
    ['the tip of main', () => repo.sha.c4],
  ])('AC-5: on push the sha is GITHUB_SHA (%s), checked out detached', (_name, pick) => {
    const sha = pick();
    const run = runResolve(repo, 'push', { githubSha: sha });
    expect(run.result.status, run.result.output).toBe(0);
    expect(shaOutputs(run.outputs)).toEqual([sha]);
    expect(run.head).toBe(sha);
    expect(run.detached).toBe(true);
  });

  test('AC-5: on dispatch with an empty ref the sha is the tip of origin/main, not GITHUB_SHA', () => {
    const run = runResolve(repo, 'workflow_dispatch', { githubSha: repo.sha.c2 });
    expect(run.result.status, run.result.output).toBe(0);
    expect(shaOutputs(run.outputs)).toEqual([repo.sha.c4]);
    expect(run.head).toBe(repo.sha.c4);
    expect(run.detached).toBe(true);
  });

  test.each<[string, () => string]>([
    ['an older first-parent commit', () => repo.sha.c2],
    ['the first commit', () => repo.sha.c1],
    ['a merge commit', () => repo.sha.merge],
    ['the tip', () => repo.sha.c4],
  ])('AC-5: on dispatch with ref = %s the sha is that ref, checked out detached', (_name, pick) => {
    const sha = pick();
    const run = runResolve(repo, 'workflow_dispatch', { githubSha: repo.sha.c4, ref: sha });
    expect(run.result.status, run.result.output).toBe(0);
    expect(shaOutputs(run.outputs)).toEqual([sha]);
    expect(run.head).toBe(sha);
    expect(run.detached).toBe(true);
  });

  test('AC-5: the output line is exactly sha=<40 hex>', () => {
    const run = runResolve(repo, 'push', { githubSha: repo.sha.c3 });
    expect(run.outputs.trim()).toMatch(/^sha=[0-9a-f]{40}$/);
  });

  // ---- AC-6: everything that must fail ----

  function expectRejected(run: ResolveRun): void {
    expect(run.result.status, run.result.output).not.toBe(0);
    expect(run.result.output).toContain('::error::');
    expect(shaOutputs(run.outputs)).toEqual([]);
  }

  test.each(['refs/heads/feature', 'refs/heads/wip', 'refs/tags/v1', 'refs/pull/1/merge'])(
    'AC-6: a dispatch from %s fails, with an empty ref',
    (githubRef) => {
      expectRejected(runResolve(repo, 'workflow_dispatch', { githubSha: repo.sha.w1, githubRef }));
    },
  );

  test('AC-6: a dispatch from another branch fails even with a valid ref', () => {
    expectRejected(
      runResolve(repo, 'workflow_dispatch', {
        githubSha: repo.sha.w1,
        githubRef: 'refs/heads/wip',
        ref: repo.sha.c2,
      }),
    );
  });

  const malformed: [string, (sha: string) => string][] = [
    ['7 characters', (sha) => sha.slice(0, 7)],
    ['39 characters', (sha) => sha.slice(0, 39)],
    ['41 characters', (sha) => `${sha}a`],
    ['upper case', (sha) => sha.toUpperCase()],
    ['a non-hex character', (sha) => `g${sha.slice(1)}`],
    ['a leading dash', (sha) => `-${sha.slice(1)}`],
    ['a trailing space', (sha) => `${sha} `],
    ['a leading space', (sha) => ` ${sha}`],
    ['a line before the sha', (sha) => `zzz\n${sha}`],
    ['a line after the sha', (sha) => `${sha}\nzzz`],
    ['a branch name', () => 'main'],
    ['origin/main', () => 'origin/main'],
    ['HEAD', () => 'HEAD'],
  ];

  test.each(malformed)('AC-6: a dispatch ref with %s fails', (_name, mutate) => {
    expectRejected(
      runResolve(repo, 'workflow_dispatch', { githubSha: repo.sha.c4, ref: mutate(repo.sha.c2) }),
    );
  });

  test('AC-6: a dispatch ref that is a 40-hex SHA that does not exist fails', () => {
    expectRejected(
      runResolve(repo, 'workflow_dispatch', { githubSha: repo.sha.c4, ref: 'deadbeef'.repeat(5) }),
    );
  });

  test.each<[string, () => string]>([
    ['the merge side branch tip (second parent)', () => repo.sha.s2],
    ['an earlier commit of the merged side branch', () => repo.sha.s1],
    ['a commit of an unmerged branch', () => repo.sha.w1],
  ])('AC-6: a dispatch ref = %s fails', (_name, pick) => {
    expectRejected(runResolve(repo, 'workflow_dispatch', { githubSha: repo.sha.c4, ref: pick() }));
  });

  test.each<[string, () => string]>([
    ['the merge side branch tip (second parent)', () => repo.sha.s2],
    ['an earlier commit of the merged side branch', () => repo.sha.s1],
    ['a commit of an unmerged branch', () => repo.sha.w1],
    ['a commit that does not exist', () => 'deadbeef'.repeat(5)],
  ])('AC-6: a push whose GITHUB_SHA is %s fails', (_name, pick) => {
    expectRejected(runResolve(repo, 'push', { githubSha: pick() }));
  });
});

// =================================================================================================
// AC-7: the build job
// =================================================================================================

describe('deploy.yml: the build job', () => {
  const index = (matches: (step: Dict) => boolean): number => stepIndex('build', matches);
  const installIndex = (): number =>
    index((step) => str(step['run']).trim() === 'pnpm install --frozen-lockfile');
  const buildIndex = (): number =>
    index((step) => str(step['run']).trim() === 'pnpm -r --if-present build');
  const uploadIndex = (): number => index(usesPrefix('actions/upload-artifact@'));

  test('AC-7: the checkout fetches the full history', () => {
    const checkout = stepWhere(
      'build',
      'that uses actions/checkout',
      usesPrefix('actions/checkout@'),
    );
    expect(withOf(checkout)['fetch-depth']).toBe(0);
  });

  test('AC-7: the resolve step comes before the pnpm setup, the Node setup and the install', () => {
    const resolveAt = index(byId('resolve'));
    expect(resolveAt).toBeGreaterThan(-1);
    for (const [name, at] of [
      ['pnpm setup', index(usesPrefix('pnpm/action-setup@'))],
      ['node setup', index(usesPrefix('actions/setup-node@'))],
      ['install', installIndex()],
    ] as const) {
      expect(at, name).toBeGreaterThan(resolveAt);
    }
  });

  test('AC-7: checkout, pnpm and Node use the same pinned actions as ci.yml', () => {
    const used = steps('build').map((step) => str(step['uses']));
    for (const action of ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node']) {
      expect(used).toContain(ciUses(action));
    }
  });

  test('AC-7: setup-node has no cache input and no cache action is used', () => {
    const node = stepWhere(
      'build',
      'that uses actions/setup-node',
      usesPrefix('actions/setup-node@'),
    );
    expect(Object.keys(withOf(node))).not.toContain('cache');
    for (const step of steps('build')) {
      expect(str(step['uses'])).not.toMatch(/(^|\/)cache(\/|@)/);
      expect(Object.keys(withOf(step))).not.toContain('cache');
    }
  });

  test('AC-7: the install is pnpm install --frozen-lockfile and the build pnpm -r --if-present build, in that order', () => {
    expect(installIndex()).toBeGreaterThan(-1);
    expect(buildIndex()).toBeGreaterThan(installIndex());
    expect(uploadIndex()).toBeGreaterThan(buildIndex());
  });

  test('AC-7: FIELD_GUIDE_FIXTURES appears nowhere in the file', () => {
    expect(deployText()).not.toContain('FIELD_GUIDE_FIXTURES');
  });

  test('AC-7: the upload step uploads apps/site/dist/ as site-<sha>, 30 days, error when empty', () => {
    const upload = steps('build')[uploadIndex()];
    expect(upload).toBeDefined();
    const inputs = withOf(upload as Dict);
    expect(str(inputs['path']).trim()).toMatch(/^apps\/site\/dist\/?$/);
    expect(String(inputs['retention-days'])).toBe('30');
    expect(inputs['if-no-files-found']).toBe('error');
  });

  test('AC-7: the artifact is named exactly site- plus the resolved sha', () => {
    const upload = steps('build')[uploadIndex()] as Dict;
    expect(str(withOf(upload)['name']).trim()).toMatch(
      /^site-\$\{\{\s*steps\.resolve\.outputs\.sha\s*\}\}$/,
    );
  });

  test('AC-7: the job exposes output sha from steps.resolve.outputs.sha', () => {
    const outputs = job('build')['outputs'];
    expect(isDict(outputs)).toBe(true);
    expect(Object.keys(outputs as Dict)).toEqual(['sha']);
    expect(isExpression((outputs as Dict)['sha'], 'steps.resolve.outputs.sha')).toBe(true);
  });
});

// =================================================================================================
// AC-8 ... AC-12: the deploy job
// =================================================================================================

describe('deploy.yml: the deploy job (contract)', () => {
  test('AC-8: no checkout, setup-node, setup-pnpm or cache action', () => {
    for (const step of steps('deploy')) {
      expect(str(step['uses'])).not.toMatch(
        /^(actions\/checkout|actions\/setup-node|pnpm\/action-setup|actions\/cache)(@|\/)/,
      );
    }
  });

  test('AC-8: its uses are only download-artifact and configure-aws-credentials', () => {
    const used = steps('deploy')
      .map((step) => str(step['uses']))
      .filter((uses) => uses !== '')
      .map((uses) => uses.split('@')[0])
      .sort();
    expect(used).toEqual(['actions/download-artifact', 'aws-actions/configure-aws-credentials']);
  });

  test('AC-8: no run uses pnpm, npm, npx, node or tsx', () => {
    for (const run of runsOf('deploy')) {
      expect(run).not.toMatch(/(^|[\s;&|(`$])(pnpm|npm|npx|node|tsx)(?=\s|$)/m);
    }
  });

  test('AC-8: it downloads site-<needs.build.outputs.sha> into site', () => {
    const download = stepWhere(
      'deploy',
      'that uses actions/download-artifact',
      usesPrefix('actions/download-artifact@'),
    );
    expect(str(withOf(download)['name']).trim()).toMatch(
      /^site-\$\{\{\s*needs\.build\.outputs\.sha\s*\}\}$/,
    );
    expect(withOf(download)['path']).toBe('site');
  });

  test('AC-8: no deploy step has if or continue-on-error', () => {
    for (const step of steps('deploy')) {
      expect('if' in step, JSON.stringify(step['name'])).toBe(false);
      expect('continue-on-error' in step, JSON.stringify(step['name'])).toBe(false);
    }
  });

  test('AC-8: the steps come in the order download, check, credentials, upload', () => {
    const download = stepIndex('deploy', usesPrefix('actions/download-artifact@'));
    const check = stepIndex('deploy', byName('Check the artifact'));
    const login = stepIndex('deploy', byId('aws'));
    const upload = stepIndex('deploy', byName('Upload and invalidate'));
    expect(download).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(download);
    expect(login).toBeGreaterThan(check);
    expect(upload).toBeGreaterThan(login);
  });

  test('AC-8: every multi-line script of the deploy job runs with set -euo pipefail', () => {
    const multiline = runsOf('deploy').filter((run) => run.trim().includes('\n'));
    expect(multiline.length).toBeGreaterThanOrEqual(2);
    for (const run of multiline) expect(run).toMatch(/^\s*set -euo pipefail\s*$/m);
  });

  test('AC-9: the artifact check comes before the credentials step', () => {
    expect(stepIndex('deploy', byName('Check the artifact'))).toBeLessThan(
      stepIndex('deploy', byId('aws')),
    );
    expect(stepIndex('deploy', byName('Check the artifact'))).toBeGreaterThan(-1);
  });

  test('AC-10: the credentials step assumes the SITE_DEPLOY_ROLE_ARN secret for 900 s in eu-west-1, masking the account id', () => {
    const login = stepWhere('deploy', 'with id "aws"', byId('aws'));
    expect(str(login['uses'])).toMatch(/^aws-actions\/configure-aws-credentials@/);
    const inputs = withOf(login);
    expect(isExpression(inputs['role-to-assume'], 'secrets.SITE_DEPLOY_ROLE_ARN')).toBe(true);
    expect(String(inputs['role-duration-seconds'])).toBe('900');
    expect(inputs['aws-region']).toBe('eu-west-1');
    expect(String(inputs['mask-aws-account-id'])).toBe('true');
  });

  test('AC-10: secrets.SITE_DEPLOY_ROLE_ARN is referenced once in the whole file', () => {
    const withoutComments = deployText()
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|\s)#.*$/, ''))
      .join('\n');
    expect(withoutComments.match(/secrets\./g)).toHaveLength(1);
  });
});

// ---- AC-9: the artifact check, executed ------------------------------------------------------------

const OLD = new Date('2020-01-01T00:00:00Z');

/** Creates `site/` in `parent` with `total` files, all with a 2020 mtime. */
function makeSite(parent: string, total: number): string[] {
  const names = ['index.html', '404.html', 'practice/bank.json', '_astro/app.abc123.js'];
  for (let i = 0; names.length < total; i += 1) names.push(`pages/p${i}/index.html`);
  for (const name of names) {
    const path = join(parent, 'site', ...name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `content of ${name}\n`);
    utimesSync(path, OLD, OLD);
  }
  return names;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('the artifact check, executed', () => {
  const checkStep = (): Dict =>
    stepWhere('deploy', 'named "Check the artifact"', byName('Check the artifact'));

  function check(
    prepare: (box: Sandbox) => void,
    ctx: Ctx = baseCtx(),
  ): { result: StepResult; mtimes: number[] } {
    return withSandbox({}, (box) => {
      prepare(box);
      const result = runStep(box, checkStep(), ctx);
      const siteDir = join(box.work, 'site');
      const mtimes = existsSync(siteDir) ? filesUnder(siteDir).map((f) => statSync(f).mtimeMs) : [];
      return { result, mtimes };
    });
  }

  function expectRejected(outcome: { result: StepResult }): void {
    expect(outcome.result.status, outcome.result.output).not.toBe(0);
    expect(outcome.result.output).toContain('::error::');
  }

  test('AC-9: a complete site of exactly 20 files passes', () => {
    const outcome = check((box) => makeSite(box.work, 20));
    expect(outcome.result.status, outcome.result.output).toBe(0);
  });

  test('AC-9: after the check every file has an mtime not older than the start of the test', () => {
    const start = Date.now();
    const outcome = check((box) => makeSite(box.work, 22));
    expect(outcome.result.status, outcome.result.output).toBe(0);
    expect(outcome.mtimes).toHaveLength(22);
    for (const mtime of outcome.mtimes) expect(mtime).toBeGreaterThanOrEqual(start - 2000);
  });

  test.each(['index.html', '404.html', 'practice/bank.json'])(
    'AC-9: a missing %s fails',
    (name) => {
      expectRejected(
        check((box) => {
          makeSite(box.work, 24);
          rmSync(join(box.work, 'site', ...name.split('/')));
        }),
      );
    },
  );

  test.each(['index.html', '404.html', 'practice/bank.json'])(
    'AC-9: %s that is a directory instead of a file fails',
    (name) => {
      expectRejected(
        check((box) => {
          makeSite(box.work, 24);
          const path = join(box.work, 'site', ...name.split('/'));
          rmSync(path);
          mkdirSync(path);
        }),
      );
    },
  );

  test('AC-9: an empty _astro directory fails', () => {
    expectRejected(
      check((box) => {
        makeSite(box.work, 24);
        rmSync(join(box.work, 'site', '_astro', 'app.abc123.js'));
      }),
    );
  });

  test('AC-9: a missing _astro directory fails', () => {
    expectRejected(
      check((box) => {
        makeSite(box.work, 24);
        rmSync(join(box.work, 'site', '_astro'), { recursive: true });
      }),
    );
  });

  test('AC-9: a site/fixtures directory with files fails', () => {
    expectRejected(
      check((box) => {
        makeSite(box.work, 22);
        const path = join(box.work, 'site', 'fixtures', 'diagram', 'index.html');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'fixture');
      }),
    );
  });

  test('AC-9: an empty site/fixtures directory fails', () => {
    expectRejected(
      check((box) => {
        makeSite(box.work, 22);
        mkdirSync(join(box.work, 'site', 'fixtures'));
      }),
    );
  });

  test('AC-9: a site/fixtures file fails', () => {
    expectRejected(
      check((box) => {
        makeSite(box.work, 22);
        writeFileSync(join(box.work, 'site', 'fixtures'), 'x');
      }),
    );
  });

  test('AC-9: 19 files fail', () => {
    expectRejected(check((box) => makeSite(box.work, 19)));
  });

  test('AC-9: a missing site directory fails', () => {
    expectRejected(check(() => undefined));
  });

  test('AC-9: an empty site directory fails', () => {
    expectRejected(check((box) => mkdirSync(join(box.work, 'site'))));
  });

  test('AC-9: an empty SITE_DISTRIBUTION_ID fails', () => {
    expectRejected(
      check((box) => makeSite(box.work, 22), baseCtx({ 'vars.SITE_DISTRIBUTION_ID': '' })),
    );
  });
});

// ---- AC-11, AC-12: the upload step, executed -------------------------------------------------------

const FAKE_AWS = `
count_file="$FAKE_LOG_DIR/aws.count"
n=$(cat "$count_file" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$count_file"
if [ "\${FAKE_AWS_FAIL_AT:-}" = "$n" ]; then
  echo "aws: simulated failure" >&2
  exit 255
fi
if [ "$1" = cloudfront ] && [ "$2" = create-invalidation ]; then
  echo I3MADEUPINVALIDATIONID
fi
exit 0
`;

const FAKE_CURL = `
printf '%s' "\${FAKE_CURL_OUT-403}"
exit "\${FAKE_CURL_EXIT:-0}"
`;

const BUCKET = 'field-guide-site-111122223333';
const INVALIDATION_ID = 'I3MADEUPINVALIDATIONID';

interface ParsedCall {
  command: string;
  positional: string[];
  flags: Record<string, string[]>;
}

const VALUE_FLAGS = new Set([
  '--cache-control',
  '--exclude',
  '--include',
  '--distribution-id',
  '--paths',
  '--query',
  '--output',
  '--id',
  '-o',
  '-w',
]);

function parseCall(call: string[]): ParsedCall {
  const [command, ...args] = call;
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const values = flags[name] ?? [];
    if (equals > 0) values.push(arg.slice(equals + 1));
    else if (VALUE_FLAGS.has(name)) values.push(args[(i += 1)] ?? '');
    flags[name] = values;
  }
  return { command: command ?? '', positional, flags };
}

describe('the upload step, executed', () => {
  const uploadStep = (): Dict =>
    stepWhere('deploy', 'named "Upload and invalidate"', byName('Upload and invalidate'));

  function upload(extraEnv: Record<string, string> = {}): {
    result: StepResult;
    calls: string[][];
  } {
    return withSandbox({ aws: FAKE_AWS, curl: FAKE_CURL }, (box) => {
      const result = runStep(box, uploadStep(), baseCtx(), extraEnv);
      return { result, calls: callsOf(box) };
    });
  }

  const assetSync = {
    positional: ['s3', 'sync', 'site/_astro', `s3://${BUCKET}/_astro`],
    flags: { '--cache-control': [ASSET_CACHE_CONTROL], '--no-progress': [] },
  };

  test('AC-11: the step runs exactly aws, aws, aws, aws, aws, curl', () => {
    const { result, calls } = upload();
    expect(result.status, result.output).toBe(0);
    expect(calls.map((call) => call[0])).toEqual(['aws', 'aws', 'aws', 'aws', 'aws', 'curl']);
  });

  test('AC-11: first the hashed assets are synced with the asset cache control and no --delete', () => {
    const { calls } = upload();
    const parsed = parseCall(calls[0] as string[]);
    expect({ positional: parsed.positional, flags: parsed.flags }).toEqual(assetSync);
    expect(parsed.flags).not.toHaveProperty('--delete');
  });

  test('AC-11: then the rest is synced excluding _astro/*, with --delete and the HTML cache control', () => {
    const { calls } = upload();
    const parsed = parseCall(calls[1] as string[]);
    expect(parsed.positional).toEqual(['s3', 'sync', 'site', `s3://${BUCKET}`]);
    expect(parsed.flags).toEqual({
      '--exclude': ['_astro/*'],
      '--delete': [],
      '--cache-control': [HTML_CACHE_CONTROL],
      '--no-progress': [],
    });
  });

  test('AC-11: then the invalidation of /* on the distribution, printing only the id', () => {
    const { calls } = upload();
    const parsed = parseCall(calls[2] as string[]);
    expect(parsed.positional).toEqual(['cloudfront', 'create-invalidation']);
    expect(parsed.flags).toEqual({
      '--distribution-id': ['E2EXAMPLE'],
      '--paths': ['/*'],
      '--query': ['Invalidation.Id'],
      '--output': ['text'],
    });
  });

  test('AC-11: then it waits for that invalidation, with the id the invalidation printed', () => {
    const { calls } = upload();
    const parsed = parseCall(calls[3] as string[]);
    expect(parsed.positional).toEqual(['cloudfront', 'wait', 'invalidation-completed']);
    expect(parsed.flags).toEqual({
      '--distribution-id': ['E2EXAMPLE'],
      '--id': [INVALIDATION_ID],
    });
  });

  test('AC-11: then the old assets are pruned: the asset sync plus --delete', () => {
    const { calls } = upload();
    const parsed = parseCall(calls[4] as string[]);
    expect(parsed.positional).toEqual(assetSync.positional);
    expect(parsed.flags).toEqual({ ...assetSync.flags, '--delete': [] });
  });

  test('AC-11: last, curl asks the bucket URL for index.html and prints only the status code', () => {
    const { calls } = upload();
    const args = (calls[5] as string[]).slice(1);
    const url = `https://${BUCKET}.s3.eu-west-1.amazonaws.com/index.html`;
    expect(args.filter((arg) => arg === url)).toHaveLength(1);
    expect(args[args.indexOf('-o') + 1]).toBe('/dev/null');
    expect(args[args.indexOf('-w') + 1]).toBe('%{http_code}');
  });

  test('AC-11: every sync has --no-progress', () => {
    const { calls } = upload();
    const syncs = calls
      .map(parseCall)
      .filter((call) => call.command === 'aws' && call.positional[1] === 'sync');
    expect(syncs).toHaveLength(3);
    for (const sync of syncs) expect(sync.flags).toHaveProperty('--no-progress');
  });

  test('AC-11: the cache control values are the ones of tools/smoke/src/cache.ts', () => {
    expect(HTML_CACHE_CONTROL).toBe('max-age=0, s-maxage=86400, must-revalidate');
    expect(ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  // ---- AC-12: failures stop the script ----

  test.each([1, 2, 3, 4, 5])(
    'AC-12: when aws call number %i fails the step fails and nothing runs after it',
    (position) => {
      const { result, calls } = upload({ FAKE_AWS_FAIL_AT: String(position) });
      expect(result.status).not.toBe(0);
      expect(calls).toHaveLength(position);
      expect(calls.every((call) => call[0] === 'aws')).toBe(true);
    },
  );

  test.each(['200', '404', '000', '500'])(
    'AC-12: when curl prints %s the step fails with ::error::',
    (printed) => {
      const { result, calls } = upload({ FAKE_CURL_OUT: printed });
      expect(calls.at(-1)?.[0]).toBe('curl');
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('::error::');
    },
  );

  test('AC-12: when curl exits non-zero the step fails with ::error::', () => {
    const { result } = upload({ FAKE_CURL_OUT: '', FAKE_CURL_EXIT: '7' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('::error::');
  });

  test('AC-12: when curl prints 403 the step succeeds', () => {
    const { result } = upload({ FAKE_CURL_OUT: '403' });
    expect(result.status, result.output).toBe(0);
  });
});

// =================================================================================================
// AC-14: the smoke job
// =================================================================================================

describe('deploy.yml: the smoke job', () => {
  const smokeStep = (): Dict =>
    stepWhere('smoke', 'that runs pnpm smoke', (step) => str(step['run']).includes('pnpm smoke'));

  test('AC-14: it checks out ref: main without persisting credentials', () => {
    const checkout = stepWhere(
      'smoke',
      'that uses actions/checkout',
      usesPrefix('actions/checkout@'),
    );
    expect(withOf(checkout)['ref']).toBe('main');
    expect(withOf(checkout)['persist-credentials']).toBe(false);
  });

  test('AC-14: checkout, pnpm and Node use the same pinned actions as ci.yml', () => {
    const used = steps('smoke').map((step) => str(step['uses']));
    for (const action of ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node']) {
      expect(used).toContain(ciUses(action));
    }
  });

  test('AC-14: it installs with pnpm install --frozen-lockfile before the smoke step', () => {
    const install = stepIndex(
      'smoke',
      (step) => str(step['run']).trim() === 'pnpm install --frozen-lockfile',
    );
    expect(install).toBeGreaterThan(-1);
    expect(stepIndex('smoke', (step) => str(step['run']).includes('pnpm smoke'))).toBeGreaterThan(
      install,
    );
  });

  test('AC-14: SITE_URL and SITE_CLOUDFRONT_DOMAIN reach the smoke step from vars through env', () => {
    const values = Object.values(envOf(smokeStep()));
    expect(values.some((value) => isExpression(value, 'vars.SITE_URL'))).toBe(true);
    expect(values.some((value) => isExpression(value, 'vars.SITE_CLOUDFRONT_DOMAIN'))).toBe(true);
  });

  function smoke(
    url: string,
    cloudfront: string,
    pnpm = 'exit 0',
  ): { result: StepResult; calls: string[][] } {
    return withSandbox({ pnpm }, (box) => {
      const ctx = baseCtx({
        'vars.SITE_URL': url,
        'vars.SITE_CLOUDFRONT_DOMAIN': cloudfront,
      });
      const result = runStep(box, smokeStep(), ctx);
      return { result, calls: callsOf(box) };
    });
  }

  test('AC-14: with both variables it runs pnpm smoke --url <url> --cloudfront-domain <name>', () => {
    const { result, calls } = smoke('https://saa-c03.example.org', 'd111111abcdef8.cloudfront.net');
    expect(result.status, result.output).toBe(0);
    expect(calls).toEqual([
      [
        'pnpm',
        'smoke',
        '--url',
        'https://saa-c03.example.org',
        '--cloudfront-domain',
        'd111111abcdef8.cloudfront.net',
      ],
    ]);
  });

  test('AC-14: with an empty SITE_CLOUDFRONT_DOMAIN it runs pnpm smoke --url <url> only', () => {
    const { result, calls } = smoke('https://saa-c03.example.org', '');
    expect(result.status, result.output).toBe(0);
    expect(calls).toEqual([['pnpm', 'smoke', '--url', 'https://saa-c03.example.org']]);
  });

  test('AC-14: with an empty SITE_URL it fails with ::error:: and does not call pnpm', () => {
    const { result, calls } = smoke('', 'd111111abcdef8.cloudfront.net');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('::error::');
    expect(calls).toEqual([]);
  });

  test('AC-14: with both variables empty it fails with ::error:: and does not call pnpm', () => {
    const { result, calls } = smoke('', '');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('::error::');
    expect(calls).toEqual([]);
  });

  test('AC-14: values are passed as single arguments (quoted), not re-split or expanded', () => {
    const url = 'https://x.example.org/a b;touch$HOME';
    const { result, calls } = smoke(url, '');
    expect(result.status, result.output).toBe(0);
    expect(calls).toEqual([['pnpm', 'smoke', '--url', url]]);
  });

  test('AC-14: when pnpm smoke fails the step fails', () => {
    const { result } = smoke('https://saa-c03.example.org', '', 'exit 1');
    expect(result.status).not.toBe(0);
  });
});

// =================================================================================================
// AC-15: the root script and the paths filter
// =================================================================================================

interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: Dict;
}

function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const group of ['apps', 'packages', 'tools']) {
    const base = repoPath(group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifest = join(base, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as Dict;
      found.push({ name: str(json['name']), dir: `${group}/${entry.name}`, manifest: json });
    }
  }
  return found;
}

function workspaceDeps(manifest: Dict): string[] {
  const names: string[] = [];
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = manifest[field];
    if (!isDict(deps)) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (str(range).startsWith('workspace:')) names.push(name);
    }
  }
  return names;
}

/** Folders of every workspace package the site needs, followed transitively. */
function siteDependencyDirs(): string[] {
  const packages = workspacePackages();
  const site = packages.find((pkg) => pkg.dir === 'apps/site');
  if (site === undefined) throw new Error('apps/site/package.json not found');
  const seen = new Set<string>();
  const queue = workspaceDeps(site.manifest);
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const pkg = packages.find((candidate) => candidate.name === name);
    if (pkg === undefined) throw new Error(`workspace dependency ${name} has no package folder`);
    queue.push(...workspaceDeps(pkg.manifest));
  }
  return [...seen].map(
    (name) => (packages.find((pkg) => pkg.name === name) as WorkspacePackage).dir,
  );
}

function filterPaths(): string[] {
  const push = (loadDeploy()['on'] as Dict)['push'] as Dict;
  return stringList(push['paths']);
}

function covered(dir: string, filter: string[]): boolean {
  return filter.some((entry) => {
    if (!entry.endsWith('/**')) return false;
    const base = entry.slice(0, -3);
    return dir === base || dir.startsWith(`${base}/`);
  });
}

describe('package.json and the paths filter', () => {
  test('AC-15: the root package.json has the smoke script', () => {
    const scripts = readJson('package.json')['scripts'];
    expect(isDict(scripts)).toBe(true);
    expect((scripts as Dict)['smoke']).toBe('tsx tools/smoke/src/cli.ts');
  });

  test('AC-15: every entry of the paths filter exists (folders for /**, files otherwise)', () => {
    const filter = filterPaths();
    expect(filter.length).toBeGreaterThan(0);
    for (const entry of filter) {
      const path = repoPath(...entry.replace(/\/\*\*$/, '').split('/'));
      expect(existsSync(path), entry).toBe(true);
      expect(statSync(path).isDirectory(), entry).toBe(entry.endsWith('/**'));
    }
  });

  test('AC-15: the site has workspace dependencies, and apps/site itself is covered', () => {
    expect(siteDependencyDirs().length).toBeGreaterThan(0);
    expect(covered('apps/site', filterPaths())).toBe(true);
  });

  test('AC-15: every workspace dependency of apps/site, transitively, has its folder covered by the filter', () => {
    const filter = filterPaths();
    for (const dir of siteDependencyDirs()) {
      expect(covered(dir, filter), `${dir} must be covered by the paths filter`).toBe(true);
    }
  });
});

// =================================================================================================
// AC-16: the lab README
// =================================================================================================

describe('labs/00-site-hosting/README.md: Deploying the site', () => {
  function section(): string {
    const lines = readRepoFile('labs', '00-site-hosting', 'README.md').split(/\r?\n/);
    const start = lines.findIndex((line) => line.trimEnd() === '## Deploying the site');
    if (start < 0) throw new Error('README.md has no "## Deploying the site" section');
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^## /.test(line));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n');
  }

  test('AC-16: the section "## Deploying the site" exists, once, with content', () => {
    const headings = readRepoFile('labs', '00-site-hosting', 'README.md')
      .split(/\r?\n/)
      .filter((line) => line.trimEnd() === '## Deploying the site');
    expect(headings).toHaveLength(1);
    expect(section().trim().length).toBeGreaterThan(200);
  });

  test.each([
    'production',
    'SITE_DEPLOY_ROLE_ARN',
    'SITE_DISTRIBUTION_ID',
    'SITE_URL',
    'SITE_CLOUDFRONT_DOMAIN',
  ])('AC-16: the section names %s', (name) => {
    expect(section()).toContain(name);
  });

  test('AC-16: rollback by re-running the deploy job, with the 30-day limit', () => {
    const text = section();
    expect(text).toMatch(/re-?run/i);
    expect(text).toMatch(/\bdeploy\b/i);
    expect(text).toMatch(/\b30[\s-]days?\b/i);
  });

  test('AC-16: rollback by dispatching deploy.yml with ref = a full commit SHA on main', () => {
    const text = section();
    expect(text).toMatch(/dispatch/i);
    expect(text).toMatch(/\bref\b/);
    expect(text).toMatch(/full[\s\S]{0,20}\bSHA\b/i);
    expect(text).toContain('deploy.yml');
  });

  test('AC-16: the headers.json ordering note: approve the infra apply first, re-run the smoke job', () => {
    const text = section();
    expect(text).toContain('headers.json');
    expect(text).toMatch(/infra/i);
    expect(text).toMatch(/smoke/i);
    expect(text).toMatch(/re-?run/i);
  });
});
