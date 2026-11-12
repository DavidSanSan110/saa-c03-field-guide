import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 046 (issue #143): contract tests over the real files of labs/05-sqs-lambda-dlq (AC-1 to AC-4),
// the reader docs (AC-29 to AC-32), the cross-check of the guardrails outside the lab (AC-33) and
// the repo files (AC-34, AC-35). The behaviour of the stack is covered by `terraform test`
// (labs/05-sqs-lambda-dlq/tests), the handler by lab-05-handler.test.ts and verify.sh by
// lab-05-verify.test.ts; this file covers what those cannot see: the layout, the HCL text, the
// reader docs, the repo files and the guardrail text.

vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB = 'labs/05-sqs-lambda-dlq';
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

function dataBody(type: string, name: string): string {
  const bodies = blockBodies(
    allTerraform(),
    new RegExp(`\\bdata\\s+"${type}"\\s+"${name}"\\s*\\{`),
  );
  if (bodies.length !== 1) {
    throw new Error(`expected one data "${type}" "${name}" in ${LAB}/*.tf, found ${bodies.length}`);
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

const descriptionOf = (body: string): string =>
  /^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(body)?.[1]?.trim() ?? '';

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

interface ProviderPin {
  source: string | undefined;
  version: string | undefined;
}

/** The `source` and `version` of one entry (`aws = { ... }`) of the required_providers of a lab. */
function providerPin(lab: string, name: string): ProviderPin {
  const required = blockBodies(
    stripHclComments(readIn(lab, 'versions.tf')),
    /\brequired_providers\s*\{/,
  );
  expect(required, `${lab}/versions.tf has one required_providers block`).toHaveLength(1);
  const entries = blockBodies(required[0] ?? '', new RegExp(`\\b${name}\\s*=\\s*\\{`));
  expect(entries, `${lab}/versions.tf has one ${name} entry in required_providers`).toHaveLength(1);
  const body = entries[0] ?? '';
  return {
    source: /^\s*source\s*=\s*"([^"]+)"\s*$/m.exec(body)?.[1],
    version: /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(body)?.[1],
  };
}

interface LockEntry {
  version: string | undefined;
  h1: string[];
}

function lockEntry(lab: string, provider: string): LockEntry {
  const bodies = blockBodies(
    readIn(lab, '.terraform.lock.hcl'),
    new RegExp(`^provider\\s+"registry\\.terraform\\.io/hashicorp/${provider}"\\s*\\{`, 'm'),
  );
  expect(bodies, `${lab}/.terraform.lock.hcl has one entry for hashicorp/${provider}`).toHaveLength(
    1,
  );
  const body = bodies[0] ?? '';
  return {
    version: /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(body)?.[1],
    h1: body.match(/"h1:[A-Za-z0-9+/=]+"/g) ?? [],
  };
}

describe('AC-1: versions, providers, tags and lock file', () => {
  test('AC-1: versions.tf requires Terraform >= 1.14.0', () => {
    expect(stripHclComments(readLabFile('versions.tf'))).toMatch(
      /^\s*required_version\s*=\s*">=\s*1\.14\.0"\s*$/m,
    );
  });

  test('AC-1: versions.tf pins hashicorp/aws to exactly the version lab 00 pins', () => {
    const pin = providerPin(LAB, 'aws');
    expect(pin.source).toBe('hashicorp/aws');
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin.version).toBe(providerPin(LAB_00, 'aws').version);
  });

  test('AC-1: versions.tf pins hashicorp/archive to one exact version', () => {
    const pin = providerPin(LAB, 'archive');
    expect(pin.source).toBe('hashicorp/archive');
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
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
    blockBodies(stripHclComments(readLabFile('providers.tf')), /\bprovider\s+"aws"\s*\{/);

  test('AC-1: providers.tf has exactly one provider "aws" (no alias)', () => {
    const awsProviders = providers();
    expect(awsProviders).toHaveLength(1);
    expect(awsProviders[0]).not.toMatch(/^\s*alias\s*=/m);
  });

  test('AC-1: the aws provider is in eu-west-1, the Region of the diagram', () => {
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

  test('AC-1: main.tf has module "tags" with source ../../modules/tags and lab = "05-sqs-lambda-dlq"', () => {
    const bodies = blockBodies(stripHclComments(readLabFile('main.tf')), /\bmodule\s+"tags"\s*\{/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/tags"\s*$/m);
    expect(bodies[0]).toMatch(/^\s*lab\s*=\s*"05-sqs-lambda-dlq"\s*$/m);
  });

  test('AC-1: the lock file pins hashicorp/aws to the version of versions.tf, with two h1 hashes or more', () => {
    const entry = lockEntry(LAB, 'aws');
    expect(entry.version).toBe(providerPin(LAB, 'aws').version);
    expect(new Set(entry.h1).size).toBeGreaterThanOrEqual(2);
  });

  test('AC-1: the lock file pins hashicorp/archive to the version of versions.tf, with two h1 hashes or more', () => {
    const entry = lockEntry(LAB, 'archive');
    expect(entry.version).toBe(providerPin(LAB, 'archive').version);
    expect(new Set(entry.h1).size).toBeGreaterThanOrEqual(2);
  });
});

// =================================================================================================
// AC-2, AC-3: the blocks of the stack, variables, outputs, forbidden constructs
// =================================================================================================

const RESOURCES = [
  'aws_sqs_queue.source',
  'aws_sqs_queue.dlq',
  'aws_sqs_queue_redrive_policy.source',
  'aws_sqs_queue_redrive_allow_policy.dlq',
  'aws_iam_role.consumer',
  'aws_iam_role_policy.consumer',
  'aws_cloudwatch_log_group.consumer',
  'aws_lambda_function.consumer',
  'aws_lambda_event_source_mapping.orders',
  'aws_cloudwatch_metric_alarm.dlq_not_empty',
];

const VARIABLES = [
  'batching_window_seconds',
  'function_timeout_seconds',
  'visibility_timeout_seconds',
];

const OUTPUTS = [
  'source_queue_url',
  'source_queue_arn',
  'dlq_url',
  'dlq_arn',
  'function_name',
  'event_source_mapping_uuid',
  'log_group_name',
  'alarm_name',
];

describe('AC-2: the blocks of the stack', () => {
  test('AC-2: the resources are exactly the ten of the spec', () => {
    expect(RESOURCES).toHaveLength(10);
    expect(declared('resource', 2)).toEqual([...RESOURCES].sort());
  });

  test('AC-2: the data blocks are exactly aws_caller_identity.current and archive_file.handler', () => {
    expect(declared('data', 2)).toEqual(['archive_file.handler', 'aws_caller_identity.current']);
  });

  test('AC-2: the only module block is tags', () => {
    expect(declared('module', 1)).toEqual(['tags']);
  });

  test('AC-2: the variable blocks are exactly the three of the spec', () => {
    expect(declared('variable', 1)).toEqual([...VARIABLES].sort());
  });

  test('AC-2: every variable block has a non-empty description', () => {
    const bodies = blockBodies(allTerraform(), /\bvariable\s+"[^"]+"\s*\{/);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(descriptionOf(body), body.trim().split('\n')[0]).not.toBe('');
  });

  test('AC-2: the outputs are the eight of the spec', () => {
    expect(OUTPUTS).toHaveLength(8);
    expect(declared('output', 1)).toEqual([...OUTPUTS].sort());
  });

  test('AC-2: every output block has a non-empty description', () => {
    const bodies = blockBodies(allTerraform(), /\boutput\s+"[^"]+"\s*\{/);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(descriptionOf(body), body.trim().split('\n')[0]).not.toBe('');
  });
});

describe('AC-3: constructs the lab must not use', () => {
  const FORBIDDEN: [string, RegExp][] = [
    ['managed_policy_arns', /\bmanaged_policy_arns\b/],
    ['an inline_policy block', /\binline_policy\b/],
    ['AWSLambdaSQSQueueExecutionRole', /AWSLambdaSQSQueueExecutionRole/],
    ['AWSLambdaBasicExecutionRole', /AWSLambdaBasicExecutionRole/],
    ['logs:CreateLogGroup', /logs:CreateLogGroup/],
    ['kms_master_key_id', /\bkms_master_key_id\b/],
    ['scaling_config', /\bscaling_config\b/],
    ['reserved_concurrent_executions', /\breserved_concurrent_executions\b/],
    ['vpc_config', /\bvpc_config\b/],
    ['aws_sqs_queue_policy', /\baws_sqs_queue_policy\b/],
    ['aws_lambda_permission', /\baws_lambda_permission\b/],
    ['alarm_actions', /\balarm_actions\b/],
    ['aws_s3_object', /aws_s3_object/],
  ];

  test.each(FORBIDDEN)('AC-3: no top-level .tf file contains %s', (_name, pattern) => {
    for (const file of needTerraformFiles()) expect(file.text, file.name).not.toMatch(pattern);
  });

  test('AC-3: no aws_sqs_queue block has a redrive_policy argument', () => {
    const bodies = blockBodies(allTerraform(), /\bresource\s+"aws_sqs_queue"\s+"[^"]+"\s*\{/);
    expect(bodies, 'no aws_sqs_queue block found').toHaveLength(2);
    for (const body of bodies) expect(body).not.toMatch(/^\s*redrive_policy\s*=/m);
  });
});

// =================================================================================================
// AC-4: depends_on and the archive
// =================================================================================================

describe('AC-4: ordering with depends_on, and the archive', () => {
  test('AC-4: aws_lambda_function.consumer waits for the log group and the role policy', () => {
    const list = dependsOn(resourceBody('aws_lambda_function', 'consumer'));
    expect(list).toContain('aws_cloudwatch_log_group.consumer');
    expect(list).toContain('aws_iam_role_policy.consumer');
  });

  test('AC-4: aws_lambda_event_source_mapping.orders waits for the role policy and the redrive policy', () => {
    const list = dependsOn(resourceBody('aws_lambda_event_source_mapping', 'orders'));
    expect(list).toContain('aws_iam_role_policy.consumer');
    expect(list).toContain('aws_sqs_queue_redrive_policy.source');
  });

  test('AC-4: the archive sets output_file_mode = "0644"', () => {
    expect(dataBody('archive_file', 'handler')).toMatch(/^\s*output_file_mode\s*=\s*"0644"\s*$/m);
  });

  test('AC-4: the archive source_file ends with src/handler.py', () => {
    expect(dataBody('archive_file', 'handler')).toMatch(
      /^\s*source_file\s*=\s*"[^"\n]*src\/handler\.py"\s*$/m,
    );
  });

  test('AC-4: the archive output_path is under .build/', () => {
    expect(dataBody('archive_file', 'handler')).toMatch(
      /^\s*output_path\s*=\s*"[^"\n]*\.build\/[^"\n]+"\s*$/m,
    );
  });
});

// =================================================================================================
// AC-29, AC-30: README.md and break-it.md
// =================================================================================================

const README_HEADINGS = [
  '# Lab 05: SQS + Lambda + dead-letter queue',
  '## What you build',
  '## Cost',
  '## Prerequisites',
  '## Quick start in your own account',
  '## Observe',
  '## Verify',
  '## Destroy now',
];

const README_GUIDE_PATH = '../../apps/site/src/content/docs/d2/2-1-scalable-loosely-coupled/';

const README_STRINGS = [
  'sqs-lambda-dlq',
  README_GUIDE_PATH,
  'fg-workload-boundary',
  '/lab/',
  'fg-lab05-consumer',
  'logs:CreateLogGroup',
  'maxReceiveCount',
  'at least 5',
  '6 × 5 + 5',
  'VERIFY_SEND=1',
  'lab.tfplan',
  'terraform destroy',
  '$0.20',
  '$0.40',
  '$0.57',
  '$0.10',
  'NumberOfEmptyReceives',
  'start-message-move-task',
  'eu-west-1',
  'destroy labs/05-sqs-lambda-dlq',
];

describe('AC-29: README.md', () => {
  const readme = (): string => readLabFile('README.md');
  const mermaid = (): string => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    return need(block?.body, 'a mermaid code block in README.md');
  };
  /** The note between the # heading and the first ## heading. */
  const note = (): string => {
    const { headings, lines } = scan(readme());
    const first = headings.find((heading) => heading.level === 1);
    const second = headings.find((heading) => heading.level === 2);
    expect(first, 'no # heading').toBeDefined();
    expect(second, 'no ## heading').toBeDefined();
    return lines.slice((first?.line ?? 0) + 1, second?.line ?? 0).join('\n');
  };

  test('AC-29: the # and ## headings are exactly the eight of the spec, in order', () => {
    const headings = scan(readme())
      .headings.filter((heading) => heading.level <= 2)
      .map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
    expect(headings).toEqual(README_HEADINGS);
  });

  test('AC-29: the note under the title says nothing bills by the hour', () => {
    expect(flat(note())).toContain('by the hour');
  });

  test('AC-29: the note under the title says to destroy', () => {
    expect(flat(note())).toContain('destroy');
  });

  test('AC-29: it has a mermaid block with a flowchart', () => {
    expect(mermaid()).toContain('flowchart');
  });

  test('AC-29: the flowchart names the producer, the source queue, the function, the DLQ and the alarm', () => {
    const body = mermaid();
    expect(body).toMatch(/producer/i);
    expect(body).toMatch(/queue/i);
    expect(body).toMatch(/function|lambda/i);
    expect(body).toMatch(/dlq|dead-letter/i);
    expect(body).toMatch(/alarm/i);
  });

  test.each(README_STRINGS)('AC-29: it contains "%s"', (needle) => {
    expect(readme()).toContain(needle);
  });
});

const BREAK_SECTIONS = [
  'Send a poison message',
  'Redrive the dead-letter queue',
  'Turn off partial batch responses',
  'Break the timeout rule',
];

describe('AC-30: break-it.md', () => {
  const breakIt = (): string => readLabFile('break-it.md');

  test('AC-30: it starts with its title', () => {
    const first = breakIt()
      .split(/\r?\n/)
      .find((line) => line.trim() !== '');
    expect(first).toBe('# Break lab 05 on purpose');
  });

  test('AC-30: it has exactly the four ## sections of the spec, in order', () => {
    const headings = scan(breakIt())
      .headings.filter((heading) => heading.level === 2)
      .map((heading) => heading.text);
    expect(headings).toEqual(BREAK_SECTIONS);
  });

  test.each(BREAK_SECTIONS)('AC-30: the section "%s" has the four parts', (title) => {
    const section = need(sectionOf(breakIt(), 2, title), `## ${title}`);
    for (const part of ['What to do', 'What you see', 'Why', 'Put it back']) {
      expect(section, part).toContain(part);
    }
  });

  test.each([
    'send-message-batch',
    'not an order',
    'start-message-move-task',
    'list-message-move-tasks',
    "--function-response-types '[]'",
    '--function-response-types ReportBatchItemFailures',
    'visibility_timeout_seconds=10',
    'VisibilityTimeout=10',
    'VisibilityTimeout=35',
    'InvalidParameterValueException',
    'at least 5',
    'AWS_REGION=eu-west-1',
    'fg-workload-boundary',
  ])('AC-30: it mentions %s', (needle) => {
    expect(breakIt()).toContain(needle);
  });
});

// =================================================================================================
// AC-31: CR removed from aws output, no receive, MSYS_NO_PATHCONV on aws logs
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

/** The commands of the code blocks of a markdown text, with `\` line continuations joined. */
function codeCommands(markdown: string): string[] {
  return scan(markdown)
    .blocks.flatMap((block) => block.body.replace(/\\\r?\n/g, ' ').split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

describe('AC-31: reader commands', () => {
  const READS_AWS_OR_TERRAFORM = /\baws\b|\bterraform\s+output\b/;
  const readingSubstitutions = (name: string, opener: '<(' | '$('): string[] =>
    substitutions(readLabFile(name), opener).filter((inner) => READS_AWS_OR_TERRAFORM.test(inner));

  test('AC-31: README.md has command substitutions that read terraform output or aws', () => {
    expect(readingSubstitutions('README.md', '$(').length).toBeGreaterThan(0);
  });

  test.each([
    ['README.md', '<('],
    ['break-it.md', '<('],
    ['README.md', '$('],
    ['break-it.md', '$('],
  ] as const)(
    "AC-31: every aws or terraform output substitution %s %s ends with | tr -d '\\r'",
    (name, opener) => {
      readLabFile(name);
      for (const inner of readingSubstitutions(name, opener)) {
        expect(inner.trim(), inner.trim().slice(0, 60)).toMatch(/\|\s*tr\s+-d\s+'\\r'$/);
      }
    },
  );

  test.each(['README.md', 'break-it.md', 'verify.sh'])(
    'AC-31: %s has neither receive-message nor purge-queue',
    (name) => {
      const text = readLabFile(name);
      expect(text).not.toContain('receive-message');
      expect(text).not.toContain('purge-queue');
    },
  );

  test('AC-31: README.md has an aws logs command', () => {
    const commands = codeCommands(readLabFile('README.md')).filter((line) =>
      /\baws logs\b/.test(line),
    );
    expect(commands.length).toBeGreaterThan(0);
  });

  test.each(['README.md', 'break-it.md'])(
    'AC-31: every aws logs command of %s runs with MSYS_NO_PATHCONV=1',
    (name) => {
      const commands = codeCommands(readLabFile(name)).filter((line) => /\baws logs\b/.test(line));
      for (const command of commands) {
        const calls = command.match(/\baws logs\b/g) ?? [];
        const prefixed = command.match(/\bMSYS_NO_PATHCONV=1 aws logs\b/g) ?? [];
        expect(prefixed.length, command).toBe(calls.length);
      }
    },
  );
});

// =================================================================================================
// AC-32: nothing private in the reader-facing files
// =================================================================================================

const ALLOWED_NUMBERS = new Set(['111122223333']);
const COURSE_SECTION = /[Ss]ection \d/;

function twelveDigitNumbers(text: string): string[] {
  return (text.match(/(?<!\d)\d{12}(?!\d)/g) ?? []).filter(
    (digits) => !ALLOWED_NUMBERS.has(digits),
  );
}

describe('AC-32: no account ids, course section references, AdministratorAccess or private domain', () => {
  const FILES = ['README.md', 'break-it.md', 'verify.sh', 'src/handler.py'];

  const checkText = (label: string, text: string): void => {
    expect(twelveDigitNumbers(text), `${label}: 12-digit numbers`).toEqual([]);
    expect(text, `${label}: course section reference`).not.toMatch(COURSE_SECTION);
    expect(text, `${label}: AdministratorAccess`).not.toContain('AdministratorAccess');
    expect(text, `${label}: tech-leads.lol`).not.toContain('tech-leads.lol');
  };

  test.each(FILES)('AC-32: %s has none of them', (name) => {
    checkText(name, readLabFile(name));
  });

  test('AC-32: no top-level .tf file has any of them', () => {
    for (const file of needTerraformFiles()) checkText(file.name, file.raw);
  });
});

// =================================================================================================
// AC-33: no guardrail outside the lab shadows its demo (lesson of #110)
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

/** Every `Effect = "Deny"` statement of a guardrail text (locals included), with its Sid. */
function denyStatementsOfText(text: string, file: string): Deny[] {
  return [...text.matchAll(/\bEffect\s*=\s*"Deny"/g)].map((match) => {
    const statement = enclosingBlock(text, match.index);
    const sid = /\bSid\s*=\s*"([^"]+)"/.exec(statement)?.[1] ?? '';
    return { file, sid, text: statement };
  });
}

/** Every `Effect = "Deny"` statement of a guardrail file (locals included), with its Sid. */
function denyStatements(...segments: string[]): Deny[] {
  return denyStatementsOfText(repoText(...segments), segments.join('/'));
}

/**
 * What the AC-33 scan reads of a guardrail text (comments already stripped): every Deny of scp.tf and
 * boundary.tf, but of ci_roles.tf only the tf_apply_deny policy (the guardrails over what the lab and
 * its deploy do). A deny on the read-only plan role (tf_plan_deny) cannot shadow the lab's demo.
 */
function scannedDenies(file: string, text: string): Deny[] {
  if (!file.endsWith('ci_roles.tf')) return denyStatementsOfText(text, file);
  const applyPolicy = blockBodies(
    text,
    /\bresource\s+"aws_iam_role_policy"\s+"tf_apply_deny"\s*\{/,
  );
  if (applyPolicy.length !== 1) {
    throw new Error(`${file}: expected one tf_apply_deny policy, found ${applyPolicy.length}`);
  }
  return denyStatementsOfText(applyPolicy[0] ?? '', file);
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

/** An IAM action pattern (`sqs:Get*`, `*`) as a case-insensitive regular expression. */
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

/** The actions the lab's demos and its deploy need (spec 046, AC-33). */
const DEMO_ACTIONS = [
  'sqs:*',
  'sqs:SendMessage',
  'sqs:ReceiveMessage',
  'sqs:DeleteMessage',
  'sqs:GetQueueAttributes',
  'sqs:SetQueueAttributes',
  'sqs:StartMessageMoveTask',
  'lambda:*',
  'lambda:CreateFunction',
  'lambda:CreateEventSourceMapping',
  'lambda:UpdateEventSourceMapping',
  'logs:*',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
  'logs:FilterLogEvents',
  'cloudwatch:*',
  'cloudwatch:PutMetricAlarm',
];

/**
 * The Deny statements with NotAction that exist today. A Deny with NotAction covers every action but
 * the listed ones, so a new one would shadow the demo (the same list as lab 03).
 */
const ALLOWED_NOT_ACTION_DENIES = [
  'DenyOutsideAllowedRegions',
  'DenyProtectedIamChanges',
  'DenyStateBucketSettings',
];

describe('AC-33: no guardrail outside the lab shadows the demo', () => {
  const all = (): Deny[] =>
    GUARDRAIL_FILES.flatMap((segments) => scannedDenies(segments.join('/'), repoText(...segments)));

  test('AC-33: the reader finds the Deny statements of the three guardrail files', () => {
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

  test('AC-33: no Deny Action names or covers an SQS, Lambda, Logs or CloudWatch demo action', () => {
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

  test('AC-33: every Deny with NotAction is one of the three that exist today', () => {
    const notActions = all()
      .filter((deny) => /(?<![A-Za-z_])NotAction\s*=/.test(deny.text))
      .map((deny) => deny.sid);
    expect(notActions.length).toBeGreaterThan(0);
    expect(
      notActions.filter((sid) => !ALLOWED_NOT_ACTION_DENIES.includes(sid)),
      'Deny statements with NotAction other than the named ones',
    ).toEqual([]);
  });

  test('AC-33: eu-west-1 is in the allowed_regions of the SCP, which denies only outside them', () => {
    const [deny] = all().filter((candidate) => candidate.sid === 'DenyOutsideAllowedRegions');
    expect(deny, 'DenyOutsideAllowedRegions not found').toBeDefined();
    expect(deny?.text).toContain('aws:RequestedRegion');
    expect(repoText('bootstrap', 'management', 'scp.tf')).toMatch(
      /\ballowed_regions\s*=\s*\[[^\]]*"eu-west-1"[^\]]*\]/,
    );
  });

  test('AC-33: the boundary iam:PassRole deny uses NotResource with the lab role path', () => {
    const [deny] = denyStatements('bootstrap', 'workload', 'boundary.tf').filter((candidate) =>
      actionStrings(candidate).includes('iam:PassRole'),
    );
    expect(deny, 'no Deny with iam:PassRole in boundary.tf').toBeDefined();
    expect((attributeValue(deny?.text ?? '', 'NotResource') ?? '').trim()).toBe(
      'local.lab_role_arn_pattern',
    );
    expect(deny?.text).not.toMatch(/(?<![A-Za-z_])Resource\s*=/);
    const main = repoText('bootstrap', 'workload', 'main.tf');
    expect(main).toMatch(/^\s*lab_role_path\s*=\s*"\/lab\/"\s*$/m);
    expect(main).toMatch(
      /^\s*lab_role_arn_pattern\s*=\s*"arn:aws:iam::[^"]*:role\$\{local\.lab_role_path\}\*"/m,
    );
  });

  test('AC-33: the lab role has path = "/lab/"', () => {
    expect(resourceBody('aws_iam_role', 'consumer')).toMatch(/^\s*path\s*=\s*"\/lab\/"\s*$/m);
  });

  test('AC-33: verify.sh makes no send-message-batch or filter-log-events call outside the VERIFY_SEND=1 branch', () => {
    const script = readLabFile('verify.sh')
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line));
    // Lines inside a top-level function definition are definitions, not calls (shfmt style: the
    // closing brace is in column 0). Whether a function is called outside the gate is for the
    // runtime tests of lab-05-verify.test.ts.
    let inFunction = false;
    const topLevel = script.map((line) => {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?\s*$/.test(line)) inFunction = true;
      const outside = !inFunction;
      if (inFunction && /^\}/.test(line)) inFunction = false;
      return outside;
    });
    const firstGate = script.findIndex(
      (line, index) => topLevel[index] === true && /\$\{?VERIFY_SEND\b/.test(line),
    );
    expect(
      firstGate,
      'verify.sh never tests $VERIFY_SEND outside a function',
    ).toBeGreaterThanOrEqual(0);
    const liveCall = /\b(send-message-batch|filter-log-events)\b/;
    expect(
      script.filter((line) => liveCall.test(line)).length,
      'verify.sh has no live call at all',
    ).toBeGreaterThan(0);
    script.forEach((line, index) => {
      if (topLevel[index] !== true || !liveCall.test(line)) return;
      expect(index, `live call before the VERIFY_SEND gate: ${line.trim()}`).toBeGreaterThan(
        firstGate,
      );
    });
  });
});

// =================================================================================================
// AC-34, AC-35: repo files
// =================================================================================================

describe('AC-34: .gitignore and the build folder', () => {
  test('AC-34: .gitignore has the line labs/*/.build/', () => {
    const lines = readRepoFile('.gitignore')
      .split(/\r?\n/)
      .map((line) => line.trim());
    expect(lines).toContain('labs/*/.build/');
  });

  test('AC-34: no file under labs/05-sqs-lambda-dlq/.build/ is tracked', () => {
    const listed = spawnSync('git', ['ls-files', '--', `${LAB}/.build`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim()).toBe('');
  });
});

describe('AC-35: the 2.1 page links the lab', () => {
  const page = (): string =>
    readRepoFile(
      'apps',
      'site',
      'src',
      'content',
      'docs',
      'd2',
      '2-1-scalable-loosely-coupled',
      'index.mdx',
    );
  const URL =
    'https://github.com/DavidSanSan110/saa-c03-field-guide/tree/main/labs/05-sqs-lambda-dlq';

  test('AC-35: it links the lab folder on GitHub', () => {
    expect(page(), `the page does not link ${URL}`).toContain(URL);
  });

  test('AC-35: the link is under a **Labs** line that comes after ## Links', () => {
    const text = page();
    const lines = text.split(/\r?\n/);
    const links = lines.findIndex((line) => line.trim() === '## Links');
    expect(links, 'no ## Links heading').toBeGreaterThanOrEqual(0);
    const labs = lines.findIndex((line, index) => index > links && line.trim() === '**Labs**');
    expect(labs, 'no **Labs** line after ## Links').toBeGreaterThan(links);
    const urlPattern = new RegExp(URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const link = lines.findIndex((line) => urlPattern.test(line));
    expect(link, `no line holds ${URL}`).toBeGreaterThan(labs);
    const nextHeading = lines.findIndex((line, index) => index > labs && /^#{1,6}\s/.test(line));
    if (nextHeading !== -1) expect(link).toBeLessThan(nextHeading);
  });
});

// =================================================================================================
// Spec 049 (issue #161): the AC-33 scan reads tf_apply_deny of ci_roles.tf, not tf_plan_deny
// =================================================================================================

const CI_ROLES = 'bootstrap/workload/ci_roles.tf';

/** A ci_roles.tf text whose `<policy>` resource denies sqs:ReceiveMessage and the other one does not. */
function ciRolesFixture(denying: 'tf_plan_deny' | 'tf_apply_deny'): string {
  const policy = (name: string, statement: string): string => `
resource "aws_iam_role_policy" "${name}" {
  name = "${name}"
  role = aws_iam_role.${name}.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      ${statement},
    ]
  })
}
`;
  const receive = `{
        Sid      = "DenyMessageReads"
        Effect   = "Deny"
        Action   = "sqs:ReceiveMessage"
        Resource = "arn:aws:sqs:*:111111111111:*"
      }`;
  const other = `{
        Sid       = "DenyStateBucketSettings"
        Effect    = "Deny"
        NotAction = ["s3:Get*", "s3:List*"]
        Resource  = local.state_bucket_arn
      }`;
  return (
    policy('tf_plan_deny', denying === 'tf_plan_deny' ? receive : other) +
    policy('tf_apply_deny', denying === 'tf_apply_deny' ? receive : other)
  );
}

/** The Deny statements of a ci_roles.tf text that the AC-33 scan would flag as covering a demo action. */
function shadowedDemoActions(ciRolesText: string): string[] {
  return scannedDenies(CI_ROLES, stripHclComments(ciRolesText)).flatMap((deny) =>
    actionStrings(deny)
      .filter((action) => DEMO_ACTIONS.some((demo) => actionPattern(action).test(demo)))
      .map((action) => `${deny.sid} denies ${action}`),
  );
}

describe('AC-7: the AC-33 scan reads tf_apply_deny of ci_roles.tf and not tf_plan_deny', () => {
  const realDenies = (): Deny[] => scannedDenies(CI_ROLES, repoText(...CI_ROLES.split('/')));

  test('AC-7: of ci_roles.tf the scan reads the tf_apply_deny denies', () => {
    expect(realDenies().map((deny) => deny.sid)).toContain('DenyStateBucketSettings');
  });

  test.each(['DenyObjectReadsOutsideLabState', 'DenySecretReads', 'DenyParameterReads'])(
    'AC-7: of ci_roles.tf the scan does not read the tf_plan_deny statement %s',
    (sid) => {
      expect(realDenies().map((deny) => deny.sid)).not.toContain(sid);
    },
  );

  test.each([
    ['bootstrap/management/scp.tf', ['bootstrap', 'management', 'scp.tf']],
    ['bootstrap/workload/boundary.tf', ['bootstrap', 'workload', 'boundary.tf']],
  ] as const)('AC-7: the scan reads every Deny of %s', (file, segments) => {
    const text = repoText(...segments);
    const whole = denyStatementsOfText(text, file);
    expect(whole.length, file).toBeGreaterThan(0);
    expect(scannedDenies(file, text).map((deny) => deny.sid)).toEqual(
      whole.map((deny) => deny.sid),
    );
  });

  test('AC-7: the scan fails when ci_roles.tf has no tf_apply_deny policy', () => {
    const planOnly = ciRolesFixture('tf_plan_deny').replace('"tf_apply_deny"', '"tf_other"');
    expect(() => scannedDenies(CI_ROLES, stripHclComments(planOnly))).toThrow(/tf_apply_deny/);
  });
});

describe('AC-8: the narrowed scan still catches a shadow in tf_apply_deny', () => {
  test('AC-8: a tf_apply_deny that denies sqs:ReceiveMessage is reported', () => {
    expect(shadowedDemoActions(ciRolesFixture('tf_apply_deny'))).toEqual([
      'DenyMessageReads denies sqs:ReceiveMessage',
    ]);
  });

  test('AC-8: a tf_plan_deny that denies sqs:ReceiveMessage is not reported', () => {
    expect(shadowedDemoActions(ciRolesFixture('tf_plan_deny'))).toEqual([]);
  });
});

// =================================================================================================
// Spec 049 (issue #179), AC-12: the AC-33 scan also reads the locals that tf_apply_deny references
// =================================================================================================

// Known limit of this reader (shared with the scans above): it does not parse heredocs, so a policy
// written as a <<EOT ... EOT JSON string is not seen.

/** The top-level `name = value` attributes of a block body (a value ends at the line end that closes its brackets). */
function topLevelAttributes(body: string): Map<string, string> {
  const found = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const head = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=(?!=)\s*/.exec(body.slice(i));
    if (!head) {
      const newline = body.indexOf('\n', i);
      i = newline === -1 ? body.length : newline + 1;
      continue;
    }
    const start = i + head[0].length;
    let depth = 0;
    let end = start;
    while (end < body.length) {
      const c = body.charAt(end);
      if (c === '"') {
        end = skipString(body, end);
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') depth -= 1;
      if (c === '\n' && depth <= 0) break;
      end += 1;
    }
    found.set(head[1] ?? '', body.slice(start, end));
    i = end + 1;
  }
  return found;
}

/** The names of the `local.<name>` references of a text (HCL identifiers may contain `-`). */
function localReferences(text: string): string[] {
  return [...text.matchAll(/\blocal\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1] ?? '');
}

/** The comment-stripped text of every top-level .tf file of bootstrap/workload, by repo path. */
function workloadTexts(): Map<string, string> {
  const dir = join(REPO_ROOT, 'bootstrap', 'workload');
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith('.tf'))
      .sort()
      .map((name): [string, string] => [
        `bootstrap/workload/${name}`,
        stripHclComments(readFileSync(join(dir, name), 'utf8')),
      ]),
  );
}

/**
 * What the AC-33 scan reads of a guardrail text (comments already stripped), as `scannedDenies` does,
 * plus, for ci_roles.tf, every Deny in each `locals` value that the tf_apply_deny block reaches
 * through `local.<name>` references, followed transitively (a cycle ends) in the text itself and in
 * `others`, the other .tf files of bootstrap/workload (path -> comment-stripped text), whichever
 * file defines the local. Locals that only tf_plan_deny references, or nothing references, are not read.
 */
function scannedDeniesWithLocals(
  file: string,
  text: string,
  others: ReadonlyMap<string, string> = new Map(),
): Deny[] {
  const base = scannedDenies(file, text);
  if (!file.endsWith('ci_roles.tf')) return base;
  const [applyPolicy = ''] = blockBodies(
    text,
    /\bresource\s+"aws_iam_role_policy"\s+"tf_apply_deny"\s*\{/,
  );
  const files = new Map<string, string>(others);
  files.set(file, text);
  const defined = new Map<string, { file: string; value: string }>();
  for (const [path, fileText] of files) {
    for (const body of blockBodies(fileText, /\blocals\s*\{/)) {
      for (const [name, value] of topLevelAttributes(body))
        defined.set(name, { file: path, value });
    }
  }
  const queue = localReferences(applyPolicy);
  const seen = new Set<string>();
  const fromLocals: Deny[] = [];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const local = defined.get(name);
    if (local === undefined || seen.has(name)) continue;
    seen.add(name);
    fromLocals.push(...denyStatementsOfText(local.value, local.file));
    queue.push(...localReferences(local.value));
  }
  return [...base, ...fromLocals];
}

/** The demo actions that the Deny statements name or cover, one line per Deny and action. */
function shadowsOf(denies: Deny[]): string[] {
  return denies.flatMap((deny) =>
    actionStrings(deny).flatMap((action) =>
      DEMO_ACTIONS.filter((demo) => actionPattern(action).test(demo)).map(
        (demo) =>
          `${deny.sid === '' ? '(no Sid)' : deny.sid} denies ${action}, which covers ${demo}`,
      ),
    ),
  );
}

/** A tf_plan_deny or tf_apply_deny policy resource of a ci_roles.tf fixture. */
function ciRolesPolicy(name: string, statements: string): string {
  return `
resource "aws_iam_role_policy" "${name}" {
  name = "${name}"
  role = aws_iam_role.${name}.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = ${statements}
  })
}
`;
}

/** The known statement of tf_apply_deny with NotAction, after the statements of `before`. */
function concatBefore(before: string): string {
  return `concat(
      ${before},
      [
        {
          Sid       = "DenyStateBucketSettings"
          Effect    = "Deny"
          NotAction = ["s3:Get*", "s3:List*"]
          Resource  = local.state_bucket_arn
        },
      ],
    )`;
}

/**
 * A ci_roles.tf text: the local `localName` holds a Deny of sqs:*, and only `referencedBy` uses it.
 * With `definedHere` false the local is not defined at all.
 */
function ciRolesLocalsFixture(
  referencedBy: 'tf_apply_deny' | 'tf_plan_deny' | 'nobody',
  definedHere = true,
  localName = 'apply_extra',
): string {
  const own = `[
      {
        Sid      = "DenySecretReads"
        Effect   = "Deny"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:aws:secretsmanager:*:111111111111:secret:*"
      },
    ]`;
  const withExtra = concatBefore(`local.${localName}`);
  const extra = `  ${localName} = [
    { Effect = "Deny", Action = "sqs:*", Resource = "*" },
  ]
`;
  const apply = referencedBy === 'tf_apply_deny' ? withExtra : own;
  const plan = referencedBy === 'tf_plan_deny' ? withExtra : own;
  return `
locals {
  tf_plan_role_name = "fg-tf-plan"

${definedHere ? extra : ''}
}
${ciRolesPolicy('tf_plan_deny', plan)}${ciRolesPolicy('tf_apply_deny', apply)}`;
}

/** The shadowed demo actions that the extended scan reports for a ci_roles.tf text. */
function shadowedDemoActionsWithLocals(
  ciRolesText: string,
  others: ReadonlyMap<string, string> = new Map(),
): string[] {
  return shadowsOf(scannedDeniesWithLocals(CI_ROLES, stripHclComments(ciRolesText), others));
}

/**
 * The cross-file chain: tf_apply_deny (ci_roles.tf) uses `local.escalation_denies` (boundary.tf), which
 * concatenates `local.ci_extra` (defined in ci_roles.tf, a Deny of lambda:CreateFunction).
 */
function crossFileFixture(): { ciRoles: string; others: Map<string, string> } {
  const ciRoles = `
locals {
  ci_extra = [
    { Sid = "DenyLambda", Effect = "Deny", Action = "lambda:CreateFunction", Resource = "*" },
  ]
}
${ciRolesPolicy('tf_apply_deny', concatBefore('local.escalation_denies'))}`;
  const boundary = `
locals {
  deny_users = {
    Sid      = "DenyIamUsersAndKeys"
    Effect   = "Deny"
    Action   = ["iam:CreateUser", "iam:CreateAccessKey"]
    Resource = "*"
  }

  escalation_denies = concat(
    [local.deny_users],
    local.ci_extra,
  )
}
`;
  return {
    ciRoles,
    others: new Map([['bootstrap/workload/boundary.tf', stripHclComments(boundary)]]),
  };
}

describe('AC-12: the AC-33 scan also reads the locals that tf_apply_deny references', () => {
  const allWithLocals = (): Deny[] => {
    const workload = workloadTexts();
    return GUARDRAIL_FILES.flatMap((segments) =>
      scannedDeniesWithLocals(segments.join('/'), repoText(...segments), workload),
    );
  };

  test('AC-12: on the real files the extended scan finds the Deny statements of the three guardrail files', () => {
    const denies = allWithLocals();
    expect(denies.length).toBeGreaterThanOrEqual(10);
    for (const segments of GUARDRAIL_FILES) {
      expect(
        denies.filter((deny) => deny.file === segments.join('/')).length,
        segments.join('/'),
      ).toBeGreaterThan(0);
    }
    expect(denies.filter((deny) => deny.sid === '')).toEqual([]);
  });

  test('AC-12: on the real files the extended scan finds no shadowed demo action', () => {
    expect(shadowsOf(allWithLocals())).toEqual([]);
  });

  test('AC-12: on the real files every Deny with NotAction found by the extended scan is allowed', () => {
    const notActions = allWithLocals()
      .filter((deny) => /(?<![A-Za-z_])NotAction\s*=/.test(deny.text))
      .map((deny) => deny.sid);
    expect(notActions.length).toBeGreaterThan(0);
    expect(
      notActions.filter((sid) => !ALLOWED_NOT_ACTION_DENIES.includes(sid)),
      'Deny statements with NotAction other than the named ones',
    ).toEqual([]);
  });

  test('AC-12: a local that tf_apply_deny concatenates is read, so its Deny of sqs:* is reported', () => {
    expect(shadowedDemoActionsWithLocals(ciRolesLocalsFixture('tf_apply_deny'))).toContain(
      '(no Sid) denies sqs:*, which covers sqs:ReceiveMessage',
    );
  });

  test('AC-12: a local with a dash in its name is read when tf_apply_deny references it', () => {
    const text = ciRolesLocalsFixture('tf_apply_deny', true, 'apply-extra');
    expect(shadowedDemoActionsWithLocals(text)).toContain(
      '(no Sid) denies sqs:*, which covers sqs:ReceiveMessage',
    );
  });

  test('AC-12: a local that only tf_plan_deny references is not read', () => {
    expect(shadowedDemoActionsWithLocals(ciRolesLocalsFixture('tf_plan_deny'))).toEqual([]);
  });

  test('AC-12: a local that nothing references is not read', () => {
    expect(shadowedDemoActionsWithLocals(ciRolesLocalsFixture('nobody'))).toEqual([]);
  });

  test('AC-12: a local that no file defines is not an error and adds no Deny', () => {
    const text = stripHclComments(ciRolesLocalsFixture('tf_apply_deny', false));
    expect(scannedDeniesWithLocals(CI_ROLES, text).map((deny) => deny.sid)).toEqual([
      'DenyStateBucketSettings',
    ]);
  });

  test('AC-12: a chain through another file is followed, so ci_extra reached via escalation_denies is reported', () => {
    const { ciRoles, others } = crossFileFixture();
    expect(shadowedDemoActionsWithLocals(ciRoles, others)).toEqual([
      'DenyLambda denies lambda:CreateFunction, which covers lambda:CreateFunction',
    ]);
  });

  test('AC-12: the same chain is not read when the other file does not reference ci_extra', () => {
    const { ciRoles, others } = crossFileFixture();
    const cut = new Map(
      [...others].map(([path, text]): [string, string] => [
        path,
        text.replace('local.ci_extra', '[]'),
      ]),
    );
    expect(shadowedDemoActionsWithLocals(ciRoles, cut)).toEqual([]);
  });

  test('AC-12: locals that reference each other terminate and their Deny is read once', () => {
    const text = `
locals {
  loop_a = concat(local.loop_b, [{ Sid = "DenyA", Effect = "Deny", Action = "sqs:*", Resource = "*" }])
  loop_b = concat(local.loop_a, [])
}
${ciRolesPolicy('tf_apply_deny', concatBefore('local.loop_a'))}`;
    const shadows = shadowedDemoActionsWithLocals(text);
    expect(shadows).toContain('DenyA denies sqs:*, which covers sqs:ReceiveMessage');
    expect(shadows).toHaveLength(7); // the seven sqs: demo actions, once each
  });
});
