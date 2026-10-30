import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 041 (issue #111): contract tests over the real files of labs/02-s3-kms-encryption (AC-1 to
// AC-4, AC-25 to AC-28) and the cross-check of the guardrails outside the lab (AC-29). The behaviour
// of the stack (key, buckets, policies, role, outputs) is covered by `terraform test`
// (labs/02-s3-kms-encryption/tests) and the behaviour of verify.sh by lab-02-verify.test.ts; this
// file covers what those cannot see: the layout, the HCL text, the reader docs and the guardrail text.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/02-s3-kms-encryption';
const LAB_00 = 'labs/00-site-hosting';
const LAB_01 = 'labs/01-iam-assume-role';

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

/** Every top-level `.tf` file, and a failure when there is none (so a missing lab is red). */
function needTerraformFiles(): TerraformFile[] {
  const files = loadTerraformFiles();
  expect(files.length, `no top-level .tf file in ${LAB}`).toBeGreaterThan(0);
  return files;
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

/** The references listed by the `depends_on = [ ... ]` attribute of a block body. */
function dependsOn(body: string): string[] {
  const match = /^\s*depends_on\s*=\s*\[([^\]]*)\]/m.exec(body);
  if (!match) return [];
  return (match[1] ?? '').split(/[\s,]+/).filter((item) => item !== '');
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

  test('AC-1: main.tf has module "tags" with source ../../modules/tags and lab = "02-s3-kms-encryption"', () => {
    const bodies = blockBodies(stripHclComments(readLabFile('main.tf')), /\bmodule\s+"tags"\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/tags"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*lab\s*=\s*"02-s3-kms-encryption"\s*$/m);
  });

  test('AC-1: the lock file pins hashicorp/aws to the version of the lab 00 lock file', () => {
    expect(lockVersionOf(LAB)).toBe(lockVersionOf(LAB_00));
  });

  test('AC-1: the lock file holds every h1 hash of the lab 01 lock file (Linux and Windows)', () => {
    const own = new Set(h1Hashes(LAB));
    expect(own.size).toBeGreaterThanOrEqual(2);
    for (const hash of new Set(h1Hashes(LAB_01))) expect(own, hash).toContain(hash);
  });
});

// =================================================================================================
// AC-2, AC-3: the blocks of the stack, no variables, outputs, forbidden constructs
// =================================================================================================

const RESOURCES = [
  'aws_kms_key.data',
  'aws_kms_alias.data',
  'aws_s3_bucket.data',
  'aws_s3_bucket_public_access_block.data',
  'aws_s3_bucket_ownership_controls.data',
  'aws_s3_bucket_server_side_encryption_configuration.data',
  'aws_s3_bucket_logging.data',
  'aws_s3_bucket_policy.data',
  'aws_s3_bucket.logs',
  'aws_s3_bucket_public_access_block.logs',
  'aws_s3_bucket_ownership_controls.logs',
  'aws_s3_bucket_server_side_encryption_configuration.logs',
  'aws_s3_bucket_lifecycle_configuration.logs',
  'aws_s3_bucket_policy.logs',
  'aws_iam_role.client',
  'aws_iam_role_policy.client',
];

describe('AC-2: the blocks of the stack', () => {
  test('AC-2: the resources are exactly the sixteen of the spec', () => {
    expect(RESOURCES).toHaveLength(16);
    expect(declared('resource', 2)).toEqual([...RESOURCES].sort());
  });

  test('AC-2: the only data block is aws_caller_identity.current', () => {
    expect(declared('data', 2)).toEqual(['aws_caller_identity.current']);
  });

  test('AC-2: the only module block is tags', () => {
    expect(declared('module', 1)).toEqual(['tags']);
  });

  test('AC-2: there is no variable block in any top-level .tf file', () => {
    needTerraformFiles();
    expect(declared('variable', 1)).toEqual([]);
  });

  test('AC-2: there is no variables.tf', () => {
    needTerraformFiles();
    expect(existsSync(pathIn(LAB, 'variables.tf'))).toBe(false);
  });

  test('AC-2: there is no terraform.tfvars.example', () => {
    needTerraformFiles();
    expect(existsSync(pathIn(LAB, 'terraform.tfvars.example'))).toBe(false);
  });

  test('AC-2: the outputs are the six of the spec', () => {
    expect(declared('output', 1)).toEqual(
      [
        'client_role_arn',
        'data_bucket_name',
        'log_bucket_name',
        'log_prefix',
        'kms_key_arn',
        'kms_key_alias',
      ].sort(),
    );
  });

  test('AC-2: every output block has a non-empty description', () => {
    const bodies = blockBodies(allTerraform(), /\boutput\s+"[^"]+"\s*\{/);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const description = /^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(body)?.[1];
      expect(description?.trim() ?? '', body.trim().split('\n')[0]).not.toBe('');
    }
  });
});

describe('AC-3: constructs the lab must not use', () => {
  test('AC-3: no top-level .tf file contains aws_s3_object', () => {
    for (const file of needTerraformFiles())
      expect(file.text, file.name).not.toContain('aws_s3_object');
  });

  test('AC-3: no top-level .tf file contains managed_policy_arns', () => {
    for (const file of needTerraformFiles()) {
      expect(file.text, file.name).not.toMatch(/\bmanaged_policy_arns\b/);
    }
  });

  test('AC-3: no top-level .tf file contains an inline_policy block', () => {
    for (const file of needTerraformFiles()) {
      expect(file.text, file.name).not.toMatch(/\binline_policy\b/);
    }
  });

  test('AC-3: no top-level .tf file contains aws_iam_role_policy_attachment', () => {
    for (const file of needTerraformFiles()) {
      expect(file.text, file.name).not.toContain('aws_iam_role_policy_attachment');
    }
  });
});

// =================================================================================================
// AC-4: depends_on of the bucket sub-resources
// =================================================================================================

describe('AC-4: the bucket sub-resources are ordered after their bucket', () => {
  const DATA_SUBS = [
    'aws_s3_bucket_public_access_block',
    'aws_s3_bucket_ownership_controls',
    'aws_s3_bucket_server_side_encryption_configuration',
    'aws_s3_bucket_logging',
    'aws_s3_bucket_policy',
  ];
  const LOG_SUBS = [
    'aws_s3_bucket_public_access_block',
    'aws_s3_bucket_ownership_controls',
    'aws_s3_bucket_server_side_encryption_configuration',
    'aws_s3_bucket_lifecycle_configuration',
    'aws_s3_bucket_policy',
  ];

  test.each(DATA_SUBS)('AC-4: %s.data has a depends_on listing aws_s3_bucket.data', (type) => {
    expect(dependsOn(resourceBody(type, 'data'))).toContain('aws_s3_bucket.data');
  });

  test.each(LOG_SUBS)('AC-4: %s.logs has a depends_on listing aws_s3_bucket.logs', (type) => {
    expect(dependsOn(resourceBody(type, 'logs'))).toContain('aws_s3_bucket.logs');
  });

  test('AC-4: the logging of the data bucket also waits for the log bucket policy', () => {
    expect(dependsOn(resourceBody('aws_s3_bucket_logging', 'data'))).toContain(
      'aws_s3_bucket_policy.logs',
    );
  });

  test('AC-4: the data bucket policy also waits for the data bucket public access block', () => {
    expect(dependsOn(resourceBody('aws_s3_bucket_policy', 'data'))).toContain(
      'aws_s3_bucket_public_access_block.data',
    );
  });

  test('AC-4: the log bucket policy also waits for the log bucket public access block', () => {
    expect(dependsOn(resourceBody('aws_s3_bucket_policy', 'logs'))).toContain(
      'aws_s3_bucket_public_access_block.logs',
    );
  });
});

// =================================================================================================
// AC-25, AC-26: README.md and break-it.md
// =================================================================================================

const README_HEADINGS = [
  '# Lab 02: S3 encryption with a KMS key, enforced by a bucket policy',
  '## What you build',
  '## Cost',
  '## Prerequisites',
  '## Quick start in your own account',
  '## Observe',
  '## Verify',
  '## Destroy now',
];

const README_GUIDE_PATH = '../../apps/site/src/content/docs/d1/1-3-data-security/';

const README_STRINGS = [
  's3-sse-kms-upload',
  README_GUIDE_PATH,
  'fg-workload-boundary',
  'fg-lab02-client',
  'VERIFY_ASSUME=1',
  'lab.tfplan',
  'terraform destroy',
  '$1.00',
  'AES256',
  'AccessDenied',
  'aws/s3',
  'x-amz-server-side-encryption',
  'alias/fg-lab02-data',
  'Bucket Key',
  'lookup-events',
  'GenerateDataKey',
  's3-access/',
  'pending deletion',
];

describe('AC-25: README.md', () => {
  const readme = (): string => readLabFile('README.md');
  const mermaid = (): string => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    return need(block?.body, 'a mermaid code block in README.md');
  };

  test('AC-25: the # and ## headings are exactly the eight of the spec, in order', () => {
    const headings = scan(readme())
      .headings.filter((heading) => heading.level <= 2)
      .map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
    expect(headings).toEqual(README_HEADINGS);
  });

  test('AC-25: it has a mermaid block with a flowchart', () => {
    expect(mermaid()).toContain('flowchart');
  });

  test('AC-25: the flowchart names the client, the data bucket, the KMS key, the log bucket and CloudTrail', () => {
    const body = mermaid();
    expect(body).toMatch(/client/i);
    expect(body).toMatch(/data[ -]?bucket/i);
    expect(body).toMatch(/\bKMS\b/);
    expect(body).toMatch(/log[ -]?bucket/i);
    expect(body).toMatch(/CloudTrail/i);
  });

  test.each(README_STRINGS)('AC-25: it contains "%s"', (needle) => {
    expect(readme()).toContain(needle);
  });

  test('AC-25: the repo-relative guide link resolves to a directory of the repo', () => {
    expect(readme()).toContain(`](${README_GUIDE_PATH}`);
    expect(existsSync(pathIn(LAB, ...README_GUIDE_PATH.split('/')))).toBe(true);
  });
});

const BREAK_SECTIONS = [
  'Upload with SSE-S3',
  'Remove the key permission',
  'Turn off the Bucket Key',
];

describe('AC-26: break-it.md', () => {
  const breakIt = (): string => readLabFile('break-it.md');

  test('AC-26: it starts with its title', () => {
    const first = breakIt()
      .split(/\r?\n/)
      .find((line) => line.trim() !== '');
    expect(first).toBe('# Break lab 02 on purpose');
  });

  test('AC-26: it has exactly the three ## sections of the spec, in order', () => {
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

  test.each([
    'AES256',
    'DenyOtherEncryption',
    'UseDataKeyThroughS3',
    'kms:GenerateDataKey',
    'bucket_key_enabled',
    'a few minutes',
    'fg-workload-boundary',
  ])('AC-26: it mentions %s', (needle) => {
    expect(breakIt()).toContain(needle);
  });
});

// =================================================================================================
// AC-27: aws output read through a process substitution has its CR removed
// =================================================================================================

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

describe('AC-27: aws output read through a process substitution has its CR removed', () => {
  const awsSubstitutions = (name: string): string[] =>
    processSubstitutions(readLabFile(name)).filter((inner) => /\baws\b/.test(inner));

  test('AC-27: README.md has process substitutions that read aws output', () => {
    expect(awsSubstitutions('README.md').length).toBeGreaterThan(0);
  });

  test.each(['README.md', 'break-it.md'])(
    "AC-27: every aws process substitution of %s ends with | tr -d '\\r'",
    (name) => {
      readLabFile(name);
      for (const inner of awsSubstitutions(name)) {
        expect(inner.trim(), inner.trim().slice(0, 60)).toMatch(/\|\s*tr\s+-d\s+'\\r'$/);
      }
    },
  );
});

// =================================================================================================
// AC-28: nothing private in the reader-facing files
// =================================================================================================

const ALLOWED_NUMBERS = new Set(['111122223333']);
const COURSE_SECTION = /[Ss]ection \d/;

/** The key ID of the "other key" probe of verify.sh: its last group is twelve zeros, not an account ID. */
const ZERO_KEY_ID = '00000000-0000-0000-0000-000000000000';

function twelveDigitNumbers(text: string): string[] {
  return (text.replaceAll(ZERO_KEY_ID, '').match(/(?<!\d)\d{12}(?!\d)/g) ?? []).filter(
    (digits) => !ALLOWED_NUMBERS.has(digits),
  );
}

describe('AC-28: no account ids, course section references, AdministratorAccess or private domain', () => {
  const FILES = ['README.md', 'break-it.md', 'verify.sh'];

  const checkText = (label: string, text: string): void => {
    expect(twelveDigitNumbers(text), `${label}: 12-digit numbers`).toEqual([]);
    expect(text, `${label}: course section reference`).not.toMatch(COURSE_SECTION);
    expect(text, `${label}: AdministratorAccess`).not.toContain('AdministratorAccess');
    expect(text, `${label}: tech-leads.lol`).not.toContain('tech-leads.lol');
  };

  test.each(FILES)('AC-28: %s has none of them', (name) => {
    checkText(name, readLabFile(name));
  });

  test('AC-28: no top-level .tf file has any of them', () => {
    for (const file of needTerraformFiles()) checkText(file.name, file.raw);
  });

  test('AC-28: log_bucket.tf has no kms_master_key_id (the log target must use SSE-S3)', () => {
    expect(stripHclComments(readLabFile('log_bucket.tf'))).not.toContain('kms_master_key_id');
  });

  test('AC-28: log_bucket.tf has no aws:kms (the log target must use SSE-S3)', () => {
    expect(stripHclComments(readLabFile('log_bucket.tf'))).not.toContain('aws:kms');
  });
});

// =================================================================================================
// AC-29: no guardrail outside the lab shadows its demo (lesson of #110)
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

function repoText(...segments: string[]): string {
  const path = join(REPO_ROOT, ...segments);
  if (!existsSync(path)) throw new Error(`missing file: ${segments.join('/')}`);
  return stripHclComments(readFileSync(path, 'utf8'));
}

/** The value of `<name> = ...` in a statement: a "string", a [list] or a reference (to the line end). */
function attributeValue(statement: string, name: string): string | undefined {
  const match = new RegExp(`(?<![A-Za-z_])${name}\\s*=\\s*`).exec(statement);
  if (!match) return undefined;
  const rest = statement.slice(match.index + match[0].length);
  if (rest.startsWith('[')) return rest.slice(0, rest.indexOf(']') + 1);
  if (rest.startsWith('"')) return rest.slice(0, skipString(rest, 0));
  return rest.split('\n')[0] ?? '';
}

interface Deny {
  file: string;
  sid: string;
  text: string;
}

/** Every `Effect = "Deny"` statement of a guardrail file (locals included), with its Sid. */
function denyStatements(...segments: string[]): Deny[] {
  const text = repoText(...segments);
  return [...text.matchAll(/\bEffect\s*=\s*"Deny"/g)].map((match) => {
    const statement = enclosingBlock(text, match.index);
    const sid = /\bSid\s*=\s*"([^"]+)"/.exec(statement)?.[1] ?? '';
    return { file: segments.join('/'), sid, text: statement };
  });
}

/** The quoted strings of an Action value; a reference (not a literal) is a failure. */
function actionStrings(deny: Deny): string[] {
  const value = attributeValue(deny.text, 'Action');
  if (value === undefined) return [];
  if (!value.startsWith('[') && !value.startsWith('"')) {
    throw new Error(`${deny.file}: ${deny.sid} has an Action that is not a literal: ${value}`);
  }
  return [...value.matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1] ?? '');
}

/** An IAM action pattern (`s3:Get*`, `*`) as a case-insensitive regular expression. */
function actionPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const GUARDRAIL_FILES: string[][] = [
  ['bootstrap', 'management', 'scp.tf'],
  ['bootstrap', 'workload', 'boundary.tf'],
  ['bootstrap', 'workload', 'ci_roles.tf'],
];

const DEMO_ACTIONS = [
  's3:*',
  's3:PutObject',
  's3:GetObject',
  's3:ListBucket',
  'kms:*',
  'kms:GenerateDataKey',
  'kms:Decrypt',
];

/** The only Deny statements that may name an S3 or KMS demo action, and why they are harmless here. */
const ALLOWED_DEMO_DENIES = ['DenyStateBucket', 'DenyObjectReadsOutsideLabState'];

/**
 * The only Deny statements with NotAction. Spec 041 names the first two; DenyStateBucketSettings
 * (tf-apply, `Resource = local.state_bucket_arn`: the state bucket itself, never an object and never
 * a lab bucket) already exists in ci_roles.tf, so the literal text of AC-29 could never pass. It is
 * allowed here with its resource pinned below.
 */
const ALLOWED_NOT_ACTION_DENIES = [
  'DenyOutsideAllowedRegions',
  'DenyProtectedIamChanges',
  'DenyStateBucketSettings',
];

describe('AC-29: no guardrail outside the lab shadows the demo', () => {
  const all = (): Deny[] => GUARDRAIL_FILES.flatMap((segments) => denyStatements(...segments));

  test('AC-29: the reader finds the Deny statements of the three guardrail files', () => {
    const denies = all();
    expect(denies.length).toBeGreaterThanOrEqual(10);
    for (const segments of GUARDRAIL_FILES) {
      expect(
        denies.filter((deny) => deny.file === segments.join('/')).length,
        segments.join('/'),
      ).toBeGreaterThan(0);
    }
    expect(denies.filter((deny) => deny.sid === '')).toEqual([]);
  });

  test('AC-29: no Deny Action names or matches an S3 or KMS demo action, except the two named ones', () => {
    const shadows: string[] = [];
    for (const deny of all()) {
      for (const action of actionStrings(deny)) {
        for (const demo of DEMO_ACTIONS) {
          if (actionPattern(action).test(demo) && !ALLOWED_DEMO_DENIES.includes(deny.sid)) {
            shadows.push(`${deny.file}: ${deny.sid} denies ${action}, which covers ${demo}`);
          }
        }
      }
    }
    expect(shadows).toEqual([]);
  });

  test('AC-29: DenyStateBucket (boundary) is limited to the state bucket', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyStateBucket');
    expect(deny, 'DenyStateBucket not found').toBeDefined();
    const references = [
      ...(attributeValue(deny?.text ?? '', 'Resource') ?? '').matchAll(/local\.(\w+)/g),
    ];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference[1]).toBe('state_bucket_arn');
    expect(deny?.text).not.toMatch(/\bNotResource\b/);
  });

  test('AC-29: DenyObjectReadsOutsideLabState (tf-plan) is NotResource = the state bucket labs/*', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyObjectReadsOutsideLabState');
    expect(deny, 'DenyObjectReadsOutsideLabState not found').toBeDefined();
    const notResource = attributeValue(deny?.text ?? '', 'NotResource') ?? '';
    expect(notResource).toMatch(/^"\$\{local\.state_bucket_arn\}\/labs\/\*"$/);
    expect(deny?.text).not.toMatch(/(?<![A-Za-z_])Resource\s*=/);
  });

  test('AC-29: every Deny with NotAction is DenyOutsideAllowedRegions or DenyProtectedIamChanges (or the state bucket settings deny)', () => {
    const notActions = all()
      .filter((deny) => /(?<![A-Za-z_])NotAction\s*=/.test(deny.text))
      .map((deny) => deny.sid);
    expect(notActions.length).toBeGreaterThan(0);
    expect(
      notActions.filter((sid) => !ALLOWED_NOT_ACTION_DENIES.includes(sid)),
      'Deny statements with NotAction other than the named ones',
    ).toEqual([]);
  });

  test('AC-29: DenyStateBucketSettings (tf-apply) has the state bucket itself as its only resource', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyStateBucketSettings');
    expect(deny, 'DenyStateBucketSettings not found').toBeDefined();
    expect((attributeValue(deny?.text ?? '', 'Resource') ?? '').trim()).toBe(
      'local.state_bucket_arn',
    );
    expect(deny?.text).not.toMatch(/\bNotResource\b/);
  });

  test('AC-29: DenyOutsideAllowedRegions (SCP) is conditioned on aws:RequestedRegion with eu-west-1 allowed', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyOutsideAllowedRegions');
    expect(deny, 'DenyOutsideAllowedRegions not found').toBeDefined();
    expect(deny?.text).toContain('aws:RequestedRegion');
    expect(repoText('bootstrap', 'management', 'scp.tf')).toMatch(
      /\ballowed_regions\s*=\s*\[[^\]]*"eu-west-1"[^\]]*\]/,
    );
  });

  test('AC-29: DenyProtectedIamChanges (boundary) has only IAM ARNs as resources', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyProtectedIamChanges');
    expect(deny, 'DenyProtectedIamChanges not found').toBeDefined();
    const resource = attributeValue(deny?.text ?? '', 'Resource') ?? '';
    const references = [...resource.matchAll(/local\.(\w+)/g)].map((match) => match[1] ?? '');
    expect(references.length).toBeGreaterThan(0);
    expect(resource, 'Resource holds only local references').not.toMatch(/"/);
    const main = repoText('bootstrap', 'workload', 'main.tf');
    for (const name of references) {
      expect(main, `${name} is an IAM ARN`).toMatch(
        new RegExp(`\\b${name}\\s*=\\s*"arn:aws:iam::`),
      );
    }
  });

  test('AC-29: verify.sh makes no get-object or put-object call outside the VERIFY_ASSUME=1 branch', () => {
    const script = readLabFile('verify.sh')
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line));
    const firstGate = script.findIndex((line) => /\bVERIFY_ASSUME\b/.test(line));
    expect(firstGate, 'verify.sh never reads VERIFY_ASSUME').toBeGreaterThanOrEqual(0);
    const objectCalls = script
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /\b(get-object|put-object)\b/.test(line));
    expect(objectCalls.length, 'verify.sh has no live object call at all').toBeGreaterThan(0);
    for (const { line, index } of objectCalls) {
      expect(index, `object call before the VERIFY_ASSUME gate: ${line.trim()}`).toBeGreaterThan(
        firstGate,
      );
    }
  });
});
