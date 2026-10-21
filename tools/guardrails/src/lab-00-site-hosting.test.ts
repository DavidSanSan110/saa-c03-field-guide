import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ESLint } from 'eslint';
import { describe, expect, test, vi } from 'vitest';

// Spec 035: contract tests over the real files of labs/00-site-hosting, the CloudFront Function
// run in node:vm, the headers.json validator and the ESLint override. The behaviour of the stack
// itself (resources, policies, preconditions) is covered by `terraform test`
// (labs/00-site-hosting/tests); this file covers what terraform test cannot see: file layout,
// HCL text (depends_on, providers, lifecycle shape), the README and the JavaScript function.
//
// WHAT THE IMPLEMENTER MUST CREATE FOR THIS FILE (AC-44):
//   tools/guardrails/src/site-headers.ts exporting
//     validateSiteHeaders(headers: Record<string, string>): string[]
//   It returns the list of problems (one message per problem), empty when the headers pass the
//   rules of the spec 035 section 7 preconditions. Header names are matched case-insensitively.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/00-site-hosting';
const ZONE_FIXTURE = 'Z0123456789EXAMPLE';

function labPath(...segments: string[]): string {
  return join(REPO_ROOT, ...LAB.split('/'), ...segments);
}

/** Reads a file of the lab; a missing file fails the test with a readable message. */
function readLabFile(name: string): string {
  const path = labPath(...name.split('/'));
  if (!existsSync(path)) throw new Error(`missing file: ${LAB}/${name}`);
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

/** The body without the nested blocks that start with `header` (to read top-level attributes). */
function withoutBlock(body: string, header: RegExp): string {
  let out = body;
  for (;;) {
    const match = new RegExp(header.source, header.flags.replace('g', '')).exec(out);
    if (!match) return out;
    const open = match.index + match[0].length - 1;
    out = out.slice(0, match.index) + out.slice(closeBrace(out, open));
  }
}

interface TerraformFile {
  name: string;
  raw: string;
  text: string;
}

/** Every `.tf` file of the lab (top level, git-ignored `*_override.tf` excluded). */
function loadTerraformFiles(): TerraformFile[] {
  const dir = labPath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tf') && !name.endsWith('_override.tf'))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8');
      return { name, raw, text: stripHclComments(raw) };
    });
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
      `expected one resource "${type}" "${name}" in ${LAB}/*.tf, found ${bodies.length}`,
    );
  }
  return bodies[0] ?? '';
}

function variableBody(name: string): string {
  const bodies = blockBodies(allTerraform(), new RegExp(`\\bvariable\\s+"${name}"\\s*\\{`));
  if (bodies.length !== 1) {
    throw new Error(`expected one variable "${name}" in ${LAB}/*.tf, found ${bodies.length}`);
  }
  return bodies[0] ?? '';
}

/** The names of every `variable "<name>"` block of the lab. */
function declaredVariables(): { name: string; hasDefault: boolean }[] {
  const text = allTerraform();
  return [...text.matchAll(/\bvariable\s+"([a-z0-9_]+)"\s*\{/g)].map((match) => {
    const open = match.index + match[0].length - 1;
    const body = text.slice(open + 1, closeBrace(text, open) - 1);
    return {
      name: match[1] ?? '',
      hasDefault: hasAttribute(withoutBlock(body, /\bvalidation\s*\{/), 'default'),
    };
  });
}

// ---- AC-11: the files of the lab, the backend, the pins ---------------------------------------------

const LAB_FILES = [
  'versions.tf',
  'providers.tf',
  'variables.tf',
  'main.tf',
  'site_bucket.tf',
  'log_bucket.tf',
  'cdn.tf',
  'logs.tf',
  'domain.tf',
  'deploy_role.tf',
  'outputs.tf',
  'functions/viewer-request.js',
  'terraform.tfvars.example',
  '.terraform.lock.hcl',
  'README.md',
  'tests/variables.tftest.hcl',
  'tests/no_domain.tftest.hcl',
  'tests/cdn.tftest.hcl',
  'tests/headers.tftest.hcl',
  'tests/deploy_role.tftest.hcl',
  'tests/domain.tftest.hcl',
];

describe('AC-11: files, backend and version pins', () => {
  test.each(LAB_FILES)('AC-11: the lab has %s', (name) => {
    expect(existsSync(labPath(...name.split('/'))), `missing file: ${LAB}/${name}`).toBe(true);
  });

  test('AC-11: one s3 backend block with region eu-west-1 and use_lockfile, no bucket, key or encrypt', () => {
    const bodies = blockBodies(allTerraform(), /\bbackend\s+"s3"\s*\{/);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(body).toMatch(/^\s*region\s*=\s*"eu-west-1"\s*$/m);
    expect(body).toMatch(/^\s*use_lockfile\s*=\s*true\s*$/m);
    for (const attribute of ['bucket', 'key', 'encrypt']) {
      expect(hasAttribute(body, attribute), `backend sets ${attribute}`).toBe(false);
    }
  });

  test('AC-11: versions.tf requires Terraform >= 1.14.0', () => {
    expect(stripHclComments(readLabFile('versions.tf'))).toMatch(
      /^\s*required_version\s*=\s*">=\s*1\.14\.0"\s*$/m,
    );
  });

  test('AC-11: versions.tf pins hashicorp/aws to exactly 6.67.0', () => {
    const bodies = blockBodies(
      stripHclComments(readLabFile('versions.tf')),
      /\brequired_providers\s*\{/,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"hashicorp\/aws"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*version\s*=\s*"6\.67\.0"\s*$/m);
  });

  test('AC-11: the lock file pins registry.terraform.io/hashicorp/aws 6.67.0', () => {
    const lock = readLabFile('.terraform.lock.hcl');
    expect(lock).toMatch(/^provider\s+"registry\.terraform\.io\/hashicorp\/aws"\s*\{/m);
    expect(lock).toMatch(/^\s*version\s*=\s*"6\.67\.0"\s*$/m);
  });

  test('AC-11: the lock file has h1: hashes for linux_amd64 and windows_amd64 (at least two)', () => {
    const hashes = readLabFile('.terraform.lock.hcl').match(/"h1:[A-Za-z0-9+/=]+"/g) ?? [];
    expect(new Set(hashes).size).toBeGreaterThanOrEqual(2);
  });
});

// ---- AC-12, AC-13: providers, tags, identity ---------------------------------------------------------

describe('AC-12: providers and tags', () => {
  const providers = (): { alias?: string; body: string }[] =>
    blockBodies(allTerraform(), /\bprovider\s+"aws"\s*\{/).map((body) => {
      const alias = /^\s*alias\s*=\s*"([^"]+)"\s*$/m.exec(body)?.[1];
      return alias === undefined ? { body } : { alias, body };
    });

  test('AC-12: exactly two aws providers: the default and the us_east_1 alias', () => {
    const all = providers();
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.alias === undefined)).toHaveLength(1);
    expect(all.filter((p) => p.alias === 'us_east_1')).toHaveLength(1);
  });

  test('AC-12: the default provider is in eu-west-1 and the alias in us-east-1', () => {
    expect(providers()).toHaveLength(2);
    for (const provider of providers()) {
      const region = provider.alias === 'us_east_1' ? 'us-east-1' : 'eu-west-1';
      expect(provider.body).toMatch(new RegExp(`^\\s*region\\s*=\\s*"${region}"\\s*$`, 'm'));
    }
  });

  test('AC-12: both providers set default_tags { tags = module.tags.tags }', () => {
    expect(providers()).toHaveLength(2);
    for (const provider of providers()) {
      const defaultTags = blockBodies(provider.body, /\bdefault_tags\s*\{/);
      expect(defaultTags).toHaveLength(1);
      expect(defaultTags[0]).toMatch(/^\s*tags\s*=\s*module\.tags\.tags\s*$/m);
    }
  });

  test('AC-12: both providers set only region (and alias on the second) besides default_tags', () => {
    expect(providers()).toHaveLength(2);
    for (const provider of providers()) {
      const rest = withoutBlock(provider.body, /\bdefault_tags\s*\{/);
      const names = [...rest.matchAll(/^\s*([a-z_0-9]+)\s*=/gm)].map((match) => match[1]).sort();
      expect(names).toEqual(provider.alias === undefined ? ['region'] : ['alias', 'region']);
    }
  });

  test('AC-12: module "tags" uses ../../modules/tags with lab = "00-site-hosting"', () => {
    const bodies = blockBodies(allTerraform(), /\bmodule\s+"tags"\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/tags"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*lab\s*=\s*"00-site-hosting"\s*$/m);
  });

  test.each(['profile', 'access_key', 'secret_key', 'assume_role'])(
    'AC-12: no .tf file sets %s',
    (name) => {
      const files = loadTerraformFiles();
      expect(files.length).toBeGreaterThan(0);
      // assume_role is matched exactly: aws_iam_role requires the assume_role_policy argument.
      const suffix = name === 'assume_role' ? '' : '\\w*';
      for (const file of files) {
        expect(file.text, file.name).not.toMatch(
          new RegExp(`^\\s*${name}${suffix}\\s*(=|\\{)`, 'm'),
        );
      }
    },
  );
});

describe('AC-13: identity and policy documents', () => {
  test('AC-13: the caller identity data source exists and only account_id is used', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(allTerraform()).toMatch(/\bdata\s+"aws_caller_identity"\s+"current"\s*\{/);
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(/aws_caller_identity\.current\.(arn|user_id)\b/);
    }
  });

  test('AC-13: no .tf file declares data "aws_iam_policy_document"', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(/\bdata\s+"aws_iam_policy_document"/);
    }
  });
});

// ---- AC-14 (the part terraform test cannot reach), AC-15: variables and the example tfvars -----------

describe('AC-14: variables (static half)', () => {
  test('AC-14: github_sub_prefix has no default, so a missing value is an error', () => {
    expect(
      hasAttribute(withoutBlock(variableBody('github_sub_prefix'), /\bvalidation\s*\{/), 'default'),
    ).toBe(false);
  });

  test('AC-14: the hosted_zone_id validation message names both hosted_zone_id and domain_name', () => {
    const messages = blockBodies(variableBody('hosted_zone_id'), /\bvalidation\s*\{/).map(
      (body) => /error_message\s*=\s*"([^"]*)"/.exec(body)?.[1] ?? '',
    );
    expect(messages.some((m) => m.includes('hosted_zone_id') && m.includes('domain_name'))).toBe(
      true,
    );
  });
});

function tfvarsLines(): string[] {
  return readLabFile('terraform.tfvars.example').split(/\r?\n/);
}

function tfvarsAssignments(): { name: string; value: string; index: number }[] {
  return tfvarsLines().flatMap((line, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    return match && !line.trimStart().startsWith('#')
      ? [{ name: match[1] ?? '', value: (match[2] ?? '').replace(/\s+#.*$/, ''), index }]
      : [];
  });
}

describe('AC-15: terraform.tfvars.example', () => {
  const value = (name: string): string | undefined =>
    tfvarsAssignments().find((assignment) => assignment.name === name)?.value;

  test('AC-15: github_sub_prefix is the repo:your-user example', () => {
    expect(value('github_sub_prefix')).toBe('"repo:your-user/saa-c03-field-guide"');
  });

  test('AC-15: domain_name is an example.com subdomain', () => {
    expect(value('domain_name') ?? '').toMatch(/^"([a-z0-9-]+\.)+example\.com"$/);
  });

  test('AC-15: hosted_zone_id is the mock zone ID', () => {
    expect(value('hosted_zone_id')).toBe(`"${ZONE_FIXTURE}"`);
  });

  test('AC-15: the header comment names terraform.tfvars and the TF_VAR_ repository variable form', () => {
    const lines = tfvarsLines();
    const first = tfvarsAssignments()[0];
    expect(first).toBeDefined();
    const header = lines
      .slice(0, first?.index ?? 0)
      .filter((line) => line.trimStart().startsWith('#'))
      .join('\n');
    expect(header).toContain('terraform.tfvars');
    expect(header).toContain('TF_VAR_');
  });

  test('AC-15: every assignment has a comment (the line before, or at the end of the line)', () => {
    const lines = tfvarsLines();
    const assignments = tfvarsAssignments();
    expect(assignments.length).toBeGreaterThan(0);
    for (const { name, index } of assignments) {
      const before = (lines[index - 1] ?? '').trimStart();
      const own = lines[index] ?? '';
      expect(before.startsWith('#') || /\s#\s*\S/.test(own), `no comment for ${name}`).toBe(true);
    }
  });

  test('AC-15: every variable without a default in variables.tf appears in it', () => {
    const required = declaredVariables()
      .filter((variable) => !variable.hasDefault)
      .map((variable) => variable.name);
    expect(required).toContain('github_sub_prefix');
    const assigned = tfvarsAssignments().map((assignment) => assignment.name);
    for (const name of required) expect(assigned, name).toContain(name);
  });

  test('AC-15: every assignment is a declared variable other than headers_json', () => {
    const declared = declaredVariables().map((variable) => variable.name);
    expect(declared.length).toBeGreaterThan(0);
    const assigned = tfvarsAssignments().map((assignment) => assignment.name);
    expect(assigned).not.toContain('headers_json');
    for (const name of assigned) expect(declared, name).toContain(name);
  });
});

// ---- AC-16: no identifiers in tracked files ----------------------------------------------------------

/** Account-like numbers: 12 digits that are not one digit repeated (test fixtures are fine). */
function findAccountIds(text: string): string[] {
  const found = text.match(/(?<!\w)\d{12}(?!\w)/g) ?? [];
  return found.filter((digits) => !/^(\d)\1{11}$/.test(digits));
}

/** Hosted zone IDs other than the documentation fixture. */
function findZoneIds(text: string): string[] {
  const found = text.match(/(?<![A-Za-z0-9+/=])Z[A-Z0-9]{10,31}(?![A-Za-z0-9])/g) ?? [];
  return found.filter((id) => id !== ZONE_FIXTURE);
}

/** Built at runtime so this file does not contain the owner's domain. */
const OWNER_DOMAIN = ['tech-leads', 'lol'].join('.');

function mentionsOwnerDomain(text: string): boolean {
  return text.toLowerCase().includes(OWNER_DOMAIN);
}

/** Files of the lab in git's view: tracked, plus new files that are not git-ignored. */
function listLabFiles(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', `${LAB}/`],
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
    expect(findAccountIds('1'.repeat(12))).toEqual([]);
    expect(findAccountIds('1234'.repeat(2) + '123')).toEqual([]);
    expect(findAccountIds(`${twelve}5`)).toEqual([]);
  });

  test('AC-16: a zone ID is found unless it is the fixture, too short or too long', () => {
    expect(findZoneIds('zone_id = "Z1ABCDEFGHIJKL"')).toEqual(['Z1ABCDEFGHIJKL']);
    expect(findZoneIds(`zone_id = "${ZONE_FIXTURE}"`)).toEqual([]);
    expect(findZoneIds('ZONE Z123 ZABCDEFGHI')).toEqual([]);
    expect(findZoneIds(`Z${'A'.repeat(40)}`)).toEqual([]);
  });

  test('AC-16: the owner domain is found in any case, other domains are not', () => {
    expect(mentionsOwnerDomain(`site.${OWNER_DOMAIN}`)).toBe(true);
    expect(mentionsOwnerDomain(`SITE.${OWNER_DOMAIN.toUpperCase()}`)).toBe(true);
    expect(mentionsOwnerDomain('site.example.com')).toBe(false);
  });

  test('AC-16: lock-file h1: and zh: lines are not flagged', () => {
    const lock = readFileSync(
      join(REPO_ROOT, 'bootstrap', 'workload', '.terraform.lock.hcl'),
      'utf8',
    );
    expect(lock).toContain('"h1:');
    expect(lock).toContain('"zh:');
    expect(findAccountIds(lock)).toEqual([]);
    expect(findZoneIds(lock)).toEqual([]);
  });
});

describe('AC-16: no identifiers in tracked files of the lab', () => {
  test('AC-16: the lab has files to check', () => {
    expect(listLabFiles()).toContain(`${LAB}/main.tf`);
  });

  test('AC-16: no file has an account ID (12 digits that are not a repeated digit)', () => {
    const offenders = listLabFiles().flatMap((file) =>
      findAccountIds(readFileSync(join(REPO_ROOT, file), 'utf8')).map((id) => `${file}: ${id}`),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-16: no file mentions the owner domain', () => {
    const offenders = listLabFiles().filter((file) =>
      mentionsOwnerDomain(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  test('AC-16: no file has a zone ID other than the fixture', () => {
    const offenders = listLabFiles().flatMap((file) =>
      findZoneIds(readFileSync(join(REPO_ROOT, file), 'utf8')).map((id) => `${file}: ${id}`),
    );
    expect(offenders).toEqual([]);
  });
});

// ---- AC-18, AC-19, AC-20, AC-21, AC-23, AC-36, AC-40: HCL text checks terraform test cannot make -----

/** Lifecycle rule bodies of a bucket lifecycle resource. */
function lifecycleRules(name: string): string[] {
  return blockBodies(resourceBody('aws_s3_bucket_lifecycle_configuration', name), /\brule\s*\{/);
}

/** True when every `filter` block of the rule is empty (an empty prefix counts as empty). */
function filtersAreEmpty(rule: string): boolean {
  const filters = blockBodies(rule, /\bfilter\s*\{/);
  return (
    filters.length === 1 &&
    filters.every((filter) => filter.replace(/^\s*prefix\s*=\s*""\s*$/gm, '').trim() === '')
  );
}

describe('AC-18, AC-21: lifecycle rules cover the whole bucket', () => {
  // filter.prefix is unknown at plan time when the filter is empty, so terraform test cannot see it.
  test.each(['site', 'logs'])(
    'AC-18/21: the %s bucket has one rule with an empty filter',
    (name) => {
      const rules = lifecycleRules(name);
      expect(rules).toHaveLength(1);
      expect(filtersAreEmpty(rules[0] ?? '')).toBe(true);
    },
  );

  test('AC-18: the site rule never expires current objects (no days or date on expiration)', () => {
    const rule = lifecycleRules('site')[0] ?? '';
    const expirations = blockBodies(rule, /\bexpiration\s*\{/);
    expect(expirations).toHaveLength(1);
    expect(expirations[0]).toMatch(/^\s*expired_object_delete_marker\s*=\s*true\s*$/m);
    expect(hasAttribute(expirations[0] ?? '', 'days')).toBe(false);
    expect(hasAttribute(expirations[0] ?? '', 'date')).toBe(false);
  });

  test('AC-18: the site rule has no transition of current objects', () => {
    const rule = lifecycleRules('site')[0] ?? '';
    expect(blockBodies(rule, /\btransition\s*\{/)).toEqual([]);
  });
});

describe('AC-19: bucket policies wait for their public access block', () => {
  test.each(['site', 'logs'])(
    'AC-19: aws_s3_bucket_policy.%s lists its public access block in depends_on',
    (name) => {
      const body = resourceBody('aws_s3_bucket_policy', name);
      expect(body).toMatch(
        new RegExp(
          `\\bdepends_on\\s*=\\s*\\[[^\\]]*\\baws_s3_bucket_public_access_block\\.${name}\\b`,
        ),
      );
    },
  );
});

describe('AC-20: the log bucket', () => {
  test('AC-20: there is no aws_s3_bucket_versioning.logs', () => {
    expect(allTerraform()).not.toMatch(resourceHeader('aws_s3_bucket_versioning', 'logs'));
    expect(allTerraform()).toMatch(resourceHeader('aws_s3_bucket', 'logs'));
  });

  test.each(['aws_s3_bucket', 'aws_s3_bucket_policy', 'aws_s3_bucket_public_access_block'])(
    'AC-20: %s.logs uses the default (eu-west-1) provider',
    (type) => {
      expect(hasAttribute(resourceBody(type, 'logs'), 'provider')).toBe(false);
    },
  );
});

describe('AC-23: the standard logs v2 resources', () => {
  test.each([
    'aws_cloudwatch_log_delivery_source',
    'aws_cloudwatch_log_delivery_destination',
    'aws_cloudwatch_log_delivery',
  ])('AC-23: %s.site uses the aws.us_east_1 provider', (type) => {
    expect(resourceBody(type, 'site')).toMatch(/^\s*provider\s*=\s*aws\.us_east_1\s*$/m);
  });

  test('AC-23: the delivery depends on the log bucket policy', () => {
    expect(resourceBody('aws_cloudwatch_log_delivery', 'site')).toMatch(
      /\bdepends_on\s*=\s*\[[^\]]*\baws_s3_bucket_policy\.logs\b/,
    );
  });
});

describe('AC-36: the certificate (static half)', () => {
  test.each(['aws_acm_certificate', 'aws_acm_certificate_validation'])(
    'AC-36: %s.site uses the aws.us_east_1 provider',
    (type) => {
      expect(resourceBody(type, 'site')).toMatch(/^\s*provider\s*=\s*aws\.us_east_1\s*$/m);
    },
  );

  test('AC-36: the certificate has lifecycle { create_before_destroy = true }', () => {
    const lifecycles = blockBodies(resourceBody('aws_acm_certificate', 'site'), /\blifecycle\s*\{/);
    expect(lifecycles.some((body) => /^\s*create_before_destroy\s*=\s*true\s*$/m.test(body))).toBe(
      true,
    );
  });

  test('AC-36: the viewer certificate takes its ARN from the validation resource', () => {
    const distribution = resourceBody('aws_cloudfront_distribution', 'site');
    const viewer = blockBodies(distribution, /\bviewer_certificate\s*\{/);
    expect(viewer).toHaveLength(1);
    expect(viewer[0]).toMatch(
      /^\s*acm_certificate_arn\s*=\s*[^\n]*\baws_acm_certificate_validation\.site\b/m,
    );
  });
});

describe('AC-40: outputs', () => {
  const names = [
    'site_bucket_name',
    'log_bucket_name',
    'distribution_id',
    'distribution_domain_name',
    'site_url',
    'deploy_role_arn',
  ];

  test.each(names)('AC-40: output "%s" exists and is not sensitive', (name) => {
    const bodies = blockBodies(allTerraform(), new RegExp(`\\boutput\\s+"${name}"\\s*\\{`));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/^\s*sensitive\s*=\s*true\s*$/m);
    expect(hasAttribute(bodies[0] ?? '', 'value')).toBe(true);
  });
});

// ---- AC-41: tags come from default_tags -------------------------------------------------------------

/** The text of the `tags` argument of a resource body, or undefined when it has none. */
function tagsArgument(body: string): string | undefined {
  const match = /^\s*tags\s*=\s*/m.exec(body);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  if (body.charAt(start) === '{') return body.slice(start, closeBrace(body, start));
  const end = body.indexOf('\n', start);
  return body.slice(start, end === -1 ? body.length : end);
}

describe('AC-41: project and lab tags only come from default_tags', () => {
  test('AC-41: the tags detector finds project, lab and module.tags (self-check)', () => {
    expect(tagsArgument('tags = { project = "x" }')).toMatch(/\bproject\b/);
    expect(tagsArgument('x = 1\n  tags = merge(module.tags.tags, { Name = "n" })\n')).toMatch(
      /module\.tags/,
    );
    expect(tagsArgument('tags = { Name = "n" }')).not.toMatch(/\b(project|lab)\b/i);
    expect(tagsArgument('name = "n"')).toBeUndefined();
  });

  test('AC-41: no resource has a tags argument that sets project or lab', () => {
    const text = allTerraform();
    const resources = [...text.matchAll(/\bresource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g)];
    expect(resources.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const match of resources) {
      const open = match.index + match[0].length - 1;
      const body = text.slice(open + 1, closeBrace(text, open) - 1);
      const tags = tagsArgument(body);
      if (tags !== undefined && /\b(project|lab)\b|module\.tags/i.test(tags)) {
        offenders.push(`${match[1]}.${match[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- AC-42: checkov skips ---------------------------------------------------------------------------

const ALLOWED_SKIPS = [
  'CKV_AWS_68',
  'CKV2_AWS_47',
  'CKV_AWS_310',
  'CKV_AWS_374',
  'CKV_AWS_86',
  'CKV_AWS_174',
  'CKV2_AWS_42',
  'CKV_AWS_259',
  'CKV_AWS_144',
  'CKV_AWS_145',
  'CKV2_AWS_62',
  'CKV_AWS_18',
  'CKV_AWS_21',
];

/** Every `#checkov:skip=<ID>:<reason>` comment of the lab's .tf files. */
function checkovSkips(): { file: string; id: string; reason: string }[] {
  return loadTerraformFiles().flatMap((file) =>
    [...file.raw.matchAll(/#\s*checkov:skip=([^\s:]+)(?::([^\r\n]*))?/g)].map((match) => ({
      file: file.name,
      id: match[1] ?? '',
      reason: (match[2] ?? '').trim(),
    })),
  );
}

describe('AC-42: checkov skips', () => {
  test('AC-42: the lab has checkov skips to check', () => {
    expect(checkovSkips().length).toBeGreaterThan(0);
  });

  test('AC-42: every skip names an ID from the list of the spec', () => {
    const offenders = checkovSkips()
      .filter((skip) => !ALLOWED_SKIPS.includes(skip.id))
      .map((skip) => `${skip.file}: ${skip.id}`);
    expect(offenders).toEqual([]);
  });

  test('AC-42: every skip has a reason after the colon', () => {
    const offenders = checkovSkips()
      .filter((skip) => skip.reason === '')
      .map((skip) => `${skip.file}: ${skip.id}`);
    expect(offenders).toEqual([]);
  });
});

// ---- AC-43: README ----------------------------------------------------------------------------------

/** Blank-line separated blocks of a Markdown text. */
function paragraphs(text: string): string[] {
  return text.split(/\r?\n\s*\r?\n/);
}

/** The section under the first heading that matches, up to the next heading of any level. */
function sectionUnder(readme: string, title: RegExp): string | undefined {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && title.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('AC-43: README', () => {
  test.each([
    ['github_sub_prefix', 'TF_VAR_GITHUB_SUB_PREFIX'],
    ['domain_name', 'TF_VAR_DOMAIN_NAME'],
    ['hosted_zone_id', 'TF_VAR_HOSTED_ZONE_ID'],
  ])('AC-43: the inputs table has a row with %s and %s', (input, variable) => {
    const rows = readLabFile('README.md')
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('|'));
    expect(rows.some((row) => row.includes(input) && row.includes(variable))).toBe(true);
  });

  test('AC-43: the inputs table header names the four columns', () => {
    const rows = readLabFile('README.md')
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('|'));
    const header = rows.find((row) => /tfvars/i.test(row) && /repository variable/i.test(row));
    expect(header, 'no table header with tfvars name and repository variable').toBeDefined();
    expect(header).toMatch(/default/i);
    expect(header).toMatch(/meaning/i);
  });

  test('AC-43: it names the destroy dispatch for this lab', () => {
    expect(readLabFile('README.md')).toContain('destroy labs/00-site-hosting');
  });

  test('AC-43: the cost section gives a $ amount', () => {
    const section = sectionUnder(readLabFile('README.md'), /cost/i);
    expect(section, 'no heading with "cost"').toBeDefined();
    expect(section).toMatch(/\$\s?\d/);
  });

  test('AC-43: a paragraph says that a change to apps/site/headers.json plans and applies this lab', () => {
    const found = paragraphs(readLabFile('README.md')).some(
      (p) =>
        p.includes('apps/site/headers.json') &&
        /\bplans?\b/i.test(p) &&
        /\bapplie[sd]|\bapply\b/i.test(p),
    );
    expect(found).toBe(true);
  });

  test('AC-43: a paragraph says to set TF_VAR_* on the repository, not on an environment', () => {
    const found = paragraphs(readLabFile('README.md')).some(
      (p) => p.includes('TF_VAR_') && /repository/i.test(p) && /environment/i.test(p),
    );
    expect(found).toBe(true);
  });

  test('AC-43: a paragraph says never to put secrets in TF_VAR_* variables', () => {
    const found = paragraphs(readLabFile('README.md')).some(
      (p) => p.includes('TF_VAR_') && /secret/i.test(p) && /\b(never|not|no)\b/i.test(p),
    );
    expect(found).toBe(true);
  });
});

// ---- AC-44: headers.json validator ------------------------------------------------------------------

type HeadersValidator = (headers: Record<string, string>) => string[];

/** Imported on demand so that a missing module fails the AC-44 tests only. */
async function loadValidator(): Promise<HeadersValidator> {
  const module: { validateSiteHeaders?: HeadersValidator } = await import('./site-headers.ts');
  if (typeof module.validateSiteHeaders !== 'function') {
    throw new Error('site-headers.ts does not export validateSiteHeaders');
  }
  return module.validateSiteHeaders;
}

function readRealHeaders(): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, 'apps', 'site', 'headers.json'), 'utf8');
  return JSON.parse(text) as Record<string, string>;
}

/** A valid header set to start the samples from. */
const GOOD_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=()',
};

function without(headers: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...headers };
  delete copy[key];
  return copy;
}

describe('AC-44: headers.json validator', () => {
  test('AC-44: the real apps/site/headers.json passes', async () => {
    const validate = await loadValidator();
    expect(validate(readRealHeaders())).toEqual([]);
  });

  test('AC-44: a valid sample passes', async () => {
    const validate = await loadValidator();
    expect(validate(GOOD_HEADERS)).toEqual([]);
  });

  test('AC-44: header names are matched case-insensitively and HSTS tokens too', async () => {
    const validate = await loadValidator();
    expect(
      validate({
        'strict-transport-security': 'max-age=600; INCLUDESUBDOMAINS; PRELOAD',
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'no-referrer',
      }),
    ).toEqual([]);
  });

  test.each([
    'max-age=600',
    'max-age=600; includeSubDomains',
    'max-age=600; preload',
    'max-age=600; includeSubDomains; preload',
    'max-age=600;includeSubDomains;preload',
  ])('AC-44: HSTS "%s" passes', async (value) => {
    const validate = await loadValidator();
    expect(validate({ ...GOOD_HEADERS, 'Strict-Transport-Security': value })).toEqual([]);
  });

  test.each([
    'no-referrer',
    'no-referrer-when-downgrade',
    'origin',
    'origin-when-cross-origin',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url',
  ])('AC-44: Referrer-Policy "%s" passes', async (value) => {
    const validate = await loadValidator();
    expect(validate({ ...GOOD_HEADERS, 'Referrer-Policy': value })).toEqual([]);
  });

  test.each(['DENY', 'SAMEORIGIN'])('AC-44: X-Frame-Options "%s" passes', async (value) => {
    const validate = await loadValidator();
    expect(validate({ ...GOOD_HEADERS, 'X-Frame-Options': value })).toEqual([]);
  });

  test('AC-44: a CSP of exactly 1783 characters passes', async () => {
    const validate = await loadValidator();
    expect(validate({ ...GOOD_HEADERS, 'Content-Security-Policy': 'a'.repeat(1783) })).toEqual([]);
  });

  test.each([
    ['HSTS max-age=abc', { 'Strict-Transport-Security': 'max-age=abc' }],
    [
      'HSTS with an unknown token',
      { 'Strict-Transport-Security': 'max-age=1; includeSubDomains; foo' },
    ],
    [
      'HSTS with the tokens in the wrong order',
      { 'Strict-Transport-Security': 'max-age=1; preload; includeSubDomains' },
    ],
    ['HSTS without max-age', { 'Strict-Transport-Security': 'includeSubDomains' }],
    ['X-Content-Type-Options sniff', { 'X-Content-Type-Options': 'sniff' }],
    ['X-Frame-Options deny (lower case)', { 'X-Frame-Options': 'deny' }],
    ['X-Frame-Options ALLOW-FROM', { 'X-Frame-Options': 'ALLOW-FROM https://example.com' }],
    ['Referrer-Policy always', { 'Referrer-Policy': 'always' }],
    ['a CSP of 1784 characters', { 'Content-Security-Policy': 'a'.repeat(1784) }],
  ])('AC-44: %s is rejected', async (_label, override) => {
    const validate = await loadValidator();
    expect(validate({ ...GOOD_HEADERS, ...override }).length).toBeGreaterThan(0);
  });

  test.each([
    'Strict-Transport-Security',
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
  ])('AC-44: a set without %s is rejected', async (missing) => {
    const validate = await loadValidator();
    expect(validate(without(GOOD_HEADERS, missing)).length).toBeGreaterThan(0);
  });
});

// ---- AC-45: ESLint override for the CloudFront Function ------------------------------------------------

const FUNCTION_FILE = `${LAB}/functions/viewer-request.js`;

describe('AC-45: ESLint override for labs/*/functions/*.js', () => {
  const eslint = (): ESLint => new ESLint({ cwd: REPO_ROOT });

  test('AC-45: the override sets sourceType script for the function file', async () => {
    const config = (await eslint().calculateConfigForFile(FUNCTION_FILE)) as {
      languageOptions?: { sourceType?: string };
    };
    expect(config.languageOptions?.sourceType).toBe('script');
  });

  test('AC-45: the override sets no-unused-vars with a varsIgnorePattern that matches handler', async () => {
    const config = (await eslint().calculateConfigForFile(FUNCTION_FILE)) as {
      rules?: Record<string, unknown>;
    };
    const setting = config.rules?.['no-unused-vars'];
    expect(Array.isArray(setting)).toBe(true);
    const options = (setting as unknown[])[1] as { varsIgnorePattern?: string } | undefined;
    expect(options?.varsIgnorePattern).toBeDefined();
    expect(new RegExp(options?.varsIgnorePattern ?? '(?!)').test('handler')).toBe(true);
  });

  test('AC-45: ESLint reports 0 problems on functions/viewer-request.js', async () => {
    const results = await eslint().lintFiles([FUNCTION_FILE]);
    const messages = results.flatMap((result) =>
      result.messages.map((m) => `${m.line}:${m.column} ${m.ruleId ?? ''} ${m.message}`),
    );
    expect(messages).toEqual([]);
  });
});

// ---- AC-31: viewer-request.js contract --------------------------------------------------------------

/** The JavaScript text without comments and the contents of string literals. */
function stripJsCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < source.length && source.charAt(i) !== c) i += source.charAt(i) === '\\' ? 2 : 1;
      i += 1;
      out += c + c;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

describe('AC-31: the JavaScript stripper works (self-check)', () => {
  test('AC-31: comments and string contents are removed, code is kept', () => {
    const stripped = stripJsCommentsAndStrings(
      'var a = \'x => y\'; // c => d\n/* e ?. f */ var b = "g ..."; var c = a;',
    );
    expect(stripped).not.toMatch(/=>|\?\.|\.\.\./);
    expect(stripped).toContain('var c = a;');
  });
});

describe('AC-31: functions/viewer-request.js is written in the subset CloudFront runs', () => {
  const source = (): string => readLabFile('functions/viewer-request.js');
  const code = (): string => stripJsCommentsAndStrings(source());

  test('AC-31: __CANONICAL_HOST__ appears exactly once, in var canonicalHost', () => {
    expect(source().split('__CANONICAL_HOST__')).toHaveLength(2);
    expect(source()).toContain("var canonicalHost = '__CANONICAL_HOST__';");
  });

  test('AC-31: the file is at most 10 240 bytes', () => {
    expect(Buffer.byteLength(source(), 'utf8')).toBeLessThanOrEqual(10240);
  });

  test('AC-31: it defines function handler(event)', () => {
    expect(code()).toMatch(/\bfunction\s+handler\s*\(\s*event\s*\)/);
  });

  test.each([
    ['require(', /\brequire\s*\(/],
    ['a line starting with import', /^\s*import\b/m],
    ['a line starting with export', /^\s*export\b/m],
    ['an arrow function', /=>/],
    ['optional chaining', /\?\./],
    ['spread or rest', /\.\.\./],
    ['a class', /\bclass\s/],
    ['a lookbehind', /\(\?</],
    ['a let declaration', /\blet\s+[\w${[]/],
    ['a const declaration', /\bconst\s+[\w${[]/],
  ])('AC-31: the code has no %s', (_label, pattern) => {
    expect(source().length).toBeGreaterThan(0);
    expect(code()).not.toMatch(pattern);
  });
});

// ---- AC-32, AC-33, AC-34: the function run in node:vm -------------------------------------------------

type Handler = (event: unknown) => unknown;

/** The file with the placeholder replaced, run in a fresh context; returns its `handler`. */
function loadHandler(canonicalHost: string): Handler {
  const source = readLabFile('functions/viewer-request.js').replaceAll(
    '__CANONICAL_HOST__',
    canonicalHost,
  );
  const result: unknown = vm.runInNewContext(
    `${source}\n;typeof handler === 'function' ? handler : undefined;`,
    {},
  );
  if (typeof result !== 'function') throw new Error('viewer-request.js does not define handler');
  return result as Handler;
}

type Querystring = Record<string, { value: string; multiValue?: { value: string }[] }>;

function makeEvent(uri: string, host: string, querystring: Querystring = {}): { request: unknown } {
  return {
    request: {
      method: 'GET',
      uri,
      querystring,
      headers: { host: { value: host } },
      cookies: {},
    },
  };
}

/** What the function returns, as plain JSON (the vm realm has its own Object prototype). */
function run(canonicalHost: string, uri: string, host: string, querystring?: Querystring): unknown {
  const result = loadHandler(canonicalHost)(makeEvent(uri, host, querystring));
  return JSON.parse(JSON.stringify(result)) as unknown;
}

const unchanged = (uri: string, host: string, querystring?: Querystring): unknown =>
  makeEvent(uri, host, querystring).request;

const SITE = 'site.example.com';
const CF_HOST = 'd111.cloudfront.net';
const q = (value: string): Querystring[string] => ({ value });

describe('AC-32: rules without a canonical host', () => {
  test.each([
    ['/', '/index.html'],
    ['/d1/', '/d1/index.html'],
    ['/d1/d2/', '/d1/d2/index.html'],
  ])('AC-32: a directory uri %s is rewritten to %s', (uri, expected) => {
    const result = run('', uri, SITE) as { uri?: string; statusCode?: number };
    expect(result.statusCode).toBeUndefined();
    expect(result.uri).toBe(expected);
  });

  test('AC-32: a rewritten request keeps everything else (headers, method, query string)', () => {
    const qs = { a: q('1') };
    expect(run('', '/d1/', SITE, qs)).toEqual({
      ...(unchanged('/d1/', SITE, qs) as object),
      uri: '/d1/index.html',
    });
  });

  test.each(['/d1/t1.html', '/_astro/x.js', '/404.html'])(
    'AC-32: the file uri %s is returned unchanged',
    (uri) => {
      expect(run('', uri, SITE)).toEqual(unchanged(uri, SITE));
    },
  );

  test.each([
    ['/d1', {}, '/d1/'],
    ['/d1', { a: q('1'), b: q('') }, '/d1/?a=1&b='],
    ['/v1.2/page', {}, '/v1.2/page/'],
  ] as [string, Querystring, string][])(
    'AC-32: %s without a trailing slash is a relative 301 to the slash form',
    (uri, qs, location) => {
      const result = run('', uri, SITE, qs) as {
        statusCode: number;
        headers: { location: { value: string } };
      };
      expect(result.statusCode).toBe(301);
      expect(result.headers.location.value).toBe(location);
    },
  );

  test('AC-32: a multi-value key is kept as a=1&a=2', () => {
    const qs: Querystring = { a: { value: '1', multiValue: [{ value: '1' }, { value: '2' }] } };
    const result = run('', '/d1', SITE, qs) as { headers: { location: { value: string } } };
    expect(result.headers.location.value).toBe('/d1/?a=1&a=2');
  });

  test('AC-32: the query string keeps the order in which the keys arrive (no sorting)', () => {
    const result = run('', '/d1', SITE, { b: q('1'), a: q('2') }) as {
      headers: { location: { value: string } };
    };
    expect(result.headers.location.value).toBe('/d1/?b=1&a=2');
  });

  test('AC-32: a value like a%26b is not re-encoded or decoded', () => {
    const result = run('', '/d1', SITE, { q: q('a%26b') }) as {
      headers: { location: { value: string } };
    };
    expect(result.headers.location.value).toBe('/d1/?q=a%26b');
  });

  test.each([
    ['/d1/', '/d1/index.html'],
    ['/', '/index.html'],
  ])('AC-32: a *.cloudfront.net host is never redirected (%s is rewritten)', (uri, expected) => {
    const result = run('', uri, 'x.cloudfront.net') as { uri?: string; statusCode?: number };
    expect(result.statusCode).toBeUndefined();
    expect(result.uri).toBe(expected);
  });

  test('AC-32: a *.cloudfront.net host still gets the relative 301 of rule 3, not a redirect to a host', () => {
    const result = run('', '/d1', 'x.cloudfront.net') as {
      headers: { location: { value: string } };
    };
    expect(result.headers.location.value).toBe('/d1/');
  });

  test('AC-32: a file uri on a *.cloudfront.net host is returned unchanged', () => {
    expect(run('', '/a.css', 'x.cloudfront.net')).toEqual(unchanged('/a.css', 'x.cloudfront.net'));
  });
});

describe('AC-33: rules with a canonical host', () => {
  const location = (result: unknown): string =>
    (result as { headers: { location: { value: string } } }).headers.location.value;

  test('AC-33: a *.cloudfront.net host with a directory uri gets a 301 to the canonical host', () => {
    const result = run(SITE, '/d1/', CF_HOST) as { statusCode: number };
    expect(result.statusCode).toBe(301);
    expect(location(result)).toBe('https://site.example.com/d1/');
  });

  test('AC-33: the root uri redirects to the canonical root (no index.html in the location)', () => {
    expect(location(run(SITE, '/', CF_HOST))).toBe('https://site.example.com/');
  });

  test('AC-33: a uri without a slash and a query string is one 301 to the slash form on the canonical host', () => {
    const result = run(SITE, '/d1', CF_HOST, { q: q('x') }) as { statusCode: number };
    expect(result.statusCode).toBe(301);
    expect(location(result)).toBe('https://site.example.com/d1/?q=x');
  });

  test('AC-33: a file uri redirects to the same path on the canonical host', () => {
    const result = run(SITE, '/a.css', CF_HOST) as { statusCode: number };
    expect(result.statusCode).toBe(301);
    expect(location(result)).toBe('https://site.example.com/a.css');
  });

  test('AC-33: a file uri keeps its query string in the redirect', () => {
    expect(location(run(SITE, '/a.css', CF_HOST, { v: q('1') }))).toBe(
      'https://site.example.com/a.css?v=1',
    );
  });

  test('AC-33: the host is compared in lower case (D111.CloudFront.NET is redirected too)', () => {
    const result = run(SITE, '/d1/', 'D111.CloudFront.NET') as { statusCode: number };
    expect(result.statusCode).toBe(301);
    expect(location(result)).toBe('https://site.example.com/d1/');
  });

  test('AC-33: the canonical host itself gets the rules of AC-32 (rewrite)', () => {
    const result = run(SITE, '/d1/', SITE) as { uri?: string; statusCode?: number };
    expect(result.statusCode).toBeUndefined();
    expect(result.uri).toBe('/d1/index.html');
  });

  test('AC-33: the canonical host itself gets the rules of AC-32 (relative 301)', () => {
    const result = run(SITE, '/d1', SITE) as { statusCode: number };
    expect(result.statusCode).toBe(301);
    expect(location(result)).toBe('/d1/');
  });

  test('AC-33: the canonical host itself gets the rules of AC-32 (file unchanged)', () => {
    expect(run(SITE, '/a.css', SITE)).toEqual(unchanged('/a.css', SITE));
  });
});

describe('AC-34: the shape of every 301', () => {
  const cases: [string, string, string, string, Querystring][] = [
    ['relative redirect', '', '/d1', SITE, {}],
    ['relative redirect with a query string', '', '/d1', SITE, { a: q('1') }],
    ['redirect to the canonical host', SITE, '/d1/', CF_HOST, {}],
    ['redirect of a file to the canonical host', SITE, '/a.css', CF_HOST, { v: q('1') }],
  ];

  test.each(cases)(
    'AC-34: %s has statusDescription Moved Permanently',
    (_l, host, uri, reqHost, qs) => {
      const result = run(host, uri, reqHost, qs) as {
        statusCode: number;
        statusDescription: string;
      };
      expect(result.statusCode).toBe(301);
      expect(result.statusDescription).toBe('Moved Permanently');
    },
  );

  test.each(cases)('AC-34: %s has only a location header', (_l, host, uri, reqHost, qs) => {
    const result = run(host, uri, reqHost, qs) as {
      statusCode: number;
      headers: Record<string, { value: string }>;
    };
    expect(result.statusCode).toBe(301);
    expect(Object.keys(result.headers)).toEqual(['location']);
    expect(typeof result.headers['location']?.value).toBe('string');
  });

  test.each(cases)(
    'AC-34: %s has no other property than the three of the response',
    (_l, host, uri, reqHost, qs) => {
      const result = run(host, uri, reqHost, qs) as object;
      expect(Object.keys(result).sort()).toEqual(['headers', 'statusCode', 'statusDescription']);
    },
  );
});

// ---- Added after review round 1 (AC-51, AC-52) ---------------------------------------------------------

// AC-51: no protocol-relative 301 locations. A uri that starts with // used to give
// `location: //evil/`, which a browser resolves to another host.

const REDIRECT_BASE = 'https://site.example.com/x';
const EVIL_URIS = ['//evil.example', '//evil%E3%80%82com', '///evil%2ecom', '//evil', '////evil/x'];

interface Outcome {
  statusCode?: number;
  headers?: { location?: { value?: string } };
}

/** The 301 location of a response, or undefined when the function did not redirect. */
function locationOf(result: unknown): string | undefined {
  const outcome = result as Outcome;
  return outcome.statusCode === 301 ? (outcome.headers?.location?.value ?? '') : undefined;
}

describe.each(['', SITE])(
  'AC-51: canonical host "%s": uris that start with several slashes',
  (canonical) => {
    test.each(EVIL_URIS)(
      'AC-51: %s on the site host never gives a protocol-relative 301',
      (uri) => {
        const location = locationOf(run(canonical, uri, SITE));
        if (location === undefined) return; // a file-like uri is served as it is: nothing to redirect
        expect(location.startsWith('/')).toBe(true);
        expect(location.startsWith('//')).toBe(false);
        expect(new URL(location, REDIRECT_BASE).host).toBe('site.example.com');
      },
    );

    test.each([
      ['//evil', '/evil/'],
      ['//evil%E3%80%82com', '/evil%E3%80%82com/'],
      ['///evil%2ecom', '/evil%2ecom/'],
      ['////evil/x', '/evil/x/'],
    ])('AC-51: %s redirects to %s (the leading slashes collapse to one)', (uri, expected) => {
      expect(locationOf(run(canonical, uri, SITE))).toBe(expected);
    });

    test('AC-51: the query string is kept after the collapsed path', () => {
      expect(locationOf(run(canonical, '//evil', SITE, { a: q('1') }))).toBe('/evil/?a=1');
    });

    test('AC-51: only the leading run collapses: slashes inside the path stay', () => {
      expect(locationOf(run(canonical, '//a//b', SITE))).toBe('/a//b/');
    });

    test('AC-51: a request rewrite (uri ending in a slash) is unchanged', () => {
      const result = run(canonical, '//a/', SITE) as { uri?: string; statusCode?: number };
      expect(result.statusCode).toBeUndefined();
      expect(result.uri).toBe('//a/index.html');
    });
  },
);

describe('AC-51: on a *.cloudfront.net host with a canonical host', () => {
  test.each(EVIL_URIS)('AC-51: %s redirects to the canonical host and nowhere else', (uri) => {
    const location = locationOf(run(SITE, uri, CF_HOST));
    expect(location).toBeDefined();
    expect(location?.startsWith('https://site.example.com/')).toBe(true);
    expect(new URL(location ?? '', REDIRECT_BASE).host).toBe('site.example.com');
  });

  test.each([
    ['//evil', 'https://site.example.com/evil/'],
    ['//evil.example', 'https://site.example.com/evil.example'],
    ['///evil%2ecom', 'https://site.example.com/evil%2ecom/'],
    ['////evil/x', 'https://site.example.com/evil/x/'],
  ])('AC-51: %s redirects to %s (the leading slashes collapse to one)', (uri, expected) => {
    expect(locationOf(run(SITE, uri, CF_HOST))).toBe(expected);
  });
});

describe('AC-51: without a canonical host a *.cloudfront.net host gets the relative rules', () => {
  test.each(EVIL_URIS)('AC-51: %s never gives a protocol-relative 301', (uri) => {
    const location = locationOf(run('', uri, CF_HOST));
    if (location === undefined) return;
    expect(location.startsWith('//')).toBe(false);
    expect(new URL(location, 'https://d111.cloudfront.net/x').host).toBe('d111.cloudfront.net');
  });
});

// AC-52: every checkov skip sits inside the resource block that the spec section 11 assigns it to.

/** The HCL text with comments replaced by spaces, so that offsets still match the original. */
function blankHclComments(text: string): string {
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
      while (i < text.length && text.charAt(i) !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (two === '/*') {
      const found = text.indexOf('*/', i + 2);
      const end = found === -1 ? text.length : found + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The `type.name` of the resource block that contains `offset`, or undefined. */
function enclosingResource(text: string, offset: number): string | undefined {
  const blank = blankHclComments(text);
  for (const match of blank.matchAll(/\bresource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    if (offset > open && offset < closeBrace(blank, open)) return `${match[1]}.${match[2]}`;
  }
  return undefined;
}

const BUCKET_SKIPS = ['CKV_AWS_144', 'CKV_AWS_145', 'CKV2_AWS_62', 'CKV_AWS_18'];
const SKIP_HOMES: Record<string, string[]> = {
  'aws_cloudfront_distribution.site': [
    'CKV_AWS_68',
    'CKV2_AWS_47',
    'CKV_AWS_310',
    'CKV_AWS_374',
    'CKV_AWS_86',
    'CKV_AWS_174',
    'CKV2_AWS_42',
  ],
  'aws_cloudfront_response_headers_policy.site': ['CKV_AWS_259'],
  'aws_s3_bucket.site': BUCKET_SKIPS,
  'aws_s3_bucket.logs': [...BUCKET_SKIPS, 'CKV_AWS_21'],
};

/** Skips that are outside every resource or inside a resource that is not their home. */
function misplacedSkips(files: { name: string; raw: string }[]): string[] {
  return files.flatMap((file) =>
    [...file.raw.matchAll(/#\s*checkov:skip=([^\s:]+)/g)].flatMap((match) => {
      const id = match[1] ?? '';
      const home = enclosingResource(file.raw, match.index);
      return home !== undefined && (SKIP_HOMES[home] ?? []).includes(id)
        ? []
        : [`${file.name}: ${id} is in ${home ?? 'no resource'}`];
    }),
  );
}

describe('AC-52: the placement check works (self-check)', () => {
  const resource = (type: string, name: string, body: string): string =>
    `resource "${type}" "${name}" {\n${body}\n}\n`;
  const skip = (id: string): string => `  #checkov:skip=${id}:a reason\n`;

  test('AC-52: a skip in its home resource is fine, in another resource or outside any is reported', () => {
    const good = resource('aws_s3_bucket', 'logs', skip('CKV_AWS_21'));
    expect(misplacedSkips([{ name: 'a.tf', raw: good }])).toEqual([]);
    const wrongBucket = resource('aws_s3_bucket', 'site', skip('CKV_AWS_21'));
    expect(misplacedSkips([{ name: 'a.tf', raw: wrongBucket }])).toHaveLength(1);
    const wrongType = resource('aws_s3_bucket_policy', 'site', skip('CKV_AWS_145'));
    expect(misplacedSkips([{ name: 'a.tf', raw: wrongType }])).toHaveLength(1);
    const outside = `${skip('CKV_AWS_145')}${good}`;
    expect(misplacedSkips([{ name: 'a.tf', raw: outside }])).toHaveLength(1);
  });

  test('AC-52: braces and quotes inside comments do not move the resource boundaries', () => {
    const raw = resource(
      'aws_s3_bucket',
      'site',
      `  # a comment with a } and a " in it\n${skip('CKV_AWS_145')}`,
    );
    expect(misplacedSkips([{ name: 'a.tf', raw }])).toEqual([]);
  });
});

describe('AC-52: checkov skips are inside the resource block the spec assigns them to', () => {
  test('AC-52: every skip of the lab is in its home resource', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(misplacedSkips(files)).toEqual([]);
  });

  test('AC-52: the lab has skips to check', () => {
    const count = loadTerraformFiles().flatMap((file) => [
      ...file.raw.matchAll(/#\s*checkov:skip=/g),
    ]).length;
    expect(count).toBeGreaterThan(0);
  });
});
