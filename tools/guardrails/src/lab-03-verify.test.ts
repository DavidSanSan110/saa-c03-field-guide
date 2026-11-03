import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 042 (issue #112), AC-16 to AC-25: labs/03-nat-vs-gateway-endpoint/verify.sh.
//
// verify.sh is executed with bash and stub `terraform`, `aws`, `session-manager-plugin` and `sleep`
// binaries on PATH (the approach of lab-02-verify.test.ts and of the sleep stub of
// lab-00-verify.test.ts). Every terraform and aws call appends one tab separated line to calls.log;
// every sleep call is appended to sleep.log (it does not sleep). The aws stub also logs, per call, the
// MSYS_NO_PATHCONV, region and pager variables it saw and, for `ssm start-session` only, the state of
// its standard input (aws-env.log, same order as the aws lines of calls.log), and, for a call with
// --body, the content of the body file at that moment (body-<line number>).
//
// Standard input: the test keeps the standard input of verify.sh an open pipe that never gets data. The
// start-session stub reads it with `read -t 0.3`: `eof` means it was redirected from /dev/null (or
// closed), `open` means the call inherited the open pipe. This was checked to work in Git Bash and
// needs no change of the script.
//
// The aws stub answers by what the call asks, not by the order of its arguments: the service and
// operation plus the value of each option the spec uses (see SIGNATURE_OPTIONS) and the exact argv is
// checked once, by AC-18. A rule can hold a list of answers: the n-th call gets the n-th answer and the
// last one repeats (the polls of AC-19).
//
// Every run gets its own TMPDIR: after the run nothing may be left in it, and the body and out files
// seen in the argv must be gone (AC-20).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const slash = (path: string): string => path.replace(/\\/g, '/');

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

const LAB = ['labs', '03-nat-vs-gateway-endpoint'];

// ---- Fixture data ---------------------------------------------------------------------------------

const ACCT = '111122223333';
const VPC = 'vpc-0a1b2c3d4e5f60718';
const PUB_RT = 'rtb-0a1b2c3d4e5f60001';
const PRIV_RT = 'rtb-0a1b2c3d4e5f60002';
const IGW = 'igw-0a1b2c3d4e5f60718';
const NAT = 'nat-0a1b2c3d4e5f60718';
const OTHER_NAT = 'nat-0fedcba987654321f';
const VPCE = 'vpce-0a1b2c3d4e5f60718';
const OTHER_VPCE = 'vpce-0fedcba987654321f';
const INST = 'i-0a1b2c3d4e5f60718';
const SG = 'sg-0a1b2c3d4e5f60718';
const RULE_ID = 'sgr-0a1b2c3d4e5f60718';
const PL = 'pl-63a5400a';
const OTHER_PL = 'pl-02cd2c6b';
/** Documentation addresses (RFC 5737): the NAT gateway's, and another one. */
const NAT_IP = '203.0.113.45';
const OTHER_IP = '198.51.100.77';
const DATA = `field-guide-lab03-data-${ACCT}`;
const OTHER = `field-guide-lab03-other-${ACCT}`;
const ROLE = `arn:aws:iam::${ACCT}:role/lab/fg-lab03-instance`;
const BOUNDARY = `arn:aws:iam::${ACCT}:policy/fg-workload-boundary`;
const SSM_POLICY = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const DATA_ARN = `arn:aws:s3:::${DATA}`;
const OTHER_ARN = `arn:aws:s3:::${OTHER}`;
const PROBE_KEY = 'endpoint-only/verify-probe.txt';
const OTHER_KEY = 'verify-probe.txt';
const BODY_TEXT = 'lab 03 verify probe';
const SERVICE = 'com.amazonaws.us-east-1.s3';
const STUB_ERR = 'stub-stderr-must-never-be-printed';
const INSTANCE_OUT_MARK = 'INSTANCE-STDOUT-MARKER';
const INSTANCE_ERR_MARK = 'INSTANCE-STDERR-MARKER';
const USAGE = 'usage: bash verify.sh (no arguments; run it from the stack directory)';
const SKIP_LIVE =
  'set VERIFY_ASSUME=1 to try it for real (needs ssm:SendCommand, ssm:StartSession and s3:PutObject)';
const BODY = '<body>';
const OUT = '<out>';

/** The eleven terraform outputs, in the order of section 7 of the spec. */
const OUTPUT_NAMES = [
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
] as const;

const OUTPUT_VALUES: Record<(typeof OUTPUT_NAMES)[number], string> = {
  vpc_id: VPC,
  public_route_table_id: PUB_RT,
  private_route_table_id: PRIV_RT,
  nat_gateway_id: NAT,
  nat_public_ip: NAT_IP,
  s3_endpoint_id: VPCE,
  instance_id: INST,
  instance_security_group_id: SG,
  instance_role_arn: ROLE,
  data_bucket_name: DATA,
  other_bucket_name: OTHER,
};

/** The read-only checks and the live checks, in the order of the spec tables (and of stdout). */
const READ_IDS: string[] = [
  'vpc-dns',
  'public-route',
  'private-nat-route',
  'private-no-igw',
  'private-endpoint-route',
  'nat-gateway',
  's3-endpoint',
  's3-endpoint-policy',
  'instance-private',
  'instance-no-inbound',
  'instance-role',
  'instance-ssm-policy',
  'role-may-use-ssm',
  'role-may-read-other',
  'buckets-private',
  'data-bucket-policy',
  'instance-online',
];
const LIVE_IDS: string[] = [
  'run-command',
  'session-manager',
  'probe-objects',
  'internet-through-nat',
  's3-through-endpoint',
  'instance-upload',
  'other-bucket-denied',
  'outside-read-denied',
  'outside-other-read',
];
const ORDER: string[] = [...READ_IDS, ...LIVE_IDS];
/** The checks that run a script on the instance (`on_instance`), with the script of each. */
const INSTANCE_SCRIPTS: Record<string, string> = {
  'run-command': 'echo lab03-run-command',
  'internet-through-nat': 'curl -sS --max-time 15 https://checkip.amazonaws.com',
  's3-through-endpoint': `aws s3api get-object --region us-east-1 --bucket ${DATA} --key ${PROBE_KEY} lab03-probe >/dev/null && cat lab03-probe`,
  'instance-upload': `echo lab03 | aws s3 cp - s3://${DATA}/verify-from-instance.txt --region us-east-1`,
  'other-bucket-denied': `aws s3api get-object --region us-east-1 --bucket ${OTHER} --key ${OTHER_KEY} lab03-probe >/dev/null`,
};
const INSTANCE_IDS = Object.keys(INSTANCE_SCRIPTS);
const SESSION_PARAMETERS = '{"command":["echo lab03-session"]}';
const paramsOf = (script: string): string => `{"commands":["${script}"]}`;
const commandIdOf = (id: string): string => `cmd-${id}`;

/** The status a healthy instance check ends with. */
const HEALTHY_STATUS: Record<string, string> = {
  'run-command': 'Success',
  'internet-through-nat': 'Success',
  's3-through-endpoint': 'Success',
  'instance-upload': 'Success',
  'other-bucket-denied': 'Failed',
};

/** What the reader sees when the check fails on its own wrong answer, per check, for "never terminal". */
const GIVE_UP_LINE: Record<string, string> = {
  'run-command': 'FAIL: run-command: Run Command did not reach the instance',
  'internet-through-nat': 'FAIL: internet-through-nat: the instance could not reach the internet',
  's3-through-endpoint': 'FAIL: s3-through-endpoint: the read failed',
  'instance-upload': 'FAIL: instance-upload: the upload through the endpoint failed',
  'other-bucket-denied': 'FAIL: other-bucket-denied: could not ask AWS',
};

// ---- Policies, as jsonencode writes them (compact, keys sorted) ------------------------------------

function endpointPolicy(resources: string[] = [DATA_ARN, `${DATA_ARN}/*`]): string {
  return JSON.stringify({
    Statement: [
      {
        Action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'],
        Effect: 'Allow',
        Principal: '*',
        Resource: resources,
        Sid: 'OnlyTheLabDataBucket',
      },
    ],
    Version: '2012-10-17',
  });
}

/** The healthy endpoint policy plus a second statement that allows every resource. */
function endpointPolicyAllowingAll(): string {
  const policy = JSON.parse(endpointPolicy()) as { Statement: unknown[] };
  policy.Statement.push({
    Action: 's3:GetObject',
    Effect: 'Allow',
    Principal: '*',
    Resource: '*',
    Sid: 'Everything',
  });
  return JSON.stringify(policy);
}

function dataPolicy(): string {
  return JSON.stringify({
    Statement: [
      {
        Action: 's3:*',
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        Effect: 'Deny',
        Principal: '*',
        Resource: [DATA_ARN, `${DATA_ARN}/*`],
        Sid: 'DenyInsecureTransport',
      },
      {
        Action: 's3:GetObject',
        Condition: { StringNotEquals: { 'aws:SourceVpce': VPCE } },
        Effect: 'Deny',
        Principal: '*',
        Resource: `${DATA_ARN}/endpoint-only/*`,
        Sid: 'DenyReadOutsideEndpoint',
      },
    ],
    Version: '2012-10-17',
  });
}

const dataPolicyWith = (from: string, to: string): string => dataPolicy().replaceAll(from, to);

/** The same JSON with spaces and line ends around the colons and commas (a pretty printed policy). */
const spaced = (policy: string): string => policy.replace(/":"/g, '" : "').replace(/,"/g, ',\n  "');
const lined = (policy: string): string =>
  policy.replace(/":"/g, '"\n:\n"').replace(/,"/g, '\n,\n"');
const pretty = (policy: string): string => JSON.stringify(JSON.parse(policy), null, 2);

// ---- Replies --------------------------------------------------------------------------------------

/** What a stub answers. `quiet`: no stdout at all (not even the line end). */
interface Reply {
  out: string;
  exit: number;
  err: string;
  quiet: boolean;
  /** For a download only: the exact content of the out file (default: the probe text). */
  file?: string;
}

const ok = (out: string): Reply => ({ out, exit: 0, err: '', quiet: false });
const failing = (exit: number, err: string): Reply => ({ out: '', exit, err, quiet: true });

const IAM_USER = `arn:aws:sts::${ACCT}:assumed-role/AWSReservedSSO_admin_0123456789abcdef/me`;

/** S3's same-account AccessDenied when a bucket policy denies the request (the laptop's identity). */
const bucketPolicyDenied = (): Reply =>
  failing(
    254,
    `An error occurred (AccessDenied) when calling the GetObject operation: User: ${IAM_USER} is not authorized to perform: s3:GetObject on resource: "${DATA_ARN}/${PROBE_KEY}" with an explicit deny in a resource-based policy ${STUB_ERR}`,
  );

/** AccessDenied that does not come from the bucket policy. */
const identityDenied = (): Reply =>
  failing(
    254,
    `An error occurred (AccessDenied) when calling the GetObject operation: User: ${IAM_USER} is not authorized to perform: s3:GetObject on resource: "${DATA_ARN}/${PROBE_KEY}" because no identity-based policy allows the s3:GetObject action ${STUB_ERR}`,
  );

/** What the instance's stderr holds (StandardErrorContent) when its read is refused. */
const ON_INSTANCE_USER = `arn:aws:sts::${ACCT}:assumed-role/fg-lab03-instance/${INST}`;
const IMPLICIT_ENDPOINT_DENY = `An error occurred (AccessDenied) when calling the GetObject operation: User: ${ON_INSTANCE_USER} is not authorized to perform: s3:GetObject on resource: "${OTHER_ARN}/${OTHER_KEY}" because no VPC endpoint policy allows the s3:GetObject action ${INSTANCE_ERR_MARK}`;
const EXPLICIT_ENDPOINT_DENY = `An error occurred (AccessDenied) when calling the GetObject operation: User: ${ON_INSTANCE_USER} is not authorized to perform: s3:GetObject on resource: "${OTHER_ARN}/${OTHER_KEY}" with an explicit deny in a VPC endpoint policy ${INSTANCE_ERR_MARK}`;
const INSTANCE_NO_IDENTITY_ALLOW = `An error occurred (AccessDenied) when calling the GetObject operation: User: ${ON_INSTANCE_USER} is not authorized to perform: s3:GetObject on resource: "${OTHER_ARN}/${OTHER_KEY}" because no identity-based policy allows the s3:GetObject action ${INSTANCE_ERR_MARK}`;
const INSTANCE_BUCKET_POLICY_DENY = `An error occurred (AccessDenied) when calling the GetObject operation: User: ${ON_INSTANCE_USER} is not authorized to perform: s3:GetObject on resource: "${DATA_ARN}/${PROBE_KEY}" with an explicit deny in a resource-based policy ${INSTANCE_ERR_MARK}`;
const INSTANCE_TIMEOUT = `Connect timeout on endpoint URL: "https://s3.us-east-1.amazonaws.com/" ${INSTANCE_ERR_MARK}`;

// ---- The aws calls of the spec tables -------------------------------------------------------------

/** `describe-route-tables` answers {"RouteTables": [{"Routes": [...]}]}: a query starts at the table. */
const ROUTE_QUERY_ROOT = 'RouteTables[0].Routes';

const describeRouteTable = (table: string, query: string): string[] => {
  if (!query.startsWith(ROUTE_QUERY_ROOT)) {
    throw new Error(`a describe-route-tables query must start with ${ROUTE_QUERY_ROOT}: ${query}`);
  }
  return [
    'ec2',
    'describe-route-tables',
    '--route-table-ids',
    table,
    '--query',
    query,
    '--output',
    'text',
  ];
};

const describeEndpoint = (query: string): string[] => [
  'ec2',
  'describe-vpc-endpoints',
  '--vpc-endpoint-ids',
  VPCE,
  '--query',
  query,
  '--output',
  'text',
];

const publicAccess = (bucket: string): string[] => [
  's3api',
  'get-public-access-block',
  '--bucket',
  bucket,
  '--query',
  'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]',
  '--output',
  'text',
];

const simulate = (actions: string[], resources: string[], query: string): string[] => [
  'iam',
  'simulate-principal-policy',
  '--policy-source-arn',
  ROLE,
  '--action-names',
  ...actions,
  ...(resources.length > 0 ? ['--resource-arns', ...resources] : []),
  '--query',
  query,
  '--output',
  'text',
];

const getRole = (query: string): string[] => [
  'iam',
  'get-role',
  '--role-name',
  'fg-lab03-instance',
  '--query',
  query,
  '--output',
  'text',
];

const putObject = (bucket: string, key: string): string[] => [
  's3api',
  'put-object',
  '--bucket',
  bucket,
  '--key',
  key,
  '--body',
  BODY,
];

const getObject = (bucket: string, key: string): string[] => [
  's3api',
  'get-object',
  '--bucket',
  bucket,
  '--key',
  key,
  OUT,
];

const IDENTITY = ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'];

const PREFIX_LISTS = [
  'ec2',
  'describe-managed-prefix-lists',
  '--filters',
  `Name=prefix-list-name,Values=${SERVICE}`,
  '--query',
  'PrefixLists[0].PrefixListId',
  '--output',
  'text',
];

const ASSUME_ACTIONS = [
  'ssm:UpdateInstanceInformation',
  'ssmmessages:CreateControlChannel',
  'ssmmessages:CreateDataChannel',
  'ssmmessages:OpenControlChannel',
  'ssmmessages:OpenDataChannel',
  'ec2messages:GetMessages',
];

/** One aws call of the spec tables. */
interface Call {
  /** Unique name of the call. */
  call: string;
  /** The check (stdout id) that makes it. */
  id: string;
  argv: string[];
  /** The n-th call gets the n-th reply; the last one repeats. */
  replies: Reply[];
  /** The stub writes the out file of a download. */
  kind?: 'download';
}

function call(name: string, id: string, argv: string[], ...replies: Reply[]): Call {
  return { call: name, id, argv, replies };
}

/** The four calls of `on_instance <id>` when the first poll answers a terminal status. */
function onInstance(id: string, status: Reply[], stdout: Reply, stderr: Reply): Call[] {
  const cmd = commandIdOf(id);
  const invocation = (query: string): string[] => [
    'ssm',
    'get-command-invocation',
    '--command-id',
    cmd,
    '--instance-id',
    INST,
    '--query',
    query,
    '--output',
    'text',
  ];
  return [
    call(
      `${id}:send`,
      id,
      [
        'ssm',
        'send-command',
        '--instance-ids',
        INST,
        '--document-name',
        'AWS-RunShellScript',
        '--parameters',
        paramsOf(INSTANCE_SCRIPTS[id] ?? ''),
        '--query',
        'Command.CommandId',
        '--output',
        'text',
      ],
      ok(cmd),
    ),
    call(`${id}:status`, id, invocation('Status'), ...status),
    call(`${id}:stdout`, id, invocation('StandardOutputContent'), stdout),
    call(`${id}:stderr`, id, invocation('StandardErrorContent'), stderr),
  ];
}

/** Every aws call of the spec, in the order of the tables. `<body>` and `<out>` stand for temp files. */
function calls(): Call[] {
  return [
    call(
      'vpc-dns',
      'vpc-dns',
      [
        'ec2',
        'describe-vpc-attribute',
        '--vpc-id',
        VPC,
        '--attribute',
        'enableDnsSupport',
        '--query',
        'EnableDnsSupport.Value',
        '--output',
        'text',
      ],
      ok('True'),
    ),
    call(
      'public-route',
      'public-route',
      describeRouteTable(
        PUB_RT,
        "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].[GatewayId,State]",
      ),
      ok(`${IGW}\tactive`),
    ),
    call(
      'private-nat-route',
      'private-nat-route',
      describeRouteTable(
        PRIV_RT,
        "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].[NatGatewayId,State]",
      ),
      ok(`${NAT}\tactive`),
    ),
    call(
      'private-no-igw',
      'private-no-igw',
      describeRouteTable(PRIV_RT, 'RouteTables[0].Routes[].GatewayId'),
      ok(`local\tNone\t${VPCE}`),
    ),
    call('private-endpoint-prefix-list', 'private-endpoint-route', PREFIX_LISTS, ok(PL)),
    call(
      'private-endpoint-route',
      'private-endpoint-route',
      describeRouteTable(
        PRIV_RT,
        `RouteTables[0].Routes[?GatewayId=='${VPCE}'].[DestinationPrefixListId,State]`,
      ),
      ok(`${PL}\tactive`),
    ),
    call(
      'nat-gateway',
      'nat-gateway',
      [
        'ec2',
        'describe-nat-gateways',
        '--nat-gateway-ids',
        NAT,
        '--query',
        'NatGateways[0].[State,ConnectivityType,NatGatewayAddresses[0].PublicIp]',
        '--output',
        'text',
      ],
      ok(`available\tpublic\t${NAT_IP}`),
    ),
    call(
      's3-endpoint',
      's3-endpoint',
      describeEndpoint('VpcEndpoints[0].[State,VpcEndpointType,ServiceName]'),
      ok(`available\tGateway\t${SERVICE}`),
    ),
    call(
      's3-endpoint-policy',
      's3-endpoint-policy',
      describeEndpoint('VpcEndpoints[0].PolicyDocument'),
      ok(endpointPolicy()),
    ),
    call(
      'instance-private',
      'instance-private',
      [
        'ec2',
        'describe-instances',
        '--instance-ids',
        INST,
        '--query',
        'Reservations[0].Instances[0].[State.Name,PublicIpAddress,KeyName,MetadataOptions.HttpTokens]',
        '--output',
        'text',
      ],
      ok('running\tNone\tNone\trequired'),
    ),
    call(
      'instance-no-inbound',
      'instance-no-inbound',
      [
        'ec2',
        'describe-security-group-rules',
        '--filters',
        `Name=group-id,Values=${SG}`,
        '--query',
        'SecurityGroupRules[?IsEgress==`false`].SecurityGroupRuleId',
        '--output',
        'text',
      ],
      ok(''),
    ),
    call(
      'instance-role',
      'instance-role',
      getRole('Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]'),
      ok(`/lab/\t${BOUNDARY}`),
    ),
    call(
      'instance-ssm-policy',
      'instance-ssm-policy',
      [
        'iam',
        'list-attached-role-policies',
        '--role-name',
        'fg-lab03-instance',
        '--query',
        'AttachedPolicies[].PolicyArn',
        '--output',
        'text',
      ],
      ok(SSM_POLICY),
    ),
    call(
      'role-may-use-ssm',
      'role-may-use-ssm',
      simulate(ASSUME_ACTIONS, [], 'EvaluationResults[].EvalDecision'),
      ok(ASSUME_ACTIONS.map(() => 'allowed').join('\t')),
    ),
    call(
      'role-may-read-other',
      'role-may-read-other',
      simulate(
        ['s3:GetObject'],
        [`${OTHER_ARN}/${OTHER_KEY}`],
        'EvaluationResults[0].EvalDecision',
      ),
      ok('allowed'),
    ),
    call('buckets-private', 'buckets-private', publicAccess(DATA), ok('True\tTrue\tTrue\tTrue')),
    call(
      'buckets-private-other',
      'buckets-private',
      publicAccess(OTHER),
      ok('True\tTrue\tTrue\tTrue'),
    ),
    call(
      'data-bucket-policy',
      'data-bucket-policy',
      ['s3api', 'get-bucket-policy', '--bucket', DATA, '--query', 'Policy', '--output', 'text'],
      ok(dataPolicy()),
    ),
    call(
      'instance-online',
      'instance-online',
      [
        'ssm',
        'describe-instance-information',
        '--filters',
        `Key=InstanceIds,Values=${INST}`,
        '--query',
        'InstanceInformationList[0].PingStatus',
        '--output',
        'text',
      ],
      ok('Online'),
    ),
    // ---- the live checks -------------------------------------------------------------------------
    ...onInstance('run-command', [ok('Success')], ok('lab03-run-command'), ok('')),
    call(
      'session-manager',
      'session-manager',
      [
        'ssm',
        'start-session',
        '--target',
        INST,
        '--document-name',
        'AWS-StartNonInteractiveCommand',
        '--parameters',
        SESSION_PARAMETERS,
      ],
      ok('Starting session\nlab03-session\nExiting session'),
    ),
    call('probe-objects', 'probe-objects', putObject(DATA, PROBE_KEY), ok('')),
    call('probe-objects-other', 'probe-objects', putObject(OTHER, OTHER_KEY), ok('')),
    ...onInstance('internet-through-nat', [ok('Success')], ok(NAT_IP), ok('')),
    ...onInstance('s3-through-endpoint', [ok('Success')], ok(BODY_TEXT), ok('')),
    ...onInstance('instance-upload', [ok('Success')], ok(''), ok('')),
    ...onInstance('other-bucket-denied', [ok('Failed')], ok(''), ok(IMPLICIT_ENDPOINT_DENY)),
    {
      ...call(
        'outside-read-denied',
        'outside-read-denied',
        getObject(DATA, PROBE_KEY),
        bucketPolicyDenied(),
      ),
      kind: 'download',
    },
    {
      ...call('outside-other-read', 'outside-other-read', getObject(OTHER, OTHER_KEY), ok('')),
      kind: 'download',
    },
  ];
}

const READ_CALL_COUNT = calls().findIndex((entry) => entry.call === 'run-command:send');
const READ_CALLS: string[] = calls()
  .slice(0, READ_CALL_COUNT)
  .map((entry) => entry.call);
const ALL_CALLS: string[] = calls().map((entry) => entry.call);

function callOf(name: string): Call {
  const found = calls().find((candidate) => candidate.call === name);
  if (found === undefined) throw new Error(`no call ${name}`);
  return found;
}

/**
 * The options the stub answers by, as `name=value` pairs; the shell in AWS_PRELUDE builds the same
 * string. Options are matched by name wherever they stand, so the order of the arguments is free. For
 * `--action-names` only the first value counts.
 */
const SIGNATURE_OPTIONS: [string, string][] = [
  ['--query', 'q'],
  ['--vpc-id', 'vpc'],
  ['--attribute', 'attr'],
  ['--route-table-ids', 'rt'],
  ['--filters', 'flt'],
  ['--nat-gateway-ids', 'nat'],
  ['--vpc-endpoint-ids', 'vpce'],
  ['--instance-ids', 'insts'],
  ['--instance-id', 'inst'],
  ['--role-name', 'rn'],
  ['--policy-source-arn', 'sarn'],
  ['--action-names', 'act'],
  ['--resource-arns', 'res'],
  ['--bucket', 'bk'],
  ['--key', 'obj'],
  ['--command-id', 'cmd'],
  ['--parameters', 'par'],
  ['--target', 'tgt'],
  ['--document-name', 'doc'],
];

function signature(argv: string[]): string {
  const value = new Map<string, string>(SIGNATURE_OPTIONS.map(([option]) => [option, '']));
  let previous = '';
  for (const argument of argv) {
    if (value.has(previous)) value.set(previous, argument);
    previous = argument;
  }
  return [
    `${argv[0]} ${argv[1]}`,
    ...SIGNATURE_OPTIONS.map(([option, name]) => `${name}=${value.get(option) ?? ''}`),
  ].join('|');
}

/** The one argument that is neither an option nor the value of an option (the out file). */
function positionalIndex(argv: string[]): number {
  for (let i = 2; i < argv.length; i += 1) {
    const argument = argv[i] ?? '';
    const previous = argv[i - 1] ?? '';
    if (!argument.startsWith('--') && !previous.startsWith('--')) return i;
  }
  return -1;
}

/** The argv with the temp files replaced by `<body>` and `<out>`. */
function normalize(argv: string[]): string[] {
  const copy = [...argv];
  if (copy[1] === 'put-object') {
    const at = copy.indexOf('--body');
    if (at !== -1 && at + 1 < copy.length) copy[at + 1] = BODY;
  }
  if (copy[1] === 'get-object') {
    const at = positionalIndex(copy);
    if (at !== -1) copy[at] = OUT;
  }
  return copy;
}

// ---- Fixtures -------------------------------------------------------------------------------------

interface Fixture {
  /** aws replies by call name. */
  replies: Record<string, Reply[]>;
  /** terraform replies by output name. */
  outputs: Record<string, Reply>;
  /** The reply of `aws sts get-caller-identity`. */
  identity: Reply;
  awsEol: string;
  tfEol: string;
}

function healthy(): Fixture {
  const replies: Record<string, Reply[]> = {};
  for (const entry of calls()) replies[entry.call] = entry.replies;
  const outputs: Record<string, Reply> = {};
  for (const name of OUTPUT_NAMES) outputs[name] = ok(OUTPUT_VALUES[name]);
  return { replies, outputs, identity: ok(ACCT), awsEol: '\n', tfEol: '' };
}

/** A healthy fixture where the answers of one call are replaced. */
function answering(name: string, ...replies: Reply[]): Fixture {
  if (!ALL_CALLS.includes(name)) throw new Error(`no call ${name}`);
  const fixture = healthy();
  fixture.replies[name] = replies;
  return fixture;
}

interface InstanceResult {
  /** The status answers of the polls: a word, or a list of replies (the last one repeats). */
  status: string | Reply[];
  stdout?: string;
  stderr?: string;
}

/** A healthy fixture where `on_instance <id>` ends as `result` says. */
function instanceEnding(id: string, result: InstanceResult): Fixture {
  const fixture = healthy();
  fixture.replies[`${id}:status`] =
    typeof result.status === 'string' ? [ok(result.status)] : result.status;
  fixture.replies[`${id}:stdout`] = [ok(result.stdout ?? '')];
  fixture.replies[`${id}:stderr`] = [ok(result.stderr ?? '')];
  return fixture;
}

// ---- Stub binaries and the runner -----------------------------------------------------------------

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

/** Shebang of the stubs: absolute, so that they run with a PATH that holds no system directory. */
function stubShebang(): string {
  return process.platform === 'win32' ? '/usr/bin/bash' : bashPath();
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface Rule {
  key: string;
  replies: Reply[];
  eol: string;
  kind?: 'download';
}

/** The shell lines that answer with one reply. */
function replyLines(
  dir: string,
  file: string,
  reply: Reply,
  eol: string,
  kind?: 'download',
): string[] {
  writeFileSync(join(dir, `${file}.out`), reply.quiet ? '' : reply.out + eol);
  if (reply.err !== '') writeFileSync(join(dir, `${file}.err`), reply.err + eol);
  const lines: string[] = [];
  if (kind === 'download' && reply.exit === 0) {
    writeFileSync(join(dir, `${file}.file`), reply.file ?? BODY_TEXT);
    lines.push(`cat "$D/${file}.file" > "$pos"`);
  }
  lines.push(`cat "$D/${file}.out"`);
  lines.push(reply.err !== '' ? `cat "$D/${file}.err" >&2` : ':');
  lines.push(`exit ${reply.exit}`);
  return lines;
}

function ruleBody(dir: string, name: string, rule: Rule): string {
  if (rule.replies.length === 1) {
    return replyLines(dir, name, rule.replies[0] ?? ok(''), rule.eol, rule.kind).join('\n    ');
  }
  const counter = `$FAKE_LOG_DIR/count-${name}`;
  const branches = rule.replies.map((reply, index) => {
    const pattern = index === rule.replies.length - 1 ? '*' : String(index);
    const body = replyLines(dir, `${name}-${index}`, reply, rule.eol, rule.kind).join('\n        ');
    return `      ${pattern})\n        ${body};;`;
  });
  return [
    `n=0; if [ -f "${counter}" ]; then n=$(cat "${counter}"); fi`,
    `echo $((n + 1)) > "${counter}"`,
    'case $n in',
    ...branches,
    '    esac',
  ].join('\n    ');
}

function stubScript(
  name: string,
  prelude: string,
  keyExpression: string,
  rules: Rule[],
  rulesDir: string,
): string {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (keys.has(rule.key)) throw new Error(`two stub rules answer the same call: ${rule.key}`);
    keys.add(rule.key);
  }
  const cases = rules
    .map(
      (rule, index) => `  ${sq(rule.key)})\n    ${ruleBody(rulesDir, `${name}-${index}`, rule)};;`,
    )
    .join('\n');
  return `#!${stubShebang()}
{ printf '%s' ${name}; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG_DIR/calls.log"
D="$FAKE_LOG_DIR/rules"
${prelude}
case ${keyExpression} in
${cases}
  *)
    printf '%s\\n' "${name} $*" >> "$FAKE_LOG_DIR/unexpected.log"
    exit 97;;
esac
`;
}

/**
 * Logs the call's environment, then builds $key (the same string as signature()), $bodyfile and $pos.
 * The standard input is looked at for `ssm start-session` only: it costs a fraction of a second.
 */
const AWS_PRELUDE = `if [ "$1 $2" = "ssm start-session" ]; then
  if read -r -t 0.3 _l 2>/dev/null; then si=data; else rc=$?; if [ "$rc" -gt 128 ]; then si=open; else si=eof; fi; fi
else
  si=n/a
fi
printf '%s|%s|%s|%s|%s\\n' "\${MSYS_NO_PATHCONV-<unset>}" "\${AWS_REGION-<unset>}" "\${AWS_DEFAULT_REGION-<unset>}" "\${AWS_PAGER-<unset>}" "$si" >> "$FAKE_LOG_DIR/aws-env.log"
${SIGNATURE_OPTIONS.map((_option, index) => `v${index}=''`).join('; ')}
bodyfile=''; pos=''
p=''
for a in "$@"; do
  case "$p" in
${SIGNATURE_OPTIONS.map(([option], index) => `    ${option}) v${index}="$a";;`).join('\n')}
    --body) bodyfile="$a";;
  esac
  case "$a" in
    --*) ;;
    *) case "$p" in --*) ;; *) pos="$a";; esac;;
  esac
  p="$a"
done
if [ -n "$bodyfile" ] && [ -f "$bodyfile" ]; then
  n=$(( $(wc -l < "$FAKE_LOG_DIR/calls.log") ))
  cat "$bodyfile" > "$FAKE_LOG_DIR/body-$n"
fi
if [ "$1 $2" = "ec2 describe-route-tables" ]; then
  case "$v0" in
    'RouteTables[0].Routes'*) ;;
    *) echo None; exit 0;;
  esac
fi
key="$1 $2${SIGNATURE_OPTIONS.map(([, name], index) => `|${name}=$v${index}`).join('')}"`;

const TOOLS = ['terraform', 'aws'] as const;
type Tool = (typeof TOOLS)[number];

function writeStubs(
  fixture: Fixture,
  bin: string,
  rulesDir: string,
  tools: readonly Tool[],
  plugin: boolean,
): void {
  const terraformRules: Rule[] = OUTPUT_NAMES.map((name) => ({
    key: `output -raw ${name}`,
    replies: [fixture.outputs[name] ?? ok('')],
    eol: fixture.tfEol,
  }));
  const awsRules: Rule[] = [
    { key: signature(IDENTITY), replies: [fixture.identity], eol: fixture.awsEol },
    ...calls().map((entry) => ({
      key: signature(entry.argv),
      replies: fixture.replies[entry.call] ?? [ok('')],
      eol: fixture.awsEol,
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    })),
  ];
  const scripts: Record<Tool, string> = {
    terraform: stubScript('terraform', '', '"$1 $2 $3"', terraformRules, rulesDir),
    aws: stubScript('aws', AWS_PRELUDE, '"$key"', awsRules, rulesDir),
  };
  for (const tool of tools) writeFileSync(join(bin, tool), scripts[tool], { mode: 0o755 });
  // A sleep that does not sleep: it only logs its arguments.
  writeFileSync(
    join(bin, 'sleep'),
    `#!${stubShebang()}\necho "sleep $*" >> "$FAKE_LOG_DIR/sleep.log"\nexit 0\n`,
    { mode: 0o755 },
  );
  if (plugin) {
    writeFileSync(join(bin, 'session-manager-plugin'), `#!${stubShebang()}\nexit 0\n`, {
      mode: 0o755,
    });
  }
}

interface RunOptions {
  args?: string[];
  extraEnv?: Record<string, string>;
  /** Stubs that exist (default: both). */
  tools?: readonly Tool[];
  /** PATH holds only the stub directory (no system directories). */
  strictPath?: boolean;
  /** A session-manager-plugin is on PATH (default: yes). */
  plugin?: boolean;
  /** VERIFY_POLL_SECONDS: a value, or null for "not set" (default: "0"). */
  poll?: string | null;
  label?: string;
}

/** One aws call: its arguments (after `aws`) and the environment it saw. */
interface AwsRun {
  argv: string[];
  msys: string;
  region: string;
  defaultRegion: string;
  pager: string;
  /** For start-session: `eof` (redirected from /dev/null), `open` or `data`; `n/a` for the others. */
  stdin: string;
  /** The content of the --body file when the call started, if the call has one. */
  body: string | undefined;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together. */
  all: string;
  /** Every terraform and aws call: [name, ...arguments]. */
  calls: string[][];
  /** Every aws call with the environment it saw. */
  aws: AwsRun[];
  /** The arguments of every sleep call. */
  sleeps: string[];
  /** Calls a stub had no answer for. */
  unexpected: string[];
  /** Files still in the run's TMPDIR, and body / out files of the argv that still exist. */
  leftovers: string[];
}

const RUNS: { label: string; assume: boolean; result: RunResult }[] = [];

function scriptPath(): string {
  const path = repoPath(...LAB, 'verify.sh');
  if (!existsSync(path)) throw new Error('missing file: labs/03-nat-vs-gateway-endpoint/verify.sh');
  return slash(path);
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '');
}

function execBash(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    // Standard input is an open pipe that never gets data (see the top of the file).
    const child = spawn(bashPath(), args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => undefined);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('verify.sh did not finish within 150 s'));
    }, 150_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      done({ status: code, stdout, stderr });
    });
  });
}

function parseAws(callLines: string[][], envLines: string[], logs: string): AwsRun[] {
  const runs: AwsRun[] = [];
  let index = 0;
  callLines.forEach((line, lineIndex) => {
    if (line[0] !== 'aws') return;
    const [msys = '', region = '', defaultRegion = '', pager = '', stdin = ''] = (
      envLines[index] ?? ''
    ).split('|');
    const bodyFile = join(logs, `body-${lineIndex + 1}`);
    runs.push({
      argv: line.slice(1),
      msys,
      region,
      defaultRegion,
      pager,
      stdin,
      body: existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : undefined,
    });
    index += 1;
  });
  return runs;
}

/** True when `path` still exists, asked of bash (the paths of the argv are bash paths). */
function stillThere(path: string): boolean {
  const probe = spawnSync(bashPath(), ['-c', 'test -e "$1"', 'probe', path], { windowsHide: true });
  return probe.status === 0;
}

/** The directories of a PATH that hold a session-manager-plugin of the machine. */
function holdsPlugin(directory: string): boolean {
  return (
    existsSync(join(directory, 'session-manager-plugin')) ||
    existsSync(join(directory, 'session-manager-plugin.exe'))
  );
}

async function runVerify(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab03-verify-'));
  try {
    const work = join(dir, 'work');
    const logs = join(dir, 'logs');
    const bin = join(dir, 'bin');
    const rules = join(logs, 'rules');
    const temp = join(dir, 'tmp');
    mkdirSync(work);
    mkdirSync(logs);
    mkdirSync(bin);
    mkdirSync(rules);
    mkdirSync(temp);
    const plugin = options.plugin ?? true;
    writeStubs(fixture, bin, rules, options.tools ?? TOOLS, plugin);

    const env: NodeJS.ProcessEnv = { ...process.env };
    let originalPath = '';
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') {
        originalPath = env[key] ?? '';
        delete env[key];
      } else if (
        key.startsWith('GIT_') ||
        key.startsWith('AWS_') ||
        key.startsWith('VERIFY_') ||
        key === 'MSYS_NO_PATHCONV' ||
        key === 'SHELLOPTS' ||
        key === 'BASH_ENV'
      ) {
        delete env[key];
      }
    }
    // The "no plugin" case must not find the plugin of the machine either.
    const systemPath = originalPath
      .split(delimiter)
      .filter((entry) => entry !== '' && (plugin || !holdsPlugin(entry)))
      .join(delimiter);
    env['PATH'] = options.strictPath === true ? bin : `${bin}${delimiter}${systemPath}`;
    env['FAKE_LOG_DIR'] = slash(logs);
    env['TMPDIR'] = slash(temp);
    const poll = options.poll === undefined ? '0' : options.poll;
    if (poll !== null) env['VERIFY_POLL_SECONDS'] = poll;
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    const done = await execBash([script, ...(options.args ?? [])], work, env);
    const callLines = readLines(join(logs, 'calls.log')).map((line) => line.split('\t'));
    const aws = parseAws(callLines, readLines(join(logs, 'aws-env.log')), logs);
    const files = aws.flatMap((run) => {
      const body =
        run.argv[1] === 'put-object' ? run.argv[run.argv.indexOf('--body') + 1] : undefined;
      const out = run.argv[1] === 'get-object' ? run.argv[positionalIndex(run.argv)] : undefined;
      return [body, out].filter((path): path is string => path !== undefined && path !== '');
    });
    const leftovers = [
      ...readdirSync(temp).map((name) => `TMPDIR/${name}`),
      ...[...new Set(files)].filter(stillThere),
    ];
    const result: RunResult = {
      status: done.status,
      stdout: done.stdout,
      stderr: done.stderr,
      all: done.stdout + done.stderr,
      calls: callLines,
      aws,
      sleeps: readLines(join(logs, 'sleep.log')).map((line) => line.replace(/^sleep /, '')),
      unexpected: readLines(join(logs, 'unexpected.log')),
      leftovers,
    };
    RUNS.push({
      label: options.label ?? 'unnamed run',
      assume: env['VERIFY_ASSUME'] === '1',
      result,
    });
    return result;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp dir must not fail a test.
    }
  }
}

const LIVE_ENV = { VERIFY_ASSUME: '1' };

// ---- Assertions on a run --------------------------------------------------------------------------

function outLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

interface Mode {
  /** VERIFY_ASSUME=1: the live checks run. */
  live?: boolean;
}

/** An exact line, or `true` for "FAIL: <id>: <some reason>". */
type Expected = string | true;

/**
 * The stdout of a run: one line per check in table order, then the summary. `lines` replaces the
 * default line of a check; the summary and the exit code follow from the lines.
 */
function expectRun(result: RunResult, mode: Mode = {}, lines: Record<string, Expected> = {}): void {
  const actual = outLines(result.stdout);
  const expected: string[] = [];
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  ORDER.forEach((id, index) => {
    const wanted = lines[id];
    let line: string;
    if (wanted === true) {
      line = actual[index] ?? '';
      expect(line).toMatch(new RegExp(`^FAIL: ${id}: \\S`));
    } else if (wanted !== undefined) {
      line = wanted;
    } else if (LIVE_IDS.includes(id) && mode.live !== true) {
      line = `skip: ${id}: ${SKIP_LIVE}`;
    } else {
      line = `ok: ${id}`;
    }
    if (line.startsWith('ok:')) passed += 1;
    else if (line.startsWith('skip:')) skipped += 1;
    else failed += 1;
    expected.push(line);
  });
  expected.push(
    failed === 0
      ? `verify: ok (${passed} passed, ${skipped} skipped)`
      : `verify: FAIL (${failed} failed, ${passed} passed, ${skipped} skipped)`,
  );
  expect(actual).toEqual(expected);
  expect(result.status).toBe(failed === 0 ? 0 : 1);
  expect(result.unexpected, 'a stub was called in a way the test has no answer for').toEqual([]);
}

const IDENTITY_SIGNATURE = signature(IDENTITY);
const isIdentity = (run: AwsRun): boolean => signature(run.argv) === IDENTITY_SIGNATURE;

/** Every aws call except the one that asks for the account ID. */
const checkRuns = (result: RunResult): AwsRun[] => result.aws.filter((run) => !isIdentity(run));

/** The calls of the run that ask what the named call asks. */
function runsOf(result: RunResult, name: string): AwsRun[] {
  const wanted = signature(callOf(name).argv);
  return result.aws.filter((run) => signature(run.argv) === wanted);
}

const isOp = (run: AwsRun, service: string, operation: string): boolean =>
  run.argv[0] === service && run.argv[1] === operation;

const opRuns = (result: RunResult, service: string, operation: string): AwsRun[] =>
  result.aws.filter((run) => isOp(run, service, operation));

/** Lines a run that went on would print. */
const verdictLines = (stdout: string): string[] =>
  outLines(stdout).filter((line) => /^(ok|FAIL|skip|verify):/.test(line));

function leaks(text: string): string[] {
  const found: string[] = [];
  if (/\d{12}/.test(text)) found.push('a 12-digit number');
  if (/(?<![A-Za-z0-9])(?:vpc|rtb|nat|vpce|igw|i|sg|sgr|pl)-[0-9a-f]{8,}/.test(text)) {
    found.push('a resource ID');
  }
  for (const needle of [
    'arn:',
    DATA,
    OTHER,
    'field-guide-lab03',
    VPC,
    PUB_RT,
    PRIV_RT,
    IGW,
    NAT,
    VPCE,
    INST,
    SG,
    PL,
    NAT_IP,
    OTHER_IP,
    'cmd-',
    STUB_ERR,
    INSTANCE_OUT_MARK,
    INSTANCE_ERR_MARK,
  ]) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

/** The expected lines of a run where the checks run after `reason` is set are skipped. */
const skipLines = (ids: string[], reason: string): Record<string, string> =>
  Object.fromEntries(ids.map((id) => [id, `skip: ${id}: ${reason}`]));

const AFTER_RUN_COMMAND = [
  'internet-through-nat',
  's3-through-endpoint',
  'instance-upload',
  'other-bucket-denied',
];
const AFTER_PROBE_OBJECTS = [
  's3-through-endpoint',
  'other-bucket-denied',
  'outside-read-denied',
  'outside-other-read',
];

// =================================================================================================
// AC-16: healthy, no VERIFY_ASSUME
// =================================================================================================

describe('verify.sh: healthy stack, no live checks', () => {
  const EXPECTED_STDOUT = [
    ...READ_IDS.map((id) => `ok: ${id}`),
    ...LIVE_IDS.map((id) => `skip: ${id}: ${SKIP_LIVE}`),
    'verify: ok (17 passed, 9 skipped)',
  ];

  test.concurrent(
    'AC-16: stdout is the 17 ok lines, the 9 skip lines and the summary',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-16 healthy' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${EXPECTED_STDOUT.join('\n')}\n`);
      expect(result.unexpected).toEqual([]);
    },
  );

  test.concurrent('AC-16: the 17 ok lines come in the order of the spec table', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 order' });
    expectRun(result);
    expect(READ_IDS).toHaveLength(17);
    expect(LIVE_IDS).toHaveLength(9);
  });

  test.concurrent(
    'AC-16: no send-command, start-session, put-object or get-object call is made',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-16 no live call' });
      expect(result.aws.length).toBeGreaterThan(0);
      expect(opRuns(result, 'ssm', 'send-command')).toEqual([]);
      expect(opRuns(result, 'ssm', 'start-session')).toEqual([]);
      expect(opRuns(result, 's3api', 'put-object')).toEqual([]);
      expect(opRuns(result, 's3api', 'get-object')).toEqual([]);
    },
  );

  test.concurrent.each([
    { name: '0', value: '0' },
    { name: 'true', value: 'true' },
    { name: 'empty', value: '' },
  ])('AC-16: VERIFY_ASSUME=$name does not run the live checks', async ({ name, value }) => {
    const result = await runVerify(healthy(), {
      label: `AC-16 VERIFY_ASSUME=${name}`,
      extraEnv: { VERIFY_ASSUME: value },
    });
    expectRun(result);
    expect(opRuns(result, 'ssm', 'send-command')).toEqual([]);
    expect(opRuns(result, 's3api', 'put-object')).toEqual([]);
  });
});

// =================================================================================================
// AC-17: each of checks 1 to 17 fails on its own wrong answer
// =================================================================================================

interface Case {
  name: string;
  /** The call whose answer is replaced. */
  call: string;
  /** The check that must fail. */
  id: string;
  answer: string;
}

const wrong = (name: string, callName: string, id: string, answer: string): Case => ({
  name,
  call: callName,
  id,
  answer,
});

const AC17_CASES: Case[] = [
  wrong('False', 'vpc-dns', 'vpc-dns', 'False'),
  wrong('an empty answer', 'vpc-dns', 'vpc-dns', ''),
  wrong('a NAT target', 'public-route', 'public-route', `${NAT}\tactive`),
  wrong('a blackhole', 'public-route', 'public-route', `${IGW}\tblackhole`),
  wrong('no route', 'public-route', 'public-route', ''),
  wrong('another NAT gateway', 'private-nat-route', 'private-nat-route', `${OTHER_NAT}\tactive`),
  wrong('a blackhole', 'private-nat-route', 'private-nat-route', `${NAT}\tblackhole`),
  wrong('an igw- in the list', 'private-no-igw', 'private-no-igw', `local\t${IGW}\t${VPCE}`),
  wrong(
    'another prefix list',
    'private-endpoint-route',
    'private-endpoint-route',
    `${OTHER_PL}\tactive`,
  ),
  wrong('a blackhole', 'private-endpoint-route', 'private-endpoint-route', `${PL}\tblackhole`),
  wrong('an empty answer', 'private-endpoint-route', 'private-endpoint-route', ''),
  wrong('pending', 'nat-gateway', 'nat-gateway', `pending\tpublic\t${NAT_IP}`),
  wrong('a private NAT gateway', 'nat-gateway', 'nat-gateway', `available\tprivate\t${NAT_IP}`),
  wrong('another IP', 'nat-gateway', 'nat-gateway', `available\tpublic\t${OTHER_IP}`),
  wrong('pending', 's3-endpoint', 's3-endpoint', `pending\tGateway\t${SERVICE}`),
  wrong('an Interface endpoint', 's3-endpoint', 's3-endpoint', `available\tInterface\t${SERVICE}`),
  wrong(
    'another service',
    's3-endpoint',
    's3-endpoint',
    'available\tGateway\tcom.amazonaws.us-east-1.dynamodb',
  ),
  wrong(
    'a stopped instance',
    'instance-private',
    'instance-private',
    'stopped\tNone\tNone\trequired',
  ),
  wrong(
    'a public IP',
    'instance-private',
    'instance-private',
    `running\t${NAT_IP}\tNone\trequired`,
  ),
  wrong('a key name', 'instance-private', 'instance-private', 'running\tNone\tmy-key\trequired'),
  wrong('optional tokens', 'instance-private', 'instance-private', 'running\tNone\tNone\toptional'),
  wrong('a rule ID', 'instance-no-inbound', 'instance-no-inbound', RULE_ID),
  wrong('the default role path', 'instance-role', 'instance-role', `/\t${BOUNDARY}`),
  wrong('no permissions boundary', 'instance-role', 'instance-role', '/lab/\tNone'),
  wrong(
    'another permissions boundary',
    'instance-role',
    'instance-role',
    `/lab/\tarn:aws:iam::${ACCT}:policy/other`,
  ),
  wrong('no attached policy', 'instance-ssm-policy', 'instance-ssm-policy', ''),
  wrong(
    'another policy',
    'instance-ssm-policy',
    'instance-ssm-policy',
    'arn:aws:iam::aws:policy/ReadOnlyAccess',
  ),
  wrong(
    'two policies',
    'instance-ssm-policy',
    'instance-ssm-policy',
    `${SSM_POLICY}\tarn:aws:iam::aws:policy/ReadOnlyAccess`,
  ),
  wrong(
    'five allowed and one implicitDeny',
    'role-may-use-ssm',
    'role-may-use-ssm',
    'allowed\tallowed\tallowed\tallowed\tallowed\timplicitDeny',
  ),
  wrong(
    'only five answers, all allowed',
    'role-may-use-ssm',
    'role-may-use-ssm',
    'allowed\tallowed\tallowed\tallowed\tallowed',
  ),
  wrong('an implicit deny', 'role-may-read-other', 'role-may-read-other', 'implicitDeny'),
  wrong('an explicit deny', 'role-may-read-other', 'role-may-read-other', 'explicitDeny'),
  wrong(
    'one False in the data bucket',
    'buckets-private',
    'buckets-private',
    'True\tTrue\tFalse\tTrue',
  ),
  wrong(
    'the first False in the data bucket',
    'buckets-private',
    'buckets-private',
    'False\tTrue\tTrue\tTrue',
  ),
  wrong(
    'one False in the other bucket',
    'buckets-private-other',
    'buckets-private',
    'True\tFalse\tTrue\tTrue',
  ),
  wrong(
    'the last False in the other bucket',
    'buckets-private-other',
    'buckets-private',
    'True\tTrue\tTrue\tFalse',
  ),
];

const POLICY_CASES: Case[] = [
  ...['DenyInsecureTransport', 'DenyReadOutsideEndpoint'].map((sid) =>
    wrong(
      `the Sid ${sid} missing`,
      'data-bucket-policy',
      'data-bucket-policy',
      dataPolicyWith(`"Sid":"${sid}"`, '"Sid":"Renamed"'),
    ),
  ),
  wrong(
    'no aws:SourceVpce',
    'data-bucket-policy',
    'data-bucket-policy',
    dataPolicyWith('aws:SourceVpce', 'aws:Other'),
  ),
  wrong(
    'another endpoint',
    'data-bucket-policy',
    'data-bucket-policy',
    dataPolicyWith(VPCE, OTHER_VPCE),
  ),
  wrong(
    'a Resource that is not endpoint-only/*',
    'data-bucket-policy',
    'data-bucket-policy',
    dataPolicyWith('/endpoint-only/*', '/*'),
  ),
  wrong(
    'a Null key',
    'data-bucket-policy',
    'data-bucket-policy',
    dataPolicyWith('"StringNotEquals":{', '"Null":{"aws:SourceVpce":"true"},"StringNotEquals":{'),
  ),
  wrong(
    'a StringNotEqualsIfExists operator',
    'data-bucket-policy',
    'data-bucket-policy',
    dataPolicyWith('"StringNotEquals"', '"StringNotEqualsIfExists"'),
  ),
  wrong(
    'the data bucket missing from the endpoint policy',
    's3-endpoint-policy',
    's3-endpoint-policy',
    endpointPolicy([`arn:aws:s3:::someone-else`, `arn:aws:s3:::someone-else/*`]),
  ),
  wrong(
    'the other bucket in the endpoint policy',
    's3-endpoint-policy',
    's3-endpoint-policy',
    endpointPolicy([DATA_ARN, `${DATA_ARN}/*`, OTHER_ARN, `${OTHER_ARN}/*`]),
  ),
  wrong(
    'a statement with "Resource":"*"',
    's3-endpoint-policy',
    's3-endpoint-policy',
    endpointPolicyAllowingAll(),
  ),
  wrong(
    'a statement with "Resource" : "*"',
    's3-endpoint-policy',
    's3-endpoint-policy',
    endpointPolicyAllowingAll().replace('"Resource":"*"', '"Resource" : "*"'),
  ),
];

describe('verify.sh: wrong answers', () => {
  // The policy cases with a reason in the spec are checked, with the reason, further down.
  test.concurrent.each([
    ...AC17_CASES,
    ...POLICY_CASES.filter((entry) => entry.name === 'no aws:SourceVpce'),
  ])('AC-17: $id fails on $name', async ({ name, call: callName, id, answer }) => {
    const result = await runVerify(answering(callName, ok(answer)), {
      label: `AC-17 ${id} ${name}`,
    });
    expectRun(result, {}, { [id]: true });
    expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent.each([
    { name: 'a lower case state', answer: `available\tGateway\t${SERVICE}` },
    { name: 'a capitalized state', answer: `Available\tGateway\t${SERVICE}` },
    { name: 'a lower case type', answer: `available\tgateway\t${SERVICE}` },
    { name: 'an upper case state and type', answer: `AVAILABLE\tGATEWAY\t${SERVICE}` },
  ])('AC-17: s3-endpoint is ok with $name', async ({ name, answer }) => {
    const result = await runVerify(answering('s3-endpoint', ok(answer)), {
      label: `AC-17 s3-endpoint ${name}`,
    });
    expectRun(result);
  });

  test.concurrent(
    'AC-17: instance-no-inbound is ok when the answer has no line at all',
    async () => {
      const quiet: Reply = { out: '', exit: 0, err: '', quiet: true };
      const result = await runVerify(answering('instance-no-inbound', quiet), {
        label: 'AC-17 no inbound quiet',
      });
      expectRun(result);
    },
  );

  test.concurrent(
    'AC-17: private-endpoint-route fails when the prefix list is another well formed one (the route is to the first)',
    async () => {
      const result = await runVerify(answering('private-endpoint-prefix-list', ok(OTHER_PL)), {
        label: 'AC-17 prefix list another',
      });
      expectRun(result, {}, { 'private-endpoint-route': true });
    },
  );

  test.concurrent.each([
    { name: 'an empty answer', answer: '' },
    { name: 'None', answer: 'None' },
    { name: 'text that is not a prefix list ID', answer: 'not-a-prefix-list' },
    { name: 'a prefix list ID with non-hex characters', answer: 'pl-zzzz0000' },
    { name: 'a prefix list ID in upper case', answer: 'PL-63A5400A' },
  ])(
    'AC-17: private-endpoint-route with the prefix list answer $name is "could not ask AWS" and makes no route call',
    async ({ name, answer }) => {
      const result = await runVerify(answering('private-endpoint-prefix-list', ok(answer)), {
        label: `AC-17 prefix list ${name}`,
      });
      expectRun(
        result,
        {},
        { 'private-endpoint-route': 'FAIL: private-endpoint-route: could not ask AWS' },
      );
      expect(runsOf(result, 'private-endpoint-route'), 'a second call after a bad answer').toEqual(
        [],
      );
    },
  );

  test.concurrent.each([
    {
      reason: 'the endpoint policy does not name the data bucket',
      call: 's3-endpoint-policy',
      index: 0,
    },
    { reason: 'the endpoint policy names the other bucket', call: 's3-endpoint-policy', index: 1 },
    { reason: 'the endpoint policy allows every resource', call: 's3-endpoint-policy', index: 2 },
    { reason: 'the endpoint policy allows every resource', call: 's3-endpoint-policy', index: 3 },
  ])('AC-17: s3-endpoint-policy case $index says "$reason"', async ({ reason, index }) => {
    const policyCase = POLICY_CASES.filter((entry) => entry.id === 's3-endpoint-policy')[index];
    expect(policyCase, 'no such case').toBeDefined();
    const result = await runVerify(answering('s3-endpoint-policy', ok(policyCase?.answer ?? '')), {
      label: `AC-17 endpoint policy ${index}`,
    });
    expectRun(result, {}, { 's3-endpoint-policy': `FAIL: s3-endpoint-policy: ${reason}` });
  });

  test.concurrent.each([
    { text: pretty(endpointPolicy()), name: 'pretty printed' },
    { text: spaced(endpointPolicy()), name: 'with spaces around the colons' },
  ])('AC-17: s3-endpoint-policy is ok when the text is $name', async ({ name, text }) => {
    const result = await runVerify(answering('s3-endpoint-policy', ok(text)), {
      label: `AC-17 endpoint policy ${name}`,
    });
    expectRun(result);
  });

  test.concurrent.each([
    ...['DenyInsecureTransport', 'DenyReadOutsideEndpoint'].map((sid) => ({
      name: `the Sid ${sid} missing`,
      text: dataPolicyWith(`"Sid":"${sid}"`, '"Sid":"Renamed"'),
      reason: `the bucket policy lacks ${sid}`,
    })),
    {
      name: 'another endpoint',
      text: dataPolicyWith(VPCE, OTHER_VPCE),
      reason: 'the bucket policy does not name the endpoint',
    },
    {
      name: 'a Resource that is not endpoint-only/*',
      text: dataPolicyWith('/endpoint-only/*', '/*'),
      reason: 'the bucket policy does not limit the deny to endpoint-only/',
    },
    {
      name: 'a Null key',
      text: dataPolicyWith(
        '"StringNotEquals":{',
        '"Null":{"aws:SourceVpce":"true"},"StringNotEquals":{',
      ),
      reason: 'the bucket policy has a Null or IfExists condition',
    },
    {
      name: 'a StringNotEqualsIfExists operator',
      text: dataPolicyWith('"StringNotEquals"', '"StringNotEqualsIfExists"'),
      reason: 'the bucket policy has a Null or IfExists condition',
    },
  ])('AC-17: data-bucket-policy with $name says "$reason"', async ({ name, text, reason }) => {
    const result = await runVerify(answering('data-bucket-policy', ok(text)), {
      label: `AC-17 policy reason ${name}`,
    });
    expectRun(result, {}, { 'data-bucket-policy': `FAIL: data-bucket-policy: ${reason}` });
  });

  test.concurrent.each([
    { name: 'pretty printed', text: pretty(dataPolicy()) },
    { name: 'with spaces around the colons', text: spaced(dataPolicy()) },
    { name: 'with line ends around the colons and commas', text: lined(dataPolicy()) },
    {
      name: 'with a line end before the colon of every Sid',
      text: dataPolicy().replaceAll('"Sid":', '"Sid"\n:'),
    },
  ])('AC-17: data-bucket-policy is ok when the text is $name', async ({ name, text }) => {
    const result = await runVerify(answering('data-bucket-policy', ok(text)), {
      label: `AC-17 policy ${name}`,
    });
    expectRun(result);
  });

  test.concurrent('AC-17: instance-online fails when the answer is never Online', async () => {
    const result = await runVerify(answering('instance-online', ok('ConnectionLost')), {
      label: 'AC-17 instance-online never',
    });
    expectRun(
      result,
      {},
      {
        'instance-online':
          'FAIL: instance-online: the instance did not come online in Systems Manager',
      },
    );
    expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent.each(
    READ_CALLS.filter((name) => name !== 'instance-online').map((name) => ({ name })),
  )('AC-17: $name answering exit 254 gives "could not ask AWS"', async ({ name }) => {
    const id = callOf(name).id;
    const reply = failing(254, `An error occurred (AccessDenied) ${STUB_ERR} ${ROLE}`);
    const result = await runVerify(answering(name, reply), { label: `AC-17 ${name} exit 254` });
    expectRun(result, {}, { [id]: `FAIL: ${id}: could not ask AWS` });
    expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent(
    'AC-17: the prefix list call exiting 254 gives "could not ask AWS" and no route call',
    async () => {
      const result = await runVerify(
        answering('private-endpoint-prefix-list', failing(254, STUB_ERR)),
        { label: 'AC-17 prefix list 254' },
      );
      expectRun(
        result,
        {},
        { 'private-endpoint-route': 'FAIL: private-endpoint-route: could not ask AWS' },
      );
      expect(runsOf(result, 'private-endpoint-route')).toEqual([]);
    },
  );

  test.concurrent(
    'AC-17: instance-online with every call exiting 254 counts them as tries and does not say "could not ask AWS"',
    async () => {
      const result = await runVerify(answering('instance-online', failing(254, STUB_ERR)), {
        label: 'AC-17 instance-online 254',
      });
      expectRun(
        result,
        {},
        {
          'instance-online':
            'FAIL: instance-online: the instance did not come online in Systems Manager',
        },
      );
      expect(runsOf(result, 'instance-online')).toHaveLength(60);
    },
  );
});

// =================================================================================================
// AC-18: the argv of every aws call
// =================================================================================================

describe('verify.sh: the arguments of every aws call', () => {
  const expectedArgv = (names: string[]): string[][] =>
    names.map((name) => normalize(callOf(name).argv));

  const actualArgv = (result: RunResult): string[][] =>
    checkRuns(result).map((run) => normalize(run.argv));

  test.concurrent(
    'AC-18: checks 1 to 17 call aws with the argv of the table, in order',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 default' });
      expect(actualArgv(result)).toEqual(expectedArgv(READ_CALLS));
    },
  );

  test.concurrent(
    'AC-18: the live checks add their calls with the argv of the tables, in order',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 live', extraEnv: LIVE_ENV });
      expect(ALL_CALLS.length).toBeGreaterThan(READ_CALLS.length);
      expect(actualArgv(result)).toEqual(expectedArgv(ALL_CALLS));
    },
  );

  test.concurrent.each(INSTANCE_IDS.map((id) => ({ id })))(
    'AC-18: the --parameters value of the send-command of $id is one argument, byte for byte',
    async ({ id }) => {
      const result = await runVerify(healthy(), {
        label: `AC-18 parameters ${id}`,
        extraEnv: LIVE_ENV,
      });
      const [run] = runsOf(result, `${id}:send`);
      expect(run, `no send-command for ${id}`).toBeDefined();
      const at = (run?.argv ?? []).indexOf('--parameters');
      expect(run?.argv[at + 1]).toBe(paramsOf(INSTANCE_SCRIPTS[id] ?? ''));
    },
  );

  test.concurrent(
    'AC-18: the start-session --parameters value is one argument, byte for byte',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 session', extraEnv: LIVE_ENV });
      const [run] = runsOf(result, 'session-manager');
      expect(run, 'no start-session call').toBeDefined();
      const at = (run?.argv ?? []).indexOf('--parameters');
      expect(run?.argv[at + 1]).toBe(SESSION_PARAMETERS);
    },
  );

  test.concurrent('AC-18: the JMESPath queries are one argument each, byte for byte', async () => {
    const result = await runVerify(healthy(), { label: 'AC-18 jmespath' });
    const queryOf = (name: string): string | undefined => {
      const [run] = runsOf(result, name);
      const argv = run?.argv ?? [];
      return argv[argv.indexOf('--query') + 1];
    };
    expect(queryOf('public-route')).toBe(
      "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].[GatewayId,State]",
    );
    expect(queryOf('private-endpoint-route')).toBe(
      `RouteTables[0].Routes[?GatewayId=='${VPCE}'].[DestinationPrefixListId,State]`,
    );
    expect(queryOf('instance-no-inbound')).toBe(
      'SecurityGroupRules[?IsEgress==`false`].SecurityGroupRuleId',
    );
  });

  test.concurrent(
    'AC-18: the six actions of role-may-use-ssm are six arguments after --action-names',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 actions' });
      const [run] = runsOf(result, 'role-may-use-ssm');
      const argv = run?.argv ?? [];
      const at = argv.indexOf('--action-names');
      expect(argv.slice(at + 1, at + 1 + ASSUME_ACTIONS.length)).toEqual(ASSUME_ACTIONS);
    },
  );

  test.concurrent(
    'AC-18: the account ID is asked once, with --query Account --output text',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 identity' });
      expect(result.aws.filter(isIdentity).map((run) => run.argv)).toEqual([IDENTITY]);
    },
  );

  test.concurrent(
    'AC-18: every aws call runs in us-east-1 with an empty pager, whatever the caller sets',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-18 environment',
        extraEnv: {
          ...LIVE_ENV,
          AWS_REGION: 'eu-west-1',
          AWS_DEFAULT_REGION: 'eu-west-1',
          AWS_PAGER: 'less',
        },
      });
      expect(result.aws.length).toBeGreaterThan(READ_CALLS.length);
      for (const run of result.aws) {
        expect([run.region, run.defaultRegion, run.pager], run.argv.join(' ')).toEqual([
          'us-east-1',
          'us-east-1',
          '',
        ]);
      }
      expectRun(result, { live: true });
    },
  );
});

// =================================================================================================
// AC-19: polls and sleeps
// =================================================================================================

describe('verify.sh: polls and sleeps', () => {
  const online = (...words: string[]): Reply[] => words.map((word) => ok(word));
  const EXPECTED_LINE_OF_17 =
    'FAIL: instance-online: the instance did not come online in Systems Manager';

  test.concurrent(
    'AC-19: instance-online asked once when the first answer is Online: no sleep',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-19 online first' });
      expectRun(result);
      expect(runsOf(result, 'instance-online')).toHaveLength(1);
      expect(result.sleeps).toEqual([]);
    },
  );

  test.concurrent(
    'AC-19: instance-online ConnectionLost twice then Online is ok after three calls and two sleeps',
    async () => {
      const result = await runVerify(
        answering('instance-online', ...online('ConnectionLost', 'ConnectionLost', 'Online')),
        { label: 'AC-19 online third', poll: '3' },
      );
      expectRun(result);
      expect(runsOf(result, 'instance-online')).toHaveLength(3);
      expect(result.sleeps).toEqual(['3', '3']);
    },
  );

  test.concurrent(
    'AC-19: instance-online sleeps VERIFY_POLL_SECONDS between polls, and 5 without the variable',
    async () => {
      const result = await runVerify(
        answering('instance-online', ...online('ConnectionLost', 'ConnectionLost', 'Online')),
        { label: 'AC-19 online default sleep', poll: null },
      );
      expectRun(result);
      expect(result.sleeps).toEqual(['5', '5']);
    },
  );

  test.concurrent(
    'AC-19: instance-online never Online makes exactly 60 calls and 59 sleeps of VERIFY_POLL_SECONDS',
    async () => {
      const result = await runVerify(answering('instance-online', ...online('ConnectionLost')), {
        label: 'AC-19 online never',
        poll: '3',
      });
      expectRun(result, {}, { 'instance-online': EXPECTED_LINE_OF_17 });
      expect(runsOf(result, 'instance-online')).toHaveLength(60);
      expect(result.sleeps).toHaveLength(59);
      expect(new Set(result.sleeps)).toEqual(new Set(['3']));
    },
  );

  test.concurrent(
    'AC-19: instance-online exiting 254 twice then Online is ok (an error is one more try)',
    async () => {
      const result = await runVerify(
        answering('instance-online', failing(254, STUB_ERR), failing(254, STUB_ERR), ok('Online')),
        { label: 'AC-19 online errors' },
      );
      expectRun(result);
      expect(runsOf(result, 'instance-online')).toHaveLength(3);
      expect(result.sleeps).toHaveLength(2);
    },
  );

  test.concurrent('AC-19: a healthy live run makes no sleep at all', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 live no sleep', extraEnv: LIVE_ENV });
    expectRun(result, { live: true });
    expect(result.sleeps).toEqual([]);
  });

  test.concurrent.each(INSTANCE_IDS.map((id) => ({ id })))(
    'AC-19: on_instance of $id polls an error, Pending, InProgress, Delayed, then the terminal status: 5 polls and 4 sleeps',
    async ({ id }) => {
      const final = HEALTHY_STATUS[id] ?? 'Success';
      const fixture = healthy();
      fixture.replies[`${id}:status`] = [
        failing(254, `InvocationDoesNotExist ${STUB_ERR}`),
        ok('Pending'),
        ok('InProgress'),
        ok('Delayed'),
        ok(final),
      ];
      const result = await runVerify(fixture, {
        label: `AC-19 on_instance polls ${id}`,
        extraEnv: LIVE_ENV,
        poll: '2',
      });
      expectRun(result, { live: true });
      expect(runsOf(result, `${id}:status`)).toHaveLength(5);
      expect(result.sleeps).toEqual(['2', '2', '2', '2']);
    },
  );

  test.concurrent.each(INSTANCE_IDS.map((id) => ({ id })))(
    'AC-19: on_instance of $id never terminal makes exactly 24 polls and 23 sleeps, and the check fails with its own text',
    async ({ id }) => {
      const result = await runVerify(instanceEnding(id, { status: [ok('Pending')] }), {
        label: `AC-19 on_instance never ${id}`,
        extraEnv: LIVE_ENV,
        poll: '2',
      });
      const lines: Record<string, string> = { [id]: GIVE_UP_LINE[id] ?? '' };
      if (id === 'run-command')
        Object.assign(lines, skipLines(AFTER_RUN_COMMAND, 'run-command failed'));
      expectRun(result, { live: true }, lines);
      expect(runsOf(result, `${id}:status`)).toHaveLength(24);
      expect(result.sleeps).toHaveLength(23);
      expect(new Set(result.sleeps)).toEqual(new Set(['2']));
      // The status is unknown: nothing is read from the invocation.
      expect(runsOf(result, `${id}:stdout`)).toEqual([]);
      expect(runsOf(result, `${id}:stderr`)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-19: on_instance never terminal with every poll exiting 254 makes 24 polls too',
    async () => {
      const fixture = healthy();
      fixture.replies['run-command:status'] = [failing(254, `InvocationDoesNotExist ${STUB_ERR}`)];
      const result = await runVerify(fixture, {
        label: 'AC-19 on_instance errors',
        extraEnv: LIVE_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'run-command': GIVE_UP_LINE['run-command'] ?? '',
          ...skipLines(AFTER_RUN_COMMAND, 'run-command failed'),
        },
      );
      expect(runsOf(result, 'run-command:status')).toHaveLength(24);
      expect(result.sleeps).toHaveLength(23);
    },
  );

  test.concurrent.each(['Failed', 'TimedOut', 'Cancelled'].map((status) => ({ status })))(
    'AC-19: on_instance stops at once on the terminal status $status',
    async ({ status }) => {
      const result = await runVerify(instanceEnding('run-command', { status }), {
        label: `AC-19 terminal ${status}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'run-command': 'FAIL: run-command: Run Command did not reach the instance',
          ...skipLines(AFTER_RUN_COMMAND, 'run-command failed'),
        },
      );
      expect(runsOf(result, 'run-command:status')).toHaveLength(1);
      expect(result.sleeps).toEqual([]);
    },
  );
});

// =================================================================================================
// AC-20: the live checks, healthy
// =================================================================================================

describe('verify.sh: live checks (VERIFY_ASSUME=1)', () => {
  test.concurrent('AC-20: a healthy live run prints 26 ok lines and no skip', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 healthy', extraEnv: LIVE_ENV });
    expectRun(result, { live: true });
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (26 passed, 0 skipped)');
  });

  test.concurrent(
    'AC-20: send-command and start-session run with MSYS_NO_PATHCONV=1, every other aws call without it',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-20 msys', extraEnv: LIVE_ENV });
      expectRun(result, { live: true });
      const withIt = result.aws.filter((run) => run.msys === '1');
      const without = result.aws.filter((run) => run.msys !== '1');
      expect(
        withIt.map((run) => `${run.argv[0]} ${run.argv[1]}`),
        'calls with MSYS_NO_PATHCONV=1',
      ).toEqual([
        'ssm send-command',
        'ssm start-session',
        'ssm send-command',
        'ssm send-command',
        'ssm send-command',
        'ssm send-command',
      ]);
      expect(new Set(without.map((run) => run.msys))).toEqual(new Set(['<unset>']));
      expect(without.length).toBeGreaterThan(READ_CALLS.length);
    },
  );

  test.concurrent('AC-20: start-session has its standard input from /dev/null', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 stdin', extraEnv: LIVE_ENV });
    const sessions = opRuns(result, 'ssm', 'start-session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.stdin).toBe('eof');
  });

  test.concurrent(
    'AC-20: the --body file holds the probe text while each upload runs',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-20 body', extraEnv: LIVE_ENV });
      const puts = opRuns(result, 's3api', 'put-object');
      expect(puts).toHaveLength(2);
      for (const run of puts) {
        expect(run.body, 'the body file did not exist during the upload').toBeDefined();
        expect((run.body ?? '').replace(/\r?\n$/, '')).toBe(BODY_TEXT);
      }
    },
  );

  test.concurrent(
    'AC-20: the two uploads use two different temp files, and the reads a third',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-20 files', extraEnv: LIVE_ENV });
      const bodies = opRuns(result, 's3api', 'put-object').map(
        (run) => run.argv[run.argv.indexOf('--body') + 1],
      );
      const outs = opRuns(result, 's3api', 'get-object').map(
        (run) => run.argv[positionalIndex(run.argv)],
      );
      expect(bodies.every((path) => path !== undefined && path !== '')).toBe(true);
      expect(outs.every((path) => path !== undefined && path !== '')).toBe(true);
      for (const out of outs) expect(bodies).not.toContain(out);
    },
  );

  test.concurrent('AC-20: both temp files are gone after the run', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 temp files', extraEnv: LIVE_ENV });
    expect(opRuns(result, 's3api', 'put-object').length).toBeGreaterThan(0);
    expect(opRuns(result, 's3api', 'get-object').length).toBeGreaterThan(0);
    expect(result.leftovers).toEqual([]);
  });

  test.concurrent('AC-20: the temp files are gone after a run that fails too', async () => {
    const result = await runVerify(answering('outside-other-read', failing(254, STUB_ERR)), {
      label: 'AC-20 temp files after fail',
      extraEnv: LIVE_ENV,
    });
    expect(result.status).toBe(1);
    expect(opRuns(result, 's3api', 'put-object').length).toBeGreaterThan(0);
    expect(result.leftovers).toEqual([]);
  });

  test.concurrent(
    'AC-20: no argv contains delete-object, delete-route, create-route, modify-vpc-endpoint or assume-role',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-20 forbidden', extraEnv: LIVE_ENV });
      expect(result.aws.length).toBeGreaterThan(READ_CALLS.length);
      for (const run of result.aws) {
        for (const word of [
          'delete-object',
          'delete-route',
          'create-route',
          'modify-vpc-endpoint',
          'assume-role',
        ]) {
          expect(run.argv.join(' '), word).not.toContain(word);
        }
      }
    },
  );

  test.concurrent('AC-20: the live checks run in the order of the table', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 order', extraEnv: LIVE_ENV });
    const operations = checkRuns(result)
      .slice(READ_CALLS.length)
      .map((run) => `${run.argv[0]} ${run.argv[1]}`);
    expect(operations).toEqual([
      'ssm send-command',
      'ssm get-command-invocation',
      'ssm get-command-invocation',
      'ssm get-command-invocation',
      'ssm start-session',
      's3api put-object',
      's3api put-object',
      ...Array.from({ length: 4 }, () => [
        'ssm send-command',
        'ssm get-command-invocation',
        'ssm get-command-invocation',
        'ssm get-command-invocation',
      ]).flat(),
      's3api get-object',
      's3api get-object',
    ]);
  });

  test.concurrent.each([
    {
      name: 'the output of run-command with a line end',
      id: 'run-command',
      stdout: 'lab03-run-command\n',
    },
    {
      name: 'the output of run-command with trailing spaces',
      id: 'run-command',
      stdout: 'lab03-run-command \n\n',
    },
    { name: 'the NAT IP with a line end', id: 'internet-through-nat', stdout: `${NAT_IP}\n` },
    { name: 'the probe text with a line end', id: 's3-through-endpoint', stdout: `${BODY_TEXT}\n` },
  ])(
    'AC-20: $id is ok with $name (trailing white space is removed)',
    async ({ name, id, stdout }) => {
      const result = await runVerify(instanceEnding(id, { status: 'Success', stdout }), {
        label: `AC-20 trailing ${id} ${name}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(result, { live: true });
    },
  );

  test.concurrent.each([
    { name: 'the text of the probe', file: BODY_TEXT },
    { name: 'the text of the probe and a line end', file: `${BODY_TEXT}\n` },
  ])('AC-20: outside-other-read is ok when the out file holds $name', async ({ name, file }) => {
    const reply: Reply = { ...ok(''), file };
    const result = await runVerify(answering('outside-other-read', reply), {
      label: `AC-20 outside-other-read ${name}`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true });
  });

  test.concurrent.each([
    {
      name: 'a noisy stdout',
      stdout: 'Starting session with SessionId: abc\nlab03-session\nExiting session abc',
    },
    { name: 'only the marker', stdout: 'lab03-session' },
  ])('AC-20: session-manager is ok with $name', async ({ name, stdout }) => {
    const result = await runVerify(answering('session-manager', ok(stdout)), {
      label: `AC-20 session ${name}`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true });
  });

  test.concurrent.each([
    { name: 'the implicit deny of the endpoint policy', stderr: IMPLICIT_ENDPOINT_DENY },
    { name: 'the explicit deny of the endpoint policy', stderr: EXPLICIT_ENDPOINT_DENY },
  ])('AC-20: other-bucket-denied is ok with $name', async ({ name, stderr }) => {
    const result = await runVerify(
      instanceEnding('other-bucket-denied', { status: 'Failed', stderr }),
      { label: `AC-20 other-bucket-denied ${name}`, extraEnv: LIVE_ENV },
    );
    expectRun(result, { live: true });
  });
});

// =================================================================================================
// AC-21: live failures
// =================================================================================================

describe('verify.sh: live failures', () => {
  interface LiveCase {
    name: string;
    fixture: Fixture;
    lines: Record<string, Expected>;
    options?: RunOptions;
  }

  const runCommandFails = (): Record<string, Expected> => ({
    'run-command': 'FAIL: run-command: Run Command did not reach the instance',
    ...skipLines(AFTER_RUN_COMMAND, 'run-command failed'),
  });

  const probeFails = (): Record<string, Expected> => ({
    'probe-objects': 'FAIL: probe-objects: the probe objects could not be uploaded',
    ...skipLines(AFTER_PROBE_OBJECTS, 'probe-objects failed'),
  });

  const CASES: LiveCase[] = [
    // #18
    {
      name: 'run-command with the status Failed',
      fixture: instanceEnding('run-command', { status: 'Failed', stderr: INSTANCE_ERR_MARK }),
      lines: runCommandFails(),
    },
    {
      name: 'run-command with the status TimedOut',
      fixture: instanceEnding('run-command', { status: 'TimedOut' }),
      lines: runCommandFails(),
    },
    {
      name: 'run-command with Success and another output',
      fixture: instanceEnding('run-command', { status: 'Success', stdout: INSTANCE_OUT_MARK }),
      lines: runCommandFails(),
    },
    {
      name: 'run-command with Success and an empty output',
      fixture: instanceEnding('run-command', { status: 'Success', stdout: '' }),
      lines: runCommandFails(),
    },
    {
      name: 'run-command whose send-command exits 254',
      fixture: answering('run-command:send', failing(254, `${STUB_ERR} ${INST}`)),
      lines: runCommandFails(),
    },
    {
      name: 'run-command whose send-command answers nothing',
      fixture: answering('run-command:send', ok('')),
      lines: runCommandFails(),
    },
    // #19
    {
      name: 'session-manager whose start-session exits 255',
      fixture: answering('session-manager', failing(255, `${STUB_ERR} ${INST}`)),
      lines: { 'session-manager': 'FAIL: session-manager: no session could be opened' },
    },
    {
      name: 'session-manager whose start-session exits 0 without the marker',
      fixture: answering('session-manager', ok('Starting session\nExiting session')),
      lines: { 'session-manager': 'FAIL: session-manager: no session could be opened' },
    },
    {
      name: 'session-manager whose start-session exits 254 and prints the marker',
      fixture: answering('session-manager', { ...ok('lab03-session'), exit: 254 }),
      lines: { 'session-manager': 'FAIL: session-manager: no session could be opened' },
    },
    // #20
    {
      name: 'probe-objects with the first upload failing',
      fixture: answering('probe-objects', failing(254, `${STUB_ERR} ${DATA}`)),
      lines: probeFails(),
    },
    {
      name: 'probe-objects with the second upload failing',
      fixture: answering('probe-objects-other', failing(254, `${STUB_ERR} ${OTHER}`)),
      lines: probeFails(),
    },
    // #21
    {
      name: 'internet-through-nat with Success and another IP',
      fixture: instanceEnding('internet-through-nat', { status: 'Success', stdout: OTHER_IP }),
      lines: {
        'internet-through-nat':
          'FAIL: internet-through-nat: the instance reached the internet from another address',
      },
    },
    {
      name: 'internet-through-nat with the status Failed',
      fixture: instanceEnding('internet-through-nat', {
        status: 'Failed',
        stderr: INSTANCE_TIMEOUT,
      }),
      lines: {
        'internet-through-nat':
          'FAIL: internet-through-nat: the instance could not reach the internet',
      },
    },
    // #22
    {
      name: 's3-through-endpoint with Failed and the deny phrase',
      fixture: instanceEnding('s3-through-endpoint', {
        status: 'Failed',
        stderr: INSTANCE_BUCKET_POLICY_DENY,
      }),
      lines: {
        's3-through-endpoint':
          'FAIL: s3-through-endpoint: S3 did not see the request come through the endpoint',
      },
    },
    {
      name: 's3-through-endpoint with Failed and a timeout',
      fixture: instanceEnding('s3-through-endpoint', {
        status: 'Failed',
        stderr: INSTANCE_TIMEOUT,
      }),
      lines: { 's3-through-endpoint': 'FAIL: s3-through-endpoint: the read failed' },
    },
    {
      name: 's3-through-endpoint with Success and other text',
      fixture: instanceEnding('s3-through-endpoint', {
        status: 'Success',
        stdout: INSTANCE_OUT_MARK,
      }),
      lines: { 's3-through-endpoint': 'FAIL: s3-through-endpoint: the read failed' },
    },
    // #23
    {
      name: 'instance-upload with the status Failed',
      fixture: instanceEnding('instance-upload', { status: 'Failed', stderr: INSTANCE_ERR_MARK }),
      lines: { 'instance-upload': 'FAIL: instance-upload: the upload through the endpoint failed' },
    },
    // #24
    {
      name: 'other-bucket-denied with Success',
      fixture: instanceEnding('other-bucket-denied', { status: 'Success' }),
      lines: {
        'other-bucket-denied':
          'FAIL: other-bucket-denied: the read through the endpoint was accepted',
      },
    },
    {
      name: 'other-bucket-denied with Failed, AccessDenied and no endpoint policy phrase',
      fixture: instanceEnding('other-bucket-denied', {
        status: 'Failed',
        stderr: INSTANCE_NO_IDENTITY_ALLOW,
      }),
      lines: {
        'other-bucket-denied': 'FAIL: other-bucket-denied: denied, but not by the endpoint policy',
      },
    },
    {
      name: 'other-bucket-denied with Failed and no AccessDenied',
      fixture: instanceEnding('other-bucket-denied', {
        status: 'Failed',
        stderr: INSTANCE_TIMEOUT,
      }),
      lines: { 'other-bucket-denied': 'FAIL: other-bucket-denied: could not ask AWS' },
    },
    // #25
    {
      name: 'outside-read-denied exiting 0',
      fixture: answering('outside-read-denied', ok('')),
      lines: {
        'outside-read-denied':
          'FAIL: outside-read-denied: a read from outside the VPC was accepted',
      },
    },
    {
      name: 'outside-read-denied with AccessDenied without the bucket policy phrase',
      fixture: answering('outside-read-denied', identityDenied()),
      lines: {
        'outside-read-denied': 'FAIL: outside-read-denied: denied, but not by the bucket policy',
      },
    },
    {
      name: 'outside-read-denied exiting 255 without AccessDenied',
      fixture: answering(
        'outside-read-denied',
        failing(255, `Unable to locate credentials ${STUB_ERR}`),
      ),
      lines: { 'outside-read-denied': 'FAIL: outside-read-denied: could not ask AWS' },
    },
    {
      name: 'outside-read-denied exiting 254 without AccessDenied',
      fixture: answering(
        'outside-read-denied',
        failing(254, `An error occurred (NoSuchBucket) when calling the operation ${STUB_ERR}`),
      ),
      lines: { 'outside-read-denied': 'FAIL: outside-read-denied: could not ask AWS' },
    },
    // #26
    {
      name: 'outside-other-read exiting 254',
      fixture: answering('outside-other-read', bucketPolicyDenied()),
      lines: {
        'outside-other-read':
          'FAIL: outside-other-read: the other bucket could not be read from outside',
      },
    },
    {
      name: 'outside-other-read with other content',
      fixture: answering('outside-other-read', { ...ok(''), file: 'something else' }),
      lines: {
        'outside-other-read':
          'FAIL: outside-other-read: the other bucket could not be read from outside',
      },
    },
    {
      name: 'outside-other-read with an empty out file',
      fixture: answering('outside-other-read', { ...ok(''), file: '' }),
      lines: {
        'outside-other-read':
          'FAIL: outside-other-read: the other bucket could not be read from outside',
      },
    },
  ];

  test.concurrent.each(CASES)('AC-21: $name', async ({ name, fixture, lines }) => {
    const result = await runVerify(fixture, { label: `AC-21 ${name}`, extraEnv: LIVE_ENV });
    expectRun(result, { live: true }, lines);
    expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent.each([
    {
      name: 'send-command exiting 254',
      fixture: answering('run-command:send', failing(254, STUB_ERR)),
    },
    { name: 'send-command answering nothing', fixture: answering('run-command:send', ok('')) },
    { name: 'a Failed status', fixture: instanceEnding('run-command', { status: 'Failed' }) },
  ])(
    'AC-21: run-command failing ($name) skips the four checks after it and sends no further command',
    async ({ name, fixture }) => {
      const result = await runVerify(fixture, {
        label: `AC-21 run-command ${name}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'run-command': true,
          ...skipLines(AFTER_RUN_COMMAND, 'run-command failed'),
        },
      );
      expect(opRuns(result, 'ssm', 'send-command')).toHaveLength(1);
    },
  );

  test.concurrent(
    'AC-21: run-command whose send-command fails makes no get-command-invocation call (the status is unknown)',
    async () => {
      const result = await runVerify(answering('run-command:send', failing(254, STUB_ERR)), {
        label: 'AC-21 send-command unknown',
        extraEnv: LIVE_ENV,
      });
      expect(opRuns(result, 'ssm', 'get-command-invocation')).toEqual([]);
      expect(result.sleeps).toEqual([]);
    },
  );

  test.concurrent.each([
    { name: 'the first upload', fixture: answering('probe-objects', failing(254, STUB_ERR)) },
    {
      name: 'the second upload',
      fixture: answering('probe-objects-other', failing(254, STUB_ERR)),
    },
  ])(
    'AC-21: probe-objects failing ($name) skips four checks and sends only three commands',
    async ({ name, fixture }) => {
      const result = await runVerify(fixture, {
        label: `AC-21 probe-objects ${name}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'probe-objects': true,
          ...skipLines(AFTER_PROBE_OBJECTS, 'probe-objects failed'),
        },
      );
      // run-command, internet-through-nat and instance-upload still run on the instance.
      expect(opRuns(result, 'ssm', 'send-command')).toHaveLength(3);
      expect(opRuns(result, 's3api', 'get-object')).toEqual([]);
    },
  );

  test.concurrent(
    'AC-21: session-manager without a session-manager-plugin on PATH fails and makes no start-session call',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-21 no plugin',
        extraEnv: LIVE_ENV,
        plugin: false,
      });
      expectRun(
        result,
        { live: true },
        { 'session-manager': 'FAIL: session-manager: the Session Manager plugin is not installed' },
      );
      expect(opRuns(result, 'ssm', 'start-session')).toEqual([]);
    },
  );

  test.concurrent(
    'AC-21: session-manager without the plugin does not look for it when VERIFY_ASSUME is not 1',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-21 no plugin, no live',
        plugin: false,
      });
      expectRun(result);
    },
  );
});

// =================================================================================================
// AC-23: CRLF
// =================================================================================================

describe('verify.sh: CRLF answers', () => {
  const crlf = (fixture: Fixture): Fixture => ({ ...fixture, awsEol: '\r\n', tfEol: '\r\n' });

  test.concurrent('AC-23: CRLF answers give the stdout of AC-16', async () => {
    const result = await runVerify(crlf(healthy()), { label: 'AC-23 crlf' });
    expectRun(result);
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (17 passed, 9 skipped)');
  });

  test.concurrent('AC-23: CRLF answers give the stdout of AC-20 with the live checks', async () => {
    const result = await runVerify(crlf(healthy()), {
      label: 'AC-23 crlf live',
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true });
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (26 passed, 0 skipped)');
  });

  test.concurrent('AC-23: a CRLF wrong answer still fails only that check', async () => {
    const fixture = crlf(healthy());
    fixture.replies['instance-role'] = [ok(`/lab/\t${BOUNDARY}x`)];
    const result = await runVerify(fixture, { label: 'AC-23 crlf fail' });
    expectRun(result, {}, { 'instance-role': true });
  });

  test.concurrent('AC-23: CRLF answers still poll instance-online and on_instance', async () => {
    const fixture = crlf(healthy());
    fixture.replies['instance-online'] = [ok('ConnectionLost'), ok('Online')];
    fixture.replies['run-command:status'] = [ok('Pending'), ok('Success')];
    const result = await runVerify(fixture, { label: 'AC-23 crlf polls', extraEnv: LIVE_ENV });
    expectRun(result, { live: true });
    expect(result.sleeps).toHaveLength(2);
  });

  test.concurrent('AC-23: CRLF denials still count as denied', async () => {
    const result = await runVerify(crlf(healthy()), {
      label: 'AC-23 crlf denied',
      extraEnv: LIVE_ENV,
    });
    const lines = outLines(result.stdout);
    expect(lines).toContain('ok: other-bucket-denied');
    expect(lines).toContain('ok: outside-read-denied');
  });
});

// =================================================================================================
// AC-24: the script cannot run
// =================================================================================================

describe('verify.sh: usage, tools, outputs and identity', () => {
  /** Nothing of a run happened: no check line, no summary, no aws call but the account ID. */
  const expectCouldNotRun = (result: RunResult): void => {
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).not.toBe('');
    expect(verdictLines(result.stdout)).toEqual([]);
    expect(checkRuns(result)).toEqual([]);
  };

  test.concurrent.each([
    { name: 'on a normal PATH', strictPath: false, tools: TOOLS, args: ['--help'] },
    { name: 'on a PATH without any tool', strictPath: true, tools: [] as Tool[], args: ['--help'] },
    { name: 'with several arguments', strictPath: false, tools: TOOLS, args: ['a', 'b'] },
    { name: 'with an empty argument', strictPath: false, tools: TOOLS, args: [''] },
  ])(
    'AC-24: an argument $name prints the usage and exits 2',
    async ({ name, strictPath, tools, args }) => {
      const result = await runVerify(healthy(), {
        label: `AC-24 argument ${name}`,
        args,
        tools,
        strictPath,
      });
      expect(result.stderr.split(/\r?\n/)[0]).toBe(USAGE);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each(TOOLS.map((name) => ({ name })))(
    'AC-24: without $name on PATH the script says so and exits 2',
    async ({ name }) => {
      const tools = TOOLS.filter((tool) => tool !== name);
      const result = await runVerify(healthy(), {
        label: `AC-24 no ${name}`,
        tools,
        strictPath: true,
      });
      expect(result.stderr.split(/\r?\n/)).toContain(`verify: ${name} is not installed`);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-24: an empty output $name stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = ok('');
      const result = await runVerify(fixture, { label: `AC-24 ${name} empty` });
      expect(result.stderr.split(/\r?\n/)).toContain(
        `verify: terraform output ${name} is empty; apply the stack first`,
      );
      expectCouldNotRun(result);
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-24: terraform output $name exiting 1 stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = failing(
        1,
        `Error: no outputs for ${ROLE} ${ACCT}, run apply first ${STUB_ERR}`,
      );
      const result = await runVerify(fixture, { label: `AC-24 ${name} fails` });
      expect(result.stderr.split(/\r?\n/)).toContain(
        `verify: terraform output ${name} is empty; apply the stack first`,
      );
      expectCouldNotRun(result);
    },
  );

  test.concurrent.each([
    { name: 'exiting 255', reply: failing(255, `Unable to locate credentials ${STUB_ERR}`) },
    { name: 'answering None', reply: ok('None') },
    { name: 'answering 11 digits', reply: ok('11112222333') },
    { name: 'answering 13 digits', reply: ok('1111222233334') },
    { name: 'answering 12 characters that are not digits', reply: ok('11112222333a') },
    { name: 'answering nothing', reply: ok('') },
  ])('AC-24: get-caller-identity $name stops the script with exit 2', async ({ name, reply }) => {
    const fixture = healthy();
    fixture.identity = reply;
    const result = await runVerify(fixture, { label: `AC-24 identity ${name}` });
    expectCouldNotRun(result);
  });
});

// =================================================================================================
// AC-22 and the audits over every run of this file
// =================================================================================================

describe('verify.sh: nothing private is printed', () => {
  test.concurrent(
    'AC-22: a failing aws call prints none of its stderr, nor an ARN, bucket, ID or account ID',
    async () => {
      const fixture = healthy();
      fixture.replies['instance-role'] = [
        failing(254, `An error occurred (AccessDenied) ${ROLE} ${DATA} ${INST} ${STUB_ERR}`),
      ];
      fixture.replies['buckets-private'] = [failing(255, `${DATA} ${ACCT} ${VPC} ${STUB_ERR}`)];
      const result = await runVerify(fixture, { label: 'AC-22 failing calls' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: mismatches on values that hold an ID, an IP, an ARN or a bucket print none of them',
    async () => {
      const fixture = healthy();
      fixture.replies['public-route'] = [ok(`${NAT}\tactive`)];
      fixture.replies['private-nat-route'] = [ok(`${OTHER_NAT}\tactive`)];
      fixture.replies['private-no-igw'] = [ok(`local\t${IGW}`)];
      fixture.replies['nat-gateway'] = [ok(`available\tpublic\t${OTHER_IP}`)];
      fixture.replies['instance-private'] = [ok(`running\t${NAT_IP}\tmy-key\trequired`)];
      fixture.replies['instance-no-inbound'] = [ok(RULE_ID)];
      fixture.replies['instance-role'] = [ok(`/lab/\tarn:aws:iam::${ACCT}:policy/other`)];
      fixture.replies['s3-endpoint-policy'] = [ok(endpointPolicyAllowingAll())];
      fixture.replies['data-bucket-policy'] = [ok(dataPolicyWith(VPCE, OTHER_VPCE))];
      const result = await runVerify(fixture, { label: 'AC-22 mismatches' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: a live run whose instance checks fail prints no output of the instance and no command ID',
    async () => {
      const fixture = healthy();
      fixture.replies['internet-through-nat:stdout'] = [ok(OTHER_IP)];
      fixture.replies['s3-through-endpoint:status'] = [ok('Failed')];
      fixture.replies['s3-through-endpoint:stderr'] = [ok(INSTANCE_BUCKET_POLICY_DENY)];
      fixture.replies['instance-upload:status'] = [ok('Failed')];
      fixture.replies['instance-upload:stderr'] = [ok(INSTANCE_TIMEOUT)];
      fixture.replies['other-bucket-denied:status'] = [ok('Success')];
      fixture.replies['other-bucket-denied:stdout'] = [ok(INSTANCE_OUT_MARK)];
      const result = await runVerify(fixture, {
        label: 'AC-22 instance failures',
        extraEnv: LIVE_ENV,
      });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: a live run whose laptop checks fail prints none of the stub stderr',
    async () => {
      const fixture = healthy();
      fixture.replies['probe-objects'] = [failing(254, `${STUB_ERR} ${DATA} ${ACCT}`)];
      fixture.replies['outside-read-denied'] = [identityDenied()];
      const result = await runVerify(fixture, {
        label: 'AC-22 laptop failures',
        extraEnv: LIVE_ENV,
      });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: a terraform output that fails with an ARN prints none of it',
    async () => {
      const fixture = healthy();
      fixture.outputs['instance_role_arn'] = failing(1, `Error: ${ROLE} ${ACCT} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-22 terraform' });
      expect(result.status).toBe(2);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent('AC-22: a missing plugin run prints no ID either', async () => {
    const result = await runVerify(healthy(), {
      label: 'AC-22 no plugin',
      extraEnv: LIVE_ENV,
      plugin: false,
    });
    expect(result.status).toBe(1);
    expect(leaks(result.all)).toEqual([]);
  });
});

describe('verify.sh: audit over every run of this file', () => {
  test('AC-22: no run printed a 12-digit number, an ARN, a bucket name, a resource ID, an IP, a command ID or a stub stderr', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.flatMap(({ label, result }) =>
      leaks(result.all).map((needle) => `${label}: printed ${needle}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-22: no run made a call a stub had no answer for', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) => result.unexpected.length > 0).map(
      ({ label, result }) => `${label}: ${result.unexpected.join('; ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-20: no run left a temp file behind', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) => result.leftovers.length > 0).map(
      ({ label, result }) => `${label}: ${result.leftovers.join(', ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-20: no run called delete-object, delete-route, create-route, modify-vpc-endpoint or assume-role', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const forbidden = [
      'delete-object',
      'delete-route',
      'create-route',
      'modify-vpc-endpoint',
      'assume-role',
    ];
    const found = RUNS.filter(({ result }) =>
      result.aws.some((run) => forbidden.some((word) => run.argv.includes(word))),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });

  test('AC-16: no run without VERIFY_ASSUME=1 made a live call', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const live = ['send-command', 'start-session', 'put-object', 'get-object'];
    const found = RUNS.filter(
      ({ assume, result }) =>
        !assume && result.aws.some((run) => live.some((word) => run.argv.includes(word))),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });
});

// =================================================================================================
// AC-25: no xtrace leak
// =================================================================================================

describe('verify.sh: no xtrace leak', () => {
  test('AC-25: set +x comes right after set -euo pipefail', () => {
    const path = scriptPath();
    expect(readFileSync(path, 'utf8')).toMatch(
      /^set -euo pipefail[ \t]*(?:;[ \t]*|\n(?:[ \t]*\n)*)set \+x\b/m,
    );
  });

  test.concurrent(
    'AC-25: a live run with SHELLOPTS=xtrace exported still prints no ID, ARN, bucket or IP',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-25 xtrace',
        extraEnv: { ...LIVE_ENV, SHELLOPTS: 'xtrace' },
      });
      expect(leaks(result.all)).toEqual([]);
      expectRun(result, { live: true });
    },
  );
});

// =================================================================================================
// AC-38, AC-39: review regressions in the policy checks
// =================================================================================================

type PrintStyle = { style: string; print: (policy: string) => string };

const PRINT_STYLES: PrintStyle[] = [
  { style: 'compact', print: (policy) => policy },
  { style: 'with spaces around the colons', print: spaced },
  { style: 'pretty printed', print: pretty },
];

const ENDPOINT_WILDCARDS = ['*', 'arn:aws:s3:::*'];
const ARRAY_POSITIONS = ['first', 'middle', 'last'] as const;

/** The healthy endpoint policy plus a second statement whose single Resource is `resource`. */
const endpointPolicyWithSingle = (resource: string): string =>
  endpointPolicyAllowingAll().replace('"Resource":"*"', `"Resource":"${resource}"`);

/** An endpoint policy whose Resource array holds `resource` at the given place. */
function endpointPolicyWithElement(resource: string, position: (typeof ARRAY_POSITIONS)[number]) {
  const bucket = DATA_ARN;
  const objects = `${DATA_ARN}/*`;
  const list =
    position === 'first'
      ? [resource, bucket, objects]
      : position === 'middle'
        ? [bucket, resource, objects]
        : [bucket, objects, resource];
  return endpointPolicy(list);
}

describe('verify.sh: the endpoint policy allows no wildcard resource (review regression)', () => {
  const cases = ENDPOINT_WILDCARDS.flatMap((resource) =>
    PRINT_STYLES.flatMap(({ style, print }) => [
      {
        name: `"${resource}" as a single Resource, ${style}`,
        text: print(endpointPolicyWithSingle(resource)),
      },
      ...ARRAY_POSITIONS.map((position) => ({
        name: `"${resource}" as the ${position} element of the Resource array, ${style}`,
        text: print(endpointPolicyWithElement(resource, position)),
      })),
    ]),
  );

  test.concurrent.each(cases)(
    'AC-38: s3-endpoint-policy with $name says "the endpoint policy allows every resource"',
    async ({ name, text }) => {
      const result = await runVerify(answering('s3-endpoint-policy', ok(text)), {
        label: `AC-38 ${name}`,
      });
      expectRun(
        result,
        {},
        {
          's3-endpoint-policy':
            'FAIL: s3-endpoint-policy: the endpoint policy allows every resource',
        },
      );
    },
  );

  const healthy = PRINT_STYLES.flatMap(({ style, print }) => [
    { name: `the healthy policy, ${style}`, text: print(endpointPolicy()) },
    {
      name: `the object ARN with /* before the bucket ARN, ${style}`,
      text: print(endpointPolicy([`${DATA_ARN}/*`, DATA_ARN])),
    },
  ]);

  test.concurrent.each(healthy)(
    'AC-38: s3-endpoint-policy is ok for $name (a /* suffix and "Principal":"*" are not a wildcard resource)',
    async ({ name, text }) => {
      const result = await runVerify(answering('s3-endpoint-policy', ok(text)), {
        label: `AC-38 ok ${name}`,
      });
      expectRun(result);
    },
  );

  test.concurrent(
    'AC-38: s3-endpoint-policy is ok when "Principal":"*" comes after the Resource array',
    async () => {
      const policy = JSON.parse(endpointPolicy()) as {
        Statement: Record<string, unknown>[];
        Version: string;
      };
      const statement = policy.Statement[0] ?? {};
      const reordered = JSON.stringify({
        Statement: [
          {
            Resource: statement.Resource,
            Principal: '*',
            Action: statement.Action,
            Effect: 'Allow',
            Sid: statement.Sid,
          },
        ],
        Version: policy.Version,
      });
      const result = await runVerify(answering('s3-endpoint-policy', ok(reordered)), {
        label: 'AC-38 ok principal after resource',
      });
      expectRun(result);
    },
  );
});

describe('verify.sh: the data bucket policy needs the demo operator and effect (review regression)', () => {
  /** The healthy data policy with `Effect` of the statement at `index` set to Allow. */
  function dataPolicyAllowing(index: number): string {
    const policy = JSON.parse(dataPolicy()) as { Statement: Record<string, unknown>[] };
    const statement = policy.Statement[index];
    if (statement === undefined) throw new Error(`no statement ${index}`);
    statement.Effect = 'Allow';
    return JSON.stringify(policy);
  }

  const NOT_EQUALS = 'FAIL: data-bucket-policy: the bucket policy deny is not StringNotEquals';
  const HAS_ALLOW = 'FAIL: data-bucket-policy: the bucket policy has an Allow statement';

  const wrongOperator = [
    ...PRINT_STYLES.map(({ style, print }) => ({
      name: `StringEquals instead of StringNotEquals, ${style}`,
      text: print(dataPolicyWith('"StringNotEquals"', '"StringEquals"')),
    })),
    {
      name: 'a line end around the colon and StringEquals',
      text: lined(dataPolicyWith('"StringNotEquals"', '"StringEquals"')),
    },
  ];

  test.concurrent.each(wrongOperator)(
    'AC-39: data-bucket-policy with $name says "the bucket policy deny is not StringNotEquals"',
    async ({ name, text }) => {
      const result = await runVerify(answering('data-bucket-policy', ok(text)), {
        label: `AC-39 operator ${name}`,
      });
      expectRun(result, {}, { 'data-bucket-policy': NOT_EQUALS });
    },
  );

  const withAllow = [0, 1].flatMap((index) => [
    ...PRINT_STYLES.map(({ style, print }) => ({
      name: `"Effect":"Allow" on statement ${index + 1}, ${style}`,
      text: print(dataPolicyAllowing(index)),
    })),
    {
      name: `"Effect":"Allow" on statement ${index + 1}, with line ends around the colon`,
      text: lined(dataPolicyAllowing(index)),
    },
  ]);

  test.concurrent.each(withAllow)(
    'AC-39: data-bucket-policy with $name says "the bucket policy has an Allow statement"',
    async ({ name, text }) => {
      const result = await runVerify(answering('data-bucket-policy', ok(text)), {
        label: `AC-39 allow ${name}`,
      });
      expectRun(result, {}, { 'data-bucket-policy': HAS_ALLOW });
    },
  );

  test.concurrent.each([
    {
      name: 'a Null key',
      text: dataPolicyWith(
        '"StringNotEquals":{',
        '"Null":{"aws:SourceVpce":"true"},"StringNotEquals":{',
      ),
      reason: 'the bucket policy has a Null or IfExists condition',
    },
    {
      name: 'another endpoint',
      text: dataPolicyWith(VPCE, OTHER_VPCE),
      reason: 'the bucket policy does not name the endpoint',
    },
  ])(
    'AC-39: data-bucket-policy with $name keeps its earlier reason',
    async ({ name, text, reason }) => {
      const result = await runVerify(answering('data-bucket-policy', ok(text)), {
        label: `AC-39 earlier ${name}`,
      });
      expectRun(result, {}, { 'data-bucket-policy': `FAIL: data-bucket-policy: ${reason}` });
    },
  );

  test.concurrent.each(PRINT_STYLES)(
    'AC-39: data-bucket-policy stays ok for the healthy policy, $style',
    async ({ style, print }) => {
      const result = await runVerify(answering('data-bucket-policy', ok(print(dataPolicy()))), {
        label: `AC-39 healthy ${style}`,
      });
      expectRun(result);
    },
  );
});

// =================================================================================================
// AC-42: describe-route-tables answers {"RouteTables": [{"Routes": [...]}]}
// =================================================================================================

describe('verify.sh: the route checks read RouteTables[0].Routes', () => {
  const NO_ROUTES = 'FAIL: private-no-igw: expected the routes of the private route table';
  const HAS_IGW =
    'FAIL: private-no-igw: the private route table has a route to an internet gateway';

  test.concurrent(
    'AC-42: every describe-route-tables call of a healthy run queries RouteTables[0].Routes',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-42 route queries' });
      const queries = opRuns(result, 'ec2', 'describe-route-tables').map((run) => {
        const at = run.argv.indexOf('--query');
        return run.argv[at + 1] ?? '';
      });
      expect(queries).toHaveLength(4);
      for (const query of queries) expect(query.startsWith(ROUTE_QUERY_ROOT), query).toBe(true);
    },
  );

  test.concurrent('AC-42: a healthy stack still passes the four route checks', async () => {
    const result = await runVerify(healthy(), { label: 'AC-42 healthy routes' });
    expectRun(result);
    expect(result.status).toBe(0);
  });

  test.concurrent.each([
    { name: 'None', answer: 'None' },
    { name: 'an empty answer', answer: '' },
  ])('AC-42: private-no-igw fails when AWS answers $name', async ({ name, answer }) => {
    const result = await runVerify(answering('private-no-igw', ok(answer)), {
      label: `AC-42 private-no-igw ${name}`,
    });
    expectRun(result, {}, { 'private-no-igw': NO_ROUTES });
  });

  test.concurrent(
    'AC-42: private-no-igw passes on the local route, None and the endpoint',
    async () => {
      const result = await runVerify(answering('private-no-igw', ok(`local\tNone\t${VPCE}`)), {
        label: 'AC-42 private-no-igw local',
      });
      expectRun(result);
    },
  );

  test.concurrent(
    'AC-42: private-no-igw fails with its own message when an igw- is present',
    async () => {
      const result = await runVerify(answering('private-no-igw', ok(`local\t${IGW}\t${VPCE}`)), {
        label: 'AC-42 private-no-igw igw',
      });
      expectRun(result, {}, { 'private-no-igw': HAS_IGW });
    },
  );

  test.concurrent(
    'AC-42: private-no-igw fails with the igw message when an igw- is present without local',
    async () => {
      const result = await runVerify(answering('private-no-igw', ok(`None\t${IGW}`)), {
        label: 'AC-42 private-no-igw igw without local',
      });
      expectRun(result, {}, { 'private-no-igw': HAS_IGW });
    },
  );
});

describe('lab 03 files: every describe-route-tables query starts with RouteTables[0].Routes', () => {
  /** The logical lines of a shell or Markdown file: a backslash at the line end joins the next line. */
  const logicalLines = (text: string): string[] => text.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/);

  /** NAME="value" and NAME='value' assignments, so that `$NAME` in a query can be expanded. */
  function assignments(text: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const line of logicalLines(text)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(["'])(.*)\2\s*$/.exec(line);
      if (match?.[1] !== undefined && match[3] !== undefined) found.set(match[1], match[3]);
    }
    return found;
  }

  /** The --query argument of every describe-route-tables call, variables expanded. */
  function routeQueries(file: string): string[] {
    const text = readFileSync(repoPath(...LAB, file), 'utf8');
    const variables = assignments(text);
    const expand = (query: string): string =>
      query.replace(
        /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
        (whole, name: string) => variables.get(name) ?? whole,
      );
    const queries: string[] = [];
    for (const line of logicalLines(text)) {
      if (!line.includes('describe-route-tables')) continue;
      const after = line.slice(line.indexOf('describe-route-tables'));
      for (const match of after.matchAll(/--query\s+("[^"]*"|'[^']*'|\S+)/g)) {
        const raw = match[1] ?? '';
        const unquoted = /^["'].*["']$/.test(raw) ? raw.slice(1, -1) : raw;
        queries.push(expand(unquoted));
      }
    }
    return queries;
  }

  test.each([
    { file: 'verify.sh', atLeast: 3 },
    { file: 'README.md', atLeast: 2 },
    { file: 'break-it.md', atLeast: 0 },
  ])(
    'AC-42: every describe-route-tables --query in $file starts with RouteTables[0].Routes',
    ({ file, atLeast }) => {
      const queries = routeQueries(file);
      expect(queries.length, `queries found in ${file}`).toBeGreaterThanOrEqual(atLeast);
      for (const query of queries) expect(query.startsWith(ROUTE_QUERY_ROOT), query).toBe(true);
    },
  );
});
