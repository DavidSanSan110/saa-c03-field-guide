import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 048 (issue #144): contract tests over the real files of labs/04-alb-asg-self-healing
// (AC-1 to AC-5, AC-22 to AC-26, AC-28) and the cross-check of the guardrails outside the lab
// (AC-27). The behaviour of the stack (network, load balancer, web tier, outputs) is covered by
// `terraform test` (labs/04-alb-asg-self-healing/tests) and the behaviour of verify.sh by
// lab-04-verify.test.ts; this file covers what those cannot see: the layout, the HCL text, the
// user data, the reader docs, the guardrail text and the 2.2 page.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/04-alb-asg-self-healing';
const LAB_00 = 'labs/00-site-hosting';
const LAB_03 = 'labs/03-nat-vs-gateway-endpoint';

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

/** Every top-level `.tf` file of a lab (git-ignored `*_override.tf` excluded). */
function loadTerraformFilesOf(lab: string): TerraformFile[] {
  const dir = pathIn(lab);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tf') && !name.endsWith('_override.tf'))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8');
      return { name, raw, text: stripHclComments(raw) };
    });
}

const loadTerraformFiles = (): TerraformFile[] => loadTerraformFilesOf(LAB);

function allTerraform(lab: string = LAB): string {
  return loadTerraformFilesOf(lab)
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

/** The body of the one `data "<type>" "<name>"` block of a lab, comments removed, white space collapsed. */
function dataBody(lab: string, type: string, name: string): string {
  const bodies = blockBodies(
    allTerraform(lab),
    new RegExp(`\\bdata\\s+"${type}"\\s+"${name}"\\s*\\{`),
  );
  if (bodies.length !== 1) {
    throw new Error(`expected one data "${type}" "${name}" in ${lab}/*.tf, found ${bodies.length}`);
  }
  return (bodies[0] ?? '').replace(/\s+/g, ' ').trim();
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

  test('AC-1: main.tf has module "tags" with source ../../modules/tags and lab = "04-alb-asg-self-healing"', () => {
    const bodies = blockBodies(stripHclComments(readLabFile('main.tf')), /\bmodule\s+"tags"\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/tags"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*lab\s*=\s*"04-alb-asg-self-healing"\s*$/m);
  });

  test('AC-1: the lock file pins hashicorp/aws to the version of the lab 00 lock file', () => {
    expect(lockVersionOf(LAB)).toBe(lockVersionOf(LAB_00));
  });

  test('AC-1: the lock file holds every h1 hash of the lab 03 lock file (Linux and Windows, section 1 of the spec)', () => {
    const own = new Set(h1Hashes(LAB));
    expect(own.size).toBeGreaterThanOrEqual(2);
    for (const hash of new Set(h1Hashes(LAB_03))) expect(own, hash).toContain(hash);
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
  'aws_route_table_association.public',
  'aws_route_table_association.private',
  'aws_security_group.alb',
  'aws_vpc_security_group_ingress_rule.alb_http',
  'aws_vpc_security_group_egress_rule.alb_to_web',
  'aws_lb.web',
  'aws_lb_target_group.web',
  'aws_lb_listener.http',
  'aws_security_group.web',
  'aws_vpc_security_group_ingress_rule.web_from_alb',
  'aws_launch_template.web',
  'aws_autoscaling_group.web',
];

const OUTPUTS = [
  'vpc_id',
  'availability_zones',
  'alb_arn',
  'alb_dns_name',
  'target_group_arn',
  'asg_name',
  'alb_security_group_id',
  'web_security_group_id',
  'private_subnet_ids',
  'private_route_table_id',
];

describe('AC-2: the blocks of the stack', () => {
  test('AC-2: the resources are exactly the twenty of the spec', () => {
    needTerraformFiles();
    expect(RESOURCES).toHaveLength(20);
    expect(declared('resource', 2)).toEqual([...RESOURCES].sort());
  });

  test('AC-2: the data blocks are exactly aws_ami.al2023_arm64 and aws_ec2_instance_type_offerings.nano', () => {
    needTerraformFiles();
    expect(declared('data', 2)).toEqual(
      ['aws_ami.al2023_arm64', 'aws_ec2_instance_type_offerings.nano'].sort(),
    );
  });

  test('AC-2: the only module block is tags', () => {
    needTerraformFiles();
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

  test('AC-2: the outputs are the ten of the spec', () => {
    needTerraformFiles();
    expect(OUTPUTS).toHaveLength(10);
    expect(declared('output', 1)).toEqual([...OUTPUTS].sort());
  });

  test('AC-2: every output block has a non-empty description', () => {
    needTerraformFiles();
    const bodies = blockBodies(allTerraform(), /\boutput\s+"[^"]+"\s*\{/);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const description = /^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(body)?.[1];
      expect(description?.trim() ?? '', body.trim().split('\n')[0]).not.toBe('');
    }
  });
});

describe('AC-3: constructs the lab must not use (matched in the raw text, comments included)', () => {
  const FORBIDDEN: [string, RegExp][] = [
    ['aws_nat_gateway', /aws_nat_gateway/],
    ['aws_eip', /aws_eip/],
    ['aws_vpc_endpoint', /aws_vpc_endpoint/],
    ['an aws_iam_ resource', /resource\s+"aws_iam_/],
    ['iam_instance_profile', /iam_instance_profile/],
    ['service_linked_role_arn', /service_linked_role_arn/],
    ['key_name', /key_name/],
    ['aws_key_pair', /aws_key_pair/],
    ['aws_s3_object', /aws_s3_object/],
    ['associate_public_ip_address = true', /associate_public_ip_address\s*=\s*true/],
    ['map_public_ip_on_launch = true', /map_public_ip_on_launch\s*=\s*true/],
    ['an ingress block', /\bingress\s*\{/],
    ['an egress block', /\begress\s*\{/],
    ['a literal availability_zone', /\bavailability_zone\s*=\s*"/],
  ];

  test.each(FORBIDDEN)('AC-3: no top-level .tf file contains %s', (_name, pattern) => {
    for (const file of needTerraformFiles()) expect(file.raw, file.name).not.toMatch(pattern);
  });
});

// =================================================================================================
// AC-4: ordering with depends_on, the AMI lookup, the launch template lifecycle
// =================================================================================================

describe('AC-4: ordering, AMI lookup and lifecycle', () => {
  test('AC-4: aws_lb.web waits for aws_route.public_internet', () => {
    expect(dependsOn(resourceBody('aws_lb', 'web'))).toContain('aws_route.public_internet');
  });

  test('AC-4: aws_autoscaling_group.web waits for aws_lb_listener.http', () => {
    expect(dependsOn(resourceBody('aws_autoscaling_group', 'web'))).toContain(
      'aws_lb_listener.http',
    );
  });

  test('AC-4: aws_launch_template.web has lifecycle ignore_changes = [image_id]', () => {
    const lifecycles = blockBodies(resourceBody('aws_launch_template', 'web'), /\blifecycle\s*\{/);
    expect(lifecycles).toHaveLength(1);
    expect(lifecycles[0]).toMatch(/^\s*ignore_changes\s*=\s*\[\s*image_id\s*,?\s*\]\s*$/m);
  });

  test('AC-4: the AMI data block has owners = ["amazon"] and the name filter al2023-ami-2023.*-arm64', () => {
    needTerraformFiles();
    const body = dataBody(LAB, 'aws_ami', 'al2023_arm64');
    expect(body).toMatch(/\bowners\s*=\s*\[\s*"amazon"\s*\]/);
    expect(body).toMatch(
      /\bfilter\s*\{\s*name\s*=\s*"name"\s*values\s*=\s*\[\s*"al2023-ami-2023\.\*-arm64"\s*\]\s*\}/,
    );
  });

  test('AC-4: the AMI data block is exactly the one of lab 03 (same owner and four filters, section 2 of the spec)', () => {
    needTerraformFiles();
    expect(dataBody(LAB, 'aws_ami', 'al2023_arm64')).toBe(
      dataBody(LAB_03, 'aws_ami', 'al2023_arm64'),
    );
  });

  test('AC-4: the instance type offerings data block is the one of lab 03 (section 2 of the spec)', () => {
    needTerraformFiles();
    expect(dataBody(LAB, 'aws_ec2_instance_type_offerings', 'nano')).toBe(
      dataBody(LAB_03, 'aws_ec2_instance_type_offerings', 'nano'),
    );
  });
});

// =================================================================================================
// AC-5: user-data.sh
// =================================================================================================

const SERVER_LINE =
  'systemd-run --unit fg-lab04-web python3 -m http.server 80 --directory /srv/fg-lab04';

describe('AC-5: user-data.sh', () => {
  const script = (): string => readLabFile('user-data.sh');

  test('AC-5: the first line is #!/bin/bash', () => {
    expect(script().split('\n')[0]).toBe('#!/bin/bash');
  });

  test.each([
    'set -euo pipefail',
    'X-aws-ec2-metadata-token-ttl-seconds',
    'X-aws-ec2-metadata-token:',
    'latest/api/token',
    'meta-data/instance-id',
    'meta-data/placement/availability-zone',
    '/srv/fg-lab04/index.html',
  ])('AC-5: it contains "%s"', (needle) => {
    expect(script()).toContain(needle);
  });

  test('AC-5: its last non-empty line starts the web server with systemd-run', () => {
    const lines = script()
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines.at(-1)).toBe(SERVER_LINE);
  });

  test.each([
    ['dnf', /dnf/],
    ['yum', /yum/],
    ['rpm followed by a space', /rpm /],
    ['amazon-linux-extras', /amazon-linux-extras/],
    ['pip or pip3 as a word', /\bpip3?\b/],
    ['https://', /https:\/\//],
    ['a carriage return', /\r/],
  ])(
    'AC-5: it contains no %s (it installs nothing and reaches nothing but IMDS)',
    (_name, pattern) => {
      expect(script()).not.toMatch(pattern);
    },
  );

  test('AC-5: it has at least one http:// and every http:// is followed by 169.254.169.254/', () => {
    const parts = script().split('http://');
    expect(parts.length, 'no http:// in the script').toBeGreaterThan(1);
    for (const rest of parts.slice(1)) {
      expect(rest.startsWith('169.254.169.254/'), rest.slice(0, 40)).toBe(true);
    }
  });

  test('AC-5: it is under 16,384 bytes', () => {
    expect(Buffer.byteLength(script(), 'utf8')).toBeLessThan(16_384);
  });

  test('AC-5: bash -n user-data.sh exits 0', () => {
    script();
    const result = spawnSync(bashPath(), ['-n', 'user-data.sh'], {
      cwd: pathIn(LAB),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

let bashPathCache: string | undefined;

/** Absolute path of the bash that runs the tests (a path Node can spawn). */
function bashPath(): string {
  if (bashPathCache !== undefined) return bashPathCache;
  const probe = spawnSync(
    'bash',
    [
      '-c',
      'p=$(command -v bash); if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; else printf "%s" "$p"; fi',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const path = probe.stdout.trim();
  if (probe.status !== 0 || path === '' || !existsSync(path)) {
    throw new Error(`cannot resolve the absolute path of bash (got "${path}")`);
  }
  bashPathCache = path;
  return path;
}

// =================================================================================================
// AC-22, AC-23, AC-24: README.md and break-it.md
// =================================================================================================

const README_HEADINGS = [
  '# Lab 04: ALB + Auto Scaling self-healing across AZs',
  '## What you build',
  '## Cost',
  '## Prerequisites',
  '## Quick start in your own account',
  '## Observe',
  '## Verify',
  '## Destroy now',
];

const README_GUIDE_PATH = '../../apps/site/src/content/docs/d2/2-2-high-availability/';

const README_STRINGS = [
  'alb-asg-az-failure',
  README_GUIDE_PATH,
  'eu-west-1',
  'NAT gateway',
  'egress',
  'IMDSv2',
  'AvailabilityZoneImpairmentPolicy',
  '300 seconds',
  '$0.0252',
  '$0.008',
  '$0.005',
  '$0.0046',
  '$0.088',
  '$26.52',
  '$7.30',
  'Plan: 24 to add',
  'lab.tfplan',
  'terraform destroy',
  'destroy labs/04-alb-asg-self-healing',
  'LoadBalancerNotFound',
  'describe-target-health',
  'verify: ok (15 passed, 0 skipped)',
];

describe('AC-22: README.md', () => {
  const readme = (): string => readLabFile('README.md');
  const mermaid = (): string => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    return need(block?.body, 'a mermaid code block in README.md');
  };

  test('AC-22: the # and ## headings are exactly the eight of the spec, in order', () => {
    const headings = scan(readme())
      .headings.filter((heading) => heading.level <= 2)
      .map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
    expect(headings).toEqual(README_HEADINGS);
  });

  test('AC-22: the warning between the # heading and the first ## heading says to destroy the same day', () => {
    const { headings, lines } = scan(readme());
    const first = headings.find((heading) => heading.level === 1);
    const second = headings.find((heading) => heading.level === 2);
    expect(first, 'no # heading').toBeDefined();
    expect(second, 'no ## heading').toBeDefined();
    const between = lines.slice((first?.line ?? 0) + 1, second?.line ?? 0).join('\n');
    expect(flat(between)).toContain('same day');
  });

  test('AC-22: that warning is about the load balancer and the instances', () => {
    const { headings, lines } = scan(readme());
    const first = headings.find((heading) => heading.level === 1);
    const second = headings.find((heading) => heading.level === 2);
    const between = flat(lines.slice((first?.line ?? 0) + 1, second?.line ?? 0).join('\n'));
    expect(between).toMatch(/load balancer|\balb\b/);
    expect(between).toMatch(/instances?/);
  });

  test('AC-22: it has a mermaid block with a flowchart', () => {
    expect(mermaid()).toContain('flowchart');
  });

  test('AC-22: the flowchart names the load balancer, the public and private subnets and the instances (section 8 of the spec)', () => {
    const body = mermaid();
    expect(body).toMatch(/ALB|load balancer/i);
    expect(body).toMatch(/public/i);
    expect(body).toMatch(/private/i);
    expect(body).toMatch(/instance/i);
  });

  test.each(README_STRINGS)('AC-22: it contains "%s"', (needle) => {
    expect(readme()).toContain(needle);
  });

  test('AC-22: the repo-relative guide link resolves to a directory of the repo', () => {
    expect(readme()).toContain(`](${README_GUIDE_PATH}`);
    expect(existsSync(pathIn(LAB, ...README_GUIDE_PATH.split('/')))).toBe(true);
  });
});

const BREAK_SECTIONS = [
  'Terminate an instance',
  'Break the health check',
  'Shift traffic away from one AZ',
];

const BREAK_STRINGS = [
  'terminate-instances',
  'describe-scaling-activities',
  'draining',
  '--no-should-decrement-desired-capacity',
  'modify-target-group',
  '--health-check-path /missing',
  'Target.ResponseCodeMismatch',
  'fails open',
  'health_check_type',
  'start-zonal-shift',
  '--away-from',
  'ZoneId',
  '--expires-in',
  '--comment',
  'get-managed-resource',
  'cancel-zonal-shift',
  'zonal_shift_active',
  'AWS_REGION=eu-west-1',
];

describe('AC-23: break-it.md', () => {
  const breakIt = (): string => readLabFile('break-it.md');

  test('AC-23: it starts with its title', () => {
    const first = breakIt()
      .split(/\r?\n/)
      .find((line) => line.trim() !== '');
    expect(first).toBe('# Break lab 04 on purpose');
  });

  test('AC-23: it has exactly the three ## sections of the spec, in order', () => {
    const headings = scan(breakIt())
      .headings.filter((heading) => heading.level === 2)
      .map((heading) => heading.text);
    expect(headings).toEqual(BREAK_SECTIONS);
  });

  test.each(BREAK_SECTIONS)('AC-23: the section "%s" has the four parts', (title) => {
    const section = need(sectionOf(breakIt(), 2, title), `## ${title}`);
    for (const part of ['What to do', 'What you see', 'Why', 'Put it back']) {
      expect(section, part).toContain(part);
    }
  });

  test.each(BREAK_STRINGS)('AC-23: it mentions %s', (needle) => {
    expect(breakIt()).toContain(needle);
  });

  test('AC-23: the zonal shift section says the shift has no effect while the load balancer fails open', () => {
    const section = flat(
      need(
        sectionOf(breakIt(), 2, 'Shift traffic away from one AZ'),
        '## Shift traffic away from one AZ',
      ),
    );
    expect(section).toMatch(/no effect[^.]{0,80}fails? open|fails? open[^.]{0,80}no effect/);
  });
});

describe('AC-24: modify-target-group is run with MSYS_NO_PATHCONV=1', () => {
  test('AC-24: break-it.md has at least two modify-target-group lines (the break and the put back)', () => {
    const lines = readLabFile('break-it.md')
      .split(/\r?\n/)
      .filter((line) => line.includes('modify-target-group'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test('AC-24: every line of break-it.md with modify-target-group starts with MSYS_NO_PATHCONV=1', () => {
    const lines = readLabFile('break-it.md')
      .split(/\r?\n/)
      .filter((line) => line.includes('modify-target-group'));
    expect(lines.length, 'no modify-target-group line').toBeGreaterThan(0);
    for (const line of lines)
      expect(line.trimStart().startsWith('MSYS_NO_PATHCONV=1 '), line).toBe(true);
  });
});

// =================================================================================================
// AC-25: aws output read through a substitution has its CR removed
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

describe('AC-25: aws output read through a substitution has its CR removed', () => {
  const awsSubstitutions = (name: string, opener: '<(' | '$('): string[] =>
    substitutions(readLabFile(name), opener).filter((inner) => /\baws\b/.test(inner));

  test('AC-25: README.md and break-it.md have command substitutions that read aws output', () => {
    const count =
      awsSubstitutions('README.md', '$(').length + awsSubstitutions('break-it.md', '$(').length;
    expect(count).toBeGreaterThan(0);
  });

  test.each([
    ['README.md', '<('],
    ['break-it.md', '<('],
    ['README.md', '$('],
    ['break-it.md', '$('],
  ] as const)("AC-25: every aws substitution %s %s ends with | tr -d '\\r'", (name, opener) => {
    readLabFile(name);
    for (const inner of awsSubstitutions(name, opener)) {
      expect(inner.trim(), inner.trim().slice(0, 60)).toMatch(/\|\s*tr\s+-d\s+'\\r'$/);
    }
  });
});

// =================================================================================================
// AC-26: nothing private in the reader-facing files
// =================================================================================================

const ALLOWED_NUMBERS = new Set(['111122223333']);
const COURSE_SECTION = /[Ss]ection \d/;
// Built at run time, so that this file does not hold the blocked strings itself.
const ADMIN_POLICY = 'Administrator' + 'Access';
const PRIVATE_DOMAIN = 'tech-' + 'leads.lol';

function twelveDigitNumbers(text: string): string[] {
  return (text.match(/(?<!\d)\d{12}(?!\d)/g) ?? []).filter(
    (digits) => !ALLOWED_NUMBERS.has(digits),
  );
}

describe('AC-26: no account ids, course section references, the admin policy name or the private domain', () => {
  const FILES = ['README.md', 'break-it.md', 'verify.sh', 'user-data.sh'];

  const checkText = (label: string, text: string): void => {
    expect(twelveDigitNumbers(text), `${label}: 12-digit numbers`).toEqual([]);
    expect(text, `${label}: course section reference`).not.toMatch(COURSE_SECTION);
    expect(text, `${label}: the admin policy name`).not.toContain(ADMIN_POLICY);
    expect(text, `${label}: the private domain`).not.toContain(PRIVATE_DOMAIN);
  };

  test.each(FILES)('AC-26: %s has none of them', (name) => {
    checkText(name, readLabFile(name));
  });

  test('AC-26: no top-level .tf file has any of them', () => {
    for (const file of needTerraformFiles()) checkText(file.name, file.raw);
  });
});

// =================================================================================================
// AC-27: no guardrail outside the lab shadows its demo (lesson of #110)
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

/** An IAM action pattern (`ec2:Run*`, `*`) as a case-insensitive regular expression. */
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

/** The actions the lab's deploy, its checks and its three breaks need (spec 048, AC-27). */
const DEMO_ACTIONS = [
  'ec2:*',
  'ec2:RunInstances',
  'ec2:CreateTags',
  'ec2:TerminateInstances',
  'elasticloadbalancing:*',
  'elasticloadbalancing:ModifyTargetGroup',
  'elasticloadbalancing:ModifyLoadBalancerAttributes',
  'autoscaling:*',
  'autoscaling:CreateAutoScalingGroup',
  'arc-zonal-shift:*',
  'arc-zonal-shift:StartZonalShift',
  'arc-zonal-shift:CancelZonalShift',
  'iam:CreateServiceLinkedRole',
];

/**
 * The Deny statements with NotAction that exist today. A Deny with NotAction covers every action but
 * the listed ones, so a new one would shadow the demo (the same guard as lab 03).
 */
const ALLOWED_NOT_ACTION_DENIES = [
  'DenyOutsideAllowedRegions',
  'DenyProtectedIamChanges',
  'DenyStateBucketSettings',
];

describe('AC-27: no guardrail outside the lab shadows the demo', () => {
  const all = (): Deny[] => GUARDRAIL_FILES.flatMap((segments) => denyStatements(...segments));

  test('AC-27: the reader finds the Deny statements of the three guardrail files', () => {
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

  test('AC-27: no Deny Action names or covers an EC2, load balancing, Auto Scaling, ARC zonal shift or service-linked role demo action', () => {
    const shadows: string[] = [];
    for (const deny of all()) {
      for (const action of actionStrings(deny)) {
        for (const demo of DEMO_ACTIONS) {
          if (actionPattern(action).test(demo)) {
            shadows.push(`${deny.file}: ${deny.sid} denies ${action}, which covers ${demo}`);
          }
        }
      }
    }
    expect(shadows).toEqual([]);
  });

  test('AC-27: every Deny with NotAction is one of the three that exist today', () => {
    const notActions = all()
      .filter((deny) => /(?<![A-Za-z_])NotAction\s*=/.test(deny.text))
      .map((deny) => deny.sid);
    expect(notActions.length).toBeGreaterThan(0);
    expect(
      notActions.filter((sid) => !ALLOWED_NOT_ACTION_DENIES.includes(sid)),
      'Deny statements with NotAction other than the named ones',
    ).toEqual([]);
  });

  test('AC-27: eu-west-1 is in the allowed_regions of the SCP, which denies only outside them', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyOutsideAllowedRegions');
    expect(deny, 'DenyOutsideAllowedRegions not found').toBeDefined();
    expect(deny?.text).toContain('aws:RequestedRegion');
    expect(repoText('bootstrap', 'management', 'scp.tf')).toMatch(
      /\ballowed_regions\s*=\s*\[[^\]]*"eu-west-1"[^\]]*\]/,
    );
  });

  test('AC-27: iam:PassRole is denied outside role/lab/* (DenyRoleWritesOutsideLabPath)', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyRoleWritesOutsideLabPath');
    expect(deny, 'DenyRoleWritesOutsideLabPath not found').toBeDefined();
    expect(actionStrings(deny as Deny)).toContain('iam:PassRole');
  });

  test('AC-27: so the lab must never need PassRole: no lab .tf has iam_instance_profile or service_linked_role_arn', () => {
    for (const file of needTerraformFiles()) {
      expect(file.raw, file.name).not.toContain('iam_instance_profile');
      expect(file.raw, file.name).not.toContain('service_linked_role_arn');
    }
  });
});

// =================================================================================================
// AC-28: the 2.2 page links the lab
// =================================================================================================

describe('AC-28: the 2.2 page links the lab', () => {
  const URL =
    'https://github.com/DavidSanSan110/saa-c03-field-guide/tree/main/labs/04-alb-asg-self-healing';
  const BULLET =
    '- [Lab 04: ALB + Auto Scaling self-healing across AZs](https://github.com/DavidSanSan110/saa-c03-field-guide/tree/main/labs/04-alb-asg-self-healing) deploys the setup of the ALB and Auto Scaling diagram above: a load balancer in two AZs, a group that replaces a terminated instance, and a zonal shift.';

  const page = (): string =>
    readRepoFile(
      'apps',
      'site',
      'src',
      'content',
      'docs',
      'd2',
      '2-2-high-availability',
      'index.mdx',
    );

  /** The index of the first line from `after` on that equals `wanted`, or -1. */
  const lineIndex = (lines: string[], wanted: string, after: number): number =>
    lines.findIndex((line, index) => index > after && line.trim() === wanted);

  test('AC-28: the page links the lab folder on GitHub exactly once', () => {
    const parts = page().split(URL);
    expect(parts.length - 1, `the page must link ${URL} once`).toBe(1);
  });

  test('AC-28: ## Links has a **Labs** paragraph after the **Practice** list', () => {
    const lines = page().split(/\r?\n/);
    const links = lineIndex(lines, '## Links', -1);
    expect(links, 'no ## Links heading').toBeGreaterThanOrEqual(0);
    const practice = lineIndex(lines, '**Practice**', links);
    expect(practice, 'no **Practice** line after ## Links').toBeGreaterThan(links);
    const labs = lineIndex(lines, '**Labs**', practice);
    expect(labs, 'no **Labs** line after the **Practice** list').toBeGreaterThan(practice);
  });

  test('AC-28: under **Labs** there is exactly one bullet, byte for byte the one of the spec', () => {
    const lines = page().split(/\r?\n/);
    const links = lineIndex(lines, '## Links', -1);
    const practice = lineIndex(lines, '**Practice**', links);
    const labs = lineIndex(lines, '**Labs**', practice);
    expect(labs, 'no **Labs** line after the **Practice** list').toBeGreaterThan(practice);
    const nextHeading = lines.findIndex((line, index) => index > labs && /^#{1,6}\s/.test(line));
    const section = lines
      .slice(labs + 1, nextHeading === -1 ? lines.length : nextHeading)
      .filter((line) => line.trim() !== '');
    expect(section).toEqual([BULLET]);
  });
});
