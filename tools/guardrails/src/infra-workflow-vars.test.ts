import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

// Spec 035 (AC-8, AC-9, AC-10): contract tests over the real files: the two tf-vars modules and
// the workflows. The behaviour of the modules is in tf-vars.test.ts and tf-vars.cli.test.ts.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a repo file; a missing file fails the test with a readable message. */
function readRepoFile(...segments: string[]): string {
  const path = join(REPO_ROOT, ...segments);
  if (!existsSync(path)) throw new Error(`missing file: ${segments.join('/')}`);
  return readFileSync(path, 'utf8');
}

function readYaml(...segments: string[]): Dict {
  const doc: unknown = parse(readRepoFile(...segments));
  if (!isDict(doc)) throw new Error(`${segments.join('/')}: not a YAML mapping`);
  return doc;
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

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---- AC-8: the modules import only node: modules (and each other) --------------------------------

/** Module specifiers of static imports, re-exports, dynamic imports and require calls. */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1] ?? '');
  }
  return found;
}

describe('AC-8: the specifier extractor works (self-check)', () => {
  test('AC-8: static, side-effect, re-export, dynamic and require specifiers are all found', () => {
    const source = [
      "import { a } from 'node:fs';",
      'import b from "yaml";',
      "import 'side-effect';",
      "export { c } from './c.ts';",
      "const d = await import('dyn');",
      "const e = require('req');",
      "// import x from 'commented';",
      "/* import y from 'blocked'; */",
    ].join('\n');
    expect(importSpecifiers(source).sort()).toEqual(
      ['./c.ts', 'dyn', 'node:fs', 'req', 'side-effect', 'yaml'].sort(),
    );
  });
});

describe('AC-8: tf-vars modules run with plain Node', () => {
  test('AC-8: tf-vars.ts imports only node: modules', () => {
    const specifiers = importSpecifiers(readRepoFile('tools', 'guardrails', 'src', 'tf-vars.ts'));
    expect(specifiers.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
  });

  test('AC-8: tf-vars-cli.ts imports only node: modules and ./tf-vars.ts', () => {
    const specifiers = importSpecifiers(
      readRepoFile('tools', 'guardrails', 'src', 'tf-vars-cli.ts'),
    );
    const others = specifiers.filter(
      (specifier) => !specifier.startsWith('node:') && specifier !== './tf-vars.ts',
    );
    expect(others).toEqual([]);
  });

  test('AC-8: tf-vars-cli.ts imports ./tf-vars.ts', () => {
    const specifiers = importSpecifiers(
      readRepoFile('tools', 'guardrails', 'src', 'tf-vars-cli.ts'),
    );
    expect(specifiers).toContain('./tf-vars.ts');
  });
});

// ---- AC-9: the "Export lab variables" step in the plan and apply jobs ------------------------------

const EXPORT_STEP = 'Export lab variables';
const EXPORT_COMMAND =
  'node --experimental-strip-types "$GITHUB_WORKSPACE/tools/guardrails/src/tf-vars-cli.ts"';

function isNodeSetup(step: Dict): boolean {
  return /^actions\/setup-node@/.test(str(step['uses']));
}

function runsTerraformPlan(step: Dict): boolean {
  return /\bterraform\s+plan\b/.test(str(step['run']));
}

describe.each(['plan', 'apply'])('AC-9: job %s', (jobId) => {
  const steps = (): Dict[] => stepsOf(jobOf(readYaml('.github', 'workflows', 'infra.yml'), jobId));
  const exportSteps = (): Dict[] => steps().filter((step) => step['name'] === EXPORT_STEP);

  test(`AC-9: ${jobId} has exactly one step named "${EXPORT_STEP}"`, () => {
    expect(exportSteps()).toHaveLength(1);
  });

  test(`AC-9: ${jobId}: REPO_VARS is exactly the toJSON(vars) expression`, () => {
    const env = exportSteps()[0]?.['env'];
    expect(isDict(env) ? env['REPO_VARS'] : undefined).toBe('${{ toJSON(vars) }}');
  });

  test(`AC-9: ${jobId}: run is the node strip-types call on tf-vars-cli.ts through $GITHUB_WORKSPACE`, () => {
    expect(str(exportSteps()[0]?.['run']).trim()).toBe(EXPORT_COMMAND);
  });

  test(`AC-9: ${jobId}: the step has no if and no continue-on-error`, () => {
    const step = exportSteps()[0];
    expect(step, `no "${EXPORT_STEP}" step`).toBeDefined();
    expect(Object.keys(step ?? {})).not.toContain('if');
    expect(Object.keys(step ?? {})).not.toContain('continue-on-error');
  });

  test(`AC-9: ${jobId}: the step comes after the Node setup and before the step that runs terraform plan`, () => {
    const all = steps();
    const exportAt = all.findIndex((step) => step['name'] === EXPORT_STEP);
    const nodeAt = all.findIndex(isNodeSetup);
    const planAt = all.findIndex(runsTerraformPlan);
    expect(exportAt).toBeGreaterThanOrEqual(0);
    expect(nodeAt).toBeGreaterThanOrEqual(0);
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(nodeAt).toBeLessThan(exportAt);
    expect(exportAt).toBeLessThan(planAt);
  });
});

// ---- AC-10: nobody else sees the repository variables -----------------------------------------------

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));
}

const TO_JSON_VARS = /toJSON\(\s*vars\s*\)/i;

/** Every `env` mapping anywhere in the document (workflow, job and step level). */
function envMappings(node: unknown): Dict[] {
  const found: Dict[] = [];
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) found.push(...envMappings(item));
  } else if (isDict(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'env' && isDict(value)) found.push(value);
      found.push(...envMappings(value));
    }
  }
  return found;
}

describe('AC-10: the repository variables stay in the two Export steps', () => {
  test('AC-10: there are workflows to check', () => {
    expect(workflowFiles()).toContain('infra.yml');
  });

  test('AC-10: no job other than infra.yml plan and apply references toJSON(vars)', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const doc = readYaml('.github', 'workflows', file);
      const rest: Dict = { ...doc };
      delete rest['jobs'];
      if (TO_JSON_VARS.test(JSON.stringify(rest))) offenders.push(`${file}: outside the jobs`);
      for (const [id, job] of Object.entries(jobsOf(doc))) {
        if (file === 'infra.yml' && (id === 'plan' || id === 'apply')) continue;
        if (TO_JSON_VARS.test(JSON.stringify(job))) offenders.push(`${file}: job ${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('AC-10: in infra.yml plan and apply, only the Export step references toJSON(vars)', () => {
    const doc = readYaml('.github', 'workflows', 'infra.yml');
    const offenders: string[] = [];
    for (const id of ['plan', 'apply']) {
      for (const step of stepsOf(jobOf(doc, id))) {
        if (step['name'] === EXPORT_STEP) continue;
        if (TO_JSON_VARS.test(JSON.stringify(step))) offenders.push(`${id}: ${str(step['name'])}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('AC-10: no workflow sets a literal TF_VAR_ env key', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const doc = readYaml('.github', 'workflows', file);
      for (const env of envMappings(doc)) {
        for (const key of Object.keys(env)) {
          if (/^TF_VAR_/i.test(key)) offenders.push(`${file}: ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('AC-10: the env scanner finds TF_VAR_ keys at every level (self-check)', () => {
    const doc = parse(
      'env: {A: 1}\njobs:\n  j:\n    env: {tf_var_x: 1}\n    steps:\n      - env: {TF_VAR_Y: 2}\n',
    ) as unknown;
    const keys = envMappings(doc).flatMap((env) => Object.keys(env));
    expect(keys.sort()).toEqual(['A', 'TF_VAR_Y', 'tf_var_x'].sort());
  });
});
