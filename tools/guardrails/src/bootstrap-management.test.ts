import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Spec 031 (AC-15, AC-16, AC-17): contract tests over the real files of bootstrap/management.
// The behaviour of the stack itself is covered by `terraform test` (bootstrap/management/tests).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const STACK = 'bootstrap/management';

function stackPath(...segments: string[]): string {
  return join(REPO_ROOT, ...STACK.split('/'), ...segments);
}

/** Reads a file of the stack; a missing file fails the test with a readable message. */
function readStackFile(name: string): string {
  const path = stackPath(name);
  if (!existsSync(path)) throw new Error(`missing file: ${STACK}/${name}`);
  return readFileSync(path, 'utf8');
}

// ---- A small HCL reader: enough to find blocks and attributes, not a parser ---------------------

/** Index just after the string that opens at `start` (a double quote), skipping `${...}`. */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '\\') {
      i += 2;
    } else if (c === '"') {
      return i + 1;
    } else if (c === '$' && text.charAt(i + 1) === '{') {
      i = skipInterpolation(text, i + 2);
    } else {
      i += 1;
    }
  }
  return i;
}

/** Index just after the `}` that closes an interpolation whose body starts at `start`. */
function skipInterpolation(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text.charAt(i);
    if (c === '"') {
      i = skipString(text, i);
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') depth -= 1;
    i += 1;
  }
  return i;
}

/** The HCL text without `#`, `//` and block comments (strings are kept as they are). */
function stripHclComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    const two = text.slice(i, i + 2);
    if (c === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '#' || two === '//') {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Index just after the `}` that closes the block whose `{` is at `open`. */
function closeBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      i = skipString(text, i);
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/** Bodies (text between the braces) of every block whose header matches; `header` ends at `{`. */
function blockBodies(text: string, header: RegExp): string[] {
  const flags = header.flags.includes('g') ? header.flags : `${header.flags}g`;
  const bodies: string[] = [];
  for (const match of text.matchAll(new RegExp(header.source, flags))) {
    const open = match.index + match[0].length - 1;
    bodies.push(text.slice(open + 1, closeBrace(text, open) - 1));
  }
  return bodies;
}

function hasAttribute(body: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\s*=`, 'm').test(body);
}

/** Every `.tf` file of the stack (top level), comments removed. */
function loadTerraformFiles(): { name: string; text: string }[] {
  const dir = stackPath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tf'))
    .sort()
    .map((name) => ({ name, text: stripHclComments(readFileSync(join(dir, name), 'utf8')) }));
}

function allTerraform(): string {
  return loadTerraformFiles()
    .map((file) => file.text)
    .join('\n');
}

function resourceHeader(type: string, name: string): RegExp {
  return new RegExp(`\\bresource\\s+"${type}"\\s+"${name}"\\s*\\{`);
}

function resourceBodies(type: string, name: string): string[] {
  const bodies = blockBodies(allTerraform(), resourceHeader(type, name));
  if (bodies.length !== 1) {
    throw new Error(
      `expected one resource "${type}" "${name}" in ${STACK}/*.tf, found ${bodies.length}`,
    );
  }
  return bodies;
}

function resourceBody(type: string, name: string): string {
  return resourceBodies(type, name)[0] ?? '';
}

// ---- AC-15: Terraform contract -------------------------------------------------------------------

describe('AC-15: backend, lifecycle, provider and policy contract', () => {
  test('AC-15: the s3 backend block keeps the state key, a lockfile and encryption', () => {
    const bodies = blockBodies(allTerraform(), /\bbackend\s+"s3"\s*\{/);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(body).toMatch(/^\s*key\s*=\s*"bootstrap\/management\.tfstate"\s*$/m);
    expect(body).toMatch(/^\s*use_lockfile\s*=\s*true\s*$/m);
    expect(body).toMatch(/^\s*encrypt\s*=\s*true\s*$/m);
  });

  test.each(['bucket', 'dynamodb_table', 'profile'])(
    'AC-15: the s3 backend block has no %s (given at init, never committed)',
    (attribute) => {
      const bodies = blockBodies(allTerraform(), /\bbackend\s+"s3"\s*\{/);
      expect(bodies).toHaveLength(1);
      expect(hasAttribute(bodies[0] ?? '', attribute)).toBe(false);
    },
  );

  test('AC-15: the state bucket resource has prevent_destroy = true', () => {
    const lifecycles = blockBodies(resourceBody('aws_s3_bucket', 'state'), /\blifecycle\s*\{/);
    expect(lifecycles.some((body) => /^\s*prevent_destroy\s*=\s*true\s*$/m.test(body))).toBe(true);
  });

  test('AC-15: the organization resource has prevent_destroy = true', () => {
    const lifecycles = blockBodies(
      resourceBody('aws_organizations_organization', 'this'),
      /\blifecycle\s*\{/,
    );
    expect(lifecycles.some((body) => /^\s*prevent_destroy\s*=\s*true\s*$/m.test(body))).toBe(true);
  });

  test('AC-15: the aws provider block sets default_tags from module.tags.tags', () => {
    const providers = blockBodies(allTerraform(), /\bprovider\s+"aws"\s*\{/);
    expect(providers).toHaveLength(1);
    const defaultTags = blockBodies(providers[0] ?? '', /\bdefault_tags\s*\{/);
    expect(defaultTags).toHaveLength(1);
    expect(defaultTags[0]).toMatch(/^\s*tags\s*=\s*module\.tags\.tags\s*$/m);
  });

  test.each(['profile', 'access_key', 'secret_key', 'assume_role'])(
    'AC-15: the aws provider block has no %s',
    (name) => {
      const providers = blockBodies(allTerraform(), /\bprovider\s+"aws"\s*\{/);
      expect(providers).toHaveLength(1);
      expect(providers[0] ?? '').not.toMatch(new RegExp(`^\\s*${name}\\w*\\s*(=|\\{)`, 'm'));
    },
  );

  test('AC-15: no .tf file declares data "aws_iam_policy_document"', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(/\bdata\s+"aws_iam_policy_document"/);
    }
  });

  test.each([
    ['aws_s3_bucket_policy', 'state', 'policy'],
    ['aws_s3_bucket_policy', 'trail_logs', 'policy'],
    ['aws_organizations_policy', 'guardrails', 'content'],
  ])('AC-15: %s.%s builds its %s with jsonencode (plan-time known)', (type, name, attribute) => {
    const body = resourceBody(type, name);
    expect(body).toMatch(new RegExp(`^\\s*${attribute}\\s*=\\s*jsonencode\\s*\\(`, 'm'));
  });
});

// ---- AC-16: no identifiers committed, example tfvars and lock file -------------------------------

/** Account-like numbers: 12 digits that are not one digit repeated (test fixtures are fine). */
function findAccountIds(text: string): string[] {
  const found = text.match(/(?<!\w)\d{12}(?!\w)/g) ?? [];
  return found.filter((digits) => !/^(\d)\1{11}$/.test(digits));
}

/** Email addresses whose domain is not example.com. */
function findForeignEmails(text: string): string[] {
  const found = [...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)];
  return found.filter((m) => (m[1] ?? '').toLowerCase() !== 'example.com').map((m) => m[0]);
}

/** Files of the stack in git's view: tracked, plus new files that are not git-ignored. */
function listStackFiles(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', `${STACK}/`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .filter((line) => existsSync(join(REPO_ROOT, line)));
}

describe('AC-16: the detectors work (self-check)', () => {
  const twelve = '1234'.repeat(3);

  test('AC-16: a 12-digit number is found, a repeated digit and 11 or 13 digits are not', () => {
    expect(findAccountIds(`arn:aws:iam::${twelve}:root`)).toEqual([twelve]);
    expect(findAccountIds(`x-${twelve}`)).toEqual([twelve]);
    expect(findAccountIds('7'.repeat(12))).toEqual([]);
    expect(findAccountIds('1234'.repeat(2) + '123')).toEqual([]);
    expect(findAccountIds(`${twelve}5`)).toEqual([]);
    expect(findAccountIds(`zh:${twelve}abcdef`)).toEqual([]);
  });

  test('AC-16: an email address is found unless its domain is example.com', () => {
    const user = ['someone', 'corp.test'].join('@');
    expect(findForeignEmails(`mail ${user} now`)).toEqual([user]);
    expect(findForeignEmails('alerts@example.com you@EXAMPLE.com')).toEqual([]);
    expect(findForeignEmails('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')).toEqual([]);
  });
});

describe('AC-16: no identifiers in tracked files, example tfvars, lock file', () => {
  test('AC-16: the stack has files to check', () => {
    expect(listStackFiles().length).toBeGreaterThan(0);
  });

  test('AC-16: no tracked file has a 12-digit number other than a repeated digit', () => {
    const offenders = listStackFiles().flatMap((file) =>
      findAccountIds(readFileSync(join(REPO_ROOT, file), 'utf8')).map((id) => `${file}: ${id}`),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-16: no tracked file has an email address outside example.com', () => {
    const offenders = listStackFiles().flatMap((file) =>
      findForeignEmails(readFileSync(join(REPO_ROOT, file), 'utf8')).map((m) => `${file}: ${m}`),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-16: terraform.tfvars.example sets alert_email to an example.com address', () => {
    expect(readStackFile('terraform.tfvars.example')).toMatch(
      /^\s*alert_email\s*=\s*"[^"@\s]+@example\.com"\s*$/m,
    );
  });

  test('AC-16: .terraform.lock.hcl pins registry.terraform.io/hashicorp/aws', () => {
    expect(readStackFile('.terraform.lock.hcl')).toMatch(
      /^provider\s+"registry\.terraform\.io\/hashicorp\/aws"\s*\{/m,
    );
  });
});

// ---- AC-17: README --------------------------------------------------------------------------------

/** The section under a `## <title>` heading, up to the next `## ` heading or the end. */
function readmeSection(readme: string, title: string): string | undefined {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${title}\\s*$`).test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('AC-17: README documents the first apply, cost and destroy', () => {
  test('AC-17: the README explains the state migration with -migrate-state', () => {
    expect(readStackFile('README.md')).toContain('-migrate-state');
  });

  test('AC-17: the README mentions backend_override.tf', () => {
    expect(readStackFile('README.md')).toContain('backend_override.tf');
  });

  test.each([
    'aws_organizations_organization.this',
    'aws_ce_anomaly_monitor.services',
    'aws_ce_anomaly_subscription.impact_5usd',
  ])('AC-17: the README has a terraform import command for %s', (address) => {
    const escaped = address.replace('.', '\\.');
    const importCommand = new RegExp(`terraform\\s+import\\s+(?:-\\S+\\s+)*['"]?${escaped}\\b`);
    expect(readStackFile('README.md')).toMatch(importCommand);
  });

  test('AC-17: the README has no terraform import command for aws_budgets_budget (it is created)', () => {
    const budgetImport = /terraform\s+import\s+(?:-\S+\s+)*['"]?aws_budgets_budget\b/;
    expect(readStackFile('README.md')).not.toMatch(budgetImport);
  });

  test('AC-17: the terraform import commands are for exactly the organization, monitor and subscription', () => {
    const imported = [
      ...readStackFile('README.md').matchAll(
        /terraform\s+import\s+(?:-\S+\s+)*['"]?([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\b/g,
      ),
    ].map((match) => match[1] ?? '');
    expect([...new Set(imported)].sort()).toEqual([
      'aws_ce_anomaly_monitor.services',
      'aws_ce_anomaly_subscription.impact_5usd',
      'aws_organizations_organization.this',
    ]);
  });

  test('AC-17: the README has a "## Cost" heading', () => {
    expect(readmeSection(readStackFile('README.md'), 'Cost')).toBeDefined();
  });

  test('AC-17: the README has a "## Destroy" heading', () => {
    expect(readmeSection(readStackFile('README.md'), 'Destroy')).toBeDefined();
  });

  test('AC-17: the Destroy section says to terraform state rm the organization first', () => {
    const destroy = readmeSection(readStackFile('README.md'), 'Destroy');
    expect(destroy).toBeDefined();
    expect(destroy).toContain('terraform state rm aws_organizations_organization.this');
  });
});
