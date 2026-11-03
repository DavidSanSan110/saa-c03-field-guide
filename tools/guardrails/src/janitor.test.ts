import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_MAX_AGE_HOURS,
  ISSUE_TITLE,
  JanitorError,
  REGIONS,
  arnRegion,
  formatAge,
  formatTime,
  labLabel,
  parseMaxAgeHours,
  reportBody,
  resourceName,
  resourceType,
  runJanitor,
  scan,
  syncIssue,
  type Deps,
  type Exec,
  type ExecResult,
  type Finding,
} from './janitor.ts';

// Spec 043: the lab janitor. Every test drives the injected dependencies: a fake `exec` records each
// call (file, args, input) and answers from a table, so no real `aws`, `gh` or network is touched.
// Only AC-27 spawns a real Node process, with an empty PATH so `aws` and `gh` cannot be found.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

// ---- Fixtures ----------------------------------------------------------------------------------

const ACCOUNT = '111122223333';
const NOW = new Date('2026-11-02T07:00:00Z');
const MAX = 12;

const LAB3 = '03-nat-vs-gateway-endpoint';
const LAB1 = '01-iam-assume-role';

const NAT_ID = 'nat-0a1b2c3d4e5f67890';
const NAT_ARN = `arn:aws:ec2:eu-west-1:${ACCOUNT}:natgateway/${NAT_ID}`;
const BUCKET_NAME = `leaky-bucket-${ACCOUNT}`;
const BUCKET_ARN = `arn:aws:s3:::${BUCKET_NAME}`;
const ROLE_NAME = 'leaky-role';
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/lab/${ROLE_NAME}`;
const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const KMS_ARN = `arn:aws:kms:eu-west-1:${ACCOUNT}:key/${KEY_ID}`;
const LAMBDA_ARN = `arn:aws:lambda:eu-west-1:${ACCOUNT}:function:my-fn`;
const SNS_ARN = `arn:aws:sns:eu-west-1:${ACCOUNT}:fg-topic`;
const OTHER_ARN = `arn:aws:ec2:eu-west-1:${ACCOUNT}:Elastic_IP/eipalloc-0abc`;
const API_ARN = `arn:aws:apigateway:eu-west-1::/restapis/abc123`;
const SITE_NAME = `site-${ACCOUNT}-hosting`;
const SITE_ARN = `arn:aws:s3:::${SITE_NAME}`;
const MGMT_ARN = `arn:aws:iam::${ACCOUNT}:role/mgmt-role`;
const WORKLOAD_ARN = `arn:aws:iam::${ACCOUNT}:role/workload-role`;

const MESSAGE_BAD_HOURS = 'JANITOR_MAX_AGE_HOURS must be a whole number from 1 to 2160';
const MESSAGE_NOTHING = 'janitor: the scan found nothing at all, not even the skipped labs';

// ---- The fake exec ------------------------------------------------------------------------------

type Call = { file: 'aws' | 'gh'; args: string[]; input: string | undefined };

const json = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value) });
const raw = (stdout: string): ExecResult => ({ code: 0, stdout });
const fail = (stdout = 'boom'): ExecResult => ({ code: 1, stdout });

/** What the fake answers. A call that has no entry gets an empty answer (`[]` or exit 0). */
interface Script {
  tagging?: Record<string, ExecResult>; // by Region
  lookup?: Record<string, ExecResult>; // by `<region>|<resource name>`
  list?: ExecResult;
  create?: ExecResult;
  edit?: ExecResult;
  close?: ExecResult;
  env?: Record<string, string | undefined>;
}

interface World {
  deps: Deps;
  calls: Call[];
  /** Tagging, lookup and sleep events, in the order they happened. */
  log: string[];
  sleeps: number[];
  out: string[];
  err: string[];
}

const lookupKey = (region: string, name: string): string => `${region}|${name}`;

function regionOf(args: string[]): string {
  const at = args.indexOf('--region');
  return at === -1 ? '' : (args[at + 1] ?? '');
}

const NAME_PREFIX = 'AttributeKey=ResourceName,AttributeValue=';

function nameOf(args: string[]): string {
  const found = args.find((arg) => arg.startsWith(NAME_PREFIX));
  return found === undefined ? '' : found.slice(NAME_PREFIX.length);
}

function answer(script: Script, call: Call, log: string[]): ExecResult {
  const { file, args } = call;
  if (file === 'aws' && args[0] === 'resourcegroupstaggingapi') {
    const region = regionOf(args);
    log.push(`tagging ${region}`);
    return script.tagging?.[region] ?? json([]);
  }
  if (file === 'aws' && args[0] === 'cloudtrail') {
    const region = regionOf(args);
    const name = nameOf(args);
    log.push(`lookup ${region} ${name}`);
    return script.lookup?.[lookupKey(region, name)] ?? json([]);
  }
  if (file === 'gh' && args[0] === 'issue') {
    switch (args[1]) {
      case 'list':
        return script.list ?? json([]);
      case 'create':
        return script.create ?? raw('');
      case 'edit':
        return script.edit ?? raw('');
      case 'close':
        return script.close ?? raw('');
    }
  }
  throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
}

function world(script: Script = {}): World {
  const calls: Call[] = [];
  const log: string[] = [];
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exec: Exec = (file, args, input) => {
    const call: Call = { file, args: [...args], input };
    calls.push(call);
    return Promise.resolve(answer(script, call, log));
  };
  const deps: Deps = {
    exec,
    sleep: (ms) => {
      sleeps.push(ms);
      log.push(`sleep ${ms}`);
      return Promise.resolve();
    },
    now: () => NOW,
    env: script.env ?? {},
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
  };
  return { deps, calls, log, sleeps, out, err };
}

const awsCalls = (w: World, service: string): Call[] =>
  w.calls.filter((call) => call.file === 'aws' && call.args[0] === service);
const taggingCalls = (w: World): Call[] => awsCalls(w, 'resourcegroupstaggingapi');
const lookupCalls = (w: World): Call[] => awsCalls(w, 'cloudtrail');
const ghCalls = (w: World): Call[] => w.calls.filter((call) => call.file === 'gh');

/** The exact tagging call of the spec. */
const taggingCall = (region: string): Call => ({
  file: 'aws',
  args: [
    'resourcegroupstaggingapi',
    'get-resources',
    '--region',
    region,
    '--tag-filters',
    'Key=project,Values=saa-c03-field-guide',
    'Key=lab',
    '--query',
    'ResourceTagMappingList[].{arn:ResourceARN,tags:Tags}',
    '--output',
    'json',
  ],
  input: undefined,
});

/** The exact CloudTrail lookup call of the spec. */
const lookupCall = (region: string, name: string): Call => ({
  file: 'aws',
  args: [
    'cloudtrail',
    'lookup-events',
    '--region',
    region,
    '--lookup-attributes',
    `${NAME_PREFIX}${name}`,
    '--max-items',
    '500',
    '--query',
    'Events[].EventTime',
    '--output',
    'json',
  ],
  input: undefined,
});

const LIST_CALL: Call = {
  file: 'gh',
  args: [
    'issue',
    'list',
    '--state',
    'open',
    '--author',
    'app/github-actions',
    '--search',
    'in:title "Forgotten lab resources"',
    '--json',
    'number,title',
    '--limit',
    '20',
  ],
  input: undefined,
};

const createCall = (body: string): Call => ({
  file: 'gh',
  args: ['issue', 'create', '--title', 'Forgotten lab resources', '--body-file', '-'],
  input: body,
});

const editCall = (number: number, body: string): Call => ({
  file: 'gh',
  args: ['issue', 'edit', String(number), '--body-file', '-'],
  input: body,
});

const closeCall = (number: number, comment: string): Call => ({
  file: 'gh',
  args: ['issue', 'close', String(number), '--comment', comment],
  input: undefined,
});

/** One tagging entry; a `null` lab leaves the `lab` tag out. */
function res(arn: string, lab: string | null): { arn: string; tags: unknown[] } {
  const tags: unknown[] = [{ Key: 'project', Value: 'saa-c03-field-guide' }];
  if (lab !== null) tags.push({ Key: 'Name', Value: 'n' }, { Key: 'lab', Value: lab });
  return { arn, tags };
}

/** The ISO time `hours` before NOW. */
const ago = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const finding = (lab: string, region: string, type: string, ageHours: number | null): Finding => ({
  lab,
  region,
  type,
  ageHours,
});

/** A tagging reply that lists the given entries. */
const listing = (...entries: { arn: string; tags: unknown[] }[]): ExecResult => json(entries);

/** A skipped-lab resource, so that a scan is never empty. */
const SITE = res(SITE_ARN, '00-site-hosting');

const CLOSE_COMMENT = 'Nothing older than 12 hours is left as of 2026-11-02 07:00 UTC.';

// ---- The report text, written out in full ------------------------------------------------------

const UNKNOWN_NOTE =
  'Unknown means CloudTrail shows no event for the resource in the last 90 days.';
const DISPATCH_NOTE =
  'To remove a lab, dispatch `infra.yml` with the action `destroy`. ' +
  'This issue updates on each run and closes when nothing is left.';

/** The exact report for the given hour figure, time text and table rows. */
const expectedBody = (hours: number, time: string, rows: string[]): string =>
  [
    `Lab resources older than ${hours} hours, as of ${time}.`,
    '',
    '| Lab | Region | Type | Count | Oldest |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    UNKNOWN_NOTE,
    '',
    DISPATCH_NOTE,
    '',
  ].join('\n');

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ---- Pure functions ----------------------------------------------------------------------------

describe('AC-1: parseMaxAgeHours', () => {
  test('AC-1: undefined gives the default of 12 hours', () => {
    expect(parseMaxAgeHours(undefined)).toBe(12);
    expect(DEFAULT_MAX_AGE_HOURS).toBe(12);
  });

  test('AC-1: the empty string gives 12', () => {
    expect(parseMaxAgeHours('')).toBe(12);
  });

  test.each([
    ['1', 1],
    ['12', 12],
    ['2160', 2160],
  ])('AC-1: %s is accepted', (value, expected) => {
    expect(parseMaxAgeHours(value)).toBe(expected);
  });

  test.each(['0', '2161', '-1', '1.5', '12h', ' 12', '1e2', '12\n', '99999999999999999999'])(
    'AC-1: %j throws JanitorError with the exact message',
    (value) => {
      const error = errorOf(() => parseMaxAgeHours(value));
      expect(error).toBeInstanceOf(JanitorError);
      expect((error as Error).message).toBe(MESSAGE_BAD_HOURS);
    },
  );
});

describe('AC-2: resourceType', () => {
  test.each([
    ['an EC2 NAT gateway', NAT_ARN, 'ec2:natgateway'],
    ['an S3 bucket', BUCKET_ARN, 's3'],
    ['an IAM role with a path', ROLE_ARN, 'iam:role'],
    ['a KMS key', KMS_ARN, 'kms:key'],
    ['a Lambda function', LAMBDA_ARN, 'lambda:function'],
    ['an SNS topic', SNS_ARN, 'sns'],
    ['a resource whose text is empty', API_ARN, 'apigateway'],
    [
      'a log group with colons in the resource',
      `arn:aws:logs:eu-west-1:${ACCOUNT}:log-group:/aws/lambda/x:*`,
      'logs:log-group',
    ],
    ['text that fails the pattern', OTHER_ARN, 'other'],
  ])('AC-2: %s', (_label, arn, expected) => {
    expect(resourceType(arn)).toBe(expected);
  });

  test('AC-2: a bucket name never appears in the type', () => {
    expect(resourceType(BUCKET_ARN)).not.toContain(BUCKET_NAME);
  });
});

describe('AC-3: resourceName and arnRegion', () => {
  test.each([
    ['an EC2 NAT gateway', NAT_ARN, NAT_ID, 'eu-west-1'],
    ['an S3 bucket', BUCKET_ARN, BUCKET_NAME, ''],
    ['an IAM role with a path', ROLE_ARN, ROLE_NAME, ''],
    ['a KMS key', KMS_ARN, KEY_ID, 'eu-west-1'],
    ['a Lambda function', LAMBDA_ARN, 'my-fn', 'eu-west-1'],
    ['an SNS topic', SNS_ARN, 'fg-topic', 'eu-west-1'],
    ['an API Gateway without account', API_ARN, 'abc123', 'eu-west-1'],
  ])('AC-3: %s', (_label, arn, name, region) => {
    expect(resourceName(arn)).toBe(name);
    expect(arnRegion(arn)).toBe(region);
  });
});

describe('AC-4: labLabel', () => {
  test('AC-4: it keeps a valid lab id', () => {
    expect(labLabel(LAB3)).toBe(LAB3);
  });

  test.each([
    ['Lab 3'],
    ['03'],
    ['3-nat'],
    ['03-Nat'],
    ['03-nat|x'],
    ['03-nat\nx'],
    ['03-nat\n'],
    ['bootstrap-management'],
    [''],
  ])('AC-4: %j gives unknown', (value) => {
    expect(labLabel(value)).toBe('unknown');
  });
});

describe('AC-5: formatAge and formatTime', () => {
  test.each([
    [null, 'unknown'],
    [0.2, '0 hours'],
    [1, '1 hour'],
    [1.9, '1 hour'],
    [2, '2 hours'],
    [47.9, '47 hours'],
    [48, '2 days'],
    [49, '2 days'],
    [96, '4 days'],
  ])('AC-5: formatAge(%j) is %s', (age, expected) => {
    expect(formatAge(age)).toBe(expected);
  });

  test.each([
    ['2026-11-02T07:00:00Z', '2026-11-02 07:00 UTC'],
    ['2026-01-05T03:04:59Z', '2026-01-05 03:04 UTC'],
    ['2026-12-31T23:30:00Z', '2026-12-31 23:30 UTC'],
    ['2026-03-01T00:30:00Z', '2026-03-01 00:30 UTC'],
    ['2026-02-28T23:59:59.999Z', '2026-02-28 23:59 UTC'],
  ])('AC-5: formatTime pads and uses UTC for %s', (iso, expected) => {
    expect(formatTime(new Date(iso))).toBe(expected);
  });
});

describe('AC-6: reportBody', () => {
  test('AC-6: one finding gives the exact text', () => {
    const body = reportBody([finding(LAB3, 'us-east-1', 'ec2:natgateway', 72)], 12, NOW);
    expect(body).toBe(
      expectedBody(12, '2026-11-02 07:00 UTC', [
        `| ${LAB3} | us-east-1 | ec2:natgateway | 1 | 3 days |`,
      ]),
    );
  });

  test('AC-6: several findings are grouped and sorted by lab, region and type', () => {
    // Reverse order on purpose; the largest age of a group sits in the middle.
    const findings = [
      finding('unknown', 'eu-west-1', 's3', 20),
      finding('05-x', 'us-east-1', 's3', 13),
      finding('03-a', 'us-east-1', 'ec2:natgateway', 30),
      finding('03-a', 'eu-west-1', 'ec2:natgateway', 50),
      finding('03-a', 'eu-west-1', 'ec2:natgateway', 100),
      finding('03-a', 'eu-west-1', 'ec2:natgateway', 70),
      finding('03-a', 'eu-west-1', 'ec2:eip', 12),
      finding('01-iam', 'us-east-1', 'iam:role', 5),
      finding('01-iam', 'us-east-1', 'iam:role', 200),
      finding('01-iam', 'us-east-1', 'iam:role', null),
    ];
    expect(reportBody(findings, 12, NOW)).toBe(
      expectedBody(12, '2026-11-02 07:00 UTC', [
        '| 01-iam | us-east-1 | iam:role | 3 | unknown |',
        '| 03-a | eu-west-1 | ec2:eip | 1 | 12 hours |',
        '| 03-a | eu-west-1 | ec2:natgateway | 3 | 4 days |',
        '| 03-a | us-east-1 | ec2:natgateway | 1 | 30 hours |',
        '| 05-x | us-east-1 | s3 | 1 | 13 hours |',
        '| unknown | eu-west-1 | s3 | 1 | 20 hours |',
      ]),
    );
  });

  test('AC-6: the sort is a plain string comparison, not a locale one', () => {
    const findings = [finding('a-lab', 'r', 't', 20), finding('B-lab', 'r', 't', 20)];
    expect(reportBody(findings, 12, NOW)).toBe(
      expectedBody(12, '2026-11-02 07:00 UTC', [
        '| B-lab | r | t | 1 | 20 hours |',
        '| a-lab | r | t | 1 | 20 hours |',
      ]),
    );
  });

  test('AC-6: unknown wins in a group even when other ages are larger', () => {
    const findings = [
      finding('01-iam', 'us-east-1', 'iam:role', null),
      finding('01-iam', 'us-east-1', 'iam:role', 500),
    ];
    expect(reportBody(findings, 12, NOW)).toBe(
      expectedBody(12, '2026-11-02 07:00 UTC', ['| 01-iam | us-east-1 | iam:role | 2 | unknown |']),
    );
  });

  test('AC-6: the hour figure of the first line comes from the argument', () => {
    const body = reportBody([finding(LAB3, 'us-east-1', 'ec2:natgateway', 72)], 24, NOW);
    expect(body.split('\n')[0]).toBe(
      'Lab resources older than 24 hours, as of 2026-11-02 07:00 UTC.',
    );
  });

  test('AC-6: the time of the first line comes from the now argument', () => {
    const later = new Date('2026-12-25T18:45:00Z');
    const body = reportBody([finding(LAB3, 'us-east-1', 'ec2:natgateway', 72)], 12, later);
    expect(body.split('\n')[0]).toBe(
      'Lab resources older than 12 hours, as of 2026-12-25 18:45 UTC.',
    );
  });

  test('AC-6: the body ends in exactly one newline', () => {
    const body = reportBody([finding(LAB3, 'us-east-1', 'ec2:natgateway', 72)], 12, NOW);
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
  });
});

// ---- Scan --------------------------------------------------------------------------------------

describe('AC-7: the tagging call', () => {
  test('AC-7: it has the exact arguments, once per Region, in REGIONS order', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(SITE),
        'us-east-1': listing(res(ROLE_ARN, '00-site-hosting')),
      },
    });
    await scan(w.deps, MAX);
    expect(REGIONS).toEqual(['eu-west-1', 'us-east-1']);
    expect(taggingCalls(w)).toEqual([taggingCall('eu-west-1'), taggingCall('us-east-1')]);
  });

  test('AC-7: empty stdout and null both count as an empty list', async () => {
    // Both Regions empty is the "nothing at all" failure of AC-25; here only the parsing is checked,
    // through a second Region that has one skipped resource.
    const emptyStdout = world({ tagging: { 'eu-west-1': raw(''), 'us-east-1': listing(SITE) } });
    const nullStdout = world({ tagging: { 'eu-west-1': raw('null'), 'us-east-1': listing(SITE) } });
    expect(await scan(emptyStdout.deps, MAX)).toEqual([]);
    expect(await scan(nullStdout.deps, MAX)).toEqual([]);
  });
});

describe('AC-8: the CloudTrail lookup', () => {
  test('AC-8: a NAT gateway is looked up with the exact arguments, after deps.sleep(600)', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]) },
    });
    await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([lookupCall('eu-west-1', NAT_ID)]);
    expect(w.sleeps).toEqual([600]);
    expect(w.log.filter((event) => !event.startsWith('tagging'))).toEqual([
      'sleep 600',
      `lookup eu-west-1 ${NAT_ID}`,
    ]);
  });

  test('AC-8: the sleep also runs before the lookup in the second Region', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: { [lookupKey('us-east-1', BUCKET_NAME)]: json([ago(30)]) },
    });
    await scan(w.deps, MAX);
    expect(w.log.filter((event) => !event.startsWith('tagging'))).toEqual([
      'sleep 600',
      `lookup eu-west-1 ${BUCKET_NAME}`,
      'sleep 600',
      `lookup us-east-1 ${BUCKET_NAME}`,
    ]);
  });

  test('AC-8: every lookup is preceded by one sleep, for several resources', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(res(NAT_ARN, LAB3), res(KMS_ARN, LAB3)),
        'us-east-1': listing(res(ROLE_ARN, LAB1)),
      },
      lookup: {
        [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]),
        [lookupKey('eu-west-1', KEY_ID)]: json([ago(30)]),
        [lookupKey('us-east-1', ROLE_NAME)]: json([ago(30)]),
      },
    });
    await scan(w.deps, MAX);
    const events = w.log.filter((event) => !event.startsWith('tagging'));
    expect(events).toHaveLength(6);
    events.forEach((event, index) => {
      expect(event.startsWith(index % 2 === 0 ? 'sleep 600' : 'lookup ')).toBe(true);
    });
  });
});

describe('AC-9: an ARN seen in both Regions', () => {
  test('AC-9: it is looked up once, under its first scan Region', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(res(ROLE_ARN, LAB1)),
        'us-east-1': listing(res(ROLE_ARN, LAB1)),
      },
      lookup: { [lookupKey('eu-west-1', ROLE_NAME)]: json([ago(30)]) },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([lookupCall('eu-west-1', ROLE_NAME)]);
    expect(findings).toEqual([finding(LAB1, 'eu-west-1', 'iam:role', 30)]);
  });

  test('AC-9: with no events anywhere each Region is tried once, not twice', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(res(BUCKET_ARN, LAB3)),
        'us-east-1': listing(res(BUCKET_ARN, LAB3)),
      },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([
      lookupCall('eu-west-1', BUCKET_NAME),
      lookupCall('us-east-1', BUCKET_NAME),
    ]);
    expect(findings).toEqual([finding(LAB3, 'eu-west-1', 's3', null)]);
  });

  test('AC-9: an ARN with its own Region is looked up once when both Regions list it', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(res(NAT_ARN, LAB3)),
        'us-east-1': listing(res(NAT_ARN, LAB3)),
      },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]) },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([lookupCall('eu-west-1', NAT_ID)]);
    expect(findings).toHaveLength(1);
  });
});

describe('AC-10: skipped labs', () => {
  test('AC-10: the three skipped labs get no lookup, while other labs are kept', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(
          SITE,
          res(MGMT_ARN, 'bootstrap-management'),
          res(WORKLOAD_ARN, 'bootstrap-workload'),
          res(NAT_ARN, LAB3),
        ),
        'us-east-1': listing(res(ROLE_ARN, LAB1), res(MGMT_ARN, 'bootstrap-management')),
      },
      lookup: {
        [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]),
        [lookupKey('us-east-1', ROLE_NAME)]: json([ago(30)]),
      },
    });
    const findings = await scan(w.deps, MAX);
    const names = lookupCalls(w).map((call) => nameOf(call.args));
    expect(names.sort()).toEqual([ROLE_NAME, NAT_ID].sort());
    expect(findings.map((f) => f.lab).sort()).toEqual([LAB1, LAB3]);
  });

  test('AC-10: a resource with only skipped labs gives no finding and no lookup', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(SITE, res(MGMT_ARN, 'bootstrap-management')),
        'us-east-1': listing(res(WORKLOAD_ARN, 'bootstrap-workload')),
      },
    });
    expect(await scan(w.deps, MAX)).toEqual([]);
    expect(lookupCalls(w)).toEqual([]);
  });

  test('AC-10: the skip check uses the raw tag value, so a near miss is kept as unknown', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, 'Bootstrap-Management')) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]) },
    });
    expect(await scan(w.deps, MAX)).toEqual([
      finding('unknown', 'eu-west-1', 'ec2:natgateway', 30),
    ]);
  });

  test('AC-10: a lab value that is not a lab id is kept under the label unknown', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, 'Lab 3')) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]) },
    });
    expect(await scan(w.deps, MAX)).toEqual([
      finding('unknown', 'eu-west-1', 'ec2:natgateway', 30),
    ]);
  });

  test('AC-10: a resource with no lab tag is kept under the label unknown', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, null)) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]) },
    });
    expect(await scan(w.deps, MAX)).toEqual([
      finding('unknown', 'eu-west-1', 'ec2:natgateway', 30),
    ]);
  });
});

describe('AC-11: the age comes from the oldest event', () => {
  test.each([
    ['newest first, as CloudTrail returns them', [ago(5), ago(10), ago(30)]],
    ['oldest first', [ago(30), ago(10), ago(5)]],
    ['with the oldest in the middle', [ago(5), ago(30), ago(10)]],
    ['with the oldest last of an unsorted list', [ago(10), ago(5), ago(30)]],
  ])('AC-11: events %s give an age of 30 hours', async (_label, events) => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json(events) },
    });
    expect(await scan(w.deps, MAX)).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', 30)]);
  });

  test('AC-11: the age is a float, not rounded', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(1.5)]) },
    });
    expect(await scan(w.deps, 1)).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', 1.5)]);
  });

  test('AC-11: an event time with a UTC offset is read as the instant it names', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
      // 08:00 at +01:00 on 1 November is 07:00 UTC, exactly 24 hours before NOW.
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json(['2026-11-01T08:00:00+01:00']) },
    });
    expect(await scan(w.deps, MAX)).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', 24)]);
  });
});

describe('AC-12: the age boundary', () => {
  const natWith = (events: string[]): World =>
    world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json(events) },
    });

  test('AC-12: a resource exactly maxAgeHours old is reported', async () => {
    expect(await scan(natWith([ago(12)]).deps, 12)).toEqual([
      finding(LAB3, 'eu-west-1', 'ec2:natgateway', 12),
    ]);
  });

  test('AC-12: a resource a minute younger is dropped', async () => {
    expect(await scan(natWith([ago(12 - 1 / 60)]).deps, 12)).toEqual([]);
  });

  test('AC-12: a resource one second past the limit is reported', async () => {
    const findings = await scan(natWith([ago(12 + 1 / 3600)]).deps, 12);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ageHours).toBeCloseTo(12 + 1 / 3600, 6);
  });

  test('AC-12: the limit is the argument, not 12', async () => {
    expect(await scan(natWith([ago(13)]).deps, 24)).toEqual([]);
    expect(await scan(natWith([ago(24)]).deps, 24)).toEqual([
      finding(LAB3, 'eu-west-1', 'ec2:natgateway', 24),
    ]);
  });
});

describe('AC-13: a resource with no events', () => {
  test('AC-13: it is kept with an age of null', async () => {
    const w = world({ tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) } });
    expect(await scan(w.deps, MAX)).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', null)]);
  });

  test('AC-13: it is kept however high the limit is', async () => {
    const w = world({ tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) } });
    expect(await scan(w.deps, 2160)).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', null)]);
  });
});

describe('AC-14: the Regions to try', () => {
  test('AC-14: a resource with a Region in its ARN is looked up in that Region only', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
      // The other Region has an event; it must not be asked.
      lookup: { [lookupKey('us-east-1', NAT_ID)]: json([ago(30)]) },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([lookupCall('eu-west-1', NAT_ID)]);
    expect(findings).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', null)]);
  });

  test('AC-14: a resource with no Region tries the scan Region, then the other', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: { [lookupKey('us-east-1', BUCKET_NAME)]: json([ago(40)]) },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([
      lookupCall('eu-west-1', BUCKET_NAME),
      lookupCall('us-east-1', BUCKET_NAME),
    ]);
    expect(findings).toEqual([finding(LAB3, 'eu-west-1', 's3', 40)]);
  });

  test('AC-14: it stops at the first Region that has events', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: {
        [lookupKey('eu-west-1', BUCKET_NAME)]: json([ago(20)]),
        [lookupKey('us-east-1', BUCKET_NAME)]: json([ago(90)]),
      },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([lookupCall('eu-west-1', BUCKET_NAME)]);
    expect(findings).toEqual([finding(LAB3, 'eu-west-1', 's3', 20)]);
  });

  test('AC-14: the other order is tried for a bucket found under us-east-1', async () => {
    const w = world({
      tagging: { 'us-east-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: { [lookupKey('eu-west-1', BUCKET_NAME)]: json([ago(40)]) },
    });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([
      lookupCall('us-east-1', BUCKET_NAME),
      lookupCall('eu-west-1', BUCKET_NAME),
    ]);
    expect(findings).toEqual([finding(LAB3, 'us-east-1', 's3', 40)]);
  });

  test('AC-14: a bucket under us-east-1 with events there is looked up once', async () => {
    const w = world({
      tagging: { 'us-east-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: {
        [lookupKey('us-east-1', BUCKET_NAME)]: json([ago(20)]),
        [lookupKey('eu-west-1', BUCKET_NAME)]: json([ago(90)]),
      },
    });
    await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([lookupCall('us-east-1', BUCKET_NAME)]);
  });

  test('AC-14: with no events in either Region both are tried and the age is null', async () => {
    const w = world({ tagging: { 'us-east-1': listing(res(BUCKET_ARN, LAB3)) } });
    const findings = await scan(w.deps, MAX);
    expect(lookupCalls(w)).toEqual([
      lookupCall('us-east-1', BUCKET_NAME),
      lookupCall('eu-west-1', BUCKET_NAME),
    ]);
    expect(findings).toEqual([finding(LAB3, 'us-east-1', 's3', null)]);
  });
});

describe('AC-15: the Region of a finding', () => {
  test('AC-15: it is the Region of the ARN when there is one', async () => {
    // Listed under us-east-1, but the ARN says eu-west-1.
    const w = world({
      tagging: { 'us-east-1': listing(res(NAT_ARN, LAB3)) },
      lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]) },
    });
    expect(await scan(w.deps, MAX)).toEqual([finding(LAB3, 'eu-west-1', 'ec2:natgateway', 30)]);
  });

  test('AC-15: otherwise it is the scan Region, even when the events came from the other one', async () => {
    const w = world({
      tagging: { 'us-east-1': listing(res(ROLE_ARN, LAB1)) },
      lookup: { [lookupKey('eu-west-1', ROLE_NAME)]: json([ago(30)]) },
    });
    expect(await scan(w.deps, MAX)).toEqual([finding(LAB1, 'us-east-1', 'iam:role', 30)]);
  });

  test('AC-15: a bucket found under eu-west-1 is reported under eu-west-1', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: { [lookupKey('us-east-1', BUCKET_NAME)]: json([ago(30)]) },
    });
    expect(await scan(w.deps, MAX)).toEqual([finding(LAB3, 'eu-west-1', 's3', 30)]);
  });
});

// ---- Issue -------------------------------------------------------------------------------------

describe('AC-16: findings and no open issue', () => {
  test('AC-16: it lists with the exact arguments, then creates with the body on stdin', async () => {
    const w = world();
    await syncIssue(w.deps, 'the body\n', CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL, createCall('the body\n')]);
  });

  test('AC-16: it returns created', async () => {
    const w = world();
    expect(await syncIssue(w.deps, 'the body\n', CLOSE_COMMENT)).toBe('created');
  });

  test('AC-16: the title is the exported ISSUE_TITLE', () => {
    expect(ISSUE_TITLE).toBe('Forgotten lab resources');
  });
});

describe('AC-17: findings and an open issue', () => {
  test('AC-17: it edits that issue with the body on stdin and does not create', async () => {
    const w = world({ list: json([{ number: 7, title: ISSUE_TITLE }]) });
    await syncIssue(w.deps, 'the body\n', CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL, editCall(7, 'the body\n')]);
  });

  test('AC-17: it returns updated', async () => {
    const w = world({ list: json([{ number: 7, title: ISSUE_TITLE }]) });
    expect(await syncIssue(w.deps, 'the body\n', CLOSE_COMMENT)).toBe('updated');
  });
});

describe('AC-18: no findings', () => {
  test('AC-18: with an open issue it closes it with the exact comment', async () => {
    const w = world({ list: json([{ number: 7, title: ISSUE_TITLE }]) });
    await syncIssue(w.deps, null, CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL, closeCall(7, CLOSE_COMMENT)]);
  });

  test('AC-18: with an open issue it returns closed', async () => {
    const w = world({ list: json([{ number: 7, title: ISSUE_TITLE }]) });
    expect(await syncIssue(w.deps, null, CLOSE_COMMENT)).toBe('closed');
  });

  test('AC-18: with no issue it makes only the list call', async () => {
    const w = world();
    await syncIssue(w.deps, null, CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL]);
  });

  test('AC-18: with no issue it returns none', async () => {
    const w = world();
    expect(await syncIssue(w.deps, null, CLOSE_COMMENT)).toBe('none');
  });
});

describe('AC-19: which issue counts', () => {
  const OTHERS = [
    { number: 2, title: 'Forgotten lab resources (copy)' },
    { number: 3, title: 'forgotten lab resources' },
    { number: 4, title: ' Forgotten lab resources' },
    { number: 1, title: 'Something else' },
  ];

  test('AC-19: entries with another title are ignored, so the issue is created', async () => {
    const w = world({ list: json(OTHERS) });
    expect(await syncIssue(w.deps, 'b\n', CLOSE_COMMENT)).toBe('created');
    expect(w.calls).toEqual([LIST_CALL, createCall('b\n')]);
  });

  test('AC-19: entries with another title are ignored, so nothing is closed', async () => {
    const w = world({ list: json(OTHERS) });
    expect(await syncIssue(w.deps, null, CLOSE_COMMENT)).toBe('none');
    expect(w.calls).toEqual([LIST_CALL]);
  });

  test('AC-19: an exact match among other titles is the one edited', async () => {
    const w = world({ list: json([...OTHERS, { number: 9, title: ISSUE_TITLE }]) });
    await syncIssue(w.deps, 'b\n', CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL, editCall(9, 'b\n')]);
  });

  test.each([
    ['ascending', [5, 9, 100]],
    ['descending', [100, 9, 5]],
    ['mixed', [9, 100, 5]],
    ['mixed again', [100, 5, 9]],
  ])(
    'AC-19: of several exact matches in %s order the lowest number is edited',
    async (_label, numbers) => {
      const w = world({ list: json(numbers.map((number) => ({ number, title: ISSUE_TITLE }))) });
      await syncIssue(w.deps, 'b\n', CLOSE_COMMENT);
      expect(w.calls).toEqual([LIST_CALL, editCall(5, 'b\n')]);
    },
  );

  test('AC-19: the lowest number is compared as a number, not as text', async () => {
    const w = world({
      list: json([
        { number: 100, title: ISSUE_TITLE },
        { number: 9, title: ISSUE_TITLE },
      ]),
    });
    await syncIssue(w.deps, 'b\n', CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL, editCall(9, 'b\n')]);
  });

  test('AC-19: of several exact matches the lowest number is the one closed', async () => {
    const w = world({
      list: json([
        { number: 12, title: ISSUE_TITLE },
        { number: 4, title: ISSUE_TITLE },
        { number: 8, title: ISSUE_TITLE },
      ]),
    });
    await syncIssue(w.deps, null, CLOSE_COMMENT);
    expect(w.calls).toEqual([LIST_CALL, closeCall(4, CLOSE_COMMENT)]);
  });
});

// ---- Run ---------------------------------------------------------------------------------------

/** The scan of the "one old NAT gateway" scenario, in Region eu-west-1. */
const oneNat = (ageHours: number, rest: Script = {}): Script => ({
  tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
  lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(ageHours)]) },
  ...rest,
});

describe('AC-20: a bad JANITOR_MAX_AGE_HOURS', () => {
  test.each(['0', '2161', '12h', '1.5', ' 12'])(
    'AC-20: %j returns 2 with the message on err and no exec call',
    async (value) => {
      const w = world({ env: { JANITOR_MAX_AGE_HOURS: value } });
      expect(await runJanitor(w.deps)).toBe(2);
      expect(w.err).toEqual([MESSAGE_BAD_HOURS]);
      expect(w.out).toEqual([]);
      expect(w.calls).toEqual([]);
    },
  );
});

describe('AC-21: a successful run', () => {
  test('AC-21: findings with no open issue print the summary, create the issue and return 0', async () => {
    const w = world(oneNat(72));
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 1 resources in 1 labs, issue created']);
    expect(w.err).toEqual([]);
  });

  test('AC-21: the issue body is the report for the findings, the limit and the time', async () => {
    const w = world(oneNat(72));
    await runJanitor(w.deps);
    const body = expectedBody(12, '2026-11-02 07:00 UTC', [
      `| ${LAB3} | eu-west-1 | ec2:natgateway | 1 | 3 days |`,
    ]);
    expect(ghCalls(w)).toEqual([LIST_CALL, createCall(body)]);
  });

  test('AC-21: the summary counts resources, and each lab once', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(res(NAT_ARN, LAB3), res(KMS_ARN, LAB3), res(BUCKET_ARN, LAB3)),
        'us-east-1': listing(res(ROLE_ARN, LAB1)),
      },
      lookup: {
        [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]),
        [lookupKey('eu-west-1', KEY_ID)]: json([ago(30)]),
        [lookupKey('eu-west-1', BUCKET_NAME)]: json([ago(30)]),
        [lookupKey('us-east-1', ROLE_NAME)]: json([ago(30)]),
      },
    });
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 4 resources in 2 labs, issue created']);
  });

  test('AC-21: two resources of one group count as two resources in one lab', async () => {
    const other = `arn:aws:ec2:eu-west-1:${ACCOUNT}:natgateway/nat-0f0f0f0f0f0f0f0f0`;
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3), res(other, LAB3)) },
      lookup: {
        [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]),
        [lookupKey('eu-west-1', 'nat-0f0f0f0f0f0f0f0f0')]: json([ago(40)]),
      },
    });
    await runJanitor(w.deps);
    expect(w.out).toEqual(['janitor: 2 resources in 1 labs, issue created']);
  });

  test('AC-21: an empty result with no issue prints the none summary and returns 0', async () => {
    const w = world({ tagging: { 'eu-west-1': listing(SITE) } });
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 0 resources in 0 labs, issue none']);
    expect(ghCalls(w)).toEqual([LIST_CALL]);
  });

  test('AC-21: findings with an open issue print updated', async () => {
    const w = world(oneNat(72, { list: json([{ number: 7, title: ISSUE_TITLE }]) }));
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 1 resources in 1 labs, issue updated']);
    expect(ghCalls(w)[1]?.args.slice(0, 3)).toEqual(['issue', 'edit', '7']);
  });

  test('AC-21: nothing old with an open issue closes it with the exact comment', async () => {
    const w = world(oneNat(2, { list: json([{ number: 7, title: ISSUE_TITLE }]) }));
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 0 resources in 0 labs, issue closed']);
    expect(ghCalls(w)).toEqual([LIST_CALL, closeCall(7, CLOSE_COMMENT)]);
  });

  test('AC-21: with JANITOR_MAX_AGE_HOURS unset the limit is 12 hours', async () => {
    const young = world(oneNat(11));
    await runJanitor(young.deps);
    expect(young.out).toEqual(['janitor: 0 resources in 0 labs, issue none']);
    const old = world(oneNat(13));
    await runJanitor(old.deps);
    expect(old.out).toEqual(['janitor: 1 resources in 1 labs, issue created']);
  });

  test('AC-21: JANITOR_MAX_AGE_HOURS sets the limit, the report and the close comment', async () => {
    const young = world(oneNat(13, { env: { JANITOR_MAX_AGE_HOURS: '24' } }));
    await runJanitor(young.deps);
    expect(young.out).toEqual(['janitor: 0 resources in 0 labs, issue none']);

    const old = world(oneNat(30, { env: { JANITOR_MAX_AGE_HOURS: '24' } }));
    await runJanitor(old.deps);
    expect(ghCalls(old)[1]?.input?.split('\n')[0]).toBe(
      'Lab resources older than 24 hours, as of 2026-11-02 07:00 UTC.',
    );

    const closing = world(
      oneNat(13, {
        env: { JANITOR_MAX_AGE_HOURS: '24' },
        list: json([{ number: 7, title: ISSUE_TITLE }]),
      }),
    );
    await runJanitor(closing.deps);
    expect(ghCalls(closing)[1]).toEqual(
      closeCall(7, 'Nothing older than 24 hours is left as of 2026-11-02 07:00 UTC.'),
    );
  });

  test('AC-21: the empty JANITOR_MAX_AGE_HOURS means 12', async () => {
    const w = world(oneNat(13, { env: { JANITOR_MAX_AGE_HOURS: '' } }));
    await runJanitor(w.deps);
    expect(w.out).toEqual(['janitor: 1 resources in 1 labs, issue created']);
  });
});

describe('AC-22: a failed tagging scan', () => {
  const NAT_LISTING = listing(res(NAT_ARN, LAB3));
  const cases: [string, Script][] = [
    ['a non-zero call in the first Region', { tagging: { 'eu-west-1': fail() } }],
    [
      'a non-zero call in the second Region',
      { tagging: { 'eu-west-1': NAT_LISTING, 'us-east-1': fail() } },
    ],
    ['invalid JSON', { tagging: { 'eu-west-1': raw('{') } }],
    ['a JSON object instead of an array', { tagging: { 'eu-west-1': json({}) } }],
    ['a JSON string instead of an array', { tagging: { 'eu-west-1': json('text') } }],
    ['an element without an arn', { tagging: { 'eu-west-1': json([{ tags: [] }]) } }],
    [
      'an element whose arn is a number',
      { tagging: { 'eu-west-1': json([{ arn: 5, tags: [] }]) } },
    ],
    [
      'an element whose tags are not a list',
      { tagging: { 'eu-west-1': json([{ arn: NAT_ARN, tags: 'x' }]) } },
    ],
  ];

  test.each(cases)(
    'AC-22: %s returns 1, prints the message and makes no gh call',
    async (_label, script) => {
      const w = world({ ...script, list: json([{ number: 7, title: ISSUE_TITLE }]) });
      expect(await runJanitor(w.deps)).toBe(1);
      expect(w.err).toEqual(['janitor: tagging scan failed']);
      expect(w.out).toEqual([]);
      expect(ghCalls(w)).toEqual([]);
      expect(lookupCalls(w)).toEqual([]);
    },
  );
});

describe('AC-23: a failed event lookup', () => {
  const key = lookupKey('eu-west-1', NAT_ID);
  const cases: [string, Script][] = [
    ['a non-zero lookup', { lookup: { [key]: fail() } }],
    ['invalid JSON', { lookup: { [key]: raw('not json') } }],
    ['a time that does not parse', { lookup: { [key]: json(['not a time']) } }],
    ['an empty time', { lookup: { [key]: json(['']) } }],
    ['a JSON object instead of an array', { lookup: { [key]: json({ events: [] }) } }],
    ['an element that is not a string', { lookup: { [key]: json([1700000000]) } }],
  ];

  test.each(cases)(
    'AC-23: %s returns 1, prints the message and leaves the issue alone',
    async (_label, script) => {
      const w = world({
        tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)) },
        list: json([{ number: 7, title: ISSUE_TITLE }]),
        ...script,
      });
      expect(await runJanitor(w.deps)).toBe(1);
      expect(w.err).toEqual(['janitor: event lookup failed']);
      expect(w.out).toEqual([]);
      expect(ghCalls(w)).toEqual([]);
    },
  );

  test('AC-23: a non-zero lookup in the second Region fails the same way', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(BUCKET_ARN, LAB3)) },
      lookup: { [lookupKey('us-east-1', BUCKET_NAME)]: fail() },
      list: json([{ number: 7, title: ISSUE_TITLE }]),
    });
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual(['janitor: event lookup failed']);
    expect(ghCalls(w)).toEqual([]);
  });

  test('AC-23: it stops at the first failed lookup', async () => {
    const w = world({
      tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3), res(KMS_ARN, LAB3)) },
      lookup: { [key]: fail(), [lookupKey('eu-west-1', KEY_ID)]: fail() },
    });
    await runJanitor(w.deps);
    expect(lookupCalls(w)).toHaveLength(1);
  });
});

describe('AC-24: a failed gh call', () => {
  const open = json([{ number: 7, title: ISSUE_TITLE }]);

  test.each([
    ['list', oneNat(72, { list: fail() })],
    ['list with invalid JSON', oneNat(72, { list: raw('{') })],
    ['list with a JSON object', oneNat(72, { list: json({}) })],
    ['create', oneNat(72, { create: fail() })],
    ['edit', oneNat(72, { list: open, edit: fail() })],
    ['close', oneNat(2, { list: open, close: fail() })],
  ])('AC-24: a failed %s returns 1 and prints the message', async (_label, script) => {
    const w = world(script);
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual(['janitor: issue update failed']);
    expect(w.out).toEqual([]);
  });

  test('AC-24: a failed list makes no create, edit or close call', async () => {
    const w = world(oneNat(72, { list: fail() }));
    await runJanitor(w.deps);
    expect(ghCalls(w)).toEqual([LIST_CALL]);
  });
});

describe('AC-25: a scan that finds nothing at all', () => {
  test.each([
    ['empty lists', raw('[]'), raw('[]')],
    ['empty stdout and null', raw(''), raw('null')],
    ['null and empty stdout', raw('null'), raw('')],
  ])('AC-25: %s in both Regions return 1 with the exact message', async (_label, eu, us) => {
    const w = world({
      tagging: { 'eu-west-1': eu, 'us-east-1': us },
      list: json([{ number: 7, title: ISSUE_TITLE }]),
    });
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual([MESSAGE_NOTHING]);
    expect(w.out).toEqual([]);
    expect(ghCalls(w)).toEqual([]);
    expect(lookupCalls(w)).toEqual([]);
  });

  test('AC-25: only skipped labs present is not that case: it returns 0 and closes the issue', async () => {
    const w = world({
      tagging: {
        'eu-west-1': listing(SITE),
        'us-east-1': listing(res(MGMT_ARN, 'bootstrap-management')),
      },
      list: json([{ number: 7, title: ISSUE_TITLE }]),
    });
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.err).toEqual([]);
    expect(w.out).toEqual(['janitor: 0 resources in 0 labs, issue closed']);
    expect(ghCalls(w)).toEqual([LIST_CALL, closeCall(7, CLOSE_COMMENT)]);
    expect(lookupCalls(w)).toEqual([]);
  });
});

// ---- The leak test -----------------------------------------------------------------------------

describe('AC-26: nothing from AWS reaches the output', () => {
  const FORBIDDEN = [
    ACCOUNT,
    'arn:',
    NAT_ARN,
    BUCKET_ARN,
    ROLE_ARN,
    SITE_ARN,
    NAT_ID,
    BUCKET_NAME,
    ROLE_NAME,
    SITE_NAME,
    KEY_ID,
  ];
  /** What a failing `aws` or `gh` says: an access-denied text that holds the ARNs. */
  const LEAK = `An error occurred (AccessDenied): ${ROLE_ARN} cannot act on ${NAT_ARN} and ${BUCKET_ARN} in ${ACCOUNT}`;
  const open = json([{ number: 7, title: ISSUE_TITLE }]);

  /** Every line the run printed, and everything it sent to gh. */
  const emitted = (w: World): string =>
    [...w.out, ...w.err, ...ghCalls(w).flatMap((call) => [...call.args, call.input ?? ''])].join(
      '\n',
    );

  const leaks = (w: World): string[] => FORBIDDEN.filter((text) => emitted(w).includes(text));

  /** Every fixture ARN holds the account ID: the three resources and a bucket named after it. */
  const fixtures = (rest: Script = {}): Script => ({
    tagging: {
      'eu-west-1': listing(res(NAT_ARN, LAB3), res(BUCKET_ARN, LAB3), SITE),
      'us-east-1': listing(res(ROLE_ARN, LAB1)),
    },
    lookup: {
      [lookupKey('eu-west-1', NAT_ID)]: json([ago(30)]),
      [lookupKey('us-east-1', BUCKET_NAME)]: json([ago(40)]),
      [lookupKey('us-east-1', ROLE_NAME)]: json([ago(50)]),
    },
    ...rest,
  });

  test('AC-26: the success path leaks nothing and does write a report', async () => {
    const w = world(fixtures());
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 3 resources in 2 labs, issue created']);
    expect(ghCalls(w)[1]?.input).toBeDefined();
    expect(leaks(w)).toEqual([]);
  });

  test('AC-26: the success path with an open issue leaks nothing', async () => {
    const w = world(fixtures({ list: open }));
    expect(await runJanitor(w.deps)).toBe(0);
    expect(leaks(w)).toEqual([]);
  });

  test('AC-26: closing an issue leaks nothing', async () => {
    const w = world({ tagging: { 'eu-west-1': listing(SITE) }, list: open });
    expect(await runJanitor(w.deps)).toBe(0);
    expect(ghCalls(w)).toEqual([LIST_CALL, closeCall(7, CLOSE_COMMENT)]);
    expect(leaks(w)).toEqual([]);
  });

  const failures: [string, Script, number, string][] = [
    [
      'a failed tagging call',
      fixtures({ tagging: { 'eu-west-1': fail(LEAK) } }),
      1,
      'janitor: tagging scan failed',
    ],
    [
      'tagging output that is not JSON and quotes an ARN',
      fixtures({ tagging: { 'eu-west-1': raw(`{"arn": "${NAT_ARN}"`) } }),
      1,
      'janitor: tagging scan failed',
    ],
    [
      'tagging output of the wrong shape that holds an ARN',
      fixtures({ tagging: { 'eu-west-1': json({ arn: NAT_ARN, message: LEAK }) } }),
      1,
      'janitor: tagging scan failed',
    ],
    [
      'a failed lookup',
      fixtures({ lookup: { [lookupKey('eu-west-1', NAT_ID)]: fail(LEAK) } }),
      1,
      'janitor: event lookup failed',
    ],
    [
      'lookup output that is not JSON and quotes an ARN',
      fixtures({ lookup: { [lookupKey('eu-west-1', NAT_ID)]: raw(`["${NAT_ARN}"`) } }),
      1,
      'janitor: event lookup failed',
    ],
    [
      'a lookup time that holds an ARN and does not parse',
      fixtures({ lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([NAT_ARN]) } }),
      1,
      'janitor: event lookup failed',
    ],
    ['a failed issue list', fixtures({ list: fail(LEAK) }), 1, 'janitor: issue update failed'],
    [
      'an issue list that is not JSON and quotes an ARN',
      fixtures({ list: raw(`[{"number": "${NAT_ARN}"`) }),
      1,
      'janitor: issue update failed',
    ],
    ['a failed issue create', fixtures({ create: fail(LEAK) }), 1, 'janitor: issue update failed'],
    [
      'a failed issue edit',
      fixtures({ list: open, edit: fail(LEAK) }),
      1,
      'janitor: issue update failed',
    ],
    [
      'a failed issue close',
      {
        tagging: { 'eu-west-1': listing(SITE) },
        list: open,
        close: fail(LEAK),
      },
      1,
      'janitor: issue update failed',
    ],
  ];

  test.each(failures)('AC-26: %s leaks nothing', async (_label, script, code, message) => {
    const w = world(script);
    expect(await runJanitor(w.deps)).toBe(code);
    expect(w.err).toEqual([message]);
    expect(leaks(w)).toEqual([]);
  });

  test('AC-26: an empty scan leaks nothing', async () => {
    const w = world({ tagging: { 'eu-west-1': raw('[]'), 'us-east-1': raw('[]') } });
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual([MESSAGE_NOTHING]);
    expect(leaks(w)).toEqual([]);
  });

  test('AC-26: a bad JANITOR_MAX_AGE_HOURS leaks nothing', async () => {
    const w = world({ ...fixtures(), env: { JANITOR_MAX_AGE_HOURS: '0' } });
    expect(await runJanitor(w.deps)).toBe(2);
    expect(leaks(w)).toEqual([]);
  });
});

// ---- Plain Node --------------------------------------------------------------------------------

const SRC = join(REPO_ROOT, 'tools', 'guardrails', 'src');

function sourceOf(name: string): string {
  const path = join(SRC, name);
  if (!existsSync(path)) throw new Error(`missing file: tools/guardrails/src/${name}`);
  return readFileSync(path, 'utf8');
}

/** The source without block comments and `//` comments, so a word in a comment does not count. */
function codeOf(name: string): string {
  return sourceOf(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** Every module specifier of an import, an export-from or a dynamic import. */
function specifiersOf(code: string): string[] {
  const pattern =
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...code.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'janitor-cli-'));
  tempDirs.push(dir);
  return dir;
}

describe('AC-27: janitor.ts and janitor-cli.ts run under plain Node', () => {
  test.each(['janitor.ts', 'janitor-cli.ts'])(
    'AC-27: %s imports only node: modules and ./ files with a .ts extension',
    (name) => {
      const specifiers = specifiersOf(codeOf(name));
      for (const specifier of specifiers) {
        expect(specifier.startsWith('node:') || /^\.\/.+\.ts$/.test(specifier)).toBe(true);
      }
    },
  );

  test.each(['janitor.ts', 'janitor-cli.ts'])('AC-27: %s holds no enum', (name) => {
    expect(codeOf(name)).not.toMatch(/\benum\b/);
  });

  test.each(['janitor.ts', 'janitor-cli.ts'])('AC-27: %s holds no parameter property', (name) => {
    expect(codeOf(name)).not.toMatch(
      /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\b/,
    );
  });

  test('AC-27: janitor-cli.ts imports ./janitor.ts and ./janitor-exec.ts, and janitor-exec.ts runs aws and gh through execFile, not a shell', () => {
    const cli = codeOf('janitor-cli.ts');
    const exec = codeOf('janitor-exec.ts');
    expect(specifiersOf(cli)).toContain('./janitor.ts');
    expect(specifiersOf(cli)).toContain('./janitor-exec.ts');
    expect(exec).toContain('execFile');
    expect(exec).not.toMatch(/shell\s*:\s*true/);
    expect(cli).not.toMatch(/shell\s*:\s*true/);
  });

  test('AC-27: janitor.ts loads under node --experimental-strip-types', () => {
    const target = join(SRC, 'janitor.ts');
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(target).href)})`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(result.stderr.replace(/^.*(ExperimentalWarning|trace-warnings).*$/gm, '').trim()).toBe(
      '',
    );
    expect(result.status).toBe(0);
  });

  test('AC-27: janitor-cli.ts with a bad JANITOR_MAX_AGE_HOURS exits 2 with the message, with no aws or gh on PATH', () => {
    const cli = join(SRC, 'janitor-cli.ts');
    if (!existsSync(cli)) throw new Error('missing file: tools/guardrails/src/janitor-cli.ts');
    // An empty directory is the whole PATH: `aws` and `gh` cannot be found. Node runs by its path.
    const guard = tempDir();
    const env: NodeJS.ProcessEnv = { PATH: guard, JANITOR_MAX_AGE_HOURS: '0' };
    for (const name of ['SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli], {
      cwd: guard,
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
    const stderr = result.stderr
      .split(/\r?\n/)
      .filter((line) => line !== '' && !/ExperimentalWarning|trace-warnings/.test(line));
    expect(result.status).toBe(2);
    expect(stderr).toEqual([MESSAGE_BAD_HOURS]);
    expect(result.stdout).toBe('');
  });
});

describe('AC-28: REGIONS follows the SCP', () => {
  test('AC-28: REGIONS has exactly the Regions of allowed_regions in bootstrap/management', () => {
    const scp = readFileSync(join(REPO_ROOT, 'bootstrap', 'management', 'scp.tf'), 'utf8');
    const list = /\ballowed_regions\s*=\s*\[([^\]]*)\]/.exec(scp)?.[1];
    expect(list).toBeDefined();
    const allowed = [...(list ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(allowed.length).toBeGreaterThan(0);
    expect([...REGIONS].sort()).toEqual([...allowed].sort());
  });
});

// ---- Review regressions (spec 043, AC-36 to AC-41) ---------------------------------------------

/** A failure as the real tools fail: a non-zero code, with whatever stdout holds (often nothing). */
const exitCode254 = (stdout: string): ExecResult => ({ code: 254, stdout });

describe('AC-36: the exit code decides, whatever stdout holds', () => {
  const open = json([{ number: 7, title: ISSUE_TITLE }]);

  /** Scripts that must each end in the step's failure; `gh` is what may have been called. */
  const failing = (stdout: string): [string, Script, string, Call[]][] => [
    [
      'tagging in the first Region',
      {
        tagging: { 'eu-west-1': exitCode254(stdout), 'us-east-1': listing(SITE) },
        list: open,
      },
      'janitor: tagging scan failed',
      [],
    ],
    [
      'tagging in the second Region, with resources in the first',
      {
        tagging: { 'eu-west-1': listing(res(NAT_ARN, LAB3)), 'us-east-1': exitCode254(stdout) },
        lookup: { [lookupKey('eu-west-1', NAT_ID)]: json([ago(72)]) },
        list: open,
      },
      'janitor: tagging scan failed',
      [],
    ],
    [
      'a lookup',
      oneNat(72, { lookup: { [lookupKey('eu-west-1', NAT_ID)]: exitCode254(stdout) }, list: open }),
      'janitor: event lookup failed',
      [],
    ],
    [
      'gh issue list',
      oneNat(72, { list: exitCode254(stdout) }),
      'janitor: issue update failed',
      [LIST_CALL],
    ],
  ];

  const cases = ['', '[]'].flatMap((stdout) =>
    failing(stdout).map(
      ([label, script, message, gh]) =>
        [
          `${label} exiting 254 with stdout ${JSON.stringify(stdout)}`,
          script,
          message,
          gh,
        ] as const,
    ),
  );

  test.each(cases)(
    'AC-36: %s returns 1 with the step message and changes no issue',
    async (_label, script, message, gh) => {
      const w = world(script);
      expect(await runJanitor(w.deps)).toBe(1);
      expect(w.err).toEqual([message]);
      expect(w.out).toEqual([]);
      expect(ghCalls(w)).toEqual(gh);
    },
  );
});

describe('AC-37: a wrong shape from gh issue list fails', () => {
  test.each([
    ['null', raw('null')],
    ['empty stdout', raw('')],
    ['an entry whose number is not a number', json([{ number: '7', title: ISSUE_TITLE }])],
    ['an entry whose title is not a string', json([{ number: 7, title: 5 }])],
    ['a string entry', json(['text'])],
  ])(
    'AC-37: %s returns 1 with the message and makes no create, edit or close',
    async (_label, list) => {
      const w = world(oneNat(72, { list }));
      expect(await runJanitor(w.deps)).toBe(1);
      expect(w.err).toEqual(['janitor: issue update failed']);
      expect(w.out).toEqual([]);
      expect(ghCalls(w)).toEqual([LIST_CALL]);
    },
  );

  test('AC-37: the same wrong shape with nothing to report makes no close call either', async () => {
    const w = world(oneNat(2, { list: raw('null') }));
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual(['janitor: issue update failed']);
    expect(ghCalls(w)).toEqual([LIST_CALL]);
  });

  test('AC-37: an empty list stays valid and the issue is created', async () => {
    const w = world(oneNat(72, { list: json([]) }));
    expect(await runJanitor(w.deps)).toBe(0);
    expect(w.out).toEqual(['janitor: 1 resources in 1 labs, issue created']);
  });
});

describe('AC-38: one bad time among good ones fails the lookup', () => {
  test.each([
    ['after a good one', (good: string) => [good, 'not a time']],
    ['before a good one', (good: string) => ['not a time', good]],
  ])('AC-38: a bad time %s returns 1 with the lookup message', async (_label, events) => {
    const w = world(
      oneNat(72, { lookup: { [lookupKey('eu-west-1', NAT_ID)]: json(events(ago(72))) } }),
    );
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual(['janitor: event lookup failed']);
    expect(w.out).toEqual([]);
    expect(ghCalls(w)).toEqual([]);
  });
});

describe('AC-40: runJanitor catches everything', () => {
  const open = json([{ number: 7, title: ISSUE_TITLE }]);
  const ghVerb = (verb: string) => (call: Call) => call.file === 'gh' && call.args[1] === verb;

  /** A world whose exec rejects, with an error that holds ARNs, on the first call that matches. */
  function rejecting(script: Script, matches: (call: Call) => boolean): World {
    const w = world(script);
    const inner = w.deps.exec;
    w.deps.exec = (file, args, input) => {
      const call: Call = { file, args: [...args], input };
      if (!matches(call)) return inner(file, args, input);
      w.calls.push(call);
      return Promise.reject(new Error(`AccessDenied for ${ROLE_ARN} on ${NAT_ARN} in ${ACCOUNT}`));
    };
    return w;
  }

  const cases: [string, Script, (call: Call) => boolean][] = [
    [
      'tagging',
      oneNat(72),
      (call) => call.file === 'aws' && call.args[0] === 'resourcegroupstaggingapi',
    ],
    ['a lookup', oneNat(72), (call) => call.file === 'aws' && call.args[0] === 'cloudtrail'],
    ['gh issue list', oneNat(72), ghVerb('list')],
    ['gh issue create', oneNat(72), ghVerb('create')],
    ['gh issue edit', oneNat(72, { list: open }), ghVerb('edit')],
    ['gh issue close', oneNat(2, { list: open }), ghVerb('close')],
  ];

  test.each(cases)(
    'AC-40: an exec that rejects in %s returns 1 and prints the generic message',
    async (_label, script, matches) => {
      const w = rejecting(script, matches);
      await expect(runJanitor(w.deps)).resolves.toBe(1);
      expect(w.err).toEqual(['janitor: unexpected failure']);
      expect(w.out).toEqual([]);
    },
  );

  test.each(cases)(
    'AC-40: an exec that rejects in %s makes no later call',
    async (_label, script, matches) => {
      const w = rejecting(script, matches);
      await runJanitor(w.deps);
      const last = w.calls.at(-1);
      expect(last !== undefined && matches(last)).toBe(true);
    },
  );

  test('AC-40: a JanitorError from a step still prints that step message', async () => {
    const w = world(oneNat(72, { lookup: { [lookupKey('eu-west-1', NAT_ID)]: exitCode254('') } }));
    expect(await runJanitor(w.deps)).toBe(1);
    expect(w.err).toEqual(['janitor: event lookup failed']);
  });
});

describe('AC-41: the real CLI with no aws on PATH', () => {
  test('AC-41: it exits 1, prints the tagging message and nothing to stdout', () => {
    const cli = join(SRC, 'janitor-cli.ts');
    if (!existsSync(cli)) throw new Error('missing file: tools/guardrails/src/janitor-cli.ts');
    // An empty directory is the whole PATH, so `aws` cannot be found and no AWS call is made.
    const guard = tempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: guard,
      JANITOR_MAX_AGE_HOURS: '12',
      NODE_NO_WARNINGS: '1',
    };
    for (const name of ['SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli], {
      cwd: guard,
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('janitor: tagging scan failed\n');
    expect(result.stdout).toBe('');
  });
});

// ---- AC-43: janitor-exec.ts follows the AC-27 code rules ---------------------------------------

describe('AC-43: janitor-exec.ts runs under plain Node', () => {
  test('AC-43: it imports only node: modules and ./ files with a .ts extension', () => {
    const specifiers = specifiersOf(codeOf('janitor-exec.ts'));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:') || /^\.\/.+\.ts$/.test(specifier)).toBe(true);
    }
  });

  test('AC-43: it holds no enum', () => {
    expect(codeOf('janitor-exec.ts')).not.toMatch(/\benum\b/);
  });

  test('AC-43: it holds no parameter property', () => {
    expect(codeOf('janitor-exec.ts')).not.toMatch(
      /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\b/,
    );
  });
});
