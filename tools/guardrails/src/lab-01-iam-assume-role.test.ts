import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 040 (issue #110): contract tests over the real files of labs/01-iam-assume-role (AC-1 to
// AC-4 and AC-25 to AC-27). The behaviour of the stack (roles, policies, validation) is covered by
// `terraform test` (labs/01-iam-assume-role/tests) and the behaviour of verify.sh by
// lab-01-verify.test.ts; this file covers what those cannot see: the layout, the HCL text, the
// example tfvars and the reader docs.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/01-iam-assume-role';
const LAB_00 = 'labs/00-site-hosting';

function pathIn(lab: string, ...segments: string[]): string {
  return join(REPO_ROOT, ...lab.split('/'), ...segments);
}

/** Reads a file of a lab; a missing file fails the test with a readable message. */
function readIn(lab: string, name: string): string {
  const path = pathIn(lab, ...name.split('/'));
  if (!existsSync(path)) throw new Error(`missing file: ${lab}/${name}`);
  return readFileSync(path, 'utf8');
}

const readLabFile = (name: string): string => readIn(LAB, name);

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

/** The body without the nested blocks that start with `header`. */
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

/** Every top-level `.tf` file of the lab (git-ignored `*_override.tf` excluded). */
function loadTerraformFiles(): TerraformFile[] {
  const dir = pathIn(LAB);
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

/** Bodies of the `variable "<name>"` block of the lab; exactly one is expected. */
function variableBody(name: string): string {
  const bodies = blockBodies(allTerraform(), new RegExp(`\\bvariable\\s+"${name}"\\s*\\{`));
  if (bodies.length !== 1) {
    throw new Error(`expected one variable "${name}" in ${LAB}/*.tf, found ${bodies.length}`);
  }
  return bodies[0] ?? '';
}

function resourceBody(type: string, name: string): string {
  const bodies = blockBodies(
    allTerraform(),
    new RegExp(`\\bresource\\s+"${type}"\\s+"${name}"\\s*\\{`),
  );
  if (bodies.length !== 1) {
    throw new Error(
      `expected one resource "${type}" "${name}" in ${LAB}/*.tf, found ${bodies.length}`,
    );
  }
  return bodies[0] ?? '';
}

/** The `error_message` strings of the blocks named `kind` (validation, precondition) in a body. */
function errorMessages(body: string, kind: string): string[] {
  return blockBodies(body, new RegExp(`\\b${kind}\\s*\\{`)).map(
    (block) => /error_message\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1] ?? '',
  );
}

/** Names of the `<keyword> "<a>"[ "<b>"]` blocks across the top-level files, sorted. */
function declared(keyword: string, labels: 1 | 2): string[] {
  const label = '\\s+"([^"]+)"';
  const header = new RegExp(`^\\s*${keyword}${label}${labels === 2 ? label : ''}\\s*\\{`, 'gm');
  const found: string[] = [];
  for (const match of allTerraform().matchAll(header)) {
    found.push(labels === 2 ? `${match[1]}.${match[2]}` : (match[1] ?? ''));
  }
  return found.sort();
}

// ---- Markdown ---------------------------------------------------------------------------------------

interface Heading {
  level: number;
  text: string;
  line: number;
}

interface Block {
  lang: string;
  body: string;
  line: number;
}

/** Headings and code blocks of a markdown text; lines inside code fences are never headings. */
function scan(markdown: string): { headings: Heading[]; blocks: Block[]; lines: string[] } {
  const lines = markdown.split(/\r?\n/);
  const headings: Heading[] = [];
  const blocks: Block[] = [];
  let open: { lang: string; start: number; body: string[] } | undefined;
  lines.forEach((line, index) => {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (open !== undefined) {
      if (fence !== null && fence[1] === '') {
        blocks.push({ lang: open.lang, body: open.body.join('\n'), line: open.start });
        open = undefined;
      } else {
        open.body.push(line);
      }
      return;
    }
    if (fence !== null) {
      open = { lang: fence[1] ?? '', start: index, body: [] };
      return;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading !== null) {
      headings.push({
        level: (heading[1] as string).length,
        text: heading[2] as string,
        line: index,
      });
    }
  });
  return { headings, blocks, lines };
}

/** The text under a heading, up to the next heading of the same or a higher level. */
function sectionOf(markdown: string, level: number, title: string): string | undefined {
  const { headings, lines } = scan(markdown);
  const start = headings.find((heading) => heading.level === level && heading.text === title);
  if (start === undefined) return undefined;
  const end = headings.find((heading) => heading.line > start.line && heading.level <= level);
  return lines.slice(start.line + 1, end === undefined ? lines.length : end.line).join('\n');
}

function need(text: string | undefined, what: string): string {
  if (text === undefined) throw new Error(`missing: ${what}`);
  return text;
}

// =================================================================================================
// AC-1: versions, providers, tags, lock file
// =================================================================================================

/** The `version = "..."` of the hashicorp/aws entry of a versions.tf. */
function awsVersionOf(lab: string): string {
  const bodies = blockBodies(
    stripHclComments(readIn(lab, 'versions.tf')),
    /\brequired_providers\s*\{/,
  );
  expect(bodies, `${lab}/versions.tf has one required_providers block`).toHaveLength(1);
  const body = bodies[0] ?? '';
  expect(body).toMatch(/^\s*source\s*=\s*"hashicorp\/aws"\s*$/m);
  const version = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(body)?.[1];
  expect(version, `${lab}/versions.tf pins hashicorp/aws`).toBeDefined();
  return version ?? '';
}

function lockVersionOf(lab: string): string {
  const lock = readIn(lab, '.terraform.lock.hcl');
  expect(lock).toMatch(/^provider\s+"registry\.terraform\.io\/hashicorp\/aws"\s*\{/m);
  const version = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(lock)?.[1];
  expect(version, `${lab}/.terraform.lock.hcl pins hashicorp/aws`).toBeDefined();
  return version ?? '';
}

function h1Hashes(lab: string): string[] {
  return readIn(lab, '.terraform.lock.hcl').match(/"h1:[A-Za-z0-9+/=]+"/g) ?? [];
}

describe('AC-1: versions, providers, tags and lock file', () => {
  test('AC-1: versions.tf requires Terraform >= 1.14.0', () => {
    expect(stripHclComments(readLabFile('versions.tf'))).toMatch(
      /^\s*required_version\s*=\s*">=\s*1\.14\.0"\s*$/m,
    );
  });

  test('AC-1: versions.tf pins hashicorp/aws to exactly the version lab 00 pins', () => {
    const version = awsVersionOf(LAB);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe(awsVersionOf(LAB_00));
  });

  test('AC-1: versions.tf has one s3 backend with region eu-west-1, use_lockfile and no bucket or key', () => {
    const bodies = blockBodies(
      stripHclComments(readLabFile('versions.tf')),
      /\bbackend\s+"s3"\s*\{/,
    );
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(body).toMatch(/^\s*region\s*=\s*"eu-west-1"\s*$/m);
    expect(body).toMatch(/^\s*use_lockfile\s*=\s*true\s*$/m);
    for (const attribute of ['bucket', 'key']) {
      expect(body, `backend sets ${attribute}`).not.toMatch(
        new RegExp(`^\\s*${attribute}\\s*=`, 'm'),
      );
    }
  });

  const providers = (): string[] =>
    blockBodies(stripHclComments(readLabFile('providers.tf')), /\bprovider\s+"[^"]+"\s*\{/);

  test('AC-1: providers.tf has exactly one provider "aws" (no alias)', () => {
    const awsProviders = blockBodies(
      stripHclComments(readLabFile('providers.tf')),
      /\bprovider\s+"aws"\s*\{/,
    );
    expect(awsProviders).toHaveLength(1);
    expect(providers()).toHaveLength(1);
    expect(awsProviders[0]).not.toMatch(/^\s*alias\s*=/m);
  });

  test('AC-1: the aws provider is in eu-west-1', () => {
    const [body = ''] = providers();
    expect(providers()).toHaveLength(1);
    expect(body).toMatch(/^\s*region\s*=\s*"eu-west-1"\s*$/m);
  });

  test('AC-1: the aws provider sets default_tags { tags = module.tags.tags }', () => {
    const [body = ''] = providers();
    expect(providers()).toHaveLength(1);
    const defaultTags = blockBodies(body, /\bdefault_tags\s*\{/);
    expect(defaultTags).toHaveLength(1);
    expect(defaultTags[0]).toMatch(/^\s*tags\s*=\s*module\.tags\.tags\s*$/m);
  });

  test('AC-1: the aws provider sets only region and default_tags', () => {
    const [body = ''] = providers();
    expect(providers()).toHaveLength(1);
    const rest = withoutBlock(body, /\bdefault_tags\s*\{/);
    const names = [...rest.matchAll(/^\s*([a-z_0-9]+)\s*=/gm)].map((match) => match[1]);
    expect(names).toEqual(['region']);
  });

  test('AC-1: main.tf has module "tags" with source ../../modules/tags and lab = "01-iam-assume-role"', () => {
    const bodies = blockBodies(stripHclComments(readLabFile('main.tf')), /\bmodule\s+"tags"\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/tags"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*lab\s*=\s*"01-iam-assume-role"\s*$/m);
  });

  test('AC-1: the lock file pins hashicorp/aws to the version of the lab 00 lock file', () => {
    expect(lockVersionOf(LAB)).toBe(lockVersionOf(LAB_00));
  });

  test('AC-1: the lock file holds every h1 hash of the lab 00 lock file (Linux and Windows)', () => {
    const own = new Set(h1Hashes(LAB));
    expect(own.size).toBeGreaterThanOrEqual(2);
    for (const hash of new Set(h1Hashes(LAB_00))) expect(own, hash).toContain(hash);
  });
});

// =================================================================================================
// AC-2, AC-3: the blocks of the stack, variables and outputs
// =================================================================================================

describe('AC-2: the blocks of the stack', () => {
  test('AC-2: the resources are exactly the nine of the spec', () => {
    expect(declared('resource', 2)).toEqual(
      [
        'aws_iam_role.caller',
        'aws_iam_role.target',
        'aws_iam_role_policy.caller',
        'aws_iam_role_policy.target',
        'aws_s3_bucket.reports',
        'aws_s3_bucket_public_access_block.reports',
        'aws_s3_bucket_ownership_controls.reports',
        'aws_s3_bucket_server_side_encryption_configuration.reports',
        'aws_s3_bucket_policy.reports',
      ].sort(),
    );
  });

  test('AC-2: the only data block is aws_caller_identity.current', () => {
    expect(declared('data', 2)).toEqual(['aws_caller_identity.current']);
  });

  test('AC-2: the only module block is tags', () => {
    expect(declared('module', 1)).toEqual(['tags']);
  });
});

describe('AC-3: variables and outputs', () => {
  test('AC-3: the variables are exactly external_id and trusted_account_id', () => {
    expect(declared('variable', 1)).toEqual(['external_id', 'trusted_account_id']);
  });

  test.each(['external_id', 'trusted_account_id'])(
    'AC-3: every validation error_message of %s starts with its own name and "must be"',
    (name) => {
      const messages = errorMessages(variableBody(name), 'validation');
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) expect(message).toMatch(new RegExp(`^${name} must be`));
    },
  );

  test('AC-3: roles.tf holds the precondition message of aws_iam_role.target', () => {
    const roles = stripHclComments(readLabFile('roles.tf'));
    const body = blockBodies(roles, /\bresource\s+"aws_iam_role"\s+"target"\s*\{/);
    expect(body).toHaveLength(1);
    const lifecycle = blockBodies(body[0] ?? '', /\blifecycle\s*\{/);
    expect(lifecycle).toHaveLength(1);
    expect(errorMessages(lifecycle[0] ?? '', 'precondition')).toContain(
      'trusted_account_id must be another account: this account is already trusted.',
    );
  });

  test('AC-3: the precondition lives on aws_iam_role.target in the stack', () => {
    expect(resourceBody('aws_iam_role', 'target')).toContain(
      'trusted_account_id must be another account: this account is already trusted.',
    );
  });

  test('AC-3: the outputs are the five of the spec', () => {
    expect(declared('output', 1)).toEqual(
      [
        'caller_role_arn',
        'target_role_arn',
        'reports_bucket_name',
        'external_id',
        'trusted_account_id',
      ].sort(),
    );
  });

  test('AC-3: every output block has a non-empty description', () => {
    const bodies = blockBodies(allTerraform(), /\boutput\s+"[^"]+"\s*\{/);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const description = /^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(body)?.[1];
      expect(description?.trim() ?? '', body.trim().split('\n')[0]).not.toBe('');
    }
  });
});

// =================================================================================================
// AC-4: terraform.tfvars.example
// =================================================================================================

describe('AC-4: terraform.tfvars.example', () => {
  const example = (): string => readLabFile('terraform.tfvars.example');

  test('AC-4: it mentions external_id', () => {
    expect(example()).toContain('external_id');
  });

  test('AC-4: trusted_account_id appears as a commented-out assignment only', () => {
    expect(example()).toMatch(/^\s*#\s*trusted_account_id\s*=/m);
    expect(example()).not.toMatch(/^\s*trusted_account_id\s*=/m);
  });

  test('AC-4: it names TF_VAR_TRUSTED_ACCOUNT_ID', () => {
    expect(example()).toContain('TF_VAR_TRUSTED_ACCOUNT_ID');
  });

  test('AC-4: it says the plan log is public', () => {
    expect(example()).toMatch(/\bpublic\b/);
  });
});

// =================================================================================================
// AC-25, AC-26: README.md and break-it.md
// =================================================================================================

const README_HEADINGS = [
  '# Lab 01: IAM role assumption and a permissions boundary',
  '## What you build',
  '## Cost',
  '## Prerequisites',
  '## Inputs',
  '## Quick start in your own account',
  '## Observe',
  '## Optional: a real second account',
  '## Verify',
  '## Destroy now',
];

const README_STRINGS = [
  'iam-cross-account-assume-role',
  '/d1/1-1-secure-access/',
  'fg-workload-boundary',
  '--external-id',
  'VERIFY_ASSUME=1',
  'lab.tfplan',
  'terraform destroy',
  '$0.00',
  'report.txt',
  'same account',
  'explicit deny in a permissions boundary',
];

describe('AC-25: README.md', () => {
  const readme = (): string => readLabFile('README.md');

  test('AC-25: the # and ## headings are exactly the ten of the spec, in order', () => {
    const headings = scan(readme())
      .headings.filter((heading) => heading.level <= 2)
      .map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
    expect(headings).toEqual(README_HEADINGS);
  });

  test('AC-25: it has a mermaid block with a flowchart', () => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    expect(block, 'no mermaid code block').toBeDefined();
    expect(block?.body).toContain('flowchart');
  });

  test('AC-25: the flowchart names the caller, STS, the reports reader, the bucket and the boundary', () => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    const body = block?.body ?? '';
    expect(body, 'no mermaid code block').not.toBe('');
    expect(body).toMatch(/caller/i);
    expect(body).toMatch(/\bSTS\b/);
    expect(body).toMatch(/reports[ -]?reader/i);
    expect(body).toMatch(/bucket/i);
    expect(body).toMatch(/boundary/i);
  });

  test.each(README_STRINGS)('AC-25: it contains "%s"', (needle) => {
    expect(readme()).toContain(needle);
  });
});

const BREAK_SECTIONS = [
  "The trust policy doesn't allow",
  'The caller lacks sts:AssumeRole',
  'Wrong external ID',
  'The boundary caps the caller',
];

describe('AC-26: break-it.md', () => {
  const breakIt = (): string => readLabFile('break-it.md');

  test('AC-26: it starts with its title', () => {
    const first = breakIt()
      .split(/\r?\n/)
      .find((line) => line.trim() !== '');
    expect(first).toBe('# Break lab 01 on purpose');
  });

  test('AC-26: it has exactly the four ## sections of the spec, in order', () => {
    const headings = scan(breakIt())
      .headings.filter((heading) => heading.level === 2)
      .map((heading) => heading.text);
    expect(headings).toEqual(BREAK_SECTIONS);
  });

  test.each(BREAK_SECTIONS)('AC-26: the section "%s" has the four parts', (title) => {
    const section = need(sectionOf(breakIt(), 2, title), `## ${title}`);
    for (const part of ['What to do', 'What you see', 'Why', 'Put it back']) {
      expect(section, part).toContain(part);
    }
  });

  test.each(['ec2.amazonaws.com', 'AssumeReportsReader', 'create-role'])(
    'AC-26: it mentions %s',
    (needle) => {
      expect(breakIt()).toContain(needle);
    },
  );

  test('AC-26: it does not mention create-user', () => {
    expect(breakIt()).not.toContain('create-user');
  });
});

// =================================================================================================
// AC-27: nothing private in the reader-facing files
// =================================================================================================

const ALLOWED_NUMBERS = new Set(['111122223333', '444455556666']);
const COURSE_SECTION = /[Ss]ection \d/;

function twelveDigitNumbers(text: string): string[] {
  return (text.match(/(?<!\d)\d{12}(?!\d)/g) ?? []).filter(
    (digits) => !ALLOWED_NUMBERS.has(digits),
  );
}

describe('AC-27: no account ids, course section references or AdministratorAccess', () => {
  const FILES = ['README.md', 'break-it.md', 'verify.sh', 'terraform.tfvars.example'];

  const checkText = (label: string, text: string): void => {
    expect(twelveDigitNumbers(text), `${label}: 12-digit numbers`).toEqual([]);
    expect(text, `${label}: course section reference`).not.toMatch(COURSE_SECTION);
    expect(text, `${label}: AdministratorAccess`).not.toContain('AdministratorAccess');
  };

  test.each(FILES)('AC-27: %s has none of them', (name) => {
    checkText(name, readLabFile(name));
  });

  test('AC-27: no top-level .tf file has any of them', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) checkText(file.name, file.raw);
  });
});

// =================================================================================================
// Review round 1: AC-28 to AC-30 and AC-33 (regression tests)
// =================================================================================================

describe('AC-28: no managed policies on the role resources', () => {
  test('AC-28: no top-level .tf file contains managed_policy_arns', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.text, file.name).not.toMatch(/\bmanaged_policy_arns\b/);
  });

  test('AC-28: no top-level .tf file contains an inline_policy block', () => {
    const files = loadTerraformFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.text, file.name).not.toMatch(/\binline_policy\b/);
  });
});

describe('AC-29: the bucket sub-resources are ordered after the bucket', () => {
  test.each([
    'aws_s3_bucket_public_access_block',
    'aws_s3_bucket_ownership_controls',
    'aws_s3_bucket_server_side_encryption_configuration',
    'aws_s3_bucket_policy',
  ])('AC-29: %s.reports depends on or references aws_s3_bucket.reports', (type) => {
    expect(resourceBody(type, 'reports')).toMatch(/\baws_s3_bucket\.reports\b/);
  });
});

/** The text inside every `<( ... )` of a markdown text (quotes and nested parentheses respected). */
function processSubstitutions(text: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('<(', from);
    if (start === -1) return found;
    let depth = 1;
    let quote = '';
    let i = start + 2;
    while (i < text.length && depth > 0) {
      const c = text.charAt(i);
      if (quote !== '') {
        if (c === quote) quote = '';
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === '(') {
        depth += 1;
      } else if (c === ')') {
        depth -= 1;
      }
      i += 1;
    }
    found.push(text.slice(start + 2, i - 1));
    from = i;
  }
}

describe('AC-30: aws output read through a process substitution has its CR removed', () => {
  const awsSubstitutions = (name: string): string[] =>
    processSubstitutions(readLabFile(name)).filter((inner) => /\baws\b/.test(inner));

  test('AC-30: README.md has process substitutions that read aws output', () => {
    expect(awsSubstitutions('README.md').length).toBeGreaterThan(0);
  });

  test.each(['README.md', 'break-it.md'])(
    "AC-30: every aws process substitution of %s ends with | tr -d '\\r'",
    (name) => {
      for (const inner of awsSubstitutions(name)) {
        expect(inner.trim(), inner.trim().slice(0, 60)).toMatch(/\|\s*tr\s+-d\s+'\\r'$/);
      }
    },
  );
});

describe('AC-33: README links and the Observe copy step', () => {
  const GUIDE_PATH = '../../apps/site/src/content/docs/d1/1-1-secure-access/';

  test('AC-33: README links the guide page repo-relatively', () => {
    expect(readLabFile('README.md')).toContain(`](${GUIDE_PATH}`);
  });

  test('AC-33: the repo-relative guide link resolves to a directory of the repo', () => {
    expect(existsSync(pathIn(LAB, ...GUIDE_PATH.split('/')))).toBe(true);
  });

  test.each(['README.md', 'break-it.md'])('AC-33: %s does not name a site domain', (name) => {
    expect(readLabFile(name)).not.toContain('tech-leads.lol');
  });

  test('AC-33: Observe says the copy as the caller fails with 403 (Forbidden)', () => {
    const observe = need(sectionOf(readLabFile('README.md'), 2, 'Observe'), '## Observe');
    expect(observe).toMatch(/\b403\b/);
    expect(observe).toContain('Forbidden');
  });

  test('AC-33: Observe still says the list fails with AccessDenied', () => {
    const observe = need(sectionOf(readLabFile('README.md'), 2, 'Observe'), '## Observe');
    expect(observe).toContain('AccessDenied');
  });
});

// =================================================================================================
// Fix after the first apply: AC-34 (the demo action can't be shadowed by the Organization SCP)
// =================================================================================================

/** The `{ ... }` block that encloses `index`: the innermost one, found by walking backwards. */
function enclosingBlock(text: string, index: number): string {
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = text.charAt(i);
    if (c === '}') depth += 1;
    if (c === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth -= 1;
    }
  }
  if (open === -1) throw new Error('no enclosing block');
  return text.slice(open, closeBrace(text, open));
}

/** The quoted values of the `Action = ...` attribute of a statement (`NotAction` is not read). */
function actionsOf(statement: string): string[] {
  const match = /(?<![A-Za-z_])Action\s*=\s*(\[[^\]]*\]|"[^"]*")/.exec(statement);
  if (!match) return [];
  return [...(match[1] ?? '').matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1] ?? '');
}

function repoText(...segments: string[]): string {
  const path = join(REPO_ROOT, ...segments);
  if (!existsSync(path)) throw new Error(`missing file: ${segments.join('/')}`);
  return stripHclComments(readFileSync(path, 'utf8'));
}

/** The Action list of the statement of the caller policy that has the given Sid (roles.tf). */
function callerStatementActions(sid: string): string[] {
  const text = repoText(...LAB.split('/'), 'roles.tf');
  const at = text.search(new RegExp(`\\bSid\\s*=\\s*"${sid}"`));
  if (at === -1) throw new Error(`no statement with Sid "${sid}" in ${LAB}/roles.tf`);
  const actions = actionsOf(enclosingBlock(text, at));
  if (actions.length === 0) throw new Error(`statement "${sid}" has no Action`);
  return actions;
}

/** An IAM action pattern (`iam:Create*`, `*`) as a case-insensitive regular expression. */
function actionPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

describe('AC-34: the boundary demo action is not shadowed by the SCP', () => {
  const SID = 'CreateRoleDeniedByBoundary';

  test('AC-34: the demo statement allows iam:CreateRole in roles.tf', () => {
    expect(callerStatementActions(SID)).toEqual(['iam:CreateRole']);
  });

  test('AC-34: no Deny statement of the Organization SCP names the demo action', () => {
    const demo = callerStatementActions(SID);
    const scp = repoText('bootstrap', 'management', 'scp.tf');
    const denies = [...scp.matchAll(/\bEffect\s*=\s*"Deny"/g)].map((match) =>
      enclosingBlock(scp, match.index),
    );
    // the SCP has several Deny statements; an empty result would mean the reader found nothing
    expect(denies.length).toBeGreaterThanOrEqual(3);
    const denied = denies.flatMap(actionsOf);
    expect(denied.length).toBeGreaterThan(0);
    for (const action of demo) {
      const shadows = denied.filter((pattern) => actionPattern(pattern).test(action));
      expect(shadows, `${action} is denied by the SCP through`).toEqual([]);
    }
  });

  test('AC-34: deny_role_writes_outside_lab_path in the boundary lists the demo action', () => {
    const demo = callerStatementActions(SID);
    const boundary = repoText('bootstrap', 'workload', 'boundary.tf');
    const bodies = blockBodies(boundary, /\bdeny_role_writes_outside_lab_path\s*=\s*\{/);
    expect(bodies).toHaveLength(1);
    const listed = actionsOf(bodies[0] ?? '');
    expect(listed.length).toBeGreaterThan(0);
    for (const action of demo) expect(listed, action).toContain(action);
  });

  test('AC-34: the lab files do not mention iam:CreateUser, create-user or user/lab01', () => {
    const files = [
      ...loadTerraformFiles().map((file) => ({ name: file.name, text: file.raw })),
      ...['README.md', 'break-it.md', 'verify.sh'].map((name) => ({
        name,
        text: readLabFile(name),
      })),
    ];
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const needle of ['iam:CreateUser', 'create-user', 'user/lab01']) {
      const found = files.filter((file) => file.text.includes(needle)).map((file) => file.name);
      expect(found, `files containing ${needle}`).toEqual([]);
    }
  });
});
