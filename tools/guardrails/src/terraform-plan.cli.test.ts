import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { planDigest, planSummary } from './terraform-plan.ts';

// Spec 033, section 3: the plan CLI runs with plain Node (no tsx, no pnpm install). Every test
// spawns a real process.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CLI_RELATIVE = 'tools/guardrails/src/terraform-plan-cli.ts';

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the entry exactly as the workflow does: node --experimental-strip-types, from the root. */
function runCli(args: string[]): Run {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', CLI_RELATIVE, ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'terraform-plan-cli-'));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const createPlan = {
  format_version: '1.2',
  terraform_version: '1.14.9',
  resource_changes: [
    {
      address: 'terraform_data.smoke',
      mode: 'managed',
      type: 'terraform_data',
      name: 'smoke',
      change: {
        actions: ['create'],
        before: null,
        after: { input: 'x' },
        after_unknown: { output: true },
        before_sensitive: false,
        after_sensitive: {},
      },
    },
  ],
};
const emptyPlan = { format_version: '1.2', terraform_version: '1.14.9', resource_changes: [] };

describe('terraform-plan-cli: commands', () => {
  test('AC-20: digest <plan.json> prints the digest and a newline, exit 0', () => {
    const file = tempFile('plan.json', JSON.stringify(createPlan));
    const run = runCli(['digest', file]);
    expect(run.stdout).toBe(`${planDigest(createPlan)}\n`);
    expect(run.status).toBe(0);
  });

  test('AC-20: the digest of an empty change set is the known constant', () => {
    const file = tempFile('plan.json', JSON.stringify(emptyPlan));
    const run = runCli(['digest', file]);
    expect(run.stdout).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\n');
    expect(run.status).toBe(0);
  });

  test('AC-20: changed prints false for an empty change set', () => {
    const file = tempFile('plan.json', JSON.stringify(emptyPlan));
    const run = runCli(['changed', file]);
    expect(run.stdout).toBe('false\n');
    expect(run.status).toBe(0);
  });

  test('AC-20: changed prints true otherwise', () => {
    const file = tempFile('plan.json', JSON.stringify(createPlan));
    const run = runCli(['changed', file]);
    expect(run.stdout).toBe('true\n');
    expect(run.status).toBe(0);
  });

  test('AC-20: summary <plan.json> <stack> prints the summary', () => {
    const file = tempFile('plan.json', JSON.stringify(createPlan));
    const run = runCli(['summary', file, 'labs/00-x']);
    expect(run.stdout).toBe(planSummary(createPlan, 'labs/00-x'));
    expect(run.stdout).toContain('| create | <code>terraform_data.smoke</code> |');
    expect(run.status).toBe(0);
  });

  test('AC-20: a pretty-printed plan file (as terraform show writes it) works too', () => {
    const file = tempFile('plan.json', `${JSON.stringify(createPlan, null, 2)}\n`);
    const run = runCli(['digest', file]);
    expect(run.stdout).toBe(`${planDigest(createPlan)}\n`);
    expect(run.status).toBe(0);
  });
});

describe('terraform-plan-cli: failures', () => {
  /** A precondition that makes sure the entry works at all before testing a failure. */
  function expectWorks(): void {
    const file = tempFile('ok.json', JSON.stringify(emptyPlan));
    expect(runCli(['changed', file]).status).toBe(0);
  }

  function expectReadFailure(run: Run, mention?: string): void {
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toBe('');
    // A message for the user, not a crash with a stack trace.
    expect(run.stderr).not.toMatch(/^\s+at /m);
    if (mention !== undefined) expect(run.stderr).toContain(mention);
  }

  function expectUsageError(run: Run): void {
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toBe('');
  }

  test('AC-20: a missing file exits 1 with a message naming it, nothing on stdout', () => {
    expectWorks();
    expectReadFailure(
      runCli(['digest', join(tmpdir(), 'no-such-plan-file.json')]),
      'no-such-plan-file',
    );
  });

  test('AC-20: invalid JSON exits 1 with a message, nothing on stdout', () => {
    expectWorks();
    expectReadFailure(runCli(['digest', tempFile('plan.json', '{ not json')]));
  });

  test('AC-20: valid JSON that is not a plan exits 1', () => {
    expectWorks();
    expectReadFailure(runCli(['changed', tempFile('plan.json', '{}')]));
  });

  test('AC-20: an errored plan exits 1 and says so', () => {
    expectWorks();
    const errored = tempFile('plan.json', JSON.stringify({ format_version: '1.2', errored: true }));
    expectReadFailure(runCli(['summary', errored, 'labs/00-x']), 'errored');
  });

  test('AC-20: no command exits 2 with usage on stderr', () => {
    expectWorks();
    expectUsageError(runCli([]));
  });

  test('AC-20: an unknown command exits 2', () => {
    expectWorks();
    expectUsageError(runCli(['frobnicate', 'plan.json']));
  });

  test('AC-20: digest without a file exits 2', () => {
    expectWorks();
    expectUsageError(runCli(['digest']));
  });

  test('AC-20: changed without a file exits 2', () => {
    expectWorks();
    expectUsageError(runCli(['changed']));
  });

  test('AC-20: summary without a stack exits 2', () => {
    expectWorks();
    const file = tempFile('plan.json', JSON.stringify(createPlan));
    expectUsageError(runCli(['summary', file]));
  });
});

// ---- AC-21: plain Node ---------------------------------------------------------------------------

describe('terraform-plan.ts and terraform-plan-cli.ts: plain Node contract', () => {
  function source(name: string): string {
    return readFileSync(join(HERE, name), 'utf8');
  }

  /** Every module specifier the file imports: static, `export ... from`, dynamic and require. */
  function specifiers(text: string): string[] {
    const found: string[] = [];
    const patterns = [
      /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\bexport\s+(?:[^'";]*?\s+)?from\s+['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) found.push(match[1] as string);
    }
    return found;
  }

  /** The code without line and block comments. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  }

  test('AC-21: terraform-plan.ts imports node: modules only (crypto for the SHA-256)', () => {
    const found = specifiers(code(source('terraform-plan.ts')));
    expect(found).toContain('node:crypto');
    for (const specifier of found) expect(specifier, specifier).toMatch(/^node:/);
  });

  test('AC-21: terraform-plan-cli.ts imports node: modules and ./terraform-plan.ts only', () => {
    const found = specifiers(code(source('terraform-plan-cli.ts')));
    expect(found).toContain('./terraform-plan.ts');
    for (const specifier of found) {
      expect(specifier === './terraform-plan.ts' || specifier.startsWith('node:'), specifier).toBe(
        true,
      );
    }
  });

  test.each(['terraform-plan.ts', 'terraform-plan-cli.ts'])(
    'AC-21: %s uses only erasable TypeScript syntax',
    (name) => {
      const text = code(source(name));
      expect(text).not.toMatch(/\benum\s+\w+/);
      expect(text).not.toMatch(/\bnamespace\s+\w+/);
      expect(text).not.toMatch(/\bconstructor\s*\([^)]*\b(public|private|protected|readonly)\b/);
      expect(text).not.toMatch(/^\s*import\s+\w+\s*=\s*require/m);
    },
  );
});
