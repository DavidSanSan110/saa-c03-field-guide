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

// Spec 046 (issue #143), AC-19 to AC-28: labs/05-sqs-lambda-dlq/verify.sh.
//
// verify.sh is executed with bash and stub `terraform`, `aws`, `sleep` and `date` binaries on PATH (the
// approach of lab-03-verify.test.ts). Every call of a stub is logged in its own file of the run's log
// directory, numbered in call order: the arguments are written NUL separated (an argument may hold a
// line end), and for `aws` the environment variables the spec talks about are logged next to it. No
// stub sleeps, and the stubs use shell built-ins only, so that they also run with a PATH that holds no
// system directory.
//
// The aws stub answers by what the call asks, not by the order of its arguments: the service and
// operation plus the value of each option the spec uses (see SIGNATURE_OPTIONS); the exact argv of
// every call is checked once, by AC-21. It answers `None` to any `--query` that would not match the
// shape of the real response (lesson of spec 042 AC-42): `get-queue-attributes` answers live under
// `Attributes.*`, `describe-log-groups` under `logGroups`, `describe-alarms` under `MetricAlarms`.
// A rule can hold a list of answers: the n-th call gets the n-th answer and the last one repeats (the
// polls of AC-22 to AC-24).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const slash = (path: string): string => path.replace(/\\/g, '/');

const LAB = ['labs', '05-sqs-lambda-dlq'];

// ---- Fixture data ---------------------------------------------------------------------------------

const ACCT = '111122223333';
const SRC_URL = `https://sqs.eu-west-1.amazonaws.com/${ACCT}/fg-lab05-orders`;
const SRC_ARN = `arn:aws:sqs:eu-west-1:${ACCT}:fg-lab05-orders`;
const DLQ_URL = `https://sqs.eu-west-1.amazonaws.com/${ACCT}/fg-lab05-orders-dlq`;
const DLQ_ARN = `arn:aws:sqs:eu-west-1:${ACCT}:fg-lab05-orders-dlq`;
const OTHER_ARN = `arn:aws:sqs:eu-west-1:${ACCT}:some-other-queue`;
const FN = 'fg-lab05-orders-consumer';
const UUID = '9f2c1d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const LG = '/aws/lambda/fg-lab05-orders-consumer';
const ALARM = 'fg-lab05-orders-dlq-not-empty';
const ROLE_ARN = `arn:aws:iam::${ACCT}:role/lab/fg-lab05-consumer`;
const BOUNDARY = `arn:aws:iam::${ACCT}:policy/fg-workload-boundary`;
const MSG_GOOD = '11111111-aaaa-4bbb-8ccc-000000000001';
const MSG_POISON = '11111111-aaaa-4bbb-8ccc-000000000002';
const DATE_OUT = '1760000000';
const RUN_ID = `verify-${DATE_OUT}`;
const STUB_ERR = 'stub-stderr-must-never-be-printed';
const SKIP_LIVE =
  'set VERIFY_SEND=1 to try it for real (sends two messages; needs sqs:SendMessage and logs:FilterLogEvents)';

/** The eight terraform outputs, in the order of section 7 of the spec. */
const OUTPUT_NAMES = [
  'source_queue_url',
  'source_queue_arn',
  'dlq_url',
  'dlq_arn',
  'function_name',
  'event_source_mapping_uuid',
  'log_group_name',
  'alarm_name',
] as const;

const OUTPUT_VALUES: Record<(typeof OUTPUT_NAMES)[number], string> = {
  source_queue_url: SRC_URL,
  source_queue_arn: SRC_ARN,
  dlq_url: DLQ_URL,
  dlq_arn: DLQ_ARN,
  function_name: FN,
  event_source_mapping_uuid: UUID,
  log_group_name: LG,
  alarm_name: ALARM,
};

/** The read-only checks and the live checks, in the order of the spec tables (and of stdout). */
const READ_IDS: string[] = [
  'source-queue',
  'redrive-policy',
  'dlq',
  'dlq-redrive-allow',
  'function',
  'function-role',
  'role-may-consume',
  'role-no-log-groups',
  'mapping',
  'log-group',
  'dlq-alarm',
];
const LIVE_IDS: string[] = ['good-processed', 'poison-in-dlq', 'good-once', 'alarm-fires'];
const ORDER: string[] = [...READ_IDS, ...LIVE_IDS];

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

/** An aws failure whose stderr holds everything that must never be printed. */
const awsError = (exit = 254): Reply =>
  failing(
    exit,
    `An error occurred (AccessDenied) when calling the operation: User is not authorized on ${SRC_ARN} ${DLQ_URL} ${UUID} ${ACCT} ${STUB_ERR}`,
  );

const tab = (...values: string[]): string => values.join('\t');

// ---- The aws calls of the spec tables -------------------------------------------------------------

const Q_SOURCE = 'Attributes.[VisibilityTimeout,MessageRetentionPeriod,SqsManagedSseEnabled]';
const Q_REDRIVE = 'Attributes.RedrivePolicy';
const Q_DLQ = 'Attributes.[MessageRetentionPeriod,SqsManagedSseEnabled]';
const Q_ALLOW = 'Attributes.RedriveAllowPolicy';
const Q_FUNCTION = '[Runtime,Architectures[0],Timeout,MemorySize,State,Role]';
const Q_ROLE = 'Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]';
const Q_CONSUME = 'EvaluationResults[].EvalDecision';
const Q_NO_LOG_GROUPS = 'EvaluationResults[0].EvalDecision';
const Q_MAPPING =
  '[State,EventSourceArn,BatchSize,MaximumBatchingWindowInSeconds,FunctionResponseTypes[0]]';
const Q_LOG_GROUP = `logGroups[?logGroupName=='${LG}'].retentionInDays`;
const Q_ALARM_CONFIG =
  'MetricAlarms[0].[Namespace,MetricName,Dimensions[0].Value,ComparisonOperator,Threshold,length(AlarmActions)]';
const Q_BASE = 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]';
const Q_EVENTS = 'length(events)';
const Q_ALARM_STATE = 'MetricAlarms[0].StateValue';

const FILTER_PATTERN = `"processed order ${RUN_ID}"`;

const queueAttributes = (url: string, query: string): string[] => [
  'sqs',
  'get-queue-attributes',
  '--queue-url',
  url,
  '--attribute-names',
  'All',
  '--query',
  query,
  '--output',
  'text',
];

const simulate = (actions: string[], resources: string[], query: string): string[] => [
  'iam',
  'simulate-principal-policy',
  '--policy-source-arn',
  ROLE_ARN,
  '--action-names',
  ...actions,
  ...(resources.length > 0 ? ['--resource-arns', ...resources] : []),
  '--query',
  query,
  '--output',
  'text',
];

const IDENTITY = ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'];
const ENTRIES = '<entries>';

/** One aws call of the spec tables. */
interface Call {
  /** Unique name of the call. */
  name: string;
  /** The check (stdout id) that makes it. */
  id: string;
  argv: string[];
  /** The n-th call gets the n-th reply; the last one repeats. */
  replies: Reply[];
}

const SEND_REPLY = JSON.stringify({
  Successful: [
    { Id: 'good', MessageId: MSG_GOOD, MD5OfMessageBody: '0123456789abcdef0123456789abcdef' },
    { Id: 'poison', MessageId: MSG_POISON, MD5OfMessageBody: 'fedcba9876543210fedcba9876543210' },
  ],
});

const CALLS: Call[] = [
  {
    name: 'source-queue',
    id: 'source-queue',
    argv: queueAttributes(SRC_URL, Q_SOURCE),
    replies: [ok(tab('35', '345600', 'true'))],
  },
  {
    name: 'redrive-policy',
    id: 'redrive-policy',
    argv: queueAttributes(SRC_URL, Q_REDRIVE),
    replies: [ok(`{"deadLetterTargetArn":"${DLQ_ARN}","maxReceiveCount":3}`)],
  },
  {
    name: 'dlq',
    id: 'dlq',
    argv: queueAttributes(DLQ_URL, Q_DLQ),
    replies: [ok(tab('1209600', 'true'))],
  },
  {
    name: 'dlq-redrive-allow',
    id: 'dlq-redrive-allow',
    argv: queueAttributes(DLQ_URL, Q_ALLOW),
    replies: [ok(`{"redrivePermission":"byQueue","sourceQueueArns":["${SRC_ARN}"]}`)],
  },
  {
    name: 'function',
    id: 'function',
    argv: [
      'lambda',
      'get-function-configuration',
      '--function-name',
      FN,
      '--query',
      Q_FUNCTION,
      '--output',
      'text',
    ],
    replies: [ok(tab('python3.14', 'arm64', '5', '128', 'Active', ROLE_ARN))],
  },
  {
    name: 'function-role',
    id: 'function-role',
    argv: [
      'iam',
      'get-role',
      '--role-name',
      'fg-lab05-consumer',
      '--query',
      Q_ROLE,
      '--output',
      'text',
    ],
    replies: [ok(tab('/lab/', BOUNDARY))],
  },
  {
    name: 'role-may-consume',
    id: 'role-may-consume',
    argv: simulate(
      ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      [SRC_ARN],
      Q_CONSUME,
    ),
    replies: [ok(tab('allowed', 'allowed', 'allowed'))],
  },
  {
    name: 'role-no-log-groups',
    id: 'role-no-log-groups',
    argv: simulate(['logs:CreateLogGroup'], [], Q_NO_LOG_GROUPS),
    replies: [ok('implicitDeny')],
  },
  {
    name: 'mapping',
    id: 'mapping',
    argv: [
      'lambda',
      'get-event-source-mapping',
      '--uuid',
      UUID,
      '--query',
      Q_MAPPING,
      '--output',
      'text',
    ],
    replies: [ok(tab('Enabled', SRC_ARN, '10', '5', 'ReportBatchItemFailures'))],
  },
  {
    name: 'log-group',
    id: 'log-group',
    argv: [
      'logs',
      'describe-log-groups',
      '--log-group-name-prefix',
      LG,
      '--query',
      Q_LOG_GROUP,
      '--output',
      'text',
    ],
    replies: [ok('1')],
  },
  {
    name: 'dlq-alarm',
    id: 'dlq-alarm',
    argv: [
      'cloudwatch',
      'describe-alarms',
      '--alarm-names',
      ALARM,
      '--query',
      Q_ALARM_CONFIG,
      '--output',
      'text',
    ],
    replies: [
      ok(
        tab(
          'AWS/SQS',
          'ApproximateNumberOfMessagesVisible',
          'fg-lab05-orders-dlq',
          'GreaterThanThreshold',
          '0.0',
          '0',
        ),
      ),
    ],
  },
  // The live checks. `dlq-base` is #12's <base> call and #13's poll: the first call is the base, the
  // next ones are the polls (sum 0 on the first poll, 1 on the second). `filter` is #12's poll and
  // #14's single call. `alarm-state` is #15's poll.
  {
    name: 'dlq-base',
    id: 'good-processed',
    argv: queueAttributes(DLQ_URL, Q_BASE),
    replies: [ok(tab('0', '0')), ok(tab('0', '0')), ok(tab('1', '0'))],
  },
  {
    name: 'send',
    id: 'good-processed',
    argv: ['sqs', 'send-message-batch', '--queue-url', SRC_URL, '--entries', ENTRIES],
    replies: [ok(SEND_REPLY)],
  },
  {
    name: 'filter',
    id: 'good-processed',
    argv: [
      'logs',
      'filter-log-events',
      '--log-group-name',
      LG,
      '--filter-pattern',
      FILTER_PATTERN,
      '--query',
      Q_EVENTS,
      '--output',
      'text',
    ],
    replies: [ok('1')],
  },
  {
    name: 'alarm-state',
    id: 'alarm-fires',
    argv: [
      'cloudwatch',
      'describe-alarms',
      '--alarm-names',
      ALARM,
      '--query',
      Q_ALARM_STATE,
      '--output',
      'text',
    ],
    replies: [ok('OK'), ok('ALARM')],
  },
];

const READ_CALLS = CALLS.slice(0, READ_IDS.length);
const callNamed = (name: string): Call => {
  const found = CALLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no call ${name}`);
  return found;
};

/** The options the stub answers by, as `name=value` pairs; the shell builds the same string. */
const SIGNATURE_OPTIONS: [string, string][] = [
  ['--query', 'q'],
  ['--queue-url', 'qu'],
  ['--function-name', 'fn'],
  ['--uuid', 'uu'],
  ['--role-name', 'rn'],
  ['--policy-source-arn', 'sarn'],
  ['--action-names', 'act'],
  ['--log-group-name', 'lg'],
  ['--log-group-name-prefix', 'lgp'],
  ['--alarm-names', 'al'],
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

/**
 * Where a real response holds what a query reads. A query that starts elsewhere would answer `None`
 * in real AWS (or fail), so the stub answers `None` too.
 */
const SHAPES: [string, string[]][] = [
  ['sqs get-queue-attributes', ['Attributes.']],
  ['iam get-role', ['Role.']],
  ['iam simulate-principal-policy', ['EvaluationResults']],
  ['logs describe-log-groups', ['logGroups']],
  ['logs filter-log-events', ['length(events)', 'events']],
  ['cloudwatch describe-alarms', ['MetricAlarms']],
  ['sts get-caller-identity', ['Account']],
];
/** Operations whose response keys sit at the top: a query that starts with a wrapper key is wrong. */
const WRAPPERS: [string, string[]][] = [
  ['lambda get-function-configuration', ['Configuration', 'Attributes', 'Role.']],
  ['lambda get-event-source-mapping', ['EventSourceMapping', 'Configuration', 'Attributes']],
];

// ---- Fixtures -------------------------------------------------------------------------------------

interface Fixture {
  /** aws replies by call name. */
  replies: Record<string, Reply[]>;
  /** terraform replies by output name. */
  outputs: Record<string, Reply>;
  /** The reply of `aws sts get-caller-identity`. */
  identity: Reply;
  /** The reply of `date +%s`. */
  date: Reply;
  /** The line end of every answer of every stub. */
  eol: string;
}

function healthy(): Fixture {
  const replies: Record<string, Reply[]> = {};
  for (const entry of CALLS) replies[entry.name] = entry.replies;
  const outputs: Record<string, Reply> = {};
  for (const name of OUTPUT_NAMES) outputs[name] = ok(OUTPUT_VALUES[name]);
  return { replies, outputs, identity: ok(ACCT), date: ok(DATE_OUT), eol: '\n' };
}

/** A healthy fixture where the answers of some calls are replaced. */
function answering(replaced: Record<string, Reply[]>): Fixture {
  const fixture = healthy();
  for (const [name, replies] of Object.entries(replaced)) {
    callNamed(name);
    fixture.replies[name] = replies;
  }
  return fixture;
}

const answer = (name: string, ...replies: Reply[]): Fixture => answering({ [name]: replies });

const repeat = (reply: Reply, times: number): Reply[] => Array.from({ length: times }, () => reply);

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
}

/**
 * The shell lines that answer with one reply (built-ins only). The text of the answer goes to files
 * of the run and is read back with `read`, never typed into the script: Git Bash drops a carriage
 * return it finds inside a script, and the CRLF answers of AC-26 would lose theirs.
 */
function replyLines(reply: Reply, eol: string, rules: string, base: string): string {
  writeFileSync(join(rules, `${base}.out`), reply.quiet ? '' : reply.out + eol);
  writeFileSync(join(rules, `${base}.err`), reply.err === '' ? '' : reply.err + eol);
  return [
    `IFS= read -r -d '' o < "$D/rules/${base}.out"; printf '%s' "$o"`,
    `IFS= read -r -d '' o < "$D/rules/${base}.err"; printf '%s' "$o" >&2`,
    `exit ${reply.exit}`,
  ].join('; ');
}

function ruleBody(name: string, index: number, rule: Rule, eol: string, rules: string): string {
  const base = `${name}-${index}`;
  if (rule.replies.length === 1) {
    return replyLines(rule.replies[0] ?? ok(''), eol, rules, `${base}-0`);
  }
  const branches = rule.replies.map((reply, at) => {
    const pattern = at === rule.replies.length - 1 ? '*' : String(at);
    return `      ${pattern}) ${replyLines(reply, eol, rules, `${base}-${at}`)};;`;
  });
  return [
    `c=0; if [ -f "$D/count-${base}" ]; then c=$(<"$D/count-${base}"); fi`,
    `echo $((c + 1)) > "$D/count-${base}"`,
    'case $c in',
    ...branches,
    '    esac',
  ].join('\n    ');
}

/**
 * The lines every stub starts with: its call goes to a numbered file of the log directory. The stub
 * resets the shell options first: bash exports SHELLOPTS, so a stub started by verify.sh inherits its
 * `set -euo pipefail` (and xtrace in AC-28), which a real aws, not being a bash script, never would.
 */
const LOG_CALL = (name: string): string => `set +eux; set +o pipefail
D="$FAKE_LOG_DIR"
n=0; if [ -f "$D/seq" ]; then n=$(<"$D/seq"); fi
n=$((n + 1)); echo $n > "$D/seq"
printf '%s\\0' ${name} "$@" > "$D/ev-$n.argv"`;

function stubScript(
  name: string,
  keyExpression: string,
  prelude: string,
  rules: Rule[],
  eol: string,
  rulesDir: string,
): string {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (keys.has(rule.key)) throw new Error(`two stub rules answer the same call: ${rule.key}`);
    keys.add(rule.key);
  }
  const cases = rules
    .map((rule, index) => `  ${sq(rule.key)})\n    ${ruleBody(name, index, rule, eol, rulesDir)};;`)
    .join('\n');
  return `#!${stubShebang()}
${LOG_CALL(name)}
${prelude}
case ${keyExpression} in
${cases}
  *)
    printf '%s\\n' "${name} $*" >> "$D/unexpected.log"
    exit 97;;
esac
`;
}

/** Builds $key (the same string as signature()) and answers `None` to a query of the wrong shape. */
function awsPrelude(eol: string, rulesDir: string): string {
  writeFileSync(join(rulesDir, 'none.out'), `None${eol}`);
  const none = `IFS= read -r -d '' o < "$D/rules/none.out"; printf '%s' "$o"; exit 0`;
  const vars = SIGNATURE_OPTIONS.map((_option, index) => `v${index}=''`).join('; ');
  const arms = SIGNATURE_OPTIONS.map(([option], index) => `    ${option}) v${index}="$a";;`).join(
    '\n',
  );
  const shapes = SHAPES.map(
    ([operation, roots]) =>
      `  ${sq(operation)})\n    case "$v0" in ${roots.map((root) => `${sq(root)}*`).join('|')}) ;; *) ${none};; esac;;`,
  ).join('\n');
  const wrappers = WRAPPERS.map(
    ([operation, roots]) =>
      `  ${sq(operation)})\n    case "$v0" in ${roots.map((root) => `${sq(root)}*`).join('|')}|'') ${none};; esac;;`,
  ).join('\n');
  return `printf '%s|%s|%s|%s\\n' "\${MSYS_NO_PATHCONV-<unset>}" "\${AWS_REGION-<unset>}" "\${AWS_DEFAULT_REGION-<unset>}" "\${AWS_PAGER-<unset>}" > "$D/ev-$n.env"
${vars}
p=''
for a in "$@"; do
  case "$p" in
${arms}
  esac
  p="$a"
done
case "$1 $2" in
${shapes}
${wrappers}
esac
key="$1 $2${SIGNATURE_OPTIONS.map(([, name], index) => `|${name}=$v${index}`).join('')}"`;
}

const TOOLS = ['terraform', 'aws'] as const;
type Tool = (typeof TOOLS)[number];

function writeStubs(fixture: Fixture, bin: string, rulesDir: string, tools: readonly Tool[]): void {
  const terraformRules: Rule[] = OUTPUT_NAMES.map((name) => ({
    key: `output -raw ${name}`,
    replies: [fixture.outputs[name] ?? ok('')],
  }));
  const awsRules: Rule[] = [
    { key: signature(IDENTITY), replies: [fixture.identity] },
    ...CALLS.map((entry) => ({
      key: signature(entry.argv),
      replies: fixture.replies[entry.name] ?? [ok('')],
    })),
  ];
  const scripts: Record<Tool, string> = {
    terraform: stubScript('terraform', '"$1 $2 $3"', '', terraformRules, fixture.eol, rulesDir),
    aws: stubScript(
      'aws',
      '"$key"',
      awsPrelude(fixture.eol, rulesDir),
      awsRules,
      fixture.eol,
      rulesDir,
    ),
  };
  for (const tool of tools) writeFileSync(join(bin, tool), scripts[tool], { mode: 0o755 });
  writeFileSync(
    join(bin, 'date'),
    stubScript(
      'date',
      '"$*"',
      '',
      [{ key: '+%s', replies: [fixture.date] }],
      fixture.eol,
      rulesDir,
    ),
    { mode: 0o755 },
  );
  // A sleep that does not sleep: it only logs its arguments.
  writeFileSync(join(bin, 'sleep'), `#!${stubShebang()}\n${LOG_CALL('sleep')}\nexit 0\n`, {
    mode: 0o755,
  });
}

interface RunOptions {
  args?: string[];
  extraEnv?: Record<string, string>;
  /** Stubs that exist (default: both). */
  tools?: readonly Tool[];
  /** PATH holds only the stub directory (no system directories). */
  strictPath?: boolean;
  /** VERIFY_POLL_SECONDS: a value, or null for "not set" (default: "0"). */
  poll?: string | null;
  label?: string;
}

/** One call of a stub, in call order. */
interface Event {
  tool: string;
  /** The arguments after the tool name. */
  argv: string[];
  /** For aws only: the environment the call saw. */
  msys: string;
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
  /** Every call of every stub, in order. */
  events: Event[];
  /** The aws calls. */
  aws: Event[];
  /** The arguments of every sleep call. */
  sleeps: string[];
  /** Calls a stub had no answer for. */
  unexpected: string[];
}

const RUNS: { label: string; send: boolean; result: RunResult }[] = [];

function scriptPath(): string {
  const path = join(REPO_ROOT, ...LAB, 'verify.sh');
  if (!existsSync(path)) throw new Error('missing file: labs/05-sqs-lambda-dlq/verify.sh');
  return slash(path);
}

function execBash(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    // Standard input is an open pipe that never gets data.
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

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '');
}

/** The calls of a run, from the numbered files the stubs wrote. */
function readEvents(logs: string): Event[] {
  const numbers = readdirSync(logs)
    .map((name) => /^ev-(\d+)\.argv$/.exec(name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  return numbers.map((number) => {
    const parts = readFileSync(join(logs, `ev-${number}.argv`), 'utf8').split('\0');
    parts.pop(); // every argument ends with a NUL
    const envPath = join(logs, `ev-${number}.env`);
    const [msys = '', region = '', defaultRegion = '', pager = ''] = (
      existsSync(envPath) ? readFileSync(envPath, 'utf8').replace(/\n$/, '') : ''
    ).split('|');
    return { tool: parts[0] ?? '', argv: parts.slice(1), msys, region, defaultRegion, pager };
  });
}

async function runVerify(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab05-verify-'));
  try {
    const work = join(dir, 'work');
    const logs = join(dir, 'logs');
    const bin = join(dir, 'bin');
    const temp = join(dir, 'tmp');
    const rules = join(logs, 'rules');
    for (const path of [work, logs, bin, temp, rules]) mkdirSync(path);
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
        key === 'MSYS_NO_PATHCONV' ||
        key === 'SHELLOPTS' ||
        key === 'BASH_ENV'
      ) {
        delete env[key];
      }
    }
    env['PATH'] = options.strictPath === true ? bin : `${bin}${delimiter}${originalPath}`;
    env['FAKE_LOG_DIR'] = slash(logs);
    env['TMPDIR'] = slash(temp);
    const poll = options.poll === undefined ? '0' : options.poll;
    if (poll !== null) env['VERIFY_POLL_SECONDS'] = poll;
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    const done = await execBash([script, ...(options.args ?? [])], work, env);
    const events = readEvents(logs);
    const result: RunResult = {
      status: done.status,
      stdout: done.stdout,
      stderr: done.stderr,
      all: done.stdout + done.stderr,
      events,
      aws: events.filter((event) => event.tool === 'aws'),
      sleeps: events.filter((event) => event.tool === 'sleep').map((event) => event.argv.join(' ')),
      unexpected: readLines(join(logs, 'unexpected.log')),
    };
    RUNS.push({
      label: options.label ?? 'unnamed run',
      send: options.extraEnv?.['VERIFY_SEND'] === '1',
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

const SEND_ENV = { VERIFY_SEND: '1' };

// ---- Assertions on a run --------------------------------------------------------------------------

function outLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

interface Mode {
  /** VERIFY_SEND=1: the live checks run. */
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
const isIdentity = (run: Event): boolean => signature(run.argv) === IDENTITY_SIGNATURE;

/** Every aws call except the one that asks for the account ID. */
const checkRuns = (result: RunResult): Event[] => result.aws.filter((run) => !isIdentity(run));

/** The calls of the run that ask what the named call asks. */
function runsOf(result: RunResult, name: string): Event[] {
  const wanted = signature(callNamed(name).argv);
  return result.aws.filter((run) => signature(run.argv) === wanted);
}

const isOp = (run: Event, service: string, operation: string): boolean =>
  run.argv[0] === service && run.argv[1] === operation;

/** The line of a check with the id of the check as the only thing it must say. */
const skipLines = (ids: string[], reason: string): Record<string, string> =>
  Object.fromEntries(ids.map((id) => [id, `skip: ${id}: ${reason}`]));

/** Lines a run that went on would print. */
const verdictLines = (stdout: string): string[] =>
  outLines(stdout).filter((line) => /^(ok|FAIL|skip|verify):/.test(line));

/** What must never be printed: an account ID, an ARN, a URL, a UUID, an output value, a stub error. */
function leaks(text: string): string[] {
  const found: string[] = [];
  if (/\d{12}/.test(text)) found.push('a 12-digit number');
  for (const needle of [
    'arn:',
    'https://sqs.',
    ...Object.values(OUTPUT_VALUES),
    OTHER_ARN,
    MSG_GOOD,
    MSG_POISON,
    STUB_ERR,
  ]) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

/** The sleep arguments of a run that slept `times` times, each with the same argument. */
const sleepsOf = (value: string, times: number): string[] =>
  Array.from({ length: times }, () => value);

const FORBIDDEN_VERBS = [
  'receive-message',
  'delete-message',
  'purge-queue',
  'start-message-move-task',
  'set-queue-attributes',
  'update-event-source-mapping',
  'invoke',
];

/** The --entries value of the send-message-batch call, parsed. */
function sentEntries(result: RunResult): unknown {
  const sends = result.aws.filter((run) => isOp(run, 'sqs', 'send-message-batch'));
  expect(sends).toHaveLength(1);
  const argv = sends[0]?.argv ?? [];
  const at = argv.indexOf('--entries');
  expect(at, 'send-message-batch has no --entries').toBeGreaterThan(-1);
  return JSON.parse(argv[at + 1] ?? 'null');
}

// =================================================================================================
// AC-19: healthy, no VERIFY_SEND
// =================================================================================================

describe('verify.sh: healthy stack, no live checks', () => {
  const EXPECTED_STDOUT = [
    ...READ_IDS.map((id) => `ok: ${id}`),
    ...LIVE_IDS.map((id) => `skip: ${id}: ${SKIP_LIVE}`),
    'verify: ok (11 passed, 4 skipped)',
  ];

  test.concurrent(
    'AC-19: stdout is the 11 ok lines, the 4 skip lines and the summary',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-19 healthy' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${EXPECTED_STDOUT.join('\n')}\n`);
      expect(result.unexpected).toEqual([]);
    },
  );

  test.concurrent('AC-19: the 11 ok lines come in the order of the spec table', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 order' });
    expectRun(result);
    expect(READ_IDS).toHaveLength(11);
    expect(LIVE_IDS).toHaveLength(4);
  });

  test.concurrent('AC-19: no send-message-batch or filter-log-events call is made', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 no live call' });
    expect(result.aws.length).toBeGreaterThan(0);
    expect(result.aws.filter((run) => isOp(run, 'sqs', 'send-message-batch'))).toEqual([]);
    expect(result.aws.filter((run) => isOp(run, 'logs', 'filter-log-events'))).toEqual([]);
  });

  test.concurrent(
    'AC-19: no aws call reads the alarm state, sends or polls the DLQ counts',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-19 no live reads' });
      expect(runsOf(result, 'alarm-state')).toEqual([]);
      expect(runsOf(result, 'dlq-base')).toEqual([]);
      expect(result.sleeps).toEqual([]);
    },
  );

  test.concurrent.each([
    { name: '0', value: '0' },
    { name: 'true', value: 'true' },
    { name: 'empty', value: '' },
  ])('AC-19: VERIFY_SEND=$name does not run the live checks', async ({ name, value }) => {
    const result = await runVerify(healthy(), {
      label: `AC-19 VERIFY_SEND=${name}`,
      extraEnv: { VERIFY_SEND: value },
    });
    expectRun(result);
    expect(result.aws.filter((run) => isOp(run, 'sqs', 'send-message-batch'))).toEqual([]);
  });
});

// =================================================================================================
// AC-20: each of checks 1 to 11 fails on its own wrong answer
// =================================================================================================

interface Case {
  id: string;
  name: string;
  call: string;
  reply: Reply;
  /** The exact FAIL line, when the spec gives the reason. */
  line?: string;
}

const wrong = (id: string, name: string, answerText: string, line?: string): Case => ({
  id,
  name,
  call: id,
  reply: ok(answerText),
  ...(line === undefined ? {} : { line }),
});

const redrive = (arn: string, max: string): string =>
  `{"deadLetterTargetArn":"${arn}","maxReceiveCount":${max}}`;
const allow = (...arns: string[]): string =>
  `{"redrivePermission":"byQueue","sourceQueueArns":[${arns.map((arn) => `"${arn}"`).join(',')}]}`;
const functionAnswer = (changes: Partial<Record<number, string>>): string =>
  tab(
    ...['python3.14', 'arm64', '5', '128', 'Active', ROLE_ARN].map(
      (value, index) => changes[index] ?? value,
    ),
  );
const mappingAnswer = (changes: Partial<Record<number, string>>): string =>
  tab(
    ...['Enabled', SRC_ARN, '10', '5', 'ReportBatchItemFailures'].map(
      (value, index) => changes[index] ?? value,
    ),
  );
const alarmAnswer = (changes: Partial<Record<number, string>>): string =>
  tab(
    ...[
      'AWS/SQS',
      'ApproximateNumberOfMessagesVisible',
      'fg-lab05-orders-dlq',
      'GreaterThanThreshold',
      '0.0',
      '0',
    ].map((value, index) => changes[index] ?? value),
  );

const AC20_CASES: Case[] = [
  // 1 source-queue
  wrong('source-queue', 'visibility timeout 30', tab('30', '345600', 'true')),
  wrong('source-queue', 'SSE false', tab('35', '345600', 'false')),
  wrong('source-queue', 'retention 86400', tab('35', '86400', 'true')),
  wrong('source-queue', 'None', 'None'),
  // 2 redrive-policy
  wrong(
    'redrive-policy',
    'another DLQ ARN',
    redrive(OTHER_ARN, '3'),
    'FAIL: redrive-policy: the redrive policy does not target the DLQ',
  ),
  wrong(
    'redrive-policy',
    'the source queue as DLQ',
    redrive(SRC_ARN, '3'),
    'FAIL: redrive-policy: the redrive policy does not target the DLQ',
  ),
  wrong(
    'redrive-policy',
    'maxReceiveCount 5',
    redrive(DLQ_ARN, '5'),
    'FAIL: redrive-policy: maxReceiveCount is not 3',
  ),
  wrong(
    'redrive-policy',
    'maxReceiveCount "5" as a string',
    redrive(DLQ_ARN, '"5"'),
    'FAIL: redrive-policy: maxReceiveCount is not 3',
  ),
  wrong(
    'redrive-policy',
    'maxReceiveCount 30',
    redrive(DLQ_ARN, '30'),
    'FAIL: redrive-policy: maxReceiveCount is not 3',
  ),
  wrong('redrive-policy', 'None', 'None'),
  // 3 dlq
  wrong('dlq', 'retention 345600', tab('345600', 'true')),
  wrong('dlq', 'SSE false', tab('1209600', 'false')),
  wrong('dlq', 'None', 'None'),
  // 4 dlq-redrive-allow
  wrong('dlq-redrive-allow', 'byQueue with another ARN', allow(OTHER_ARN)),
  wrong('dlq-redrive-allow', 'two ARNs', allow(SRC_ARN, OTHER_ARN)),
  wrong('dlq-redrive-allow', 'allowAll', '{"redrivePermission":"allowAll"}'),
  wrong('dlq-redrive-allow', 'denyAll', '{"redrivePermission":"denyAll"}'),
  wrong('dlq-redrive-allow', 'None', 'None'),
  // 5 function
  wrong('function', 'another runtime', functionAnswer({ 0: 'python3.13' })),
  wrong('function', 'x86_64', functionAnswer({ 1: 'x86_64' })),
  wrong('function', 'timeout 10', functionAnswer({ 2: '10' })),
  wrong('function', 'memory 256', functionAnswer({ 3: '256' })),
  wrong('function', 'Pending', functionAnswer({ 4: 'Pending' })),
  wrong(
    'function',
    'a role outside /lab/',
    functionAnswer({ 5: `arn:aws:iam::${ACCT}:role/fg-lab05-consumer` }),
  ),
  wrong('function', 'None', 'None'),
  // 6 function-role
  wrong('function-role', 'wrong path', tab('/', BOUNDARY)),
  wrong('function-role', 'boundary None', tab('/lab/', 'None')),
  wrong('function-role', 'another boundary', tab('/lab/', `arn:aws:iam::${ACCT}:policy/other`)),
  // 7 role-may-consume
  wrong(
    'role-may-consume',
    'two allowed and one implicitDeny',
    tab('allowed', 'allowed', 'implicitDeny'),
  ),
  wrong('role-may-consume', 'only two answers', tab('allowed', 'allowed')),
  wrong('role-may-consume', 'four answers', tab('allowed', 'allowed', 'allowed', 'allowed')),
  wrong('role-may-consume', 'None', 'None'),
  // 8 role-no-log-groups
  wrong('role-no-log-groups', 'allowed', 'allowed'),
  wrong('role-no-log-groups', 'explicitDeny', 'explicitDeny'),
  wrong('role-no-log-groups', 'None', 'None'),
  // 9 mapping
  wrong('mapping', 'Disabled', mappingAnswer({ 0: 'Disabled' })),
  wrong('mapping', 'another queue', mappingAnswer({ 1: OTHER_ARN })),
  wrong('mapping', 'batch size 1', mappingAnswer({ 2: '1' })),
  wrong('mapping', 'window 0', mappingAnswer({ 3: '0' })),
  wrong('mapping', 'None for the response types', mappingAnswer({ 4: 'None' })),
  // 10 log-group
  wrong('log-group', 'None (no retention)', 'None'),
  wrong('log-group', 'retention 7', '7'),
  wrong('log-group', 'empty (no such group)', ''),
  // 11 dlq-alarm
  wrong('dlq-alarm', 'another metric', alarmAnswer({ 1: 'NumberOfMessagesSent' })),
  wrong('dlq-alarm', 'another queue', alarmAnswer({ 2: 'fg-lab05-orders' })),
  wrong('dlq-alarm', 'LessThanThreshold', alarmAnswer({ 3: 'LessThanThreshold' })),
  wrong('dlq-alarm', 'threshold 1.0', alarmAnswer({ 4: '1.0' })),
  wrong('dlq-alarm', 'one alarm action', alarmAnswer({ 5: '1' })),
  wrong('dlq-alarm', 'None', 'None'),
];

describe('verify.sh: each read-only check fails on its own wrong answer', () => {
  test('AC-20: the cases cover all eleven checks', () => {
    expect(new Set(AC20_CASES.map((entry) => entry.id))).toEqual(new Set(READ_IDS));
  });

  test.concurrent.each(AC20_CASES)(
    'AC-20: $id fails with $name and the others stay ok',
    async ({ id, name, call, reply, line }) => {
      const result = await runVerify(answer(call, reply), { label: `AC-20 ${id} ${name}` });
      expectRun(result, {}, { [id]: line ?? true });
      expect(result.stdout).toMatch(/^verify: FAIL \(1 failed, 10 passed, 4 skipped\)$/m);
    },
  );

  const OK_VARIANTS: [string, string, string][] = [
    ['redrive-policy', 'maxReceiveCount "3" as a string', redrive(DLQ_ARN, '"3"')],
    ['redrive-policy', 'maxReceiveCount 3 as a number', redrive(DLQ_ARN, '3')],
    [
      'redrive-policy',
      'spaces around the colons',
      `{"deadLetterTargetArn" : "${DLQ_ARN}", "maxReceiveCount" : 3}`,
    ],
    [
      'redrive-policy',
      'a pretty printed policy with maxReceiveCount "3"',
      `{\n  "deadLetterTargetArn": "${DLQ_ARN}",\n  "maxReceiveCount": "3"\n}`,
    ],
    [
      'redrive-policy',
      'the keys in the other order',
      `{"maxReceiveCount":3,"deadLetterTargetArn":"${DLQ_ARN}"}`,
    ],
  ];

  test.concurrent.each(OK_VARIANTS)('AC-20: %s is ok with %s', async (id, name, answerText) => {
    const result = await runVerify(answer(id, ok(answerText)), { label: `AC-20 ${id} ok ${name}` });
    expectRun(result);
  });

  test.concurrent.each(READ_IDS.map((id) => ({ id })))(
    'AC-20: $id fails with "could not ask AWS" when its aws call exits 254',
    async ({ id }) => {
      const result = await runVerify(answer(id, awsError(254)), { label: `AC-20 ${id} exits 254` });
      expectRun(result, {}, { [id]: `FAIL: ${id}: could not ask AWS` });
      expect(result.stdout).toMatch(/^verify: FAIL \(1 failed, 10 passed, 4 skipped\)$/m);
    },
  );
});

// =================================================================================================
// AC-21: the argv of every aws call, and where MSYS_NO_PATHCONV is set
// =================================================================================================

describe('verify.sh: every aws call has the argv of the spec', () => {
  /** The argv with the value of --entries replaced (it is compared as JSON by AC-22). */
  const withoutEntries = (argv: string[]): string[] =>
    argv.map((argument, index) => (argv[index - 1] === '--entries' ? ENTRIES : argument));

  /** What a healthy VERIFY_SEND=1 run asks AWS, after the account ID, in order. */
  const EXPECTED_SEQUENCE = [
    ...READ_CALLS.map((entry) => entry.argv),
    callNamed('dlq-base').argv, // <base>
    callNamed('send').argv,
    callNamed('filter').argv, // #12, one event on the first try
    callNamed('dlq-base').argv, // #13, first poll: still 0
    callNamed('dlq-base').argv, // #13, second poll: 1
    callNamed('filter').argv, // #14
    callNamed('alarm-state').argv, // #15, OK
    callNamed('alarm-state').argv, // #15, ALARM
  ];

  test.concurrent(
    'AC-21: the eleven read-only calls have the argv of the spec, in the order of the table',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-21 read-only argv' });
      expectRun(result);
      expect(checkRuns(result).map((run) => run.argv)).toEqual(
        READ_CALLS.map((entry) => entry.argv),
      );
    },
  );

  test.concurrent('AC-21: a live run asks AWS exactly what the spec says, in order', async () => {
    const result = await runVerify(healthy(), { label: 'AC-21 live argv', extraEnv: SEND_ENV });
    expectRun(result, { live: true });
    expect(checkRuns(result).map((run) => withoutEntries(run.argv))).toEqual(
      EXPECTED_SEQUENCE.map(withoutEntries),
    );
  });

  test.concurrent(
    'AC-21: the account ID is asked with aws sts get-caller-identity --query Account --output text',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-21 identity' });
      expect(result.aws.filter(isIdentity).map((run) => run.argv)).toEqual([IDENTITY]);
    },
  );

  test.concurrent(
    'AC-21: only the aws logs calls have MSYS_NO_PATHCONV=1 in their environment',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-21 msys', extraEnv: SEND_ENV });
      expectRun(result, { live: true });
      const logs = result.aws.filter((run) => run.argv[0] === 'logs');
      const others = result.aws.filter((run) => run.argv[0] !== 'logs');
      expect(logs.length).toBe(3); // describe-log-groups and two filter-log-events
      for (const run of logs) expect(run.msys, run.argv.slice(0, 2).join(' ')).toBe('1');
      expect(others.length).toBeGreaterThan(10);
      for (const run of others) expect(run.msys, run.argv.slice(0, 2).join(' ')).not.toBe('1');
    },
  );

  test.concurrent('AC-21: every aws call runs in eu-west-1 with no pager', async () => {
    const result = await runVerify(healthy(), { label: 'AC-21 env', extraEnv: SEND_ENV });
    expectRun(result, { live: true });
    for (const run of result.aws) {
      expect(run.region, run.argv.slice(0, 2).join(' ')).toBe('eu-west-1');
      expect(run.defaultRegion, run.argv.slice(0, 2).join(' ')).toBe('eu-west-1');
      expect(run.pager, run.argv.slice(0, 2).join(' ')).toBe('');
    }
  });

  test.concurrent(
    'AC-21: the terraform calls are terraform output -raw for each of the eight outputs',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-21 terraform' });
      const calls = result.events
        .filter((event) => event.tool === 'terraform')
        .map((event) => event.argv);
      expect(calls.map((argv) => argv.slice(0, 2))).toEqual(calls.map(() => ['output', '-raw']));
      expect(calls.map((argv) => argv[2]).sort()).toEqual([...OUTPUT_NAMES].sort());
      expect(calls.every((argv) => argv.length === 3)).toBe(true);
    },
  );

  test('stub self-check: every query of the spec starts where the real response holds the data', () => {
    for (const entry of CALLS) {
      const query = entry.argv[entry.argv.indexOf('--query') + 1] ?? '';
      const operation = `${entry.argv[0]} ${entry.argv[1]}`;
      const shape = SHAPES.find(([name]) => name === operation);
      if (shape !== undefined && query !== '') {
        expect(
          shape[1].some((root) => query.startsWith(root)),
          `${entry.name}: ${query}`,
        ).toBe(true);
      }
    }
  });
});

// =================================================================================================
// AC-22: the live checks, healthy
// =================================================================================================

/** The assertions of a healthy VERIFY_SEND=1 run (also used by the CRLF test). */
function expectHealthyLiveRun(result: RunResult): void {
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    `${[...ORDER.map((id) => `ok: ${id}`), 'verify: ok (15 passed, 0 skipped)'].join('\n')}\n`,
  );
  expect(result.unexpected).toEqual([]);
  expect(sentEntries(result)).toEqual([
    { Id: 'good', MessageBody: `{"order_id":"${RUN_ID}"}` },
    { Id: 'poison', MessageBody: 'not an order' },
  ]);
  const filters = result.aws.filter((run) => isOp(run, 'logs', 'filter-log-events'));
  expect(filters).toHaveLength(2);
  for (const run of filters) {
    const at = run.argv.indexOf('--filter-pattern');
    expect(run.argv[at + 1]).toBe(`"processed order ${RUN_ID}"`);
  }
}

describe('verify.sh: the live checks, healthy', () => {
  test.concurrent('AC-22: VERIFY_SEND=1 prints 15 ok lines and no skip', async () => {
    const result = await runVerify(healthy(), { label: 'AC-22 healthy', extraEnv: SEND_ENV });
    expectHealthyLiveRun(result);
  });

  test.concurrent(
    'AC-22: the --entries argument has exactly the good and the poison entry',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-22 entries', extraEnv: SEND_ENV });
      expectRun(result, { live: true });
      const entries = sentEntries(result) as { Id: string; MessageBody: string }[];
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.Id)).toEqual(['good', 'poison']);
      expect(JSON.parse(entries[0]?.MessageBody ?? 'null')).toEqual({ order_id: RUN_ID });
      expect(entries[1]?.MessageBody).toBe('not an order');
    },
  );

  test.concurrent(
    'AC-22: the run ID is verify- and the output of date +%s, and the filter pattern names it',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-22 run id',
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      const dates = result.events.filter((event) => event.tool === 'date');
      expect(dates.length).toBeGreaterThan(0);
      for (const date of dates) expect(date.argv).toEqual(['+%s']);
      const filter = result.aws.find((run) => isOp(run, 'logs', 'filter-log-events'));
      const at = filter?.argv.indexOf('--filter-pattern') ?? -1;
      expect(filter?.argv[at + 1]).toBe(FILTER_PATTERN);
    },
  );

  test.concurrent(
    'AC-22: another date answer gives another run ID in the entries and in the pattern',
    async () => {
      const fixture = healthy();
      fixture.date = ok('1799999999');
      const result = await runVerify(fixture, { label: 'AC-22 other date', extraEnv: SEND_ENV });
      const entries = sentEntries(result) as { Id: string; MessageBody: string }[];
      expect(JSON.parse(entries[0]?.MessageBody ?? 'null')).toEqual({
        order_id: 'verify-1799999999',
      });
      const filter = result.aws.find((run) => isOp(run, 'logs', 'filter-log-events'));
      const at = filter?.argv.indexOf('--filter-pattern') ?? -1;
      expect(filter?.argv[at + 1]).toBe('"processed order verify-1799999999"');
    },
  );

  test.concurrent(
    'AC-22: the DLQ is polled twice (sum 0, then 1) with one sleep, the alarm twice with one sleep',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-22 polls', extraEnv: SEND_ENV });
      expectRun(result, { live: true });
      expect(runsOf(result, 'dlq-base')).toHaveLength(3);
      expect(runsOf(result, 'alarm-state')).toHaveLength(2);
      expect(runsOf(result, 'filter')).toHaveLength(2);
      expect(result.sleeps).toEqual(['0', '0']);
    },
  );

  test.concurrent(
    'AC-22: no argv holds receive-message, delete-message, purge-queue, start-message-move-task, set-queue-attributes, update-event-source-mapping or invoke',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-22 forbidden verbs',
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      for (const run of result.aws) {
        for (const verb of FORBIDDEN_VERBS)
          expect(run.argv, run.argv.join(' ')).not.toContain(verb);
      }
    },
  );

  test.concurrent(
    'AC-22: the DLQ base counts the visible and the in-flight messages: the sum decides',
    async () => {
      const result = await runVerify(answer('dlq-base', ok(tab('1', '0')), ok(tab('0', '2'))), {
        label: 'AC-22 sum',
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      expect(runsOf(result, 'dlq-base')).toHaveLength(2);
    },
  );

  test.concurrent('AC-22: a base of 2 and 1 needs a sum of 4 (base + 1), not 3', async () => {
    const result = await runVerify(
      answer('dlq-base', ok(tab('2', '1')), ok(tab('2', '1')), ok(tab('3', '1'))),
      { label: 'AC-22 boundary', extraEnv: SEND_ENV },
    );
    expectRun(result, { live: true });
    expect(runsOf(result, 'dlq-base')).toHaveLength(3);
  });
});

// =================================================================================================
// AC-23: live failures
// =================================================================================================

describe('verify.sh: live failures', () => {
  const NOT_SENT = ['poison-in-dlq', 'good-once', 'alarm-fires'];

  test.concurrent.each([
    { name: 'one number', reply: ok('0') },
    { name: 'None', reply: ok('None') },
    { name: 'nothing', reply: ok('') },
    { name: 'three numbers', reply: ok(tab('0', '0', '0')) },
    { name: 'two words', reply: ok(tab('x', 'y')) },
    { name: 'an aws error', reply: awsError(254) },
  ])(
    'AC-23: <base> answering $name fails good-processed and skips the three after it',
    async ({ name, reply }) => {
      const result = await runVerify(answer('dlq-base', reply), {
        label: `AC-23 base ${name}`,
        extraEnv: SEND_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'good-processed': 'FAIL: good-processed: could not ask AWS',
          ...skipLines(NOT_SENT, 'good-processed failed'),
        },
      );
      expect(result.stdout).toMatch(/^verify: FAIL \(1 failed, 11 passed, 3 skipped\)$/m);
      expect(result.aws.filter((run) => isOp(run, 'sqs', 'send-message-batch'))).toEqual([]);
      expect(result.aws.filter((run) => isOp(run, 'logs', 'filter-log-events'))).toEqual([]);
      expect(runsOf(result, 'alarm-state')).toEqual([]);
    },
  );

  test.concurrent(
    'AC-23: send-message-batch exiting 255 fails good-processed and skips the three after it',
    async () => {
      const result = await runVerify(answer('send', awsError(255)), {
        label: 'AC-23 send fails',
        extraEnv: SEND_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'good-processed': 'FAIL: good-processed: the messages could not be sent',
          ...skipLines(NOT_SENT, 'good-processed failed'),
        },
      );
      expect(result.aws.filter((run) => isOp(run, 'sqs', 'send-message-batch'))).toHaveLength(1);
      expect(result.aws.filter((run) => isOp(run, 'logs', 'filter-log-events'))).toEqual([]);
      expect(runsOf(result, 'alarm-state')).toEqual([]);
    },
  );

  test.concurrent(
    'AC-23: logs never at 1 or more: exactly 24 filter-log-events calls and 23 sleeps for #12',
    async () => {
      // 24 answers of 0, then a 1 for good-once. Other sleeps of the run: 1 between the two DLQ polls and
      // 1 between the two alarm polls.
      const result = await runVerify(answer('filter', ...repeat(ok('0'), 24), ok('1')), {
        label: 'AC-23 logs never',
        extraEnv: SEND_ENV,
      });
      expectRun(
        result,
        { live: true },
        { 'good-processed': 'FAIL: good-processed: the good order was not processed' },
      );
      expect(runsOf(result, 'filter')).toHaveLength(25);
      expect(result.sleeps).toEqual(sleepsOf('0', 23 + 1 + 1));
    },
  );

  test.concurrent(
    'AC-23: the DLQ never above <base>: 60 polls, 59 sleeps, and #14 and #15 skip',
    async () => {
      const result = await runVerify(answer('dlq-base', ok(tab('0', '0'))), {
        label: 'AC-23 dlq never',
        extraEnv: SEND_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'poison-in-dlq': 'FAIL: poison-in-dlq: the poison message did not reach the DLQ',
          'good-once': 'skip: good-once: poison-in-dlq failed',
          'alarm-fires': 'skip: alarm-fires: poison-in-dlq failed',
        },
      );
      expect(runsOf(result, 'dlq-base')).toHaveLength(1 + 60); // <base> and 60 polls
      expect(result.sleeps).toEqual(sleepsOf('0', 59));
      // #12 asked once; #14 is skipped, so no second filter call.
      expect(runsOf(result, 'filter')).toHaveLength(1);
    },
  );

  test.concurrent(
    'AC-23: the DLQ never above <base>: #15 makes no describe-alarms call for the state',
    async () => {
      const result = await runVerify(answer('dlq-base', ok(tab('3', '1'))), {
        label: 'AC-23 alarm skipped',
        extraEnv: SEND_ENV,
      });
      expect(outLines(result.stdout)).toContain('skip: alarm-fires: poison-in-dlq failed');
      expect(runsOf(result, 'alarm-state')).toEqual([]);
      expect(
        result.aws.filter(
          (run) => isOp(run, 'cloudwatch', 'describe-alarms') && run.argv.includes(Q_ALARM_STATE),
        ),
      ).toEqual([]);
    },
  );

  test.concurrent('AC-23: logs showing 2 at #14 fail good-once', async () => {
    const result = await runVerify(answer('filter', ok('1'), ok('2')), {
      label: 'AC-23 good twice',
      extraEnv: SEND_ENV,
    });
    expectRun(
      result,
      { live: true },
      { 'good-once': 'FAIL: good-once: the good order was processed more than once' },
    );
    expect(runsOf(result, 'filter')).toHaveLength(2);
  });

  test.concurrent('AC-23: logs showing 3 at #14 fail good-once', async () => {
    const result = await runVerify(answer('filter', ok('1'), ok('3')), {
      label: 'AC-23 good three times',
      extraEnv: SEND_ENV,
    });
    expectRun(
      result,
      { live: true },
      { 'good-once': 'FAIL: good-once: the good order was processed more than once' },
    );
  });

  test.concurrent(
    'AC-23: logs showing several events at #12 are ok (a number of 1 or more)',
    async () => {
      const result = await runVerify(answer('filter', ok('3'), ok('1')), {
        label: 'AC-23 several events',
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
    },
  );

  test.concurrent('AC-23: the alarm never ALARM: 120 polls and 119 sleeps', async () => {
    const result = await runVerify(answer('alarm-state', ok('OK')), {
      label: 'AC-23 alarm never',
      extraEnv: SEND_ENV,
    });
    expectRun(
      result,
      { live: true },
      { 'alarm-fires': 'FAIL: alarm-fires: the DLQ alarm did not go off' },
    );
    expect(runsOf(result, 'alarm-state')).toHaveLength(120);
    // 119 between the alarm polls and 1 between the two DLQ polls.
    expect(result.sleeps).toEqual(sleepsOf('0', 119 + 1));
  });

  test.concurrent.each([
    { name: 'letters', value: 'abc' },
    { name: 'nothing', value: '' },
    { name: 'digits and a letter', value: '1760000000x' },
    { name: 'a space inside', value: '17600 00000' },
    { name: 'a sign', value: '-1760000000' },
  ])('AC-23: a date answer of $name exits 2 before anything is sent', async ({ name, value }) => {
    const fixture = healthy();
    fixture.date = ok(value);
    const result = await runVerify(fixture, { label: `AC-23 date ${name}`, extraEnv: SEND_ENV });
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).not.toBe('');
    expect(result.aws.filter((run) => isOp(run, 'sqs', 'send-message-batch'))).toEqual([]);
    expect(result.aws.filter((run) => isOp(run, 'logs', 'filter-log-events'))).toEqual([]);
    expect(verdictLines(result.stdout).filter((line) => line.startsWith('verify:'))).toEqual([]);
  });
});

// =================================================================================================
// AC-24: polling
// =================================================================================================

describe('verify.sh: polling', () => {
  test.concurrent('AC-24: without VERIFY_POLL_SECONDS the sleep is 5', async () => {
    const result = await runVerify(healthy(), {
      label: 'AC-24 default sleep',
      extraEnv: SEND_ENV,
      poll: null,
    });
    expectRun(result, { live: true });
    expect(result.sleeps).toEqual(['5', '5']);
  });

  test.concurrent('AC-24: VERIFY_POLL_SECONDS is the sleep between polls', async () => {
    const result = await runVerify(healthy(), {
      label: 'AC-24 sleep 7',
      extraEnv: SEND_ENV,
      poll: '7',
    });
    expectRun(result, { live: true });
    expect(result.sleeps).toEqual(['7', '7']);
  });

  test.concurrent('AC-24: an aws error while polling the DLQ counts as one more try', async () => {
    const result = await runVerify(
      answer('dlq-base', ok(tab('0', '0')), awsError(254), ok(tab('1', '0'))),
      { label: 'AC-24 dlq error', extraEnv: SEND_ENV },
    );
    expectRun(result, { live: true });
    expect(runsOf(result, 'dlq-base')).toHaveLength(3);
    expect(result.sleeps).toEqual(['0', '0']);
  });

  test.concurrent('AC-24: an aws error while polling the logs counts as one more try', async () => {
    const result = await runVerify(answer('filter', awsError(254), ok('1'), ok('1')), {
      label: 'AC-24 logs error',
      extraEnv: SEND_ENV,
    });
    expectRun(result, { live: true });
    expect(runsOf(result, 'filter')).toHaveLength(3);
    // one sleep after the error, one between the DLQ polls, one between the alarm polls
    expect(result.sleeps).toEqual(['0', '0', '0']);
  });

  test.concurrent(
    'AC-24: an aws error while polling the alarm counts as one more try',
    async () => {
      const result = await runVerify(answer('alarm-state', awsError(254), ok('ALARM')), {
        label: 'AC-24 alarm error',
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      expect(runsOf(result, 'alarm-state')).toHaveLength(2);
    },
  );

  test.concurrent(
    'AC-24: a DLQ that always fails makes 60 tries and fails with the DLQ text',
    async () => {
      const result = await runVerify(answer('dlq-base', ok(tab('0', '0')), awsError(254)), {
        label: 'AC-24 dlq always errors',
        extraEnv: SEND_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'poison-in-dlq': 'FAIL: poison-in-dlq: the poison message did not reach the DLQ',
          'good-once': 'skip: good-once: poison-in-dlq failed',
          'alarm-fires': 'skip: alarm-fires: poison-in-dlq failed',
        },
      );
      expect(runsOf(result, 'dlq-base')).toHaveLength(1 + 60);
      expect(result.sleeps).toEqual(sleepsOf('0', 59));
    },
  );
});

// =================================================================================================
// AC-26: CRLF
// =================================================================================================

describe('verify.sh: CRLF answers', () => {
  const crlf = (fixture: Fixture): Fixture => ({ ...fixture, eol: '\r\n' });

  test.concurrent('AC-26: CRLF answers give the stdout of AC-19', async () => {
    const result = await runVerify(crlf(healthy()), { label: 'AC-26 read-only' });
    expectRun(result);
    expect(result.stdout).not.toContain('\r');
  });

  test.concurrent('AC-26: CRLF answers give the stdout of AC-22', async () => {
    const result = await runVerify(crlf(healthy()), { label: 'AC-26 live', extraEnv: SEND_ENV });
    expectHealthyLiveRun(result);
    expect(result.stdout).not.toContain('\r');
  });

  test.concurrent('AC-26: a CRLF wrong answer still fails only that check', async () => {
    const fixture = crlf(answer('function-role', ok(tab('/lab/', 'None'))));
    const result = await runVerify(fixture, { label: 'AC-26 wrong answer' });
    expectRun(result, {}, { 'function-role': true });
  });

  test.concurrent(
    'AC-26: the CRLF answer of the account ID and of the outputs are cleaned',
    async () => {
      const result = await runVerify(crlf(healthy()), { label: 'AC-26 outputs' });
      for (const run of checkRuns(result)) {
        for (const argument of run.argv) expect(argument, run.argv.join(' ')).not.toContain('\r');
      }
    },
  );
});

// =================================================================================================
// AC-27: the script cannot run
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
    'AC-27: an argument $name exits 2 with a message and calls nothing',
    async ({ name, strictPath, tools, args }) => {
      const result = await runVerify(healthy(), {
        label: `AC-27 argument ${name}`,
        args,
        tools,
        strictPath,
      });
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).not.toBe('');
      expect(result.events).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each(TOOLS.map((name) => ({ name })))(
    'AC-27: without $name on PATH the script says so and exits 2',
    async ({ name }) => {
      const tools = TOOLS.filter((tool) => tool !== name);
      const result = await runVerify(healthy(), {
        label: `AC-27 no ${name}`,
        tools,
        strictPath: true,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(name);
      expect(result.aws).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-27: an empty output $name stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = ok('');
      const result = await runVerify(fixture, { label: `AC-27 ${name} empty` });
      expect(result.stderr).toContain(name);
      expectCouldNotRun(result);
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-27: terraform output $name exiting 1 stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = failing(
        1,
        `Error: no outputs for ${SRC_ARN} ${ACCT}, run apply first ${STUB_ERR}`,
      );
      const result = await runVerify(fixture, { label: `AC-27 ${name} fails` });
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
  ])('AC-27: get-caller-identity $name stops the script with exit 2', async ({ name, reply }) => {
    const fixture = healthy();
    fixture.identity = reply;
    const result = await runVerify(fixture, { label: `AC-27 identity ${name}` });
    expectCouldNotRun(result);
  });
});

// =================================================================================================
// AC-25 and the audits over every run of this file
// =================================================================================================

describe('verify.sh: nothing private is printed', () => {
  test.concurrent(
    'AC-25: a failing aws call prints none of its stderr, nor an ARN, URL, UUID or account ID',
    async () => {
      const result = await runVerify(
        answering({
          'source-queue': [awsError(254)],
          'redrive-policy': [ok(redrive(OTHER_ARN, '3'))],
          mapping: [ok(mappingAnswer({ 1: OTHER_ARN }))],
          'function-role': [awsError(255)],
        }),
        { label: 'AC-25 failing calls' },
      );
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent('AC-25: mismatches on values that hold an ARN print none of them', async () => {
    const result = await runVerify(
      answering({
        function: [ok(functionAnswer({ 5: `arn:aws:iam::${ACCT}:role/other` }))],
        'dlq-redrive-allow': [ok(allow(SRC_ARN, OTHER_ARN))],
        'function-role': [ok(tab('/lab/', `arn:aws:iam::${ACCT}:policy/other`))],
      }),
      { label: 'AC-25 mismatches' },
    );
    expect(result.status).toBe(1);
    expect(leaks(result.all)).toEqual([]);
  });

  test.concurrent('AC-25: live failures print no message ID, URL or stub stderr', async () => {
    const result = await runVerify(
      answering({
        send: [failing(255, `${SEND_REPLY} ${SRC_URL} ${STUB_ERR}`)],
      }),
      { label: 'AC-25 send fails', extraEnv: SEND_ENV },
    );
    expect(result.status).toBe(1);
    expect(leaks(result.all)).toEqual([]);
  });

  test.concurrent(
    'AC-25: a terraform output that fails with an ARN prints none of it',
    async () => {
      const fixture = healthy();
      fixture.outputs['source_queue_arn'] = failing(1, `Error: ${SRC_ARN} ${ACCT} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-25 terraform error' });
      expect(result.status).toBe(2);
      expect(leaks(result.all)).toEqual([]);
    },
  );
});

describe('verify.sh: no xtrace leak', () => {
  test('AC-28: set +x comes right after set -euo pipefail', () => {
    expect(readFileSync(scriptPath(), 'utf8')).toMatch(
      /^set -euo pipefail[ \t]*(?:;[ \t]*|\n(?:[ \t]*\n)*)set \+x\b/m,
    );
  });

  test.concurrent(
    'AC-28: a live run with SHELLOPTS=xtrace exported still prints nothing private',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-28 xtrace',
        extraEnv: { ...SEND_ENV, SHELLOPTS: 'xtrace' },
      });
      expect(leaks(result.all)).toEqual([]);
      expectRun(result, { live: true });
    },
  );

  test.concurrent(
    'AC-28: a failing live run with SHELLOPTS=xtrace exported still prints nothing private',
    async () => {
      const result = await runVerify(
        answering({ send: [awsError(255)], mapping: [awsError(254)] }),
        { label: 'AC-28 xtrace failing', extraEnv: { ...SEND_ENV, SHELLOPTS: 'xtrace' } },
      );
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );
});

describe('verify.sh: audit over every run of this file', () => {
  test('AC-25: no run printed a 12-digit number, an ARN, a URL, a UUID, an output value or a stub stderr', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.flatMap(({ label, result }) =>
      leaks(result.all).map((needle) => `${label}: printed ${needle}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-25: no run made a call a stub had no answer for', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) => result.unexpected.length > 0).map(
      ({ label, result }) => `${label}: ${result.unexpected.join('; ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-22: no run called receive-message, delete-message, purge-queue, start-message-move-task, set-queue-attributes, update-event-source-mapping or invoke', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) =>
      result.aws.some((run) => FORBIDDEN_VERBS.some((verb) => run.argv.includes(verb))),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });

  test('AC-19: no run without VERIFY_SEND=1 sent a message or read the logs', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(
      ({ send, result }) =>
        !send &&
        result.aws.some(
          (run) => isOp(run, 'sqs', 'send-message-batch') || isOp(run, 'logs', 'filter-log-events'),
        ),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });

  test('AC-21: no run called an aws service the spec does not name', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const allowed = new Set([
      'sqs get-queue-attributes',
      'sqs send-message-batch',
      'lambda get-function-configuration',
      'lambda get-event-source-mapping',
      'iam get-role',
      'iam simulate-principal-policy',
      'logs describe-log-groups',
      'logs filter-log-events',
      'cloudwatch describe-alarms',
      'sts get-caller-identity',
    ]);
    const found = RUNS.flatMap(({ label, result }) =>
      result.aws
        .map((run) => `${run.argv[0] ?? ''} ${run.argv[1] ?? ''}`)
        .filter((operation) => !allowed.has(operation))
        .map((operation) => `${label}: ${operation}`),
    );
    expect(found).toEqual([]);
  });
});

// =================================================================================================
// Review round 1 regressions (AC-36 to AC-38), appended: nothing above this line was changed.
// =================================================================================================

/** An aws call with the AWS_DEFAULT_OUTPUT it saw (`<unset>` when the variable was not set at all). */
interface OutputEvent extends Event {
  output: string;
}

interface OutputRunResult extends RunResult {
  /** The aws calls, in order, each with its AWS_DEFAULT_OUTPUT. */
  awsOutput: OutputEvent[];
}

/**
 * A variant of runVerify() for AC-37: the aws stub also writes the AWS_DEFAULT_OUTPUT it sees to
 * `ev-<n>.out`, next to the `ev-<n>.env` file the other tests read (that format is left as it is).
 * The stub is the one writeStubs() makes, with one line added.
 */
async function runVerifyRecordingOutput(
  fixture: Fixture,
  options: Pick<RunOptions, 'args' | 'extraEnv' | 'poll' | 'label'> = {},
): Promise<OutputRunResult> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab05-verify-'));
  try {
    const work = join(dir, 'work');
    const logs = join(dir, 'logs');
    const bin = join(dir, 'bin');
    const temp = join(dir, 'tmp');
    const rules = join(logs, 'rules');
    for (const path of [work, logs, bin, temp, rules]) mkdirSync(path);
    writeStubs(fixture, bin, rules, TOOLS);
    const awsStub = readFileSync(join(bin, 'aws'), 'utf8');
    const envLine = '> "$D/ev-$n.env"';
    if (!awsStub.includes(envLine))
      throw new Error('the aws stub has no ev-<n>.env line to extend');
    writeFileSync(
      join(bin, 'aws'),
      awsStub.replace(
        envLine,
        `${envLine}\nprintf '%s' "\${AWS_DEFAULT_OUTPUT-<unset>}" > "$D/ev-$n.out"`,
      ),
      { mode: 0o755 },
    );

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
    env['PATH'] = `${bin}${delimiter}${originalPath}`;
    env['FAKE_LOG_DIR'] = slash(logs);
    env['TMPDIR'] = slash(temp);
    const poll = options.poll === undefined ? '0' : options.poll;
    if (poll !== null) env['VERIFY_POLL_SECONDS'] = poll;
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    const done = await execBash([script, ...(options.args ?? [])], work, env);
    const events = readEvents(logs);
    const numbers = readdirSync(logs)
      .map((name) => /^ev-(\d+)\.argv$/.exec(name)?.[1])
      .filter((digits): digits is string => digits !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const awsOutput: OutputEvent[] = [];
    events.forEach((event, index) => {
      if (event.tool !== 'aws') return;
      const outPath = join(logs, `ev-${numbers[index]}.out`);
      awsOutput.push({
        ...event,
        output: existsSync(outPath) ? readFileSync(outPath, 'utf8') : '<no record>',
      });
    });
    return {
      status: done.status,
      stdout: done.stdout,
      stderr: done.stderr,
      all: done.stdout + done.stderr,
      events,
      aws: events.filter((event) => event.tool === 'aws'),
      sleeps: events.filter((event) => event.tool === 'sleep').map((event) => event.argv.join(' ')),
      unexpected: readLines(join(logs, 'unexpected.log')),
      awsOutput,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp dir must not fail a test.
    }
  }
}

// ---- AC-36: ARNs match exactly, not as a prefix --------------------------------------------------

describe('verify.sh: ARNs match exactly (AC-36)', () => {
  // The source ARN is a prefix of the DLQ ARN, and an "-old" suffix makes a longer ARN of either.
  test.concurrent(
    'AC-36: a redrive allow policy that names the DLQ itself as the source fails',
    async () => {
      const result = await runVerify(answer('dlq-redrive-allow', ok(allow(DLQ_ARN))), {
        label: 'AC-36 allow names the DLQ',
      });
      expectRun(result, {}, { 'dlq-redrive-allow': true });
    },
  );

  test.concurrent(
    'AC-36: a redrive allow policy with the source ARN and the same ARN with -old fails',
    async () => {
      const result = await runVerify(
        answer('dlq-redrive-allow', ok(allow(SRC_ARN, `${SRC_ARN}-old`))),
        { label: 'AC-36 allow with -old second' },
      );
      expectRun(result, {}, { 'dlq-redrive-allow': true });
    },
  );

  test.concurrent(
    'AC-36: a redrive allow policy that only names the source ARN with -old fails',
    async () => {
      const result = await runVerify(answer('dlq-redrive-allow', ok(allow(`${SRC_ARN}-old`))), {
        label: 'AC-36 allow with -old only',
      });
      expectRun(result, {}, { 'dlq-redrive-allow': true });
    },
  );

  test.concurrent(
    'AC-36: a redrive policy whose dead-letter target is the DLQ ARN with -old fails',
    async () => {
      const result = await runVerify(answer('redrive-policy', ok(redrive(`${DLQ_ARN}-old`, '3'))), {
        label: 'AC-36 redrive -old',
      });
      expectRun(
        result,
        {},
        { 'redrive-policy': 'FAIL: redrive-policy: the redrive policy does not target the DLQ' },
      );
    },
  );

  test.concurrent(
    'AC-36: the exact ARNs still pass (the healthy answers of both checks)',
    async () => {
      const result = await runVerify(
        answering({
          'dlq-redrive-allow': [ok(allow(SRC_ARN))],
          'redrive-policy': [ok(redrive(DLQ_ARN, '3'))],
        }),
        { label: 'AC-36 exact ARNs' },
      );
      expectRun(result);
    },
  );
});

// ---- AC-37: a partial send fails -------------------------------------------------------------------

describe('verify.sh: a partial send fails (AC-37)', () => {
  const NOT_SENT = ['poison-in-dlq', 'good-once', 'alarm-fires'];

  const successful = [
    { Id: 'good', MessageId: MSG_GOOD, MD5OfMessageBody: '0123456789abcdef0123456789abcdef' },
  ];
  const failedEntry = { Id: 'poison', SenderFault: true, Code: 'X', Message: 'rejected' };
  const partial = { Successful: successful, Failed: [failedEntry] };
  const complete = { Successful: successful, Failed: [] };

  /** The same JSON with spaces around the colons and the commas. */
  const spacedOut = (value: unknown): string =>
    JSON.stringify(value).replace(/:/g, ' : ').replace(/,/g, ' , ');

  const PARTIAL_ANSWERS: [string, string][] = [
    ['compact JSON', JSON.stringify(partial)],
    ['pretty printed JSON', JSON.stringify(partial, null, 2)],
    ['JSON with spaces around the colons and commas', spacedOut(partial)],
    [
      'Failed written after the entries it lists, with a space before the list',
      `{"Successful":[],"Failed": [{"Id":"good","SenderFault":false,"Code":"InternalError"},{"Id":"poison","SenderFault":true,"Code":"X"}]}`,
    ],
  ];

  const EMPTY_FAILED_ANSWERS: [string, string][] = [
    ['"Failed":[] without spaces', JSON.stringify(complete)],
    ['"Failed": [] with a space', `{"Successful":[{"Id":"good"},{"Id":"poison"}],"Failed": []}`],
    ['"Failed" : [ ] with spaces everywhere', `{ "Successful": [], "Failed" : [ ] }`],
    ['pretty printed JSON with an empty list', JSON.stringify(complete, null, 2)],
    ['no Failed key at all', JSON.stringify({ Successful: successful })],
  ];

  test.concurrent(
    'AC-37: the send-message-batch call runs with AWS_DEFAULT_OUTPUT=json and no other call has it',
    async () => {
      const result = await runVerifyRecordingOutput(healthy(), {
        label: 'AC-37 env',
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      const sends = result.awsOutput.filter((run) => isOp(run, 'sqs', 'send-message-batch'));
      expect(sends).toHaveLength(1);
      expect(sends[0]?.output).toBe('json');
      const others = result.awsOutput.filter((run) => !isOp(run, 'sqs', 'send-message-batch'));
      expect(others.length).toBeGreaterThan(10);
      for (const run of others) {
        expect(['<unset>', ''], run.argv.slice(0, 2).join(' ')).toContain(run.output);
      }
    },
  );

  test.concurrent('AC-37: without VERIFY_SEND=1 no call has AWS_DEFAULT_OUTPUT set', async () => {
    const result = await runVerifyRecordingOutput(healthy(), { label: 'AC-37 env read-only' });
    expectRun(result);
    expect(result.awsOutput.length).toBeGreaterThan(10);
    for (const run of result.awsOutput) {
      expect(['<unset>', ''], run.argv.slice(0, 2).join(' ')).toContain(run.output);
    }
  });

  test.concurrent.each(PARTIAL_ANSWERS.map(([name, text]) => ({ name, text })))(
    'AC-37: an answer with a failed entry ($name) fails good-processed and skips the rest',
    async ({ name, text }) => {
      const result = await runVerify(answer('send', ok(text)), {
        label: `AC-37 partial ${name}`,
        extraEnv: SEND_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'good-processed': 'FAIL: good-processed: the messages could not be sent',
          ...skipLines(NOT_SENT, 'good-processed failed'),
        },
      );
      expect(result.aws.filter((run) => isOp(run, 'logs', 'filter-log-events'))).toEqual([]);
      expect(runsOf(result, 'alarm-state')).toEqual([]);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent.each(EMPTY_FAILED_ANSWERS.map(([name, text]) => ({ name, text })))(
    'AC-37: an answer with $name is a successful send',
    async ({ name, text }) => {
      const result = await runVerify(answer('send', ok(text)), {
        label: `AC-37 complete ${name}`,
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      expect(runsOf(result, 'filter')).toHaveLength(2);
    },
  );
});

// ---- AC-38: VERIFY_POLL_SECONDS is digits only ---------------------------------------------------

describe('verify.sh: VERIFY_POLL_SECONDS must be digits only (AC-38)', () => {
  test.concurrent.each([
    { name: 'letters', value: 'abc' },
    { name: 'a decimal', value: '1.5' },
    { name: 'a negative number', value: '-1' },
    { name: 'an empty string', value: '' },
    { name: 'digits and a unit', value: '5s' },
    { name: 'a plus sign', value: '+3' },
    { name: 'a space', value: ' ' },
  ])(
    'AC-38: VERIFY_POLL_SECONDS of $name exits 2, names the variable and calls nothing',
    async ({ name, value }) => {
      const result = await runVerify(healthy(), {
        label: `AC-38 poll ${name}`,
        poll: value,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('VERIFY_POLL_SECONDS');
      expect(result.aws).toEqual([]);
      expect(outLines(result.stdout).filter((line) => line.startsWith('verify:'))).toEqual([]);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-38: VERIFY_POLL_SECONDS of abc with VERIFY_SEND=1 also exits 2 before any call',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-38 poll abc live',
        poll: 'abc',
        extraEnv: SEND_ENV,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('VERIFY_POLL_SECONDS');
      expect(result.aws).toEqual([]);
      expect(result.sleeps).toEqual([]);
    },
  );

  test.concurrent.each([{ value: '0' }, { value: '7' }, { value: '12' }])(
    'AC-38: VERIFY_POLL_SECONDS of $value still works and is the sleep',
    async ({ value }) => {
      const result = await runVerify(healthy(), {
        label: `AC-38 poll ${value}`,
        poll: value,
        extraEnv: SEND_ENV,
      });
      expectRun(result, { live: true });
      expect(result.sleeps).toEqual([value, value]);
    },
  );
});
