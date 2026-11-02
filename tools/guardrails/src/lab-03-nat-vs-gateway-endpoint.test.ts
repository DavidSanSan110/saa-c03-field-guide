import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 042 (issue #112): contract tests over the real files of labs/03-nat-vs-gateway-endpoint
// (AC-1 to AC-4, AC-26 to AC-30, AC-32 to AC-34) and the cross-check of the guardrails outside the
// lab (AC-31). The behaviour of the stack (network, endpoint, instance, buckets, outputs) is covered
// by `terraform test` (labs/03-nat-vs-gateway-endpoint/tests) and the behaviour of verify.sh by
// lab-03-verify.test.ts; this file covers what those cannot see: the layout, the HCL text, the
// reader docs, the repo files and the guardrail text.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/03-nat-vs-gateway-endpoint';
const LAB_00 = 'labs/00-site-hosting';
const LAB_02 = 'labs/02-s3-kms-encryption';

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

function readRepoFile(...segments: string[]): string {
  const path = join(REPO_ROOT, ...segments);
  if (!existsSync(path)) throw new Error(`missing file: ${segments.join('/')}`);
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

/**
 * The text on one line, lower case, so that a phrase wrapped over two lines (also inside a block
 * quote) is still found.
 */
const flat = (text: string): string =>
  text
    .replace(/^\s*>[ \t]?/gm, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

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

  test('AC-1: the aws provider is in us-east-1 (the Region of the diagram), not in the Region of the state', () => {
    const [body = ''] = providers();
    expect(providers()).toHaveLength(1);
    expect(body).toMatch(/^\s*region\s*=\s*"us-east-1"\s*$/m);
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

  test('AC-1: main.tf has module "tags" with source ../../modules/tags and lab = "03-nat-vs-gateway-endpoint"', () => {
    const bodies = blockBodies(stripHclComments(readLabFile('main.tf')), /\bmodule\s+"tags"\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/tags"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*lab\s*=\s*"03-nat-vs-gateway-endpoint"\s*$/m);
  });

  test('AC-1: the lock file pins hashicorp/aws to the version of the lab 00 lock file', () => {
    expect(lockVersionOf(LAB)).toBe(lockVersionOf(LAB_00));
  });

  test('AC-1: the lock file holds every h1 hash of the lab 02 lock file (Linux and Windows, section 1 of the spec)', () => {
    const own = new Set(h1Hashes(LAB));
    expect(own.size).toBeGreaterThanOrEqual(2);
    for (const hash of new Set(h1Hashes(LAB_02))) expect(own, hash).toContain(hash);
  });
});

// =================================================================================================
// AC-2, AC-3: the blocks of the stack, no variables, outputs, forbidden constructs
// =================================================================================================

const RESOURCES = [
  'aws_vpc.lab',
  'aws_default_security_group.lab',
  'aws_internet_gateway.lab',
  'aws_subnet.public',
  'aws_subnet.private',
  'aws_route_table.public',
  'aws_route_table.private',
  'aws_route.public_internet',
  'aws_route.private_nat',
  'aws_route_table_association.public',
  'aws_route_table_association.private',
  'aws_eip.nat',
  'aws_nat_gateway.lab',
  'aws_vpc_endpoint.s3',
  'aws_vpc_endpoint_route_table_association.s3_private',
  'aws_security_group.instance',
  'aws_vpc_security_group_egress_rule.https',
  'aws_instance.private',
  'aws_iam_role.instance',
  'aws_iam_role_policy.instance',
  'aws_iam_role_policy_attachment.ssm_core',
  'aws_iam_instance_profile.instance',
  'aws_s3_bucket.data',
  'aws_s3_bucket_public_access_block.data',
  'aws_s3_bucket_ownership_controls.data',
  'aws_s3_bucket_server_side_encryption_configuration.data',
  'aws_s3_bucket_policy.data',
  'aws_s3_bucket.other',
  'aws_s3_bucket_public_access_block.other',
  'aws_s3_bucket_ownership_controls.other',
  'aws_s3_bucket_server_side_encryption_configuration.other',
];

const OUTPUTS = [
  'vpc_id',
  'public_route_table_id',
  'private_route_table_id',
  'nat_gateway_id',
  'nat_public_ip',
  's3_endpoint_id',
  'instance_id',
  'instance_security_group_id',
  'instance_role_arn',
  'data_bucket_name',
  'other_bucket_name',
];

describe('AC-2: the blocks of the stack', () => {
  test('AC-2: the resources are exactly the thirty-one of the spec', () => {
    expect(RESOURCES).toHaveLength(31);
    expect(declared('resource', 2)).toEqual([...RESOURCES].sort());
  });

  test('AC-2: the data blocks are exactly aws_caller_identity.current, aws_ami.al2023_arm64 and aws_ec2_instance_type_offerings.nano', () => {
    expect(declared('data', 2)).toEqual(
      [
        'aws_caller_identity.current',
        'aws_ami.al2023_arm64',
        'aws_ec2_instance_type_offerings.nano',
      ].sort(),
    );
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

  test('AC-2: the outputs are the eleven of the spec', () => {
    expect(OUTPUTS).toHaveLength(11);
    expect(declared('output', 1)).toEqual([...OUTPUTS].sort());
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
  const FORBIDDEN: [string, RegExp][] = [
    ['aws_s3_object', /aws_s3_object/],
    ['managed_policy_arns', /\bmanaged_policy_arns\b/],
    ['an inline_policy block', /\binline_policy\b/],
    ['key_name', /\bkey_name\b/],
    ['aws_key_pair', /\baws_key_pair\b/],
    ['user_data', /\buser_data/],
    ['aws_vpc_security_group_ingress_rule', /\baws_vpc_security_group_ingress_rule\b/],
    ['an ingress block', /\bingress\s*\{/],
    ['route_table_ids', /\broute_table_ids\b/],
    ['associate_public_ip_address = true', /\bassociate_public_ip_address\s*=\s*true\b/],
  ];

  test.each(FORBIDDEN)('AC-3: no top-level .tf file contains %s', (_name, pattern) => {
    for (const file of needTerraformFiles()) expect(file.text, file.name).not.toMatch(pattern);
  });
});

// =================================================================================================
// AC-4: depends_on
// =================================================================================================

describe('AC-4: ordering with depends_on', () => {
  const SUBS = [
    'aws_s3_bucket_public_access_block',
    'aws_s3_bucket_ownership_controls',
    'aws_s3_bucket_server_side_encryption_configuration',
  ];

  test('AC-4: aws_nat_gateway.lab waits for aws_internet_gateway.lab', () => {
    expect(dependsOn(resourceBody('aws_nat_gateway', 'lab'))).toContain('aws_internet_gateway.lab');
  });

  test('AC-4: aws_eip.nat waits for aws_internet_gateway.lab', () => {
    expect(dependsOn(resourceBody('aws_eip', 'nat'))).toContain('aws_internet_gateway.lab');
  });

  test.each([
    'aws_route.private_nat',
    'aws_vpc_endpoint_route_table_association.s3_private',
    'aws_iam_role_policy_attachment.ssm_core',
  ])('AC-4: aws_instance.private waits for %s', (reference) => {
    expect(dependsOn(resourceBody('aws_instance', 'private'))).toContain(reference);
  });

  test.each(SUBS)('AC-4: %s.data has a depends_on listing aws_s3_bucket.data', (type) => {
    expect(dependsOn(resourceBody(type, 'data'))).toContain('aws_s3_bucket.data');
  });

  test.each(SUBS)('AC-4: %s.other has a depends_on listing aws_s3_bucket.other', (type) => {
    expect(dependsOn(resourceBody(type, 'other'))).toContain('aws_s3_bucket.other');
  });

  test('AC-4: aws_s3_bucket_policy.data has a depends_on listing aws_s3_bucket.data', () => {
    expect(dependsOn(resourceBody('aws_s3_bucket_policy', 'data'))).toContain('aws_s3_bucket.data');
  });

  test('AC-4: the data bucket policy also waits for the data bucket public access block', () => {
    expect(dependsOn(resourceBody('aws_s3_bucket_policy', 'data'))).toContain(
      'aws_s3_bucket_public_access_block.data',
    );
  });

  test('AC-4: aws_instance.private has lifecycle ignore_changes = [ami]', () => {
    const lifecycles = blockBodies(resourceBody('aws_instance', 'private'), /\blifecycle\s*\{/);
    expect(lifecycles).toHaveLength(1);
    expect(lifecycles[0]).toMatch(/^\s*ignore_changes\s*=\s*\[\s*ami\s*,?\s*\]\s*$/m);
  });
});

// =================================================================================================
// AC-10, AC-13: what a plan cannot show (the provider computes these sets, unknown until apply)
// =================================================================================================

describe('AC-10 and AC-13: HCL text that terraform test cannot assert', () => {
  test('AC-10: aws_default_security_group.lab has vpc_id only: no ingress block, no egress block', () => {
    const body = resourceBody('aws_default_security_group', 'lab');
    expect(body).not.toMatch(/\bingress\s*\{/);
    expect(body).not.toMatch(/\begress\s*\{/);
    const names = [...body.matchAll(/^\s*([a-z_0-9]+)\s*=/gm)].map((match) => match[1]);
    expect(names).toEqual(['vpc_id']);
  });

  test('AC-10: aws_security_group.instance has no inline ingress or egress block', () => {
    const body = resourceBody('aws_security_group', 'instance');
    expect(body).not.toMatch(/\bingress\s*\{/);
    expect(body).not.toMatch(/\begress\s*\{/);
  });

  test.each(['data', 'other'])(
    'AC-13: the encryption configuration of the %s bucket names no KMS key',
    (name) => {
      const body = resourceBody('aws_s3_bucket_server_side_encryption_configuration', name);
      expect(body).not.toContain('kms_master_key_id');
      expect(body).not.toContain('aws:kms');
    },
  );
});

// =================================================================================================
// AC-26, AC-27: README.md and break-it.md
// =================================================================================================

const README_HEADINGS = [
  '# Lab 03: NAT gateway vs S3 gateway endpoint',
  '## What you build',
  '## Cost',
  '## Prerequisites',
  '## Quick start in your own account',
  '## Observe',
  '## Verify',
  '## Destroy now',
];

const README_GUIDE_PATH = '../../apps/site/src/content/docs/d1/1-2-secure-workloads/';

const README_STRINGS = [
  'vpc-nat-vs-gateway-endpoint',
  README_GUIDE_PATH,
  'fg-workload-boundary',
  'fg-lab03-instance',
  'VERIFY_ASSUME=1',
  'lab.tfplan',
  'terraform destroy',
  '$0.045',
  '$0.005',
  'AccessDenied',
  'aws:SourceVpce',
  'checkip.amazonaws.com',
  'aws ssm start-session',
  'Session Manager plugin',
  'BytesOutToDestination',
  'aws s3api get-object',
  'us-east-1',
  'endpoint-only/',
  'destroy labs/03-nat-vs-gateway-endpoint',
];

describe('AC-26: README.md', () => {
  const readme = (): string => readLabFile('README.md');
  const mermaid = (): string => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    return need(block?.body, 'a mermaid code block in README.md');
  };

  test('AC-26: the # and ## headings are exactly the eight of the spec, in order', () => {
    const headings = scan(readme())
      .headings.filter((heading) => heading.level <= 2)
      .map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
    expect(headings).toEqual(README_HEADINGS);
  });

  test('AC-26: the warning between the # heading and the first ## heading says to destroy the same day', () => {
    const { headings, lines } = scan(readme());
    const first = headings.find((heading) => heading.level === 1);
    const second = headings.find((heading) => heading.level === 2);
    expect(first, 'no # heading').toBeDefined();
    expect(second, 'no ## heading').toBeDefined();
    const between = lines.slice((first?.line ?? 0) + 1, second?.line ?? 0).join('\n');
    expect(flat(between)).toContain('same day');
  });

  test('AC-26: that warning is about the NAT gateway', () => {
    const { headings, lines } = scan(readme());
    const first = headings.find((heading) => heading.level === 1);
    const second = headings.find((heading) => heading.level === 2);
    const between = lines.slice((first?.line ?? 0) + 1, second?.line ?? 0).join('\n');
    expect(between).toMatch(/NAT/);
  });

  test('AC-26: it has a mermaid block with a flowchart', () => {
    expect(mermaid()).toContain('flowchart');
  });

  test('AC-26: the flowchart names the instance, NAT gateway, internet gateway, gateway endpoint and both buckets (section 9 of the spec)', () => {
    const body = mermaid();
    expect(body).toMatch(/instance/i);
    expect(body).toMatch(/NAT/);
    expect(body).toMatch(/internet gateway|\bIGW\b/i);
    expect(body).toMatch(/endpoint/i);
    expect(body).toMatch(/\bdata\b/i);
    expect(body).toMatch(/\bother\b/i);
  });

  test.each(README_STRINGS)('AC-26: it contains "%s"', (needle) => {
    expect(readme()).toContain(needle);
  });

  test('AC-26: the repo-relative guide link resolves to a directory of the repo', () => {
    expect(readme()).toContain(`](${README_GUIDE_PATH}`);
    expect(existsSync(pathIn(LAB, ...README_GUIDE_PATH.split('/')))).toBe(true);
  });
});

const BREAK_SECTIONS = ['Remove the endpoint route', 'Remove the NAT route'];

describe('AC-27: break-it.md', () => {
  const breakIt = (): string => readLabFile('break-it.md');

  test('AC-27: it starts with its title', () => {
    const first = breakIt()
      .split(/\r?\n/)
      .find((line) => line.trim() !== '');
    expect(first).toBe('# Break lab 03 on purpose');
  });

  test('AC-27: it has exactly the two ## sections of the spec, in order', () => {
    const headings = scan(breakIt())
      .headings.filter((heading) => heading.level === 2)
      .map((heading) => heading.text);
    expect(headings).toEqual(BREAK_SECTIONS);
  });

  test.each(BREAK_SECTIONS)('AC-27: the section "%s" has the four parts', (title) => {
    const section = need(sectionOf(breakIt(), 2, title), `## ${title}`);
    for (const part of ['What to do', 'What you see', 'Why', 'Put it back']) {
      expect(section, part).toContain(part);
    }
  });

  test.each([
    '--remove-route-table-ids',
    '--add-route-table-ids',
    'delete-route',
    'create-route',
    '--nat-gateway-id',
    'ConnectionLost',
    'heartbeat.txt',
    'internet=none',
    'aws:SourceVpce',
    'fg-workload-boundary',
  ])('AC-27: it mentions %s', (needle) => {
    expect(breakIt()).toContain(needle);
  });

  test('AC-27: the endpoint route section states that the other bucket can be read once the route is gone', () => {
    const section = flat(
      need(sectionOf(breakIt(), 2, 'Remove the endpoint route'), '## Remove the endpoint route'),
    );
    expect(section).toMatch(
      /other bucket[^.]{0,60}\bcan (now )?be read\b|\bcan (now )?read the other bucket\b/,
    );
  });

  test('AC-27: the endpoint section removes the route with remove-route-table-ids and puts it back with add-route-table-ids', () => {
    const section = need(
      sectionOf(breakIt(), 2, 'Remove the endpoint route'),
      '## Remove the endpoint route',
    );
    expect(section).toContain('--remove-route-table-ids');
    expect(section).toContain('--add-route-table-ids');
  });

  test('AC-27: the NAT section deletes the route with delete-route and puts it back with create-route and --nat-gateway-id', () => {
    const section = need(
      sectionOf(breakIt(), 2, 'Remove the NAT route'),
      '## Remove the NAT route',
    );
    expect(section).toContain('delete-route');
    expect(section).toContain('create-route');
    expect(section).toContain('--nat-gateway-id');
    expect(section).toContain('ConnectionLost');
    expect(section).toContain('heartbeat.txt');
  });
});

// =================================================================================================
// AC-28: aws output read through a substitution has its CR removed
// =================================================================================================

/** The text inside every `<opener> ... )` of a text (quotes and nested parentheses respected). */
function substitutions(text: string, opener: '<(' | '$('): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(opener, from);
    if (start === -1) return found;
    if (opener === '$(' && text.charAt(start + 2) === '(') {
      from = start + 3; // arithmetic expansion, not a command
      continue;
    }
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

describe('AC-28: aws output read through a substitution has its CR removed', () => {
  const awsSubstitutions = (name: string, opener: '<(' | '$('): string[] =>
    substitutions(readLabFile(name), opener).filter((inner) => /\baws\b/.test(inner));

  test('AC-28: README.md has process substitutions that read aws output', () => {
    expect(awsSubstitutions('README.md', '<(').length).toBeGreaterThan(0);
  });

  test('AC-28: README.md has command substitutions that read aws output', () => {
    expect(awsSubstitutions('README.md', '$(').length).toBeGreaterThan(0);
  });

  test.each([
    ['README.md', '<('],
    ['break-it.md', '<('],
    ['README.md', '$('],
    ['break-it.md', '$('],
  ] as const)("AC-28: every aws substitution %s %s ends with | tr -d '\\r'", (name, opener) => {
    readLabFile(name);
    for (const inner of awsSubstitutions(name, opener)) {
      expect(inner.trim(), inner.trim().slice(0, 60)).toMatch(/\|\s*tr\s+-d\s+'\\r'$/);
    }
  });
});

// =================================================================================================
// AC-29: nothing private in the reader-facing files
// =================================================================================================

const ALLOWED_NUMBERS = new Set(['111122223333']);
const COURSE_SECTION = /[Ss]ection \d/;

function twelveDigitNumbers(text: string): string[] {
  return (text.match(/(?<!\d)\d{12}(?!\d)/g) ?? []).filter(
    (digits) => !ALLOWED_NUMBERS.has(digits),
  );
}

describe('AC-29: no account ids, course section references, AdministratorAccess or private domain', () => {
  const FILES = ['README.md', 'break-it.md', 'verify.sh'];

  const checkText = (label: string, text: string): void => {
    expect(twelveDigitNumbers(text), `${label}: 12-digit numbers`).toEqual([]);
    expect(text, `${label}: course section reference`).not.toMatch(COURSE_SECTION);
    expect(text, `${label}: AdministratorAccess`).not.toContain('AdministratorAccess');
    expect(text, `${label}: tech-leads.lol`).not.toContain('tech-leads.lol');
  };

  test.each(FILES)('AC-29: %s has none of them', (name) => {
    checkText(name, readLabFile(name));
  });

  test('AC-29: no top-level .tf file has any of them', () => {
    for (const file of needTerraformFiles()) checkText(file.name, file.raw);
  });
});

// =================================================================================================
// AC-30: a refused object is never read with `aws s3 cp` in the Observe steps
// =================================================================================================

/** The commands of the code blocks of a markdown text, with `\` line continuations joined. */
function codeCommands(markdown: string): string[] {
  return scan(markdown)
    .blocks.flatMap((block) => block.body.replace(/\\\r?\n/g, ' ').split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

describe('AC-30: the Observe steps read a refused object with aws s3api get-object', () => {
  const observe = (): string =>
    need(sectionOf(readLabFile('README.md'), 2, 'Observe'), '## Observe');

  test('AC-30: no command of Observe reads an object with aws s3 cp (the source of a cp is never s3://)', () => {
    const commands = codeCommands(observe());
    expect(commands.length, 'Observe has no commands').toBeGreaterThan(0);
    const reads = commands.filter((line) =>
      /\baws\s+s3\s+cp\s+(?:-\S+\s+)*["']?s3:\/\//.test(line),
    );
    expect(reads).toEqual([]);
  });

  test('AC-30: Observe reads objects with aws s3api get-object at least four times (two in the session, two from the laptop)', () => {
    const reads = codeCommands(observe()).filter((line) =>
      /\baws\s+s3api\s+get-object\b/.test(line),
    );
    expect(reads.length).toBeGreaterThanOrEqual(4);
  });

  test('AC-30: at least two of those reads name endpoint-only/', () => {
    const reads = codeCommands(observe()).filter(
      (line) => /\baws\s+s3api\s+get-object\b/.test(line) && line.includes('endpoint-only/'),
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  test('AC-30: Observe explains why aws s3 cp hides the reason (a HEAD has no body)', () => {
    const text = flat(observe());
    expect(text).toContain('aws s3 cp');
    expect(text).toMatch(/\bhead\b/);
  });
});

// =================================================================================================
// AC-31: no guardrail outside the lab shadows its demo (lesson of #110)
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
  return stripHclComments(readRepoFile(...segments));
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

/** The actions the lab's demos and its deploy need (spec 042, AC-31). */
const DEMO_ACTIONS = [
  's3:*',
  's3:GetObject',
  's3:PutObject',
  's3:ListBucket',
  'ssm:*',
  'ssm:SendCommand',
  'ssm:StartSession',
  'ssmmessages:*',
  'ec2messages:*',
  'ec2:*',
  'ec2:RunInstances',
  'ec2:CreateRoute',
  'ec2:DeleteRoute',
  'ec2:ModifyVpcEndpoint',
  'iam:CreateInstanceProfile',
  'iam:AddRoleToInstanceProfile',
];

/** The only Deny statements that may name an S3 demo action, and why they are harmless here. */
const ALLOWED_DEMO_DENIES = ['DenyStateBucket', 'DenyObjectReadsOutsideLabState'];

/**
 * The Deny statements with NotAction that exist today. Spec 042 does not mention NotAction; a Deny
 * with NotAction covers every action but the listed ones, so a new one would shadow the demo.
 */
const ALLOWED_NOT_ACTION_DENIES = [
  'DenyOutsideAllowedRegions',
  'DenyProtectedIamChanges',
  'DenyStateBucketSettings',
];

describe('AC-31: no guardrail outside the lab shadows the demo', () => {
  const all = (): Deny[] => GUARDRAIL_FILES.flatMap((segments) => denyStatements(...segments));

  test('AC-31: the reader finds the Deny statements of the three guardrail files', () => {
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

  test('AC-31: no Deny Action names or covers an S3, SSM, EC2 or instance profile demo action, except the two named ones', () => {
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

  test('AC-31: DenyStateBucket (boundary) is limited to the state bucket', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyStateBucket');
    expect(deny, 'DenyStateBucket not found').toBeDefined();
    const references = [
      ...(attributeValue(deny?.text ?? '', 'Resource') ?? '').matchAll(/local\.(\w+)/g),
    ];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference[1]).toBe('state_bucket_arn');
    expect(deny?.text).not.toMatch(/\bNotResource\b/);
  });

  test('AC-31: DenyObjectReadsOutsideLabState (tf-plan) is NotResource = the state bucket labs/*', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyObjectReadsOutsideLabState');
    expect(deny, 'DenyObjectReadsOutsideLabState not found').toBeDefined();
    const notResource = attributeValue(deny?.text ?? '', 'NotResource') ?? '';
    expect(notResource).toMatch(/^"\$\{local\.state_bucket_arn\}\/labs\/\*"$/);
    expect(deny?.text).not.toMatch(/(?<![A-Za-z_])Resource\s*=/);
  });

  test('AC-31: every Deny with NotAction is one of the three that exist today', () => {
    const notActions = all()
      .filter((deny) => /(?<![A-Za-z_])NotAction\s*=/.test(deny.text))
      .map((deny) => deny.sid);
    expect(notActions.length).toBeGreaterThan(0);
    expect(
      notActions.filter((sid) => !ALLOWED_NOT_ACTION_DENIES.includes(sid)),
      'Deny statements with NotAction other than the named ones',
    ).toEqual([]);
  });

  test('AC-31: DenyStateBucketSettings (tf-apply) has the state bucket itself as its only resource', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyStateBucketSettings');
    expect(deny, 'DenyStateBucketSettings not found').toBeDefined();
    expect((attributeValue(deny?.text ?? '', 'Resource') ?? '').trim()).toBe(
      'local.state_bucket_arn',
    );
    expect(deny?.text).not.toMatch(/\bNotResource\b/);
  });

  test('AC-31: DenyProtectedIamChanges has only IAM ARNs as resources', () => {
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

  test('AC-31: us-east-1 is in the allowed_regions of the SCP, which denies only outside them', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyOutsideAllowedRegions');
    expect(deny, 'DenyOutsideAllowedRegions not found').toBeDefined();
    expect(deny?.text).toContain('aws:RequestedRegion');
    expect(repoText('bootstrap', 'management', 'scp.tf')).toMatch(
      /\ballowed_regions\s*=\s*\[[^\]]*"us-east-1"[^\]]*\]/,
    );
  });

  test('AC-31: verify.sh makes no get-object, put-object, send-command or start-session call outside the VERIFY_ASSUME=1 branch', () => {
    const script = readLabFile('verify.sh')
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line));
    // Lines inside a top-level function definition are definitions, not calls (shfmt style: the
    // closing brace is in column 0). Whether a function is called outside the gate is for the
    // runtime tests of lab-03-verify.test.ts.
    let inFunction = false;
    const topLevel = script.map((line) => {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?\s*$/.test(line)) inFunction = true;
      const outside = !inFunction;
      if (inFunction && /^\}/.test(line)) inFunction = false;
      return outside;
    });
    const firstGate = script.findIndex(
      (line, index) => topLevel[index] === true && /\$\{?VERIFY_ASSUME\b/.test(line),
    );
    expect(
      firstGate,
      'verify.sh never tests $VERIFY_ASSUME outside a function',
    ).toBeGreaterThanOrEqual(0);
    const liveCall = /\b(get-object|put-object|send-command|start-session)\b/;
    expect(
      script.filter((line) => liveCall.test(line)).length,
      'verify.sh has no live call at all',
    ).toBeGreaterThan(0);
    script.forEach((line, index) => {
      if (topLevel[index] !== true || !liveCall.test(line)) return;
      expect(index, `live call before the VERIFY_ASSUME gate: ${line.trim()}`).toBeGreaterThan(
        firstGate,
      );
    });
  });
});

// =================================================================================================
// AC-32, AC-33, AC-34: repo files
// =================================================================================================

describe('AC-32: .gitignore', () => {
  const lines = (): string[] =>
    readRepoFile('.gitignore')
      .split(/\r?\n/)
      .map((line) => line.trim());

  test.each(['labs/*/probe.txt', 'labs/*/client-without-key.json'])(
    'AC-32: .gitignore has the line %s',
    (line) => {
      expect(lines()).toContain(line);
    },
  );
});

describe('AC-33: the Availability Zone comes from the offerings, never a literal', () => {
  test('AC-33: no top-level .tf file sets availability_zone to a literal', () => {
    for (const file of needTerraformFiles()) {
      expect(file.text, file.name).not.toMatch(/\bavailability_zone\s*=\s*"/);
    }
  });

  test.each(['public', 'private'])(
    'AC-33: aws_subnet.%s sets availability_zone = local.availability_zone',
    (name) => {
      expect(resourceBody('aws_subnet', name)).toMatch(
        /^\s*availability_zone\s*=\s*local\.availability_zone\s*$/m,
      );
    },
  );
});

describe('AC-34: the 1.2 page links the lab', () => {
  const page = (): string =>
    readRepoFile(
      'apps',
      'site',
      'src',
      'content',
      'docs',
      'd1',
      '1-2-secure-workloads',
      'index.mdx',
    );

  test('AC-34: it no longer says the lab "is being built"', () => {
    expect(page().includes('is being built'), 'the page still says "is being built"').toBe(false);
  });

  test('AC-34: it links the lab folder on GitHub', () => {
    const url =
      'https://github.com/DavidSanSan110/saa-c03-field-guide/tree/main/labs/03-nat-vs-gateway-endpoint';
    expect(page().includes(url), `the page does not link ${url}`).toBe(true);
  });
});

// =================================================================================================
// AC-32 (heartbeat.txt), AC-35 to AC-37, AC-40, AC-41: review regressions in the reader docs
// =================================================================================================

/** The text with every run of white space (also a line wrap and its indent) as one space. */
const unwrap = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The trimmed lines of the code blocks of a section, in order. */
function sectionCodeLines(markdown: string, level: number, title: string): string[] {
  const { headings, blocks } = scan(markdown);
  const start = headings.find((heading) => heading.level === level && heading.text === title);
  if (start === undefined) throw new Error(`missing: ${'#'.repeat(level)} ${title}`);
  const end = headings.find((heading) => heading.line > start.line && heading.level <= level);
  return blocks
    .filter((block) => block.line > start.line && (end === undefined || block.line < end.line))
    .flatMap((block) => block.body.split('\n').map((line) => line.trim()));
}

/** A step of the Observe list of README.md: its text and its code blocks. */
function observeStep(markdown: string, number: number): { text: string; blocks: Block[] } {
  const { headings, blocks, lines } = scan(markdown);
  const observe = headings.find((heading) => heading.level === 2 && heading.text === 'Observe');
  if (observe === undefined) throw new Error('missing: ## Observe');
  const next = headings.find((heading) => heading.line > observe.line && heading.level <= 2);
  const limit = next === undefined ? lines.length : next.line;
  const isStep = (line: string | undefined, wanted?: number): boolean => {
    const match = /^(\d+)\.\s/.exec(line ?? '');
    return match !== null && (wanted === undefined || Number(match[1]) === wanted);
  };
  let start = -1;
  for (let i = observe.line + 1; i < limit; i += 1) {
    if (isStep(lines[i], number)) {
      start = i;
      break;
    }
  }
  if (start === -1) throw new Error(`missing: Observe step ${number}`);
  let end = limit;
  for (let i = start + 1; i < limit; i += 1) {
    if (isStep(lines[i])) {
      end = i;
      break;
    }
  }
  return {
    text: lines.slice(start, end).join('\n'),
    blocks: blocks.filter((block) => block.line > start && block.line < end),
  };
}

/** The first trimmed line of a block that is not blank. */
const firstCodeLine = (block: Block): string | undefined =>
  block.body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

/** The lines before the first `cd /tmp` that touch one of the probe files (all of them when none). */
function relativeWritesBeforeCd(codeLines: string[]): string[] {
  const cd = codeLines.findIndex((line) => line === 'cd /tmp');
  const before = cd === -1 ? codeLines : codeLines.slice(0, cd);
  return before.filter((line) => /\b(got\.txt|big\.bin|big2\.bin)\b/.test(line));
}

/** A command with its backslash continuations joined on one line. */
const joinContinuations = (text: string): string => text.replace(/\\\r?\n\s*/g, ' ');

describe('AC-32: .gitignore ignores the heartbeat file', () => {
  test('AC-32: .gitignore has the line labs/*/heartbeat.txt', () => {
    const lines = readRepoFile('.gitignore')
      .split(/\r?\n/)
      .map((line) => line.trim());
    expect(lines).toContain('labs/*/heartbeat.txt');
  });
});

describe('AC-35: every relative write on the instance comes after cd /tmp', () => {
  const readme = (): string => readLabFile('README.md');
  const breakIt = (): string => readLabFile('break-it.md');
  const SENTENCE = 'A session does not start in a folder you can write to, so go to /tmp first';

  test('AC-35: README Observe step 6 has a code block whose first line is cd /tmp', () => {
    const { blocks } = observeStep(readme(), 6);
    expect(blocks.length, 'step 6 has no code block').toBeGreaterThan(0);
    expect(firstCodeLine(blocks[0] as Block)).toBe('cd /tmp');
  });

  test('AC-35: README Observe step 6 says a session does not start in a folder you can write to', () => {
    expect(unwrap(observeStep(readme(), 6).text)).toContain(SENTENCE);
  });

  test('AC-35: README Observe has no got.txt, big.bin or big2.bin line above its first cd /tmp', () => {
    const codeLines = sectionCodeLines(readme(), 2, 'Observe');
    expect(codeLines, 'Observe has no cd /tmp line').toContain('cd /tmp');
    expect(relativeWritesBeforeCd(codeLines)).toEqual([]);
  });

  test('AC-35: break-it.md, the endpoint route section, has the code block with got.txt start with cd /tmp', () => {
    const section = need(
      sectionOf(breakIt(), 2, 'Remove the endpoint route'),
      '## Remove the endpoint route',
    );
    const block = scan(section).blocks.find((candidate) => /got\.txt/.test(candidate.body));
    expect(block, 'no code block with got.txt').toBeDefined();
    expect(firstCodeLine(block as Block)).toBe('cd /tmp');
  });

  test('AC-35: break-it.md, the endpoint route section, has no got.txt, big.bin or big2.bin line above its first cd /tmp', () => {
    const codeLines = sectionCodeLines(breakIt(), 2, 'Remove the endpoint route');
    expect(codeLines, 'the section has no cd /tmp line').toContain('cd /tmp');
    expect(relativeWritesBeforeCd(codeLines)).toEqual([]);
  });
});

describe('AC-36: Destroy now names the Region and warns about an empty list', () => {
  const section = (): string =>
    need(sectionOf(readLabFile('README.md'), 2, 'Destroy now'), '## Destroy now');

  test('AC-36: the aws ec2 describe-nat-gateways command has --region us-east-1', () => {
    const commands = joinContinuations(
      scan(section())
        .blocks.map((block) => block.body)
        .join('\n'),
    )
      .split('\n')
      .filter((line) => /\baws ec2 describe-nat-gateways\b/.test(line));
    expect(commands.length, 'no describe-nat-gateways command').toBeGreaterThan(0);
    for (const command of commands) expect(command).toMatch(/--region us-east-1(\s|$)/);
  });

  test('AC-36: the section says an empty list right after the destroy means the wrong account', () => {
    expect(unwrap(section())).toContain(
      'An empty list right after the destroy means you asked the wrong account, not that it is gone',
    );
  });
});

describe('AC-37: the bucket names are echoed before the first session', () => {
  const readme = (): string => readLabFile('README.md');
  const START_SESSION = 'aws ssm start-session --target "$INSTANCE"';

  test('AC-37: echo "$DATA" "$OTHER" is alone in a bash block', () => {
    const block = scan(readme()).blocks.find(
      (candidate) => candidate.lang === 'bash' && candidate.body.trim() === 'echo "$DATA" "$OTHER"',
    );
    expect(block, 'no bash block holding only echo "$DATA" "$OTHER"').toBeDefined();
  });

  test('AC-37: that block comes before the first aws ssm start-session line', () => {
    const { blocks, lines } = scan(readme());
    const echo = blocks.find(
      (candidate) => candidate.lang === 'bash' && candidate.body.trim() === 'echo "$DATA" "$OTHER"',
    );
    const session = lines.findIndex((line) => line.includes(START_SESSION));
    expect(echo, 'no bash block holding only echo "$DATA" "$OTHER"').toBeDefined();
    expect(session, `README has no ${START_SESSION} line`).toBeGreaterThanOrEqual(0);
    expect(echo?.line ?? Number.POSITIVE_INFINITY).toBeLessThan(session);
  });

  test('AC-37: the sentence about steps 5 to 8 comes before the first aws ssm start-session line', () => {
    const text = unwrap(readme());
    const sentence = 'Everything in steps 5 to 8 runs **on the instance**, in the session.';
    const at = text.indexOf(sentence);
    const session = text.indexOf(START_SESSION);
    expect(at, `README does not say: ${sentence}`).toBeGreaterThanOrEqual(0);
    expect(session, `README has no ${START_SESSION} line`).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(session);
  });
});

describe('AC-40: Observe step 10 also runs on macOS', () => {
  const START_LINE =
    "START=$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-20M +%Y-%m-%dT%H:%M:%SZ)";
  const readme = (): string => readLabFile('README.md');

  test('AC-40: README has the START= line that tries GNU date, then BSD date', () => {
    const lines = scan(readme()).blocks.flatMap((block) =>
      block.body.split('\n').map((line) => line.trim()),
    );
    expect(lines).toContain(START_LINE);
  });

  test('AC-40: the get-metric-statistics command passes --start-time "$START"', () => {
    const commands = joinContinuations(
      scan(readme())
        .blocks.map((block) => block.body)
        .join('\n'),
    )
      .split('\n')
      .filter((line) => /\baws cloudwatch get-metric-statistics\b/.test(line));
    expect(commands.length, 'no get-metric-statistics command').toBeGreaterThan(0);
    for (const command of commands) expect(command).toContain('--start-time "$START"');
  });

  test('AC-40: the START= line comes before the get-metric-statistics command', () => {
    const lines = scan(readme()).blocks.flatMap((block) =>
      block.body.split('\n').map((line) => line.trim()),
    );
    const start = lines.indexOf(START_LINE);
    const command = lines.findIndex((line) =>
      /\baws cloudwatch get-metric-statistics\b/.test(line),
    );
    expect(start, 'no START= line').toBeGreaterThanOrEqual(0);
    expect(command, 'no get-metric-statistics line').toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(command);
  });
});

describe('AC-41: Remove the NAT route tells the reader to wait and where the variables are', () => {
  const section = (): string =>
    need(
      sectionOf(readLabFile('break-it.md'), 2, 'Remove the NAT route'),
      '## Remove the NAT route',
    );

  test('AC-41: the wait for the first round is said before the first heartbeat read', () => {
    const text = unwrap(section());
    const sentence =
      'Wait about 30 seconds for the first round (until then the read answers NoSuchKey)';
    const at = text.indexOf(sentence);
    const read = text.search(/\baws s3api get-object\b[^\n]*heartbeat\.txt/);
    expect(at, `the section does not say: ${sentence}`).toBeGreaterThanOrEqual(0);
    expect(read, 'the section never reads heartbeat.txt').toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(read);
  });

  test('AC-41: the second terminal runs Observe, step 1, because $INSTANCE is empty there', () => {
    expect(unwrap(section())).toContain('open a second terminal, run Observe, step 1, in it');
  });
});
