import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

// Spec 030: contract tests over the real repository files (workflows, tool configs, tags module).

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

function loadTerraformWorkflow(): Dict {
  return readYaml('.github', 'workflows', 'terraform.yml');
}

function loadSecurityWorkflow(): Dict {
  return readYaml('.github', 'workflows', 'security.yml');
}

function loadCiWorkflow(): Dict {
  return readYaml('.github', 'workflows', 'ci.yml');
}

// ---- Section 3: terraform.yml -----------------------------------------------------------------

describe('terraform.yml: triggers and permissions', () => {
  test('AC-6: the workflow file exists', () => {
    expect(existsSync(repoPath('.github', 'workflows', 'terraform.yml'))).toBe(true);
  });

  test('AC-6: it triggers on pull_request, push and workflow_dispatch', () => {
    const on = loadTerraformWorkflow()['on'];
    expect(isDict(on)).toBe(true);
    expect(Object.keys(on as Dict).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
  });

  test('AC-6: pull_request has no paths or paths-ignore filter (the required check never pends)', () => {
    const pullRequest = (loadTerraformWorkflow()['on'] as Dict)['pull_request'];
    if (pullRequest === null || pullRequest === undefined) return;
    expect(isDict(pullRequest)).toBe(true);
    expect(Object.keys(pullRequest as Dict)).not.toContain('paths');
    expect(Object.keys(pullRequest as Dict)).not.toContain('paths-ignore');
  });

  test('AC-6: push is limited to the main branch', () => {
    const push = (loadTerraformWorkflow()['on'] as Dict)['push'];
    expect(isDict(push)).toBe(true);
    expect((push as Dict)['branches']).toEqual(['main']);
  });

  test('AC-6: push has no paths or paths-ignore filter either', () => {
    const push = (loadTerraformWorkflow()['on'] as Dict)['push'] as Dict;
    expect(Object.keys(push)).not.toContain('paths');
    expect(Object.keys(push)).not.toContain('paths-ignore');
  });

  test('AC-6: top-level permissions is an empty mapping', () => {
    expect(loadTerraformWorkflow()['permissions']).toEqual({});
  });
});

describe('terraform.yml: jobs', () => {
  test('AC-7: it has the jobs stacks, check and terraform', () => {
    expect(Object.keys(jobsOf(loadTerraformWorkflow())).sort()).toEqual([
      'check',
      'stacks',
      'terraform',
    ]);
  });

  test('AC-7: check needs stacks', () => {
    expect(stringList(jobOf(loadTerraformWorkflow(), 'check')['needs'])).toContain('stacks');
  });

  test('AC-7: check is skipped when the stack list is empty', () => {
    const condition = jobOf(loadTerraformWorkflow(), 'check')['if'];
    expect(typeof condition).toBe('string');
    expect(String(condition)).toContain('needs.stacks.outputs.stacks');
    expect(String(condition)).toContain("'[]'");
  });

  test('AC-7: check does not fail fast', () => {
    const strategy = jobOf(loadTerraformWorkflow(), 'check')['strategy'];
    expect(isDict(strategy)).toBe(true);
    expect((strategy as Dict)['fail-fast']).toBe(false);
  });

  test('AC-7: the check matrix is built with fromJSON(needs.stacks.outputs.stacks)', () => {
    const strategy = jobOf(loadTerraformWorkflow(), 'check')['strategy'] as Dict;
    const matrix = strategy['matrix'];
    expect(isDict(matrix)).toBe(true);
    expect(String((matrix as Dict)['stack'])).toMatch(
      /fromjson\(\s*needs\.stacks\.outputs\.stacks\s*\)/i,
    );
  });

  test('AC-7: the stacks job exposes its result as the job output "stacks"', () => {
    const outputs = jobOf(loadTerraformWorkflow(), 'stacks')['outputs'];
    expect(isDict(outputs)).toBe(true);
    expect(Object.keys(outputs as Dict)).toContain('stacks');
  });

  test('AC-7: the stacks job checks out the full history without persisting credentials', () => {
    const checkout = stepsOf(jobOf(loadTerraformWorkflow(), 'stacks')).find((step) =>
      String(step['uses']).startsWith('actions/checkout@'),
    );
    expect(checkout).toBeDefined();
    const withInputs = (checkout as Dict)['with'] as Dict;
    expect(withInputs['fetch-depth']).toBe(0);
    expect(withInputs['persist-credentials']).toBe(false);
  });

  /** The stacks-job steps whose command runs `guardrails tf-stacks` with the given flag. */
  function tfStacksSteps(flag: string): Dict[] {
    const doc = loadTerraformWorkflow();
    return stepsOf(jobOf(doc, 'stacks')).filter((step) =>
      commandLines(step).some(
        (line) => /\bpnpm guardrails tf-stacks\b/.test(line) && line.includes(flag),
      ),
    );
  }

  /** The step's `if` and command text: where the pull-request condition may live. */
  function conditionText(step: Dict): string {
    return `${str(step['if'])}\n${str(step['run'])}`;
  }

  test('AC-7: the stacks job runs pnpm guardrails tf-stacks --base on pull requests', () => {
    const steps = tfStacksSteps('--base');
    expect(steps.length).toBeGreaterThan(0);
    expect(conditionText(steps[0] as Dict)).toMatch(/pull_request/);
  });

  test('AC-7: the --base value comes from github.base_ref through env', () => {
    const step = tfStacksSteps('--base')[0];
    expect(step).toBeDefined();
    const run = commandLines(step as Dict).find((line) => line.includes('--base')) ?? '';
    const variable = /--base[ =]"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?/.exec(run)?.[1];
    expect(variable).toBeDefined();
    const env = (step as Dict)['env'];
    expect(isDict(env)).toBe(true);
    expect(String((env as Dict)[variable ?? ''])).toContain('github.base_ref');
  });

  test('AC-7: the stacks job runs pnpm guardrails tf-stacks --all outside pull requests', () => {
    const steps = tfStacksSteps('--all');
    expect(steps.length).toBeGreaterThan(0);
    expect(conditionText(steps[0] as Dict)).toMatch(/pull_request|event_name/);
  });
});

describe('terraform.yml: the check job steps', () => {
  /** Every command line of the check job, in order, with the step it belongs to. */
  function checkCommands(): { line: string; step: Dict }[] {
    const job = jobOf(loadTerraformWorkflow(), 'check');
    return stepsOf(job).flatMap((step) => commandLines(step).map((line) => ({ line, step })));
  }

  const matchers: [string, (line: string) => boolean][] = [
    [
      'terraform fmt -check -recursive',
      (line) =>
        /\bterraform fmt\b/.test(line) && /-check\b/.test(line) && /-recursive\b/.test(line),
    ],
    [
      'terraform init -backend=false -lockfile=readonly',
      (line) =>
        /\bterraform init\b/.test(line) &&
        /-backend=false\b/.test(line) &&
        /-lockfile=readonly\b/.test(line),
    ],
    ['terraform validate', (line) => /\bterraform validate\b/.test(line)],
    ['tflint --init', (line) => /\btflint --init\b/.test(line)],
    [
      'tflint --config .tflint.hcl',
      (line) =>
        /\btflint\b/.test(line) &&
        !/--init\b/.test(line) &&
        /--config\b/.test(line) &&
        line.includes('.tflint.hcl'),
    ],
    [
      'checkov with .checkov.yaml',
      (line) => /\bcheckov\b/.test(line) && line.includes('.checkov.yaml'),
    ],
    ['terraform test', (line) => /\bterraform test\b/.test(line)],
  ];

  function indexOfCommand(matches: (line: string) => boolean, from: number): number {
    const commands = checkCommands();
    for (let index = from; index < commands.length; index += 1) {
      if (matches((commands[index] as { line: string }).line)) return index;
    }
    return -1;
  }

  test.each(matchers.map(([label, matches]) => [label, matches] as const))(
    'AC-8: the check job runs %s',
    (_label, matches) => {
      expect(indexOfCommand(matches, 0)).toBeGreaterThanOrEqual(0);
    },
  );

  test('AC-8: the commands run in the required order', () => {
    let position = -1;
    for (const [label, matches] of matchers) {
      const found = indexOfCommand(matches, position + 1);
      expect(found, `"${label}" must come after the previous command`).toBeGreaterThan(position);
      position = found;
    }
  });

  test('AC-8: the commands run inside the stack directory (matrix.stack)', () => {
    const job = jobOf(loadTerraformWorkflow(), 'check');
    const defaults = isDict(job['defaults']) ? job['defaults']['run'] : undefined;
    const defaultDirectory = isDict(defaults) ? str(defaults['working-directory']) : '';
    for (const [label, matches] of matchers) {
      const entry = checkCommands().find(({ line }) => matches(line));
      expect(entry, `"${label}" is missing`).toBeDefined();
      const step = (entry as { step: Dict }).step;
      const env = isDict(step['env']) ? Object.values(step['env']).join(' ') : '';
      const location = [str(step['working-directory']), defaultDirectory, env].join(' ');
      expect(location, `"${label}" must run in matrix.stack`).toContain('matrix.stack');
    }
  });

  test('AC-8: tflint --init gets the workflow token as GITHUB_TOKEN', () => {
    const entry = checkCommands().find(({ line }) => /\btflint --init\b/.test(line));
    expect(entry).toBeDefined();
    const step = (entry as { step: Dict }).step;
    const job = jobOf(loadTerraformWorkflow(), 'check');
    const env: Dict = {
      ...(isDict(job['env']) ? job['env'] : {}),
      ...(isDict(step['env']) ? step['env'] : {}),
    };
    expect(String(env['GITHUB_TOKEN'])).toContain('github.token');
  });
});

describe('terraform.yml: the required "terraform" job', () => {
  test('AC-9: the job is named terraform', () => {
    expect(jobOf(loadTerraformWorkflow(), 'terraform')['name']).toBe('terraform');
  });

  test('AC-9: the job needs stacks and check', () => {
    const needs = stringList(jobOf(loadTerraformWorkflow(), 'terraform')['needs']);
    expect(needs).toContain('stacks');
    expect(needs).toContain('check');
  });

  test('AC-9: the job runs even when a needed job failed (if contains always())', () => {
    const condition = jobOf(loadTerraformWorkflow(), 'terraform')['if'];
    expect(String(condition)).toContain('always()');
  });

  test('AC-9: a step reads the needed jobs results and fails on failure or cancelled', () => {
    const job = jobOf(loadTerraformWorkflow(), 'terraform');
    const texts = stepsOf(job).map((step) =>
      [str(step['if']), str(step['run']), JSON.stringify(step['env'] ?? {})].join('\n'),
    );
    const reading = texts.find((text) => /needs\.(\*|[A-Za-z0-9_-]+)\.result/.test(text));
    expect(reading, 'no step reads needs.*.result').toBeDefined();
    expect(reading).toContain('failure');
    expect(reading).toContain('cancelled');
  });
});

describe('terraform.yml: least privilege', () => {
  test('AC-10: no job grants anything but contents: read', () => {
    const jobs = Object.entries(jobsOf(loadTerraformWorkflow()));
    expect(jobs.length).toBeGreaterThan(0);
    for (const [id, job] of jobs) {
      const permissions = (job as Dict)['permissions'];
      expect(isDict(permissions), `job ${id} needs a permissions mapping`).toBe(true);
      for (const [scope, level] of Object.entries(permissions as Dict)) {
        expect(`${scope}: ${String(level)}`, `job ${id}`).toBe('contents: read');
      }
    }
  });

  test('AC-10: no job requests id-token', () => {
    expect(readRepoFile('.github', 'workflows', 'terraform.yml')).not.toContain('id-token');
  });

  test('AC-10: the workflow references no secrets.*', () => {
    expect(withoutComments(readRepoFile('.github', 'workflows', 'terraform.yml'))).not.toMatch(
      /secrets\./,
    );
  });

  test('AC-10: every job has a timeout and the workflow has top-level concurrency', () => {
    const doc = loadTerraformWorkflow();
    expect(doc['concurrency']).toBeDefined();
    for (const [id, job] of Object.entries(jobsOf(doc))) {
      expect(typeof (job as Dict)['timeout-minutes'], `job ${id}`).toBe('number');
    }
  });
});

describe('terraform.yml: pinned tools', () => {
  test('AC-11: .terraform-version is one line with an exact version', () => {
    expect(readRepoFile('.terraform-version')).toMatch(/^\d+\.\d+\.\d+\r?\n?$/);
  });

  test('AC-11: .terraform-version is 1.14.9', () => {
    expect(readRepoFile('.terraform-version').trim()).toBe('1.14.9');
  });

  test('AC-11: terraform.yml references .terraform-version', () => {
    expect(readRepoFile('.github', 'workflows', 'terraform.yml')).toContain('.terraform-version');
  });

  test('AC-11: hashicorp/setup-terraform gets its version from an expression, not a literal', () => {
    const job = jobOf(loadTerraformWorkflow(), 'check');
    const step = stepsOf(job).find((candidate) =>
      String(candidate['uses']).startsWith('hashicorp/setup-terraform@'),
    );
    expect(step, 'the check job must use hashicorp/setup-terraform').toBeDefined();
    const inputs = (step as Dict)['with'];
    expect(isDict(inputs)).toBe(true);
    expect(String((inputs as Dict)['terraform_version'])).toMatch(/\$\{\{.+\}\}/);
  });

  test('AC-11: the workflow never uses "latest" for a tool', () => {
    const text = withoutComments(readRepoFile('.github', 'workflows', 'terraform.yml'));
    expect(text.replace(/ubuntu-latest/g, '')).not.toMatch(/latest/i);
  });

  test('AC-11: tflint is pinned to an exact vX.Y.Z', () => {
    const text = withoutComments(readRepoFile('.github', 'workflows', 'terraform.yml'));
    expect(text).toMatch(/tflint[\s\S]{0,300}?\bv\d+\.\d+\.\d+\b/i);
  });

  test('AC-11: checkov is installed as checkov==X.Y.Z', () => {
    const text = withoutComments(readRepoFile('.github', 'workflows', 'terraform.yml'));
    expect(text).toMatch(/\bcheckov==\d+\.\d+\.\d+\b/);
  });
});

// ---- Section 4: repo-root Terraform config ----------------------------------------------------

/** A named HCL block body, e.g. `plugin "aws" { ... }` (no nested braces), comments removed. */
function hclBlock(text: string, type: string, label: string): string | undefined {
  const clean = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*(#|\/\/).*$/, ''))
    .join('\n');
  const pattern = new RegExp(`${type}\\s+"${label}"\\s*\\{([^}]*)\\}`);
  return pattern.exec(clean)?.[1];
}

describe('.tflint.hcl and .checkov.yaml', () => {
  test('AC-12: .tflint.hcl enables the terraform plugin with the recommended preset', () => {
    const body = hclBlock(readRepoFile('.tflint.hcl'), 'plugin', 'terraform');
    expect(body, 'no plugin "terraform" block').toBeDefined();
    expect(body).toMatch(/\bpreset\s*=\s*"recommended"/);
    expect(body).not.toMatch(/\benabled\s*=\s*false\b/);
  });

  test('AC-12: .tflint.hcl enables the aws plugin', () => {
    const body = hclBlock(readRepoFile('.tflint.hcl'), 'plugin', 'aws');
    expect(body, 'no plugin "aws" block').toBeDefined();
    expect(body).toMatch(/\benabled\s*=\s*true\b/);
  });

  test('AC-12: the aws plugin comes from terraform-linters/tflint-ruleset-aws', () => {
    const body = hclBlock(readRepoFile('.tflint.hcl'), 'plugin', 'aws');
    expect(body).toMatch(/\bsource\s*=\s*"github\.com\/terraform-linters\/tflint-ruleset-aws"/);
  });

  test('AC-12: the aws plugin is pinned to an exact version', () => {
    const body = hclBlock(readRepoFile('.tflint.hcl'), 'plugin', 'aws');
    expect(body).toMatch(/\bversion\s*=\s*"\d+\.\d+\.\d+"/);
  });

  test('AC-12: .checkov.yaml parses as YAML and its framework contains terraform', () => {
    const config = readYaml('.checkov.yaml');
    expect(stringList(config['framework'])).toContain('terraform');
  });

  test('AC-12: .checkov.yaml has no global skip-check', () => {
    const config = readYaml('.checkov.yaml');
    expect(Object.keys(config)).not.toContain('skip-check');
    expect(Object.keys(config)).not.toContain('skip_check');
  });

  test('AC-12: .checkov.yaml is compact and quiet', () => {
    const config = readYaml('.checkov.yaml');
    expect(config['compact']).toBe(true);
    expect(config['quiet']).toBe(true);
  });

  test('AC-12: .checkov.yaml skips .terraform directories', () => {
    const config = readYaml('.checkov.yaml');
    const skipped = [...stringList(config['skip-path']), ...stringList(config['skip-dir'])];
    expect(skipped.some((entry) => entry.includes('.terraform'))).toBe(true);
  });
});

// ---- Section 5: zizmor ------------------------------------------------------------------------

describe('security.yml: the zizmor job', () => {
  const zizmor = (): Dict => jobOf(loadSecurityWorkflow(), 'zizmor');

  test('AC-13: security.yml has a job zizmor named zizmor', () => {
    expect(zizmor()['name']).toBe('zizmor');
  });

  test('AC-13: the job has exactly contents: read permissions', () => {
    expect(zizmor()['permissions']).toEqual({ contents: 'read' });
  });

  test('AC-13: the checkout does not persist credentials', () => {
    const checkout = stepsOf(zizmor()).find((step) =>
      String(step['uses']).startsWith('actions/checkout@'),
    );
    expect(checkout, 'the zizmor job needs a checkout step').toBeDefined();
    expect(((checkout as Dict)['with'] as Dict | undefined)?.['persist-credentials']).toBe(false);
  });

  test('AC-13: zizmor is pinned to an exact version and scans .github/workflows offline', () => {
    const steps = stepsOf(zizmor());
    const action = steps.find((step) =>
      String(step['uses']).startsWith('zizmorcore/zizmor-action@'),
    );
    if (action !== undefined) {
      expect(String(action['uses'])).toMatch(/@[0-9a-f]{40}$/);
      expect(String((action['with'] as Dict | undefined)?.['version'])).toMatch(
        /^v?\d+\.\d+\.\d+$/,
      );
      return;
    }
    const lines = steps.flatMap(commandLines);
    const command = lines.find((line) => /\bzizmor\b/.test(line) && line.includes('--offline'));
    expect(command, 'no step runs zizmor with --offline').toBeDefined();
    expect(command).toContain('.github/workflows');
    expect(lines.join('\n')).toMatch(/\bzizmor(==|@)\d+\.\d+\.\d+\b/);
  });

  test('AC-13: zizmor findings fail the job (nothing swallows the exit code)', () => {
    const job = zizmor();
    expect(job['continue-on-error']).not.toBe(true);
    for (const step of stepsOf(job)) {
      expect(step['continue-on-error']).not.toBe(true);
      for (const line of commandLines(step)) {
        expect(line).not.toMatch(/\|\|\s*(true|:)\b/);
        expect(line).not.toContain('--no-exit-codes');
      }
    }
  });
});

// ---- Section 6: per-job permissions in ci.yml and security.yml --------------------------------

describe('ci.yml and security.yml: per-job permissions', () => {
  test('AC-15: ci.yml verify and e2e grant contents: read', () => {
    const ci = loadCiWorkflow();
    expect(jobOf(ci, 'verify')['permissions']).toEqual({ contents: 'read' });
    expect(jobOf(ci, 'e2e')['permissions']).toEqual({ contents: 'read' });
  });

  test('AC-15: security.yml codeql grants exactly actions, contents and security-events', () => {
    expect(jobOf(loadSecurityWorkflow(), 'codeql')['permissions']).toEqual({
      actions: 'read',
      contents: 'read',
      'security-events': 'write',
    });
  });

  test('AC-15: security.yml gitleaks grants exactly contents and pull-requests read', () => {
    expect(jobOf(loadSecurityWorkflow(), 'gitleaks')['permissions']).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
  });

  test('AC-15: security.yml dependency-review grants contents: read', () => {
    expect(jobOf(loadSecurityWorkflow(), 'dependency-review')['permissions']).toEqual({
      contents: 'read',
    });
  });

  test('AC-15: the jobs still exist with their names and steps', () => {
    const ci = loadCiWorkflow();
    const security = loadSecurityWorkflow();
    for (const id of ['verify', 'e2e']) expect(stepsOf(jobOf(ci, id)).length).toBeGreaterThan(0);
    for (const id of ['gitleaks', 'codeql', 'dependency-review']) {
      expect(stepsOf(jobOf(security, id)).length).toBeGreaterThan(0);
    }
  });
});

// ---- Section 7: .gitignore --------------------------------------------------------------------

describe('.gitignore: Terraform local files', () => {
  const lines = (): string[] =>
    readRepoFile('.gitignore')
      .split(/\r?\n/)
      .map((line) => line.trim());

  test.each(['*.tfvars', '*.tfvars.json', '.terraform/', '*.tfplan'])(
    'AC-17: .gitignore contains the line %s',
    (pattern) => {
      expect(lines()).toContain(pattern);
    },
  );
});

// ---- Section 8: modules/tags ------------------------------------------------------------------

describe('modules/tags: files and shape', () => {
  const MODULE_DIR = repoPath('modules', 'tags');

  function moduleTfFiles(): string[] {
    if (!existsSync(MODULE_DIR)) throw new Error('modules/tags does not exist');
    return readdirSync(MODULE_DIR)
      .filter((file) => file.endsWith('.tf'))
      .sort();
  }

  function moduleHcl(): string {
    const files = moduleTfFiles();
    // An empty module would satisfy every "declares no ..." assertion by accident.
    if (files.length === 0) throw new Error('modules/tags has no *.tf files');
    return files
      .map((file) => withoutComments(readFileSync(join(MODULE_DIR, file), 'utf8')))
      .join('\n');
  }

  test('AC-21: the module has versions.tf, variables.tf and outputs.tf', () => {
    expect(moduleTfFiles()).toEqual(
      expect.arrayContaining(['outputs.tf', 'variables.tf', 'versions.tf']),
    );
  });

  test('AC-21: the module declares no resource block', () => {
    expect(moduleHcl()).not.toMatch(/^\s*resource\s+"/m);
  });

  test('AC-21: the module declares no data block', () => {
    expect(moduleHcl()).not.toMatch(/^\s*data\s+"/m);
  });

  test('AC-21: the module declares no provider block', () => {
    expect(moduleHcl()).not.toMatch(/^\s*provider\s+"/m);
  });

  test('AC-21: the module declares no required_providers', () => {
    expect(moduleHcl()).not.toContain('required_providers');
  });

  test('AC-21: the module declares required_version', () => {
    expect(moduleHcl()).toMatch(/\brequired_version\s*=\s*"[^"]+"/);
  });

  test('AC-21: README.md exists', () => {
    expect(existsSync(repoPath('modules', 'tags', 'README.md'))).toBe(true);
  });

  test('AC-21: tests/tags.tftest.hcl exists', () => {
    expect(existsSync(repoPath('modules', 'tags', 'tests', 'tags.tftest.hcl'))).toBe(true);
  });
});

// ---- Section 4: CONTRIBUTING.md ---------------------------------------------------------------

describe('CONTRIBUTING.md: the Terraform section', () => {
  test('AC-22: CONTRIBUTING.md has a "Terraform" heading', () => {
    expect(readRepoFile('CONTRIBUTING.md')).toMatch(/^#{1,6}\s+Terraform\b/m);
  });

  test('AC-22: the Terraform section names the provider lock command for both platforms', () => {
    expect(readRepoFile('CONTRIBUTING.md')).toContain(
      'terraform providers lock -platform=linux_amd64 -platform=windows_amd64',
    );
  });
});
