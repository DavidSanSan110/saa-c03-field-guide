import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Spec 032 (AC-25, AC-26, AC-27, plus the static half of AC-2): contract tests over the real files of
// bootstrap/workload. The behaviour of the stack itself is covered by `terraform test`
// (bootstrap/workload/tests).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const STACK = 'bootstrap/workload';
const ALLOWED_SUB_PREFIX = 'repo:example-owner@1000/example-repo@2000';

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

/** Every `.tf` file of the stack (top level, git-ignored `*_override.tf` excluded), comments removed. */
function loadTerraformFiles(): { name: string; text: string }[] {
  const dir = stackPath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tf') && !name.endsWith('_override.tf'))
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

function resourceBody(type: string, name: string): string {
  const bodies = blockBodies(allTerraform(), resourceHeader(type, name));
  if (bodies.length !== 1) {
    throw new Error(
      `expected one resource "${type}" "${name}" in ${STACK}/*.tf, found ${bodies.length}`,
    );
  }
  return bodies[0] ?? '';
}

function hasPreventDestroy(resource: string): boolean {
  const lifecycles = blockBodies(resource, /\blifecycle\s*\{/);
  return lifecycles.some((body) => /^\s*prevent_destroy\s*=\s*true\s*$/m.test(body));
}

// ---- AC-25: Terraform contract -------------------------------------------------------------------

describe('AC-25: backend, lifecycle, provider and policy contract', () => {
  test('AC-25: the s3 backend block keeps the state key, region, a lockfile and encryption', () => {
    const bodies = blockBodies(allTerraform(), /\bbackend\s+"s3"\s*\{/);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(body).toMatch(/^\s*key\s*=\s*"bootstrap\/workload\.tfstate"\s*$/m);
    expect(body).toMatch(/^\s*region\s*=\s*"eu-west-1"\s*$/m);
    expect(body).toMatch(/^\s*use_lockfile\s*=\s*true\s*$/m);
    expect(body).toMatch(/^\s*encrypt\s*=\s*true\s*$/m);
  });

  test.each(['bucket', 'dynamodb_table', 'profile'])(
    'AC-25: the s3 backend block has no %s (given at init, never committed)',
    (attribute) => {
      const bodies = blockBodies(allTerraform(), /\bbackend\s+"s3"\s*\{/);
      expect(bodies).toHaveLength(1);
      expect(hasAttribute(bodies[0] ?? '', attribute)).toBe(false);
    },
  );

  test('AC-25: the state bucket resource has prevent_destroy = true', () => {
    expect(hasPreventDestroy(resourceBody('aws_s3_bucket', 'state'))).toBe(true);
  });

  test('AC-25: the hosted zone resource has prevent_destroy = true', () => {
    expect(hasPreventDestroy(resourceBody('aws_route53_zone', 'site'))).toBe(true);
  });

  test('AC-25: the aws provider block sets default_tags from module.tags.tags', () => {
    const providers = blockBodies(allTerraform(), /\bprovider\s+"aws"\s*\{/);
    expect(providers).toHaveLength(1);
    const defaultTags = blockBodies(providers[0] ?? '', /\bdefault_tags\s*\{/);
    expect(defaultTags).toHaveLength(1);
    expect(defaultTags[0]).toMatch(/^\s*tags\s*=\s*module\.tags\.tags\s*$/m);
  });

  test.each(['profile', 'access_key', 'secret_key', 'assume_role'])(
    'AC-25: the aws provider block has no %s',
    (name) => {
      const providers = blockBodies(allTerraform(), /\bprovider\s+"aws"\s*\{/);
      expect(providers).toHaveLength(1);
      expect(providers[0] ?? '').not.toMatch(new RegExp(`^\\s*${name}\\w*\\s*(=|\\{)`, 'm'));
    },
  );

  test('AC-25: no .tf file declares data "aws_iam_policy_document"', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(/\bdata\s+"aws_iam_policy_document"/);
    }
  });

  test('AC-25: required_providers pins the aws provider to version "6.67.0"', () => {
    const bodies = blockBodies(allTerraform(), /\brequired_providers\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*version\s*=\s*"6\.67\.0"\s*$/m);
  });

  test('AC-25: ci_roles.tf exists and never uses StringLike in a trust policy', () => {
    const file = loadTerraformFiles().find((f) => f.name === 'ci_roles.tf');
    expect(file, `missing file: ${STACK}/ci_roles.tf`).toBeDefined();
    expect(file?.text ?? '').not.toContain('StringLike');
  });
});

// ---- AC-2 (static half): the lifecycle rule covers the whole bucket -------------------------------

describe('AC-2: the state bucket lifecycle rule applies to the whole bucket (static check)', () => {
  // filter.prefix is unknown at plan time when the filter is empty, so terraform test cannot see it.
  test('AC-2: the lifecycle rule has no filter, or an empty one, and no prefix', () => {
    const body = resourceBody('aws_s3_bucket_lifecycle_configuration', 'state');
    expect(body).not.toMatch(/^\s*prefix\s*=\s*(?!"")\S/m);
    for (const filter of blockBodies(body, /\bfilter\s*\{/)) {
      const rest = filter.replace(/^\s*prefix\s*=\s*""\s*$/gm, '').trim();
      expect(rest, 'a lifecycle filter must be empty').toBe('');
    }
  });
});

// ---- AC-26: no identifiers committed, example tfvars and lock file -------------------------------

/** Account-like numbers: 12 digits that are not one digit repeated (test fixtures are fine). */
function findAccountIds(text: string): string[] {
  const found = text.match(/(?<!\w)\d{12}(?!\w)/g) ?? [];
  return found.filter((digits) => !/^(\d)\1{11}$/.test(digits));
}

/** Email addresses whose domain isn't example.com. */
function findForeignEmails(text: string): string[] {
  const found = [...text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)];
  return found.filter((m) => (m[1] ?? '').toLowerCase() !== 'example.com').map((m) => m[0]);
}

/** GitHub subject prefixes with numeric IDs (`repo:<owner>@<id>/...@<id>`) other than the fixture. */
function findSubPrefixes(text: string): string[] {
  const found = text.match(/repo:[^"\s]*@[0-9]+/g) ?? [];
  return found.filter((prefix) => prefix !== ALLOWED_SUB_PREFIX);
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

describe('AC-26: the detectors work (self-check)', () => {
  const twelve = '1234'.repeat(3);

  test('AC-26: a 12-digit number is found, a repeated digit and 11 or 13 digits are not', () => {
    expect(findAccountIds(`arn:aws:iam::${twelve}:root`)).toEqual([twelve]);
    expect(findAccountIds(`x-${twelve}`)).toEqual([twelve]);
    expect(findAccountIds('7'.repeat(12))).toEqual([]);
    expect(findAccountIds('1234'.repeat(2) + '123')).toEqual([]);
    expect(findAccountIds(`${twelve}5`)).toEqual([]);
    expect(findAccountIds(`zh:${twelve}abcdef`)).toEqual([]);
  });

  test('AC-26: an email address is found unless its domain is example.com', () => {
    const user = ['someone', 'corp.test'].join('@');
    expect(findForeignEmails(`mail ${user} now`)).toEqual([user]);
    expect(findForeignEmails('alerts@example.com you@EXAMPLE.com')).toEqual([]);
    expect(findForeignEmails('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')).toEqual([]);
  });

  test('AC-26: an immutable subject prefix is found unless it is the fixture', () => {
    const real = ['repo:acme', '4242/widgets', '9001'].join('@');
    expect(findSubPrefixes(`"${real}:pull_request"`)).toEqual([real]);
    expect(findSubPrefixes(`"${ALLOWED_SUB_PREFIX}:ref:refs/heads/main"`)).toEqual([]);
    expect(findSubPrefixes('repo:your-user/saa-c03-field-guide repo:owner@x1/repo')).toEqual([]);
  });
});

describe('AC-26: no identifiers in tracked files, example tfvars, lock file', () => {
  test('AC-26: the stack has files to check', () => {
    expect(listStackFiles().length).toBeGreaterThan(0);
  });

  test('AC-26: no tracked file has a 12-digit number other than a repeated digit', () => {
    const offenders = listStackFiles().flatMap((file) =>
      findAccountIds(readFileSync(join(REPO_ROOT, file), 'utf8')).map((id) => `${file}: ${id}`),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-26: no tracked file has an email address outside example.com', () => {
    const offenders = listStackFiles().flatMap((file) =>
      findForeignEmails(readFileSync(join(REPO_ROOT, file), 'utf8')).map((m) => `${file}: ${m}`),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-26: no tracked file has an immutable GitHub subject prefix other than the fixture', () => {
    const offenders = listStackFiles().flatMap((file) =>
      findSubPrefixes(readFileSync(join(REPO_ROOT, file), 'utf8')).map((m) => `${file}: ${m}`),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-26: terraform.tfvars.example sets github_sub_prefix', () => {
    expect(readStackFile('terraform.tfvars.example')).toMatch(
      /^\s*github_sub_prefix\s*=\s*"repo:[^"\s]+"\s*$/m,
    );
  });

  test('AC-26: terraform.tfvars.example sets hosted_zone_name to an example.com subdomain', () => {
    expect(readStackFile('terraform.tfvars.example')).toMatch(
      /^\s*hosted_zone_name\s*=\s*"([a-z0-9-]+\.)+example\.com"\s*$/m,
    );
  });

  test('AC-26: .terraform.lock.hcl pins registry.terraform.io/hashicorp/aws', () => {
    expect(readStackFile('.terraform.lock.hcl')).toMatch(
      /^provider\s+"registry\.terraform\.io\/hashicorp\/aws"\s*\{/m,
    );
  });
});

// ---- AC-27: README --------------------------------------------------------------------------------

/** The section under a `## <title>` heading, up to the next `## ` heading or the end. */
function readmeSection(readme: string, title: string): string | undefined {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${title}\\s*$`).test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Lines inside fenced blocks whose info string is powershell (pwsh and ps1 count too). */
function powershellLines(readme: string): string[] {
  const out: string[] = [];
  let inPowershell = false;
  let inOtherFence = false;
  for (const line of readme.split(/\r?\n/)) {
    const fence = /^\s*```\s*([A-Za-z0-9_-]*)/.exec(line);
    if (fence) {
      if (inPowershell || inOtherFence) {
        inPowershell = false;
        inOtherFence = false;
      } else if (/^(powershell|pwsh|ps1)$/i.test(fence[1] ?? '')) {
        inPowershell = true;
      } else {
        inOtherFence = true;
      }
      continue;
    }
    if (inPowershell) out.push(line);
  }
  return out;
}

const BACKTICK = '`';

/** True when the double quote count before `index` is odd (a backtick escapes a quote). */
function insideDoubleQuotes(line: string, index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i += 1) {
    if (line.charAt(i) === BACKTICK) {
      i += 1;
    } else if (line.charAt(i) === '"') {
      open = !open;
    }
  }
  return open;
}

/** Every `-out=` / `-backend-config=` flag of a PowerShell line that is not inside double quotes. */
function unquotedFlags(line: string): string[] {
  return [...line.matchAll(/(?<![\w-])-(?:out|backend-config)=/g)]
    .filter((match) => !insideDoubleQuotes(line, match.index))
    .map((match) => `${match[0]} in: ${line.trim()}`);
}

describe('AC-27: the PowerShell quoting detector works (self-check)', () => {
  test('AC-27: flags inside double quotes pass, bare or single-quoted flags are reported', () => {
    expect(unquotedFlags('terraform plan "-out=first.tfplan"')).toEqual([]);
    expect(unquotedFlags('terraform init -migrate-state "-backend-config=bucket=$b"')).toEqual([]);
    expect(unquotedFlags('terraform plan -out=first.tfplan')).toHaveLength(1);
    expect(unquotedFlags("terraform plan '-out=first.tfplan'")).toHaveLength(1);
    expect(unquotedFlags('terraform init -backend-config=bucket=x -migrate-state')).toHaveLength(1);
  });

  test('AC-27: only lines inside powershell fences are collected', () => {
    const fence = BACKTICK.repeat(3);
    const readme = [
      `${fence}bash`,
      'terraform plan -out=first.tfplan',
      fence,
      `${fence}powershell`,
      'terraform plan "-out=first.tfplan"',
      fence,
      'terraform plan -out=outside.tfplan',
    ].join('\n');
    expect(powershellLines(readme)).toEqual(['terraform plan "-out=first.tfplan"']);
  });
});

describe('AC-27: README documents the first apply, DNS delegation, cost and destroy', () => {
  test.each([
    '-migrate-state',
    'backend_override.tf',
    'name_servers',
    'sub_claim_prefix',
    '-lock=false',
  ])('AC-27: the README mentions %s', (needle) => {
    expect(readStackFile('README.md')).toContain(needle);
  });

  test('AC-27: the README has a "## Cost" heading', () => {
    expect(readmeSection(readStackFile('README.md'), 'Cost')).toBeDefined();
  });

  test('AC-27: the README has a "## Destroy" heading', () => {
    expect(readmeSection(readStackFile('README.md'), 'Destroy')).toBeDefined();
  });

  test('AC-27: terraform import commands, if any, are only for the GitHub OIDC provider', () => {
    const imported = [
      ...readStackFile('README.md').matchAll(
        /terraform\s+import\s+(?:-\S+\s+)*['"]?([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\b/g,
      ),
    ].map((match) => match[1] ?? '');
    const others = imported.filter(
      (address) => address !== 'aws_iam_openid_connect_provider.github',
    );
    expect(others).toEqual([]);
  });

  test('AC-27: the README does not import the state bucket, zone, roles or boundary', () => {
    const readme = readStackFile('README.md');
    expect(readme).not.toMatch(
      /terraform\s+import\s+(?:-\S+\s+)*['"]?aws_(?!iam_openid_connect_provider\.github)/,
    );
  });
});

describe('AC-27: the README does not run terraform output once the override is gone', () => {
  const deletesOverride =
    /(?:\brm\b|\bRemove-Item\b)\s+(?:-\S+\s+)*['"]?(?:\.[\\/])?backend_override\.tf/;

  function deletionLine(lines: string[]): number {
    return lines.findIndex((line) => deletesOverride.test(line));
  }

  test('AC-27: the README deletes backend_override.tf with rm or Remove-Item', () => {
    const lines = readStackFile('README.md').split(/\r?\n/);
    expect(deletionLine(lines)).toBeGreaterThanOrEqual(0);
  });

  test('AC-27: terraform output -raw state_bucket is captured before the override is deleted', () => {
    const lines = readStackFile('README.md').split(/\r?\n/);
    const deleted = deletionLine(lines);
    expect(deleted).toBeGreaterThanOrEqual(0);
    const before = lines.slice(0, deleted);
    expect(before.some((line) => /terraform\s+output\s+-raw\s+state_bucket\b/.test(line))).toBe(
      true,
    );
  });

  test('AC-27: no line from the deletion to the -migrate-state line runs terraform output', () => {
    const lines = readStackFile('README.md').split(/\r?\n/);
    const deleted = deletionLine(lines);
    expect(deleted).toBeGreaterThanOrEqual(0);
    const migrate = lines.findIndex((line, i) => i > deleted && line.includes('-migrate-state'));
    expect(migrate).toBeGreaterThan(deleted);
    const offenders = lines
      .slice(deleted, migrate + 1)
      .filter((line) => /terraform\s+output\b/.test(line));
    expect(offenders).toEqual([]);
  });
});

describe('AC-27: PowerShell commands in the README quote -out= and -backend-config=', () => {
  test('AC-27: the README has PowerShell forms of the plan and the state migration', () => {
    const lines = powershellLines(readStackFile('README.md'));
    expect(lines.some((line) => /(?<![\w-])-out=/.test(line))).toBe(true);
    expect(lines.some((line) => /(?<![\w-])-backend-config=/.test(line))).toBe(true);
  });

  test('AC-27: every -out= and -backend-config= on a PowerShell line is inside double quotes', () => {
    const offenders = powershellLines(readStackFile('README.md')).flatMap(unquotedFlags);
    expect(offenders).toEqual([]);
  });
});

// ---- Review round 1: AC-36 (no extra grants), AC-37 (README order), AC-38 (contract fixes) --------

/** Names of every `resource "<type>" "<name>"` block in the stack, sorted. */
function resourceNames(type: string): string[] {
  const header = new RegExp(`\\bresource\\s+"${type}"\\s+"([^"]+)"\\s*\\{`, 'g');
  return [...allTerraform().matchAll(header)].map((match) => match[1] ?? '').sort();
}

describe('AC-36: the stack grants nothing beyond the two managed and two inline policies', () => {
  test('AC-36: exactly two aws_iam_role_policy_attachment resources', () => {
    expect(resourceNames('aws_iam_role_policy_attachment')).toEqual([
      'tf_apply_admin',
      'tf_plan_read_only',
    ]);
  });

  test('AC-36: exactly two aws_iam_role_policy resources', () => {
    expect(resourceNames('aws_iam_role_policy')).toEqual(['tf_apply_deny', 'tf_plan_deny']);
  });

  test.each([
    'aws_iam_policy_attachment',
    'aws_iam_role_policies_exclusive',
    'aws_iam_role_policy_attachments_exclusive',
  ])('AC-36: no %s resource', (type) => {
    expect(loadTerraformFiles().length).toBeGreaterThan(0);
    expect(resourceNames(type)).toEqual([]);
  });

  test('AC-36: the aws_iam_role blocks have no managed_policy_arns or inline_policy', () => {
    const roles = blockBodies(allTerraform(), /\bresource\s+"aws_iam_role"\s+"[^"]+"\s*\{/);
    expect(roles.length).toBeGreaterThanOrEqual(2);
    for (const body of roles) {
      expect(hasAttribute(body, 'managed_policy_arns')).toBe(false);
      expect(body).not.toMatch(/\binline_policy\b/);
    }
  });
});

/** Block number of every line: 0 outside fenced code, 1, 2, ... for each fenced block (fences are 0). */
function fenceBlocks(lines: string[]): number[] {
  const fence = BACKTICK.repeat(3);
  const ids: number[] = [];
  let current = 0;
  let count = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith(fence)) {
      if (current === 0) {
        count += 1;
        current = count;
      } else {
        current = 0;
      }
      ids.push(0);
    } else {
      ids.push(current);
    }
  }
  return ids;
}

const DELETES_OVERRIDE =
  /(?:\brm\b|\bRemove-Item\b)\s+(?:-\S+\s+)*['"]?(?:\.[\\/])?backend_override\.tf/;

/** Problems with every command line (inside a fenced block) that deletes backend_override.tf. */
function overrideDeletionProblems(readme: string): string[] {
  const lines = readme.split(/\r?\n/);
  const blocks = fenceBlocks(lines);
  const problems: string[] = [];
  lines.forEach((line, i) => {
    if ((blocks[i] ?? 0) === 0 || !DELETES_OVERRIDE.test(line)) return;
    const captured = lines.some(
      (other, j) =>
        j < i &&
        blocks[j] === blocks[i] &&
        /terraform\s+output\s+-raw\s+state_bucket\b/.test(other),
    );
    if (!captured) {
      problems.push(`line ${i + 1}: no "terraform output -raw state_bucket" earlier in its block`);
    }
    const migrate = lines.findIndex((other, j) => j > i && other.includes('-migrate-state'));
    if (migrate === -1) {
      problems.push(`line ${i + 1}: no -migrate-state line after the deletion`);
      return;
    }
    lines.slice(i, migrate + 1).forEach((other, offset) => {
      if (/terraform\s+output\b/.test(other)) {
        problems.push(
          `line ${i + offset + 1}: terraform output between the deletion and -migrate-state`,
        );
      }
    });
  });
  return problems;
}

function deletionLineCount(readme: string): number {
  const lines = readme.split(/\r?\n/);
  const blocks = fenceBlocks(lines);
  return lines.filter((line, i) => (blocks[i] ?? 0) !== 0 && DELETES_OVERRIDE.test(line)).length;
}

/** Fenced lines that pass -reconfigure to terraform. */
function reconfigureLines(readme: string): string[] {
  const lines = readme.split(/\r?\n/);
  const blocks = fenceBlocks(lines);
  return lines.filter((line, i) => (blocks[i] ?? 0) !== 0 && line.includes('-reconfigure'));
}

describe('AC-37: the order detectors work (self-check)', () => {
  const fence = BACKTICK.repeat(3);
  const block = (...body: string[]): string => [`${fence}bash`, ...body, fence].join('\n');
  const capture = 'terraform output -raw state_bucket';
  const migrate = 'terraform init -migrate-state "-backend-config=bucket=x"';

  test('AC-37: a block that captures first and then migrates is fine', () => {
    const readme = block(capture, 'rm backend_override.tf', migrate);
    expect(overrideDeletionProblems(readme)).toEqual([]);
    expect(deletionLineCount(readme)).toBe(1);
  });

  test('AC-37: a missing capture, or a capture in another block, is reported', () => {
    expect(overrideDeletionProblems(block('rm backend_override.tf', migrate))).toHaveLength(1);
    const split = [block(capture), block('Remove-Item backend_override.tf', migrate)].join('\n');
    expect(overrideDeletionProblems(split)).toHaveLength(1);
  });

  test('AC-37: terraform output after the deletion is reported, also in a second block', () => {
    const second = block(capture, 'Remove-Item backend_override.tf', capture, migrate);
    const readme = [block(capture, 'rm backend_override.tf', migrate), second].join('\n');
    expect(overrideDeletionProblems(readme)).toHaveLength(1);
  });

  test('AC-37: a deletion without a later -migrate-state line is reported', () => {
    expect(overrideDeletionProblems(block(capture, 'rm backend_override.tf'))).toHaveLength(1);
  });

  test('AC-37: -reconfigure is only reported inside fenced blocks', () => {
    expect(reconfigureLines(block('terraform init -reconfigure'))).toHaveLength(1);
    expect(reconfigureLines('never use -reconfigure here')).toEqual([]);
  });
});

describe('AC-37: README order, no -reconfigure, /lab/ path', () => {
  test('AC-37: the README deletes backend_override.tf in a command block', () => {
    expect(deletionLineCount(readStackFile('README.md'))).toBeGreaterThanOrEqual(1);
  });

  test('AC-37: every deletion has its capture earlier in the block and no terraform output before the migration', () => {
    expect(overrideDeletionProblems(readStackFile('README.md'))).toEqual([]);
  });

  test('AC-37: no fenced command uses -reconfigure', () => {
    expect(reconfigureLines(readStackFile('README.md'))).toEqual([]);
  });

  test('AC-37: the README explains the /lab/ role path', () => {
    expect(readStackFile('README.md')).toContain('/lab/');
  });
});

/**
 * Stricter account-ID detector (AC-38): 12 digits not touching other digits, so it also finds
 * `x_123456789012` and `id123456789012`. A repeated digit is a test fixture and is fine.
 */
function findAccountIdsStrict(text: string): string[] {
  const found = text.match(/(?<!\d)\d{12}(?!\d)/g) ?? [];
  return found.filter((digits) => !/^(\d)\1{11}$/.test(digits));
}

/** The text without the provider hash lines of a lock file (hex digests can hold long digit runs). */
function withoutLockHashes(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*"(?:zh|h1):/.test(line))
    .join('\n');
}

describe('AC-38: the stricter account-ID detector works (self-check)', () => {
  const twelve = '1234'.repeat(3);

  test('AC-38: a 12-digit number is found next to an underscore or a letter', () => {
    expect(findAccountIdsStrict(`x_${twelve}`)).toEqual([twelve]);
    expect(findAccountIdsStrict(`id${twelve}`)).toEqual([twelve]);
    expect(findAccountIdsStrict(`${twelve}abc`)).toEqual([twelve]);
    expect(findAccountIdsStrict(`arn:aws:iam::${twelve}:root`)).toEqual([twelve]);
  });

  test('AC-38: a repeated digit and runs of 11 or 13 digits are not reported', () => {
    expect(findAccountIdsStrict('7'.repeat(12))).toEqual([]);
    expect(findAccountIdsStrict('x_' + '7'.repeat(12))).toEqual([]);
    expect(findAccountIdsStrict('1234'.repeat(2) + '123')).toEqual([]);
    expect(findAccountIdsStrict(`${twelve}5`)).toEqual([]);
  });

  test('AC-38: lock file hash lines are ignored, other lines are not', () => {
    const lock = [`  "zh:abc${twelve}def",`, `  "h1:${twelve}=",`, `x_${twelve}`].join('\n');
    expect(findAccountIdsStrict(withoutLockHashes(lock))).toEqual([twelve]);
  });
});

describe('AC-38: contract fixes', () => {
  test('AC-38: no tracked file has a 12-digit number next to an underscore or a letter', () => {
    expect(listStackFiles().length).toBeGreaterThan(0);
    const offenders = listStackFiles().flatMap((file) => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      const scanned = file.endsWith('.terraform.lock.hcl') ? withoutLockHashes(text) : text;
      return findAccountIdsStrict(scanned).map((id) => `${file}: ${id}`);
    });
    expect(offenders).toEqual([]);
  });

  test.each(['transition', 'noncurrent_version_transition', 'newer_noncurrent_versions'])(
    'AC-38: the state bucket lifecycle rule has no %s',
    (name) => {
      const body = resourceBody('aws_s3_bucket_lifecycle_configuration', 'state');
      expect(body).not.toMatch(new RegExp(`(^|[^\\w])${name}\\b`, 'm'));
    },
  );
});
