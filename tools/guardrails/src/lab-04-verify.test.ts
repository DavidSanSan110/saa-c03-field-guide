import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 048 (issue #144), AC-14 to AC-21: labs/04-alb-asg-self-healing/verify.sh.
//
// verify.sh is executed with bash (cwd = the lab folder, the script given as the relative path
// `verify.sh`) and stub `terraform`, `aws`, `curl` and `sleep` binaries on PATH (the approach of
// lab-03-verify.test.ts). Every terraform, aws, curl and sleep call appends one tab separated line to
// calls.log (the order of the lines is the order of the calls); sleep does not sleep.
//
// The aws stub answers by what the call asks, not by the order of its arguments: the service and
// operation plus the value(s) of each option the spec uses (see SIGNATURE_OPTIONS), including the exact
// --query. The exact argv is checked once, by AC-16. A call whose operation the spec knows but whose
// options (above all the --query) are not exactly the ones of section 7 gets the answer `None`, which
// is what the CLI prints for a JMESPath that finds nothing (the lesson of spec 042, AC-42: lab 03's
// verify.sh asked the wrong JSON shape and a too kind stub hid it). A rule can hold a list of answers:
// the n-th call gets the n-th answer and the last one repeats (the polls of AC-17). The curl stub
// answers by the order of its calls only; its argv is checked by AC-16.
//
// Every run gets its own temporary directory; nothing of it is left behind.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LAB_DIR = join(REPO_ROOT, 'labs', '04-alb-asg-self-healing');

// ---- Fixture data ---------------------------------------------------------------------------------

const ACCT = '111122223333';
const VPC = 'vpc-0a1b2c3d4e5f60718';
const AZ1 = 'eu-west-1a';
const AZ2 = 'eu-west-1b';
const AZ3 = 'eu-west-1c';
const ALB = `arn:aws:elasticloadbalancing:eu-west-1:${ACCT}:loadbalancer/app/fg-lab04-web/0123456789abcdef`;
const DNS = 'fg-lab04-web-1234567890.eu-west-1.elb.amazonaws.com';
const TG = `arn:aws:elasticloadbalancing:eu-west-1:${ACCT}:targetgroup/fg-lab04-web/0123456789abcdef`;
const OTHER_TG = `arn:aws:elasticloadbalancing:eu-west-1:${ACCT}:targetgroup/other/fedcba9876543210`;
const ASG = 'fg-lab04-web';
const ALB_SG = 'sg-0a1b2c3d4e5f60001';
const WEB_SG = 'sg-0a1b2c3d4e5f60002';
const PRIV1 = 'subnet-0a1b2c3d4e5f60003';
const PRIV2 = 'subnet-0a1b2c3d4e5f60004';
const PUB1 = 'subnet-0a1b2c3d4e5f60005';
const PRIV_RT = 'rtb-0a1b2c3d4e5f60002';
const IGW = 'igw-0a1b2c3d4e5f60718';
const NAT = 'nat-0a1b2c3d4e5f60718';
const INST1 = 'i-0a1b2c3d4e5f60001';
const INST2 = 'i-0a1b2c3d4e5f60002';
/** Documentation address (RFC 5737). */
const PUBLIC_IP = '203.0.113.45';
const PROFILE_ARN = `arn:aws:iam::${ACCT}:instance-profile/other`;
const PROJECT = 'saa-c03-field-guide';
const STUB_ERR = 'stub-stderr-must-never-be-printed';

/** The ten terraform outputs, in the order of section 6 of the spec. */
const OUTPUT_NAMES = [
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
] as const;

type OutputName = (typeof OUTPUT_NAMES)[number];

const OUTPUT_VALUES: Record<OutputName, string> = {
  vpc_id: VPC,
  availability_zones: `${AZ1} ${AZ2}`,
  alb_arn: ALB,
  alb_dns_name: DNS,
  target_group_arn: TG,
  asg_name: ASG,
  alb_security_group_id: ALB_SG,
  web_security_group_id: WEB_SG,
  private_subnet_ids: `${PRIV1} ${PRIV2}`,
  private_route_table_id: PRIV_RT,
};

/** The fifteen checks, in the order of the table of section 7 (and of stdout). */
const ORDER: string[] = [
  'alb',
  'alb-azs',
  'alb-zonal-shift',
  'listener',
  'health-check',
  'deregistration-delay',
  'asg',
  'asg-target-group',
  'asg-subnets',
  'instances-private',
  'web-sg-rules',
  'private-no-route-out',
  'no-nat-gateway',
  'targets-healthy',
  'serves-both-azs',
];

/** Checks 1 to 13: one aws call each. */
const AWS_CHECKS: string[] = ORDER.slice(0, 13);

const FIELD_SEPARATOR = '\t';
const row = (...fields: string[]): string => fields.join(FIELD_SEPARATOR);

// ---- Replies --------------------------------------------------------------------------------------

/** What a stub answers. `quiet`: no stdout at all (not even the line end). */
interface Reply {
  out: string;
  exit: number;
  err: string;
  quiet: boolean;
}

const ok = (out: string): Reply => ({ out, exit: 0, err: '', quiet: false });
const failing = (exit: number, err: string): Reply => ({ out: '', exit, err, quiet: true });
const quiet = (): Reply => ({ out: '', exit: 0, err: '', quiet: true });

// ---- The answers of a healthy stack ---------------------------------------------------------------

const LISTENER_ROW = row('80', 'HTTP', 'forward', TG);
const HEALTH_CHECK_FIELDS = ['HTTP', '80', 'instance', '/', '10', '5', '2', '2', '200'];
const ASG_FIELDS = ['2', '4', '2', 'ELB', '120'];
const INSTANCE_ROW = row('t4g.nano', 'None', 'None', 'None', 'required', PROJECT);
const WEB_SG_RULE_ROW = row('False', 'tcp', '80', '80', ALB_SG);
const LOCAL_ROUTE_ROW = row('10.40.0.0/16', 'local');

const instanceAnswer = (id: string, zone: string): string => `instance=${id} az=${zone}`;
const twoRows = (first: string, second: string): string => `${first}\n${second}`;

// ---- The aws calls of the spec table --------------------------------------------------------------

const QUERIES = {
  alb: 'LoadBalancers[0].[State.Code,Scheme,Type,IpAddressType]',
  albAzs: 'LoadBalancers[0].AvailabilityZones[].ZoneName',
  zonalShift: "Attributes[?Key=='zonal_shift.config.enabled'].Value",
  listener: 'Listeners[].[Port,Protocol,DefaultActions[0].Type,DefaultActions[0].TargetGroupArn]',
  healthCheck:
    'TargetGroups[0].[Protocol,Port,TargetType,HealthCheckPath,HealthCheckIntervalSeconds,HealthCheckTimeoutSeconds,HealthyThresholdCount,UnhealthyThresholdCount,Matcher.HttpCode]',
  deregistration: "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value",
  asg: 'AutoScalingGroups[0].[MinSize,MaxSize,DesiredCapacity,HealthCheckType,HealthCheckGracePeriod]',
  asgTargetGroup: 'AutoScalingGroups[0].TargetGroupARNs',
  asgSubnets: 'AutoScalingGroups[0].VPCZoneIdentifier',
  // The query holds a plain `|`: the backslash of the Markdown table is only Markdown escaping.
  instances:
    "Reservations[].Instances[].[InstanceType,PublicIpAddress,KeyName,IamInstanceProfile.Arn,MetadataOptions.HttpTokens,Tags[?Key=='project'].Value|[0]]",
  webSgRules:
    'SecurityGroupRules[].[IsEgress,IpProtocol,FromPort,ToPort,ReferencedGroupInfo.GroupId]',
  routes: 'RouteTables[0].Routes[].[DestinationCidrBlock,GatewayId]',
  natGateways: 'NatGateways[].NatGatewayId',
  targetHealth: 'TargetHealthDescriptions[].TargetHealth.State',
};

const IDENTITY = ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'];

/** One aws call of the spec table. */
interface Call {
  /** Unique name of the call (the id of its check). */
  call: string;
  argv: string[];
  /** The n-th call gets the n-th reply; the last one repeats. */
  replies: Reply[];
}

function call(name: string, argv: string[], ...replies: Reply[]): Call {
  return { call: name, argv, replies };
}

/** Every aws call of the spec, in the order of the table. */
function calls(): Call[] {
  return [
    call(
      'alb',
      [
        'elbv2',
        'describe-load-balancers',
        '--load-balancer-arns',
        ALB,
        '--query',
        QUERIES.alb,
        '--output',
        'text',
      ],
      ok(row('active', 'internet-facing', 'application', 'ipv4')),
    ),
    call(
      'alb-azs',
      [
        'elbv2',
        'describe-load-balancers',
        '--load-balancer-arns',
        ALB,
        '--query',
        QUERIES.albAzs,
        '--output',
        'text',
      ],
      ok(row(AZ1, AZ2)),
    ),
    call(
      'alb-zonal-shift',
      [
        'elbv2',
        'describe-load-balancer-attributes',
        '--load-balancer-arn',
        ALB,
        '--query',
        QUERIES.zonalShift,
        '--output',
        'text',
      ],
      ok('true'),
    ),
    call(
      'listener',
      [
        'elbv2',
        'describe-listeners',
        '--load-balancer-arn',
        ALB,
        '--query',
        QUERIES.listener,
        '--output',
        'text',
      ],
      ok(LISTENER_ROW),
    ),
    call(
      'health-check',
      [
        'elbv2',
        'describe-target-groups',
        '--target-group-arns',
        TG,
        '--query',
        QUERIES.healthCheck,
        '--output',
        'text',
      ],
      ok(row(...HEALTH_CHECK_FIELDS)),
    ),
    call(
      'deregistration-delay',
      [
        'elbv2',
        'describe-target-group-attributes',
        '--target-group-arn',
        TG,
        '--query',
        QUERIES.deregistration,
        '--output',
        'text',
      ],
      ok('30'),
    ),
    call(
      'asg',
      [
        'autoscaling',
        'describe-auto-scaling-groups',
        '--auto-scaling-group-names',
        ASG,
        '--query',
        QUERIES.asg,
        '--output',
        'text',
      ],
      ok(row(...ASG_FIELDS)),
    ),
    call(
      'asg-target-group',
      [
        'autoscaling',
        'describe-auto-scaling-groups',
        '--auto-scaling-group-names',
        ASG,
        '--query',
        QUERIES.asgTargetGroup,
        '--output',
        'text',
      ],
      ok(TG),
    ),
    call(
      'asg-subnets',
      [
        'autoscaling',
        'describe-auto-scaling-groups',
        '--auto-scaling-group-names',
        ASG,
        '--query',
        QUERIES.asgSubnets,
        '--output',
        'text',
      ],
      ok(`${PRIV1},${PRIV2}`),
    ),
    call(
      'instances-private',
      [
        'ec2',
        'describe-instances',
        '--filters',
        `Name=tag:aws:autoscaling:groupName,Values=${ASG}`,
        'Name=instance-state-name,Values=pending,running',
        '--query',
        QUERIES.instances,
        '--output',
        'text',
      ],
      ok(twoRows(INSTANCE_ROW, INSTANCE_ROW)),
    ),
    call(
      'web-sg-rules',
      [
        'ec2',
        'describe-security-group-rules',
        '--filters',
        `Name=group-id,Values=${WEB_SG}`,
        '--query',
        QUERIES.webSgRules,
        '--output',
        'text',
      ],
      ok(WEB_SG_RULE_ROW),
    ),
    call(
      'private-no-route-out',
      [
        'ec2',
        'describe-route-tables',
        '--route-table-ids',
        PRIV_RT,
        '--query',
        QUERIES.routes,
        '--output',
        'text',
      ],
      ok(LOCAL_ROUTE_ROW),
    ),
    call(
      'no-nat-gateway',
      [
        'ec2',
        'describe-nat-gateways',
        '--filter',
        `Name=vpc-id,Values=${VPC}`,
        'Name=state,Values=pending,available',
        '--query',
        QUERIES.natGateways,
        '--output',
        'text',
      ],
      ok(''),
    ),
    call(
      'targets-healthy',
      [
        'elbv2',
        'describe-target-health',
        '--target-group-arn',
        TG,
        '--query',
        QUERIES.targetHealth,
        '--output',
        'text',
      ],
      ok(row('healthy', 'healthy')),
    ),
  ];
}

const ALL_CALLS: string[] = calls().map((entry) => entry.call);

function callOf(name: string): Call {
  const found = calls().find((candidate) => candidate.call === name);
  if (found === undefined) throw new Error(`no call ${name}`);
  return found;
}

/** The aws operations the spec lists (section 7), as `<service> <operation>`. */
const ALLOWED_OPERATIONS: string[] = [
  ...new Set([
    'sts get-caller-identity',
    ...calls().map((entry) => `${entry.argv[0] ?? ''} ${entry.argv[1] ?? ''}`),
  ]),
];

/** The curl call of section 7: `curl -sS --max-time 5 http://<dns>/`. */
const CURL_ARGV = ['-sS', '--max-time', '5', `http://${DNS}/`];

/**
 * The options the stub answers by, as `name=values` pairs (a value list is joined by a space); the
 * shell in AWS_PRELUDE builds the same string. Options are matched by name wherever they stand, so
 * the order of the arguments is free (AC-16 checks it).
 */
const SIGNATURE_OPTIONS: [string, string][] = [
  ['--query', 'q'],
  ['--load-balancer-arns', 'lbs'],
  ['--load-balancer-arn', 'lb'],
  ['--auto-scaling-group-names', 'asgs'],
  ['--target-group-arns', 'tgs'],
  ['--target-group-arn', 'tg'],
  ['--filters', 'flts'],
  ['--filter', 'flt'],
  ['--route-table-ids', 'rt'],
];

function signature(argv: string[]): string {
  const values = new Map<string, string[]>(SIGNATURE_OPTIONS.map(([option]) => [option, []]));
  let current = '';
  for (const argument of argv) {
    if (argument.startsWith('--')) {
      current = argument;
      continue;
    }
    values.get(current)?.push(argument);
  }
  return [
    `${argv[0]} ${argv[1]}`,
    ...SIGNATURE_OPTIONS.map(([option, name]) => `${name}=${(values.get(option) ?? []).join(' ')}`),
  ].join('|');
}

// ---- Fixtures -------------------------------------------------------------------------------------

interface Fixture {
  /** aws replies by call name. */
  replies: Record<string, Reply[]>;
  /** terraform replies by output name. */
  outputs: Record<OutputName, Reply>;
  /** The reply of `aws sts get-caller-identity`. */
  identity: Reply;
  /** The replies of the curl calls: the n-th call gets the n-th reply; the last one repeats. */
  curl: Reply[];
  /** The line end of every answer. */
  eol: string;
}

function healthy(): Fixture {
  const replies: Record<string, Reply[]> = {};
  for (const entry of calls()) replies[entry.call] = entry.replies;
  const outputs = {} as Record<OutputName, Reply>;
  for (const name of OUTPUT_NAMES) outputs[name] = ok(OUTPUT_VALUES[name]);
  return {
    replies,
    outputs,
    identity: ok(ACCT),
    curl: [ok(instanceAnswer(INST1, AZ1)), ok(instanceAnswer(INST2, AZ2))],
    eol: '\n',
  };
}

/** A healthy fixture where the answers of one aws call are replaced. */
function answering(name: string, ...replies: Reply[]): Fixture {
  if (!ALL_CALLS.includes(name)) throw new Error(`no call ${name}`);
  const fixture = healthy();
  fixture.replies[name] = replies;
  return fixture;
}

/** A healthy fixture where the answers of the curl calls are replaced. */
function curling(...replies: Reply[]): Fixture {
  const fixture = healthy();
  fixture.curl = replies;
  return fixture;
}

const answers = (...texts: string[]): Reply[] => texts.map((text) => ok(text));

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
}

/** The shell lines that answer with one reply. */
function replyLines(dir: string, file: string, reply: Reply, eol: string): string[] {
  writeFileSync(join(dir, `${file}.out`), reply.quiet ? '' : reply.out + eol);
  if (reply.err !== '') writeFileSync(join(dir, `${file}.err`), reply.err + eol);
  return [
    `cat "$D/${file}.out"`,
    reply.err !== '' ? `cat "$D/${file}.err" >&2` : ':',
    `exit ${reply.exit}`,
  ];
}

function ruleBody(dir: string, name: string, rule: Rule): string {
  if (rule.replies.length === 1) {
    return replyLines(dir, name, rule.replies[0] ?? ok(''), rule.eol).join('\n    ');
  }
  const counter = `$FAKE_LOG_DIR/count-${name}`;
  const branches = rule.replies.map((reply, index) => {
    const pattern = index === rule.replies.length - 1 ? '*' : String(index);
    const body = replyLines(dir, `${name}-${index}`, reply, rule.eol).join('\n        ');
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
  fallback: string,
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
${fallback}
    printf '%s\\n' "${name} $*" >> "$FAKE_LOG_DIR/unexpected.log"
    exit 97;;
esac
`;
}

/**
 * Logs the environment the call saw, then builds $key (the same string as signature()). A call of an
 * operation the spec lists, with options that are not exactly the ones of the spec (the --query above
 * all), is answered `None` with exit 0 (the AWS CLI prints None for a JMESPath that finds nothing).
 */
const AWS_PRELUDE = [
  'printf \'%s|%s|%s\\n\' "${AWS_REGION-<unset>}" "${AWS_DEFAULT_REGION-<unset>}" "${AWS_PAGER-<unset>}" >> "$FAKE_LOG_DIR/aws-env.log"',
  SIGNATURE_OPTIONS.map((_option, index) => `v${index}=''`).join('; '),
  "cur=''",
  'for a in "$@"; do',
  '  case "$a" in',
  '    --*) cur="$a"; continue;;',
  '  esac',
  '  case "$cur" in',
  ...SIGNATURE_OPTIONS.map(
    ([option], index) => `    ${option}) v${index}="\${v${index}:+\${v${index}} }$a";;`,
  ),
  '  esac',
  'done',
  `key="$1 $2${SIGNATURE_OPTIONS.map(([, name], index) => `|${name}=$v${index}`).join('')}"`,
].join('\n');

const AWS_FALLBACK = `    case "$1 $2" in
      ${ALLOWED_OPERATIONS.map((operation) => sq(operation)).join('|')})
        echo None
        exit 0;;
    esac`;

const CURL_RULE_KEY = 'curl';

const TOOLS = ['terraform', 'aws', 'curl'] as const;
type Tool = (typeof TOOLS)[number];

function writeStubs(fixture: Fixture, bin: string, rulesDir: string, tools: readonly Tool[]): void {
  const terraformRules: Rule[] = OUTPUT_NAMES.map((name) => ({
    key: `output -raw ${name}`,
    replies: [fixture.outputs[name]],
    eol: fixture.eol,
  }));
  const awsRules: Rule[] = [
    { key: signature(IDENTITY), replies: [fixture.identity], eol: fixture.eol },
    ...calls().map((entry) => ({
      key: signature(entry.argv),
      replies: fixture.replies[entry.call] ?? [ok('')],
      eol: fixture.eol,
    })),
  ];
  const curlRules: Rule[] = [{ key: CURL_RULE_KEY, replies: fixture.curl, eol: fixture.eol }];
  const scripts: Record<Tool, string> = {
    terraform: stubScript('terraform', '', '"$1 $2 $3"', terraformRules, rulesDir, ''),
    aws: stubScript('aws', AWS_PRELUDE, '"$key"', awsRules, rulesDir, AWS_FALLBACK),
    curl: stubScript('curl', '', `'${CURL_RULE_KEY}'`, curlRules, rulesDir, ''),
  };
  for (const tool of tools) writeFileSync(join(bin, tool), scripts[tool], { mode: 0o755 });
  // A sleep that does not sleep: it only logs its arguments, in the order of the other calls.
  writeFileSync(
    join(bin, 'sleep'),
    `#!${stubShebang()}\n{ printf 'sleep'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG_DIR/calls.log"\nexit 0\n`,
    { mode: 0o755 },
  );
}

interface RunOptions {
  args?: string[];
  extraEnv?: Record<string, string>;
  /** Stubs that exist (default: all three). */
  tools?: readonly Tool[];
  /** PATH holds only the stub directory (no system directories). */
  strictPath?: boolean;
  /** VERIFY_POLL_SECONDS: a value, or null for "not set" (default: "0"). */
  poll?: string | null;
  label?: string;
}

/** One aws call: its arguments (after `aws`) and the environment it saw. */
interface AwsRun {
  argv: string[];
  region: string;
  defaultRegion: string;
  pager: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together. */
  all: string;
  /** Every terraform, aws, curl and sleep call, in order: [name, ...arguments]. */
  calls: string[][];
  /** Every aws call with the environment it saw. */
  aws: AwsRun[];
  /** The arguments of every curl call. */
  curl: string[][];
  /** The arguments of every sleep call. */
  sleeps: string[];
  /** Calls a stub had no answer for. */
  unexpected: string[];
}

const RUNS: { label: string; result: RunResult }[] = [];

function requireScript(): void {
  if (!existsSync(join(LAB_DIR, 'verify.sh'))) {
    throw new Error('missing file: labs/04-alb-asg-self-healing/verify.sh');
  }
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
    const child = spawn(bashPath(), args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      done({ status: code, stdout, stderr });
    });
  });
}

function parseAws(callLines: string[][], envLines: string[]): AwsRun[] {
  const runs: AwsRun[] = [];
  let index = 0;
  for (const line of callLines) {
    if (line[0] !== 'aws') continue;
    const [region = '', defaultRegion = '', pager = ''] = (envLines[index] ?? '').split('|');
    runs.push({ argv: line.slice(1), region, defaultRegion, pager });
    index += 1;
  }
  return runs;
}

async function runVerify(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  requireScript();
  const dir = mkdtempSync(join(tmpdir(), 'lab04-verify-'));
  try {
    const logs = join(dir, 'logs');
    const bin = join(dir, 'bin');
    const rules = join(logs, 'rules');
    mkdirSync(logs);
    mkdirSync(bin);
    mkdirSync(rules);
    writeStubs(fixture, bin, rules, options.tools ?? TOOLS);

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
        key === 'SHELLOPTS' ||
        key === 'BASH_ENV'
      ) {
        delete env[key];
      }
    }
    env['PATH'] = options.strictPath === true ? bin : `${bin}${delimiter}${originalPath}`;
    env['FAKE_LOG_DIR'] = logs.replace(/\\/g, '/');
    env['TMPDIR'] = dir.replace(/\\/g, '/');
    const poll = options.poll === undefined ? '0' : options.poll;
    if (poll !== null) env['VERIFY_POLL_SECONDS'] = poll;
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    // cwd = the lab folder, the script given as a relative path.
    const done = await execBash(['verify.sh', ...(options.args ?? [])], LAB_DIR, env);
    const callLines = readLines(join(logs, 'calls.log')).map((line) => line.split('\t'));
    const result: RunResult = {
      status: done.status,
      stdout: done.stdout,
      stderr: done.stderr,
      all: done.stdout + done.stderr,
      calls: callLines,
      aws: parseAws(callLines, readLines(join(logs, 'aws-env.log'))),
      curl: callLines.filter((line) => line[0] === 'curl').map((line) => line.slice(1)),
      sleeps: callLines.filter((line) => line[0] === 'sleep').map((line) => line[1] ?? ''),
      unexpected: readLines(join(logs, 'unexpected.log')),
    };
    RUNS.push({ label: options.label ?? 'unnamed run', result });
    return result;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp dir must not fail a test.
    }
  }
}

// ---- Assertions on a run --------------------------------------------------------------------------

function outLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** An exact line, or `true` for "FAIL: <id>: <some reason>". */
type Expected = string | true;

/** The exact line of a check that failed with `reason`. */
const failLine = (id: string, reason: string): string => `FAIL: ${id}: ${reason}`;
const COULD_NOT_ASK = 'could not ask AWS';

/**
 * The stdout of a run: one line per check in table order, then the summary. `lines` replaces the
 * default line of a check; the summary and the exit code follow from the lines.
 */
function expectRun(result: RunResult, lines: Record<string, Expected> = {}): void {
  const actual = outLines(result.stdout);
  const expected: string[] = [];
  let passed = 0;
  let failed = 0;
  ORDER.forEach((id, index) => {
    const wanted = lines[id];
    let line: string;
    if (wanted === true) {
      line = actual[index] ?? '';
      expect(line).toMatch(new RegExp(`^FAIL: ${id}: \\S`));
    } else if (wanted !== undefined) {
      line = wanted;
    } else {
      line = `ok: ${id}`;
    }
    if (line.startsWith('ok:')) passed += 1;
    else failed += 1;
    expected.push(line);
  });
  expected.push(
    failed === 0
      ? `verify: ok (${passed} passed, 0 skipped)`
      : `verify: FAIL (${failed} failed, ${passed} passed, 0 skipped)`,
  );
  expect(actual).toEqual(expected);
  expect(result.status).toBe(failed === 0 ? 0 : 1);
  expect(result.unexpected, 'a stub was called in a way the test has no answer for').toEqual([]);
}

const lastLine = (result: RunResult): string | undefined => outLines(result.stdout).at(-1);

const IDENTITY_SIGNATURE = signature(IDENTITY);
const isIdentity = (run: AwsRun): boolean => signature(run.argv) === IDENTITY_SIGNATURE;

/** Every aws call except the one that asks for the account ID. */
const checkRuns = (result: RunResult): AwsRun[] => result.aws.filter((run) => !isIdentity(run));

/** The calls of the run that ask what the named call asks. */
function runsOf(result: RunResult, name: string): AwsRun[] {
  const wanted = signature(callOf(name).argv);
  return result.aws.filter((run) => signature(run.argv) === wanted);
}

/** The sleeps made before the first curl call (the waits of check 14). */
function sleepsBeforeCurl(result: RunResult): string[] {
  const first = result.calls.findIndex((line) => line[0] === 'curl');
  const part = first === -1 ? result.calls : result.calls.slice(0, first);
  return part.filter((line) => line[0] === 'sleep').map((line) => line[1] ?? '');
}

/** The sleeps made after the first curl call (the waits of check 15). */
function sleepsAfterFirstCurl(result: RunResult): string[] {
  const first = result.calls.findIndex((line) => line[0] === 'curl');
  const part = first === -1 ? [] : result.calls.slice(first);
  return part.filter((line) => line[0] === 'sleep').map((line) => line[1] ?? '');
}

/** Lines a run that went on would print. */
const verdictLines = (stdout: string): string[] =>
  outLines(stdout).filter((line) => /^(ok|FAIL|skip|verify):/.test(line));

/** What no run may print: the IDs, ARNs, DNS name and account ID of the fixture, and any stub stderr. */
function leaks(text: string): string[] {
  const found: string[] = [];
  if (/\d{12}/.test(text)) found.push('a 12-digit number');
  if (/(?<![A-Za-z0-9])(?:vpc|subnet|sg|rtb|i|nat|igw)-[0-9a-f]{8,}/.test(text)) {
    found.push('a resource ID');
  }
  for (const needle of [
    'arn:',
    'elb.amazonaws.com',
    DNS,
    VPC,
    ALB_SG,
    WEB_SG,
    PRIV1,
    PRIV2,
    PUB1,
    PRIV_RT,
    IGW,
    NAT,
    INST1,
    INST2,
    PUBLIC_IP,
    STUB_ERR,
  ]) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

// =================================================================================================
// AC-14: healthy
// =================================================================================================

describe('verify.sh: healthy stack', () => {
  const EXPECTED_STDOUT = [...ORDER.map((id) => `ok: ${id}`), 'verify: ok (15 passed, 0 skipped)'];

  test.concurrent('AC-14: stdout is the 15 ok lines in table order, then the summary', async () => {
    const result = await runVerify(healthy(), { label: 'AC-14 healthy' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${EXPECTED_STDOUT.join('\n')}\n`);
    expect(result.unexpected).toEqual([]);
  });

  test.concurrent(
    'AC-14: the table has fifteen checks and the run is expectRun-clean',
    async () => {
      expect(ORDER).toHaveLength(15);
      const result = await runVerify(healthy(), { label: 'AC-14 order' });
      expectRun(result);
    },
  );

  test.concurrent('AC-14: the two zones may be listed in either order', async () => {
    const result = await runVerify(answering('alb-azs', ok(row(AZ2, AZ1))), {
      label: 'AC-14 zones reversed',
    });
    expectRun(result);
  });

  test.concurrent('AC-14: the two subnets may be listed in either order', async () => {
    const result = await runVerify(answering('asg-subnets', ok(`${PRIV2},${PRIV1}`)), {
      label: 'AC-14 subnets reversed',
    });
    expectRun(result);
  });

  test.concurrent('AC-14: no-nat-gateway is ok when AWS prints nothing at all', async () => {
    const result = await runVerify(answering('no-nat-gateway', quiet()), {
      label: 'AC-14 no nat quiet',
    });
    expectRun(result);
  });

  test.concurrent(
    'AC-14: instances-private is ok with more than two instances (a replacement is pending)',
    async () => {
      const lines = [INSTANCE_ROW, INSTANCE_ROW, INSTANCE_ROW].join('\n');
      const result = await runVerify(answering('instances-private', ok(lines)), {
        label: 'AC-14 three instances',
      });
      expectRun(result);
    },
  );

  test.concurrent('AC-14: serves-both-azs is ok when the second zone answers first', async () => {
    const result = await runVerify(
      curling(...answers(instanceAnswer(INST2, AZ2), instanceAnswer(INST1, AZ1))),
      { label: 'AC-14 zones answer reversed' },
    );
    expectRun(result);
  });

  test.concurrent('AC-14: serves-both-azs is ok with several instances in one zone', async () => {
    const result = await runVerify(
      curling(
        ...answers(
          instanceAnswer(INST1, AZ1),
          instanceAnswer('i-0a1b2c3d4e5f60003', AZ1),
          instanceAnswer(INST2, AZ2),
        ),
      ),
      { label: 'AC-14 three answers' },
    );
    expectRun(result);
  });
});

// =================================================================================================
// AC-15: each check fails on its own wrong answer
// =================================================================================================

interface Case {
  name: string;
  /** The call whose answer is replaced. */
  call: string;
  /** The check that must fail (the id of the call). */
  id: string;
  answer: string;
  /** The exact reason, when the spec gives one. */
  reason?: string;
}

const wrong = (name: string, callName: string, answer: string, reason?: string): Case => ({
  name,
  call: callName,
  id: callName,
  answer,
  ...(reason === undefined ? {} : { reason }),
});

/** The fields of a tab separated row with the one at `index` replaced. */
const withField = (fields: string[], index: number, value: string): string =>
  row(...fields.map((field, at) => (at === index ? value : field)));

const HEALTH_CHECK_WRONG = ['HTTPS', '8080', 'ip', '/health', '30', '6', '5', '3', '200-299'];
const HEALTH_CHECK_FIELD_NAMES = [
  'the protocol',
  'the port',
  'the target type',
  'the path',
  'the interval',
  'the timeout',
  'the healthy threshold',
  'the unhealthy threshold',
  'the matcher',
];
const ASG_WRONG = ['1', '5', '3', 'EC2', '0'];
const ASG_FIELD_NAMES = [
  'MinSize',
  'MaxSize',
  'DesiredCapacity',
  'HealthCheckType',
  'grace period',
];

const PUBLIC_IP_REASON = 'an instance has a public IP, a key pair, a role or optional IMDS';

/** An instance row with one column replaced. */
const instanceRow = (column: number, value: string): string =>
  withField(INSTANCE_ROW.split(FIELD_SEPARATOR), column, value);

const CASES: Case[] = [
  // #1
  wrong('provisioning', 'alb', row('provisioning', 'internet-facing', 'application', 'ipv4')),
  wrong('internal', 'alb', row('active', 'internal', 'application', 'ipv4')),
  wrong('network', 'alb', row('active', 'internet-facing', 'network', 'ipv4')),
  wrong('dualstack', 'alb', row('active', 'internet-facing', 'application', 'dualstack')),
  wrong('None', 'alb', 'None'),
  // #2
  wrong('one zone', 'alb-azs', AZ1),
  wrong('a third zone', 'alb-azs', row(AZ1, AZ2, AZ3)),
  wrong('another zone', 'alb-azs', row(AZ1, AZ3)),
  // #3
  wrong('false', 'alb-zonal-shift', 'false'),
  wrong('an empty answer', 'alb-zonal-shift', ''),
  // #4
  wrong('port 443', 'listener', row('443', 'HTTP', 'forward', TG)),
  wrong('HTTPS', 'listener', row('80', 'HTTPS', 'forward', TG)),
  wrong('a redirect', 'listener', row('80', 'HTTP', 'redirect', 'None')),
  wrong('another target group', 'listener', row('80', 'HTTP', 'forward', OTHER_TG)),
  wrong('two listeners', 'listener', twoRows(LISTENER_ROW, row('443', 'HTTPS', 'forward', TG))),
  // #5: each field wrong once
  ...HEALTH_CHECK_WRONG.map((value, index) =>
    wrong(
      `${HEALTH_CHECK_FIELD_NAMES[index] ?? 'a field'} wrong`,
      'health-check',
      withField(HEALTH_CHECK_FIELDS, index, value),
    ),
  ),
  // #6
  wrong('300', 'deregistration-delay', '300'),
  // #7: each field wrong once
  ...ASG_WRONG.map((value, index) =>
    wrong(
      `${ASG_FIELD_NAMES[index] ?? 'a field'} wrong`,
      'asg',
      withField(ASG_FIELDS, index, value),
    ),
  ),
  // #8
  wrong('another ARN', 'asg-target-group', OTHER_TG),
  wrong('two ARNs', 'asg-target-group', row(TG, OTHER_TG)),
  // #9
  wrong('one subnet', 'asg-subnets', PRIV1),
  wrong('a public subnet', 'asg-subnets', `${PRIV1},${PUB1}`),
  // #10
  wrong('one instance', 'instances-private', INSTANCE_ROW, 'fewer than two instances are running'),
  wrong('no instance', 'instances-private', '', 'fewer than two instances are running'),
  wrong(
    'a public IP',
    'instances-private',
    twoRows(INSTANCE_ROW, instanceRow(1, PUBLIC_IP)),
    PUBLIC_IP_REASON,
  ),
  wrong(
    'a key name',
    'instances-private',
    twoRows(INSTANCE_ROW, instanceRow(2, 'my-key')),
    PUBLIC_IP_REASON,
  ),
  wrong(
    'a role ARN',
    'instances-private',
    twoRows(INSTANCE_ROW, instanceRow(3, PROFILE_ARN)),
    PUBLIC_IP_REASON,
  ),
  wrong(
    'optional IMDS',
    'instances-private',
    twoRows(INSTANCE_ROW, instanceRow(4, 'optional')),
    PUBLIC_IP_REASON,
  ),
  wrong(
    'a missing project tag',
    'instances-private',
    twoRows(INSTANCE_ROW, instanceRow(5, 'None')),
    'an instance lacks the project tag',
  ),
  wrong(
    'one instance with a public IP (the count is checked first)',
    'instances-private',
    instanceRow(1, PUBLIC_IP),
    'fewer than two instances are running',
  ),
  wrong(
    'a public IP and a missing tag (the public IP is checked first)',
    'instances-private',
    twoRows(instanceRow(1, PUBLIC_IP), instanceRow(5, 'None')),
    PUBLIC_IP_REASON,
  ),
  // #11
  wrong(
    'an extra egress line',
    'web-sg-rules',
    twoRows(WEB_SG_RULE_ROW, row('True', '-1', 'None', 'None', 'None')),
    'the instances have an egress rule',
  ),
  wrong(
    'an egress line and another ingress line (the egress is said first)',
    'web-sg-rules',
    [
      WEB_SG_RULE_ROW,
      row('False', 'tcp', '22', '22', ALB_SG),
      row('True', '-1', 'None', 'None', 'None'),
    ].join('\n'),
    'the instances have an egress rule',
  ),
  wrong(
    'an ingress rule from a CIDR (no referenced group)',
    'web-sg-rules',
    row('False', 'tcp', '80', '80', 'None'),
    'the instances accept traffic from elsewhere',
  ),
  wrong(
    'port 22',
    'web-sg-rules',
    row('False', 'tcp', '22', '22', ALB_SG),
    'the instances accept traffic from elsewhere',
  ),
  wrong(
    'an extra ingress line',
    'web-sg-rules',
    twoRows(WEB_SG_RULE_ROW, row('False', 'tcp', '80', '80', 'None')),
    'the instances accept traffic from elsewhere',
  ),
  // #12
  wrong(
    'an extra route to an internet gateway',
    'private-no-route-out',
    twoRows(LOCAL_ROUTE_ROW, row('0.0.0.0/0', IGW)),
  ),
  wrong(
    'an extra route to a NAT gateway',
    'private-no-route-out',
    twoRows(LOCAL_ROUTE_ROW, row('0.0.0.0/0', 'None')),
  ),
  wrong('no local route', 'private-no-route-out', ''),
  // #13
  wrong('a NAT gateway', 'no-nat-gateway', NAT),
  wrong('two NAT gateways', 'no-nat-gateway', row(NAT, 'nat-0fedcba987654321f')),
];

const EXIT_254_CASES = AWS_CHECKS.map((id) => ({ id }));

describe('verify.sh: wrong answers', () => {
  test.concurrent.each(CASES)(
    'AC-15: $id fails on $name',
    async ({ name, call: callName, id, answer, reason }) => {
      const result = await runVerify(answering(callName, ok(answer)), {
        label: `AC-15 ${id} ${name}`,
      });
      expectRun(result, { [id]: reason === undefined ? true : failLine(id, reason) });
      expect(lastLine(result)).toMatch(/^verify: FAIL \(1 failed,/);
    },
  );

  test.concurrent.each(EXIT_254_CASES)(
    'AC-15: $id answering exit 254 gives "could not ask AWS"',
    async ({ id }) => {
      const reply = failing(254, `An error occurred (AccessDenied) ${ALB} ${STUB_ERR}`);
      const result = await runVerify(answering(id, reply), { label: `AC-15 ${id} exit 254` });
      expectRun(result, { [id]: failLine(id, COULD_NOT_ASK) });
      expect(lastLine(result)).toMatch(/^verify: FAIL \(1 failed,/);
    },
  );

  // #14
  test.concurrent.each([
    { name: 'unhealthy twice', answer: row('unhealthy', 'unhealthy') },
    { name: 'initial forever', answer: row('initial', 'initial') },
    { name: 'one healthy and one draining', answer: row('healthy', 'draining') },
    { name: 'no target at all', answer: '' },
  ])('AC-15: targets-healthy fails on $name', async ({ name, answer }) => {
    const result = await runVerify(answering('targets-healthy', ok(answer)), {
      label: `AC-15 targets-healthy ${name}`,
    });
    expectRun(result, {
      'targets-healthy': failLine('targets-healthy', 'fewer than two targets became healthy'),
    });
    expect(lastLine(result)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent(
    'AC-15: targets-healthy with every call exiting 254 fails (an error is one more try)',
    async () => {
      const result = await runVerify(answering('targets-healthy', failing(254, STUB_ERR)), {
        label: 'AC-15 targets-healthy exit 254',
      });
      expectRun(result, {
        'targets-healthy': failLine('targets-healthy', 'fewer than two targets became healthy'),
      });
    },
  );

  // #15
  const NOT_FROM_LAB = 'an answer did not come from a lab instance';
  const NOT_BOTH = 'the load balancer did not answer from both AZs';

  test.concurrent.each([
    { name: 'one zone only', replies: answers(instanceAnswer(INST1, AZ1)), reason: NOT_BOTH },
    { name: 'an HTML answer', replies: answers('<html>'), reason: NOT_FROM_LAB },
    {
      name: 'an answer with a third zone',
      replies: answers(instanceAnswer(INST1, AZ3)),
      reason: NOT_FROM_LAB,
    },
    {
      name: 'an instance ID that is not hexadecimal',
      replies: answers('instance=i-zzzzzzzz az=eu-west-1a'),
      reason: NOT_FROM_LAB,
    },
    {
      name: 'text after the zone',
      replies: answers(`${instanceAnswer(INST1, AZ1)} extra`),
      reason: NOT_FROM_LAB,
    },
    {
      name: 'a good answer, then an HTML one',
      replies: answers(instanceAnswer(INST1, AZ1), '<html>'),
      reason: NOT_FROM_LAB,
    },
    { name: 'an empty answer', replies: answers(''), reason: NOT_FROM_LAB },
    { name: 'a curl that always exits 6', replies: [failing(6, STUB_ERR)], reason: NOT_BOTH },
  ])('AC-15: serves-both-azs fails on $name', async ({ name, replies, reason }) => {
    const result = await runVerify(curling(...replies), { label: `AC-15 serves-both-azs ${name}` });
    expectRun(result, { 'serves-both-azs': failLine('serves-both-azs', reason) });
    expect(lastLine(result)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent(
    'AC-15: serves-both-azs ignores the answer of a curl that exits non-zero',
    async () => {
      const result = await runVerify(
        curling(
          { out: '<html>', exit: 6, err: STUB_ERR, quiet: false },
          { out: '<html>', exit: 28, err: STUB_ERR, quiet: false },
          ok(instanceAnswer(INST1, AZ1)),
          ok(instanceAnswer(INST2, AZ2)),
        ),
        { label: 'AC-15 serves-both-azs curl errors first' },
      );
      expectRun(result);
    },
  );
});

// =================================================================================================
// AC-16: the argv of every call
// =================================================================================================

describe('verify.sh: the arguments of every call', () => {
  test.concurrent('AC-16: every aws call has exactly the argv of the table, in order', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 aws argv' });
    expect(checkRuns(result).map((run) => run.argv)).toEqual(calls().map((entry) => entry.argv));
  });

  test.concurrent(
    'AC-16: every --query value is one argument, byte for byte (check 10 holds a plain |)',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-16 queries' });
      const queries = checkRuns(result).map((run) => run.argv[run.argv.indexOf('--query') + 1]);
      expect(queries).toEqual(Object.values(QUERIES));
      const instances = queries[9] ?? '';
      expect(instances).toContain('Value|[0]]');
      expect(instances).not.toContain('\\');
    },
  );

  test.concurrent(
    'AC-16: the account ID is asked once, with --query Account --output text',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-16 identity' });
      expect(result.aws.filter(isIdentity).map((run) => run.argv)).toEqual([IDENTITY]);
    },
  );

  test.concurrent('AC-16: every curl call is exactly -sS --max-time 5 http://<dns>/', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 curl argv' });
    expect(result.curl.length).toBeGreaterThan(0);
    for (const argv of result.curl) expect(argv).toEqual(CURL_ARGV);
  });

  test.concurrent(
    'AC-16: every aws call runs in eu-west-1 with an empty pager, whatever the caller sets',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-16 environment',
        extraEnv: { AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', AWS_PAGER: 'less' },
      });
      expect(result.aws.length).toBeGreaterThan(ALL_CALLS.length - 1);
      for (const run of result.aws) {
        expect([run.region, run.defaultRegion, run.pager], run.argv.join(' ')).toEqual([
          'eu-west-1',
          'eu-west-1',
          '',
        ]);
      }
      expectRun(result);
    },
  );
});

// =================================================================================================
// AC-17: polls and sleeps
// =================================================================================================

describe('verify.sh: polls and sleeps', () => {
  const targets = (...texts: string[]): Reply[] => texts.map((text) => ok(text));
  const NOT_HEALTHY = failLine('targets-healthy', 'fewer than two targets became healthy');
  const NOT_BOTH = failLine('serves-both-azs', 'the load balancer did not answer from both AZs');

  test.concurrent(
    'AC-17: targets-healthy asked once when the first answer has two healthy: no sleep before the curl',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-17 targets first' });
      expectRun(result);
      expect(runsOf(result, 'targets-healthy')).toHaveLength(1);
      expect(sleepsBeforeCurl(result)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-17: targets-healthy initial, one healthy, two healthy is ok after three calls and two sleeps',
    async () => {
      const result = await runVerify(
        answering(
          'targets-healthy',
          ...targets(
            row('initial', 'initial'),
            row('healthy', 'initial'),
            row('healthy', 'healthy'),
          ),
        ),
        { label: 'AC-17 targets third', poll: '3' },
      );
      expectRun(result);
      expect(runsOf(result, 'targets-healthy')).toHaveLength(3);
      expect(sleepsBeforeCurl(result)).toEqual(['3', '3']);
    },
  );

  test.concurrent(
    'AC-17: targets-healthy sleeps 5 seconds between polls without VERIFY_POLL_SECONDS',
    async () => {
      const result = await runVerify(
        answering(
          'targets-healthy',
          ...targets(row('initial', 'initial'), row('healthy', 'healthy')),
        ),
        { label: 'AC-17 targets default sleep', poll: null },
      );
      expectRun(result);
      expect(runsOf(result, 'targets-healthy')).toHaveLength(2);
      expect(sleepsBeforeCurl(result)).toEqual(['5']);
    },
  );

  test.concurrent(
    'AC-17: targets-healthy exiting 254 twice then two healthy is ok after three calls (an error is one more try)',
    async () => {
      const result = await runVerify(
        answering(
          'targets-healthy',
          failing(254, STUB_ERR),
          failing(254, STUB_ERR),
          ok(row('healthy', 'healthy')),
        ),
        { label: 'AC-17 targets errors', poll: '2' },
      );
      expectRun(result);
      expect(runsOf(result, 'targets-healthy')).toHaveLength(3);
      expect(sleepsBeforeCurl(result)).toEqual(['2', '2']);
    },
  );

  test.concurrent(
    'AC-17: targets-healthy never two healthy makes exactly 60 calls and 59 sleeps of VERIFY_POLL_SECONDS',
    async () => {
      const result = await runVerify(
        answering('targets-healthy', ok(row('healthy', 'unhealthy'))),
        { label: 'AC-17 targets never', poll: '4' },
      );
      expectRun(result, { 'targets-healthy': NOT_HEALTHY });
      expect(runsOf(result, 'targets-healthy')).toHaveLength(60);
      expect(sleepsBeforeCurl(result)).toEqual(Array.from({ length: 59 }, () => '4'));
    },
  );

  test.concurrent(
    'AC-17: serves-both-azs with both zones on the first two answers makes exactly 2 curl calls',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-17 curl two' });
      expectRun(result);
      expect(result.curl).toHaveLength(2);
    },
  );

  test.concurrent(
    'AC-17: serves-both-azs with one zone only makes exactly 30 curl calls and 29 sleeps',
    async () => {
      const result = await runVerify(curling(ok(instanceAnswer(INST1, AZ1))), {
        label: 'AC-17 curl one zone',
        poll: '7',
      });
      expectRun(result, { 'serves-both-azs': NOT_BOTH });
      expect(result.curl).toHaveLength(30);
      expect(sleepsAfterFirstCurl(result)).toEqual(Array.from({ length: 29 }, () => '7'));
    },
  );

  test.concurrent(
    'AC-17: serves-both-azs with a curl that always exits 6 makes exactly 30 curl calls and 29 sleeps',
    async () => {
      const result = await runVerify(curling(failing(6, STUB_ERR)), {
        label: 'AC-17 curl exit 6',
        poll: '7',
      });
      expectRun(result, { 'serves-both-azs': NOT_BOTH });
      expect(result.curl).toHaveLength(30);
      expect(sleepsAfterFirstCurl(result)).toEqual(Array.from({ length: 29 }, () => '7'));
    },
  );

  test.concurrent(
    'AC-17: serves-both-azs with a bad answer on call 3 makes exactly 3 curl calls and no further one',
    async () => {
      const result = await runVerify(
        curling(...answers(instanceAnswer(INST1, AZ1), instanceAnswer(INST1, AZ1), '<html>')),
        { label: 'AC-17 curl bad third' },
      );
      expectRun(result, {
        'serves-both-azs': failLine(
          'serves-both-azs',
          'an answer did not come from a lab instance',
        ),
      });
      expect(result.curl).toHaveLength(3);
    },
  );

  test.concurrent(
    'AC-17: serves-both-azs sleeps 5 seconds between curl calls without VERIFY_POLL_SECONDS',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-17 curl default sleep', poll: null });
      expectRun(result);
      expect(sleepsAfterFirstCurl(result)).toEqual(['5']);
    },
  );
});

// =================================================================================================
// AC-19: CRLF
// =================================================================================================

describe('verify.sh: CRLF answers', () => {
  const crlf = (fixture: Fixture): Fixture => ({ ...fixture, eol: '\r\n' });

  test.concurrent('AC-19: CRLF answers give the stdout of AC-14', async () => {
    const result = await runVerify(crlf(healthy()), { label: 'AC-19 crlf' });
    expectRun(result);
    expect(lastLine(result)).toBe('verify: ok (15 passed, 0 skipped)');
    expect(result.stdout).not.toContain('\r');
  });

  test.concurrent('AC-19: a CRLF wrong answer still fails only that check', async () => {
    const fixture = crlf(healthy());
    fixture.replies['asg'] = [ok(withField(ASG_FIELDS, 3, 'EC2'))];
    const result = await runVerify(fixture, { label: 'AC-19 crlf fail' });
    expectRun(result, { asg: true });
  });

  test.concurrent(
    'AC-19: CRLF answers still poll targets-healthy and serves-both-azs',
    async () => {
      const fixture = crlf(healthy());
      fixture.replies['targets-healthy'] = answers(
        row('initial', 'initial'),
        row('healthy', 'healthy'),
      );
      fixture.curl = answers(
        instanceAnswer(INST1, AZ1),
        instanceAnswer(INST1, AZ1),
        instanceAnswer(INST2, AZ2),
      );
      const result = await runVerify(fixture, { label: 'AC-19 crlf polls' });
      expectRun(result);
      expect(result.curl).toHaveLength(3);
    },
  );

  test.concurrent('AC-19: a CRLF bad curl answer is still refused', async () => {
    const result = await runVerify(crlf(curling(ok('<html>'))), { label: 'AC-19 crlf bad answer' });
    expectRun(result, {
      'serves-both-azs': failLine('serves-both-azs', 'an answer did not come from a lab instance'),
    });
  });
});

// =================================================================================================
// AC-20: the script cannot run
// =================================================================================================

describe('verify.sh: usage, tools, outputs and identity', () => {
  /** Nothing of a run happened: no check line, no summary, no aws call but the account ID, no curl. */
  const expectCouldNotRun = (result: RunResult): void => {
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).not.toBe('');
    expect(verdictLines(result.stdout)).toEqual([]);
    expect(checkRuns(result)).toEqual([]);
    expect(result.curl).toEqual([]);
  };

  test.concurrent.each([
    { name: 'on a normal PATH', strictPath: false, tools: TOOLS, args: ['--help'] },
    { name: 'on a PATH without any tool', strictPath: true, tools: [] as Tool[], args: ['--help'] },
    { name: 'with several arguments', strictPath: false, tools: TOOLS, args: ['a', 'b'] },
    { name: 'with an empty argument', strictPath: false, tools: TOOLS, args: [''] },
  ])(
    'AC-20: an argument $name exits 2 with a message and calls nothing',
    async ({ name, strictPath, tools, args }) => {
      const result = await runVerify(healthy(), {
        label: `AC-20 argument ${name}`,
        args,
        tools,
        strictPath,
      });
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).not.toBe('');
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each(TOOLS.map((name) => ({ name })))(
    'AC-20: without $name on PATH the script says so, exits 2 and calls nothing',
    async ({ name }) => {
      const tools = TOOLS.filter((tool) => tool !== name);
      const result = await runVerify(healthy(), {
        label: `AC-20 no ${name}`,
        tools,
        strictPath: true,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(name);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-20: an empty output $name stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = ok('');
      const result = await runVerify(fixture, { label: `AC-20 ${name} empty` });
      expect(result.stderr).toContain(name);
      expectCouldNotRun(result);
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-20: terraform output $name exiting 1 stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = failing(
        1,
        `Error: no outputs for ${ALB} ${ACCT}, run apply first ${STUB_ERR}`,
      );
      const result = await runVerify(fixture, { label: `AC-20 ${name} fails` });
      expect(result.stderr).toContain(name);
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
  ])('AC-20: get-caller-identity $name stops the script with exit 2', async ({ name, reply }) => {
    const fixture = healthy();
    fixture.identity = reply;
    const result = await runVerify(fixture, { label: `AC-20 identity ${name}` });
    expectCouldNotRun(result);
  });

  test.concurrent(
    'AC-20: terraform output -raw is asked once for each of the ten outputs',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-20 terraform calls' });
      const asked = result.calls
        .filter((line) => line[0] === 'terraform')
        .map((line) => line.slice(1).join(' '));
      expect([...asked].sort()).toEqual(OUTPUT_NAMES.map((name) => `output -raw ${name}`).sort());
    },
  );
});

// =================================================================================================
// AC-21: no xtrace leak, nothing written
// =================================================================================================

describe('verify.sh: no xtrace leak, read-only', () => {
  test('AC-21: set +x comes right after set -euo pipefail', () => {
    requireScript();
    expect(readFileSync(join(LAB_DIR, 'verify.sh'), 'utf8')).toMatch(
      /^set -euo pipefail[ \t]*(?:;[ \t]*|\n(?:[ \t]*\n)*)set \+x\b/m,
    );
  });

  test.concurrent(
    'AC-21: a run with SHELLOPTS=xtrace exported still prints no ID, ARN, DNS name or stub stderr',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-21 xtrace',
        extraEnv: { SHELLOPTS: 'xtrace' },
      });
      expect(leaks(result.all)).toEqual([]);
      expectRun(result);
    },
  );

  test.concurrent('AC-21: a healthy run calls only the aws operations of the spec', async () => {
    const result = await runVerify(healthy(), { label: 'AC-21 operations' });
    expect(result.aws.length).toBeGreaterThan(0);
    for (const run of result.aws) {
      expect(ALLOWED_OPERATIONS, run.argv.join(' ')).toContain(`${run.argv[0]} ${run.argv[1]}`);
    }
  });
});

// =================================================================================================
// AC-18 and the audits over every run of this file
// =================================================================================================

describe('verify.sh: nothing private is printed', () => {
  test.concurrent(
    'AC-18: a failing aws call prints none of its stderr, nor an ARN, ID or the account ID',
    async () => {
      const fixture = healthy();
      fixture.replies['alb'] = [
        failing(254, `An error occurred (AccessDenied) ${ALB} ${INST1} ${ACCT} ${STUB_ERR}`),
      ];
      fixture.replies['asg'] = [failing(255, `${TG} ${PRIV1} ${VPC} ${STUB_ERR}`)];
      const result = await runVerify(fixture, { label: 'AC-18 failing calls' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-18: mismatches on values that hold an ID, an ARN or an address print none of them',
    async () => {
      const fixture = healthy();
      fixture.replies['listener'] = [ok(row('80', 'HTTP', 'forward', OTHER_TG))];
      fixture.replies['asg-target-group'] = [ok(OTHER_TG)];
      fixture.replies['asg-subnets'] = [ok(`${PRIV1},${PUB1}`)];
      fixture.replies['instances-private'] = [
        ok(twoRows(instanceRow(1, PUBLIC_IP), instanceRow(3, PROFILE_ARN))),
      ];
      fixture.replies['web-sg-rules'] = [
        ok(twoRows(WEB_SG_RULE_ROW, row('True', '-1', 'None', 'None', 'None'))),
      ];
      fixture.replies['private-no-route-out'] = [
        ok(twoRows(LOCAL_ROUTE_ROW, row('0.0.0.0/0', IGW))),
      ];
      fixture.replies['no-nat-gateway'] = [ok(NAT)];
      const result = await runVerify(fixture, { label: 'AC-18 mismatches' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-18: a bad curl answer and a curl that fails print none of the answer, the host or the stderr',
    async () => {
      const bad = await runVerify(curling(ok(`${instanceAnswer(INST1, AZ3)} ${DNS}`)), {
        label: 'AC-18 curl bad answer',
      });
      expect(bad.status).toBe(1);
      expect(leaks(bad.all)).toEqual([]);
      const broken = await runVerify(
        curling(failing(6, `curl: (6) Could not resolve host: ${DNS} ${STUB_ERR}`)),
        {
          label: 'AC-18 curl fails',
        },
      );
      expect(broken.status).toBe(1);
      expect(leaks(broken.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-18: a terraform output that fails with an ARN prints none of it',
    async () => {
      const fixture = healthy();
      fixture.outputs['alb_arn'] = failing(1, `Error: ${ALB} ${ACCT} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-18 terraform' });
      expect(result.status).toBe(2);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent('AC-18: an identity call that fails prints none of its stderr', async () => {
    const fixture = healthy();
    fixture.identity = failing(255, `Unable to locate credentials ${ACCT} ${STUB_ERR}`);
    const result = await runVerify(fixture, { label: 'AC-18 identity' });
    expect(result.status).toBe(2);
    expect(leaks(result.all)).toEqual([]);
  });
});

describe('verify.sh: audit over every run of this file', () => {
  const MIN_RUNS = 100;

  test('AC-18: no run printed a 12-digit number, an ARN, a DNS name, a resource ID, an address or a stub stderr', () => {
    expect(RUNS.length).toBeGreaterThan(MIN_RUNS);
    const found = RUNS.flatMap(({ label, result }) =>
      leaks(result.all).map((needle) => `${label}: printed ${needle}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-18: no run made a call a stub had no answer for', () => {
    expect(RUNS.length).toBeGreaterThan(MIN_RUNS);
    const found = RUNS.filter(({ result }) => result.unexpected.length > 0).map(
      ({ label, result }) => `${label}: ${result.unexpected.join('; ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-21: no run called an aws operation outside the list of the spec', () => {
    expect(RUNS.length).toBeGreaterThan(MIN_RUNS);
    const found = RUNS.flatMap(({ label, result }) =>
      result.aws
        .map((run) => `${run.argv[0]} ${run.argv[1]}`)
        .filter((operation) => !ALLOWED_OPERATIONS.includes(operation))
        .map((operation) => `${label}: ${operation}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-21: no run called terminate-instances, modify-target-group, start-zonal-shift or update-auto-scaling-group', () => {
    expect(RUNS.length).toBeGreaterThan(MIN_RUNS);
    const forbidden = [
      'terminate-instances',
      'terminate-instance-in-auto-scaling-group',
      'modify-target-group',
      'modify-load-balancer-attributes',
      'start-zonal-shift',
      'cancel-zonal-shift',
      'update-auto-scaling-group',
      'set-desired-capacity',
    ];
    const found = RUNS.filter(({ result }) =>
      result.aws.some((run) => forbidden.some((word) => run.argv.includes(word))),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });

  test('AC-16: no run called curl with anything but -sS --max-time 5 http://<dns>/', () => {
    expect(RUNS.length).toBeGreaterThan(MIN_RUNS);
    const found = RUNS.filter(({ result }) =>
      result.curl.some((argv) => JSON.stringify(argv) !== JSON.stringify(CURL_ARGV)),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });
});

// =================================================================================================
// Review regressions (round 1): AC-30, AC-31, AC-33
// =================================================================================================

describe('verify.sh: review regressions (round 1)', () => {
  const NOT_BOTH_AZS = failLine(
    'serves-both-azs',
    'the load balancer did not answer from both AZs',
  );

  test.concurrent.each([
    { name: 'the first zone twice', answer: row(AZ1, AZ1) },
    { name: 'the second zone twice', answer: row(AZ2, AZ2) },
  ])('AC-30: alb-azs fails when AWS answers $name', async ({ name, answer }) => {
    const result = await runVerify(answering('alb-azs', ok(answer)), {
      label: `AC-30 alb-azs ${name}`,
    });
    expectRun(result, { 'alb-azs': true });
    expect(lastLine(result)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent.each([
    { name: 'the first subnet twice', answer: `${PRIV1},${PRIV1}` },
    { name: 'the second subnet twice', answer: `${PRIV2},${PRIV2}` },
  ])('AC-30: asg-subnets fails when AWS answers $name', async ({ name, answer }) => {
    const result = await runVerify(answering('asg-subnets', ok(answer)), {
      label: `AC-30 asg-subnets ${name}`,
    });
    expectRun(result, { 'asg-subnets': true });
    expect(lastLine(result)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent(
    'AC-31: a curl that exits 28 does not count, even if its stdout names the second zone',
    async () => {
      const result = await runVerify(
        curling(
          { out: instanceAnswer(INST2, AZ2), exit: 28, err: STUB_ERR, quiet: false },
          ok(instanceAnswer(INST1, AZ1)),
        ),
        { label: 'AC-31 curl exit 28 with an answer' },
      );
      expectRun(result, { 'serves-both-azs': NOT_BOTH_AZS });
      expect(result.curl).toHaveLength(30);
    },
  );

  test.concurrent.each(
    OUTPUT_NAMES.filter(
      (name) => name === 'availability_zones' || name === 'private_subnet_ids',
    ).flatMap((name) => [
      { name, words: 'one word', value: name === 'availability_zones' ? AZ1 : PRIV1 },
      {
        name,
        words: 'three words',
        value: name === 'availability_zones' ? `${AZ1} ${AZ2} ${AZ3}` : `${PRIV1} ${PRIV2} ${PUB1}`,
      },
    ]),
  )('AC-33: $name with $words stops the script with exit 2', async ({ name, words, value }) => {
    const fixture = healthy();
    fixture.outputs[name] = ok(value);
    const result = await runVerify(fixture, { label: `AC-33 ${name} ${words}` });
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).not.toBe('');
    expect(verdictLines(result.stdout)).toEqual([]);
    const lastTerraform = result.calls.map((line) => line[0]).lastIndexOf('terraform');
    expect(lastTerraform, 'the outputs were never read').toBeGreaterThanOrEqual(0);
    const after = result.calls
      .slice(lastTerraform + 1)
      .filter((line) => line[0] === 'aws' || line[0] === 'curl');
    expect(after, 'a call was made after the outputs were read').toEqual([]);
    expect(checkRuns(result)).toEqual([]);
    expect(result.curl).toEqual([]);
  });
});
