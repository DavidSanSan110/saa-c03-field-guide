import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 040 (issue #110), AC-16 to AC-24: labs/01-iam-assume-role/verify.sh.
//
// verify.sh is executed with bash and stub `terraform` and `aws` binaries on PATH (the approach of
// lab-00-verify.test.ts). Every stub appends one tab separated line to calls.log. The aws stub also
// logs, per call, the three credential variables, whether AWS_PROFILE / AWS_DEFAULT_PROFILE are set,
// and the region and pager variables (aws-env.log, same order as the aws lines of calls.log).
//
// The aws stub answers by what the call asks, not by the order of its arguments: the service and
// operation plus the value of each option the spec uses (--role-name, --bucket, --policy-source-arn,
// --action-names, --resource-arns, --role-arn, --external-id, --permissions-boundary-policy-input-list,
// --analyzer-arn, --type, --filter, --query), and the access key id for `s3api list-objects-v2` (so
// the caller session and the target session get their own answers). The exact argv, in the exact
// order, is checked once, by AC-19.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const slash = (path: string): string => path.replace(/\\/g, '/');

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

const LAB = ['labs', '01-iam-assume-role'];

// ---- Fixture data ---------------------------------------------------------------------------------

const ACCT = '111122223333';
const TRUSTED = '444455556666';
const OTHER = '777788889999';
const EXT = 'field-guide-lab-01';
const BUCKET = `field-guide-lab01-reports-${ACCT}`;
const ROOT = `arn:aws:iam::${ACCT}:root`;
const TRUSTED_ROOT = `arn:aws:iam::${TRUSTED}:root`;
const OTHER_ROOT = `arn:aws:iam::${OTHER}:root`;
const CALLER = `arn:aws:iam::${ACCT}:role/lab/fg-lab01-caller`;
const TARGET = `arn:aws:iam::${ACCT}:role/lab/fg-lab01-reports-reader`;
const BOUNDARY = `arn:aws:iam::${ACCT}:policy/fg-workload-boundary`;
const PROBE = `arn:aws:iam::${ACCT}:user/lab01-verify-probe`;
const ANALYZER = `arn:aws:access-analyzer:eu-west-1:${ACCT}:analyzer/account-analyzer`;
const NOBOUNDARY =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}';
const STUB_ERR = 'stub-stderr-must-never-be-printed';
const USAGE = 'usage: bash verify.sh (no arguments; run it from the stack directory)';
const SKIP_LIVE = 'set VERIFY_ASSUME=1 to try it for real (needs sts:AssumeRole)';
const SKIP_FINDING =
  'no active finding for the trusted account yet (Access Analyzer can take up to 30 minutes)';

interface Session {
  id: string;
  secret: string;
  token: string;
}

const CALLER_SESSION: Session = {
  id: 'CALLERKEYIDVALUE',
  secret: 'CALLERSECRETVALUE',
  token: 'CALLERTOKENVALUE',
};
const TARGET_SESSION: Session = {
  id: 'TARGETKEYIDVALUE',
  secret: 'TARGETSECRETVALUE',
  token: 'TARGETTOKENVALUE',
};
const ORIGINAL_SESSION: Session = {
  id: 'ORIGINALKEYIDVALUE',
  secret: 'ORIGINALSECRETVALUE',
  token: 'ORIGINALTOKENVALUE',
};
const SESSION_VALUES = [CALLER_SESSION, TARGET_SESSION, ORIGINAL_SESSION].flatMap((session) => [
  session.id,
  session.secret,
  session.token,
]);

const tabs = (session: Session): string => `${session.id}\t${session.secret}\t${session.token}`;

const OUTPUT_NAMES = [
  'caller_role_arn',
  'target_role_arn',
  'reports_bucket_name',
  'external_id',
  'trusted_account_id',
] as const;

const BOUNDARY_Q = 'Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]';
const CALLER_TRUST_Q =
  'Role.AssumeRolePolicyDocument.Statement[].[Effect,Action,Principal.AWS,Condition]';
const TARGET_TRUST_Q =
  'Role.AssumeRolePolicyDocument.Statement[].[Effect,Action,Condition.StringEquals."sts:ExternalId"]';
const PRINCIPALS_Q = 'Role.AssumeRolePolicyDocument.Statement[0].Principal.AWS';
const BPA_Q =
  'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]';
const DECISION_Q = 'EvaluationResults[0].EvalDecision';
const ANALYZERS_Q = "analyzers[?status=='ACTIVE'].arn";
const FINDINGS_Q = 'findings[].principal.AWS';
const CREDENTIALS_Q = 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]';

/** The order of the checks in the spec tables, and so of the stdout lines. */
const ORDER = [
  'caller-role',
  'target-role',
  'caller-trust',
  'target-trust',
  'target-principals',
  'reports-bucket-private',
  'caller-may-assume',
  'boundary-denies-create-user',
  'identity-allows-create-user',
  'caller-cannot-list-reports',
  'target-may-list-reports',
  'target-may-read-reports',
  'external-access-finding',
  'assume-caller',
  'assume-target',
  'wrong-external-id-denied',
  'missing-external-id-denied',
  'target-lists-reports',
  'caller-cannot-list-reports-live',
] as const;
const CHECK_IDS = ORDER.slice(0, 12);
const LIVE_IDS = ORDER.slice(13);

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
const denied = (): Reply =>
  failing(
    254,
    `An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:sts::${ACCT}:assumed-role/x/y is not authorized to perform: sts:AssumeRole on resource: ${TARGET} ${STUB_ERR}`,
  );

// ---- The aws calls of the spec table --------------------------------------------------------------

interface World {
  ext: string;
  /** The trusted_account_id output: '' when it is not set. */
  trusted: string;
}

interface AwsCall {
  /** The key of the reply: a check id, or `external-access-finding/analyzers` for its first call. */
  key: string;
  argv: string[];
  session?: Session;
  pass: Reply;
}

const wrongOf = (ext: string): string =>
  ext === 'wrong-external-id' ? 'wrong-external-id-2' : 'wrong-external-id';

const getRole = (name: string, query: string): string[] => [
  'iam',
  'get-role',
  '--role-name',
  name,
  '--query',
  query,
  '--output',
  'text',
];

const simulate = (
  source: string,
  action: string,
  resource: string,
  extra: string[] = [],
): string[] => [
  'iam',
  'simulate-principal-policy',
  '--policy-source-arn',
  source,
  '--action-names',
  action,
  '--resource-arns',
  resource,
  ...extra,
  '--query',
  DECISION_Q,
  '--output',
  'text',
];

const assumeRole = (role: string, externalId: string | undefined): string[] => [
  'sts',
  'assume-role',
  '--role-arn',
  role,
  '--role-session-name',
  'lab01-verify',
  ...(externalId === undefined ? [] : ['--external-id', externalId]),
  '--query',
  CREDENTIALS_Q,
  '--output',
  'text',
];

const LIST_OBJECTS = [
  's3api',
  'list-objects-v2',
  '--bucket',
  BUCKET,
  '--query',
  'KeyCount',
  '--output',
  'text',
];
const IDENTITY = ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'];

/** Every aws call of checks 1 to 19, in table order (check 13 has two calls). */
function awsCalls(world: World): AwsCall[] {
  const principals = world.trusted === '' ? ROOT : `${ROOT}\t${TRUSTED_ROOT}`;
  const filter = `{"resource":{"eq":["${TARGET}"]},"status":{"eq":["ACTIVE"]}}`;
  return [
    {
      key: 'caller-role',
      argv: getRole('fg-lab01-caller', BOUNDARY_Q),
      pass: ok(`/lab/\t${BOUNDARY}`),
    },
    {
      key: 'target-role',
      argv: getRole('fg-lab01-reports-reader', BOUNDARY_Q),
      pass: ok(`/lab/\t${BOUNDARY}`),
    },
    {
      key: 'caller-trust',
      argv: getRole('fg-lab01-caller', CALLER_TRUST_Q),
      pass: ok(`Allow\tsts:AssumeRole\t${ROOT}\tNone`),
    },
    {
      key: 'target-trust',
      argv: getRole('fg-lab01-reports-reader', TARGET_TRUST_Q),
      pass: ok(`Allow\tsts:AssumeRole\t${world.ext}`),
    },
    {
      key: 'target-principals',
      argv: getRole('fg-lab01-reports-reader', PRINCIPALS_Q),
      pass: ok(principals),
    },
    {
      key: 'reports-bucket-private',
      argv: [
        's3api',
        'get-public-access-block',
        '--bucket',
        BUCKET,
        '--query',
        BPA_Q,
        '--output',
        'text',
      ],
      pass: ok('True\tTrue\tTrue\tTrue'),
    },
    {
      key: 'caller-may-assume',
      argv: simulate(CALLER, 'sts:AssumeRole', TARGET),
      pass: ok('allowed'),
    },
    {
      key: 'boundary-denies-create-user',
      argv: simulate(CALLER, 'iam:CreateUser', PROBE),
      pass: ok('explicitDeny'),
    },
    {
      key: 'identity-allows-create-user',
      argv: simulate(CALLER, 'iam:CreateUser', PROBE, [
        '--permissions-boundary-policy-input-list',
        NOBOUNDARY,
      ]),
      pass: ok('allowed'),
    },
    {
      key: 'caller-cannot-list-reports',
      argv: simulate(CALLER, 's3:ListBucket', `arn:aws:s3:::${BUCKET}`),
      pass: ok('implicitDeny'),
    },
    {
      key: 'target-may-list-reports',
      argv: simulate(TARGET, 's3:ListBucket', `arn:aws:s3:::${BUCKET}`),
      pass: ok('allowed'),
    },
    {
      key: 'target-may-read-reports',
      argv: simulate(TARGET, 's3:GetObject', `arn:aws:s3:::${BUCKET}/report.txt`),
      pass: ok('allowed'),
    },
    {
      key: 'external-access-finding/analyzers',
      argv: [
        'accessanalyzer',
        'list-analyzers',
        '--type',
        'ACCOUNT',
        '--query',
        ANALYZERS_Q,
        '--output',
        'text',
      ],
      pass: ok(ANALYZER),
    },
    {
      key: 'external-access-finding',
      argv: [
        'accessanalyzer',
        'list-findings',
        '--analyzer-arn',
        ANALYZER,
        '--filter',
        filter,
        '--query',
        FINDINGS_Q,
        '--output',
        'text',
      ],
      pass: ok(TRUSTED_ROOT),
    },
    { key: 'assume-caller', argv: assumeRole(CALLER, undefined), pass: ok(tabs(CALLER_SESSION)) },
    {
      key: 'assume-target',
      argv: assumeRole(TARGET, world.ext),
      session: CALLER_SESSION,
      pass: ok(tabs(TARGET_SESSION)),
    },
    {
      key: 'wrong-external-id-denied',
      argv: assumeRole(TARGET, wrongOf(world.ext)),
      session: CALLER_SESSION,
      pass: denied(),
    },
    {
      key: 'missing-external-id-denied',
      argv: assumeRole(TARGET, undefined),
      session: CALLER_SESSION,
      pass: denied(),
    },
    {
      key: 'target-lists-reports',
      argv: LIST_OBJECTS,
      session: TARGET_SESSION,
      pass: ok('0'),
    },
    {
      key: 'caller-cannot-list-reports-live',
      argv: LIST_OBJECTS,
      session: CALLER_SESSION,
      pass: denied(),
    },
  ];
}

/** The calls of the default run, of a run with a trusted account and of a live run. */
const CHECK_KEYS: string[] = [...CHECK_IDS];
const FINDING_KEYS = ['external-access-finding/analyzers', 'external-access-finding'];

/**
 * The pieces of a call the stub answers by, as one string; the shell in AWS_PRELUDE builds the same
 * string. Options are matched by name wherever they stand, so the order of the arguments is free.
 */
function signature(argv: string[]): string {
  const value: Record<string, string> = {
    '--query': '',
    '--role-name': '',
    '--bucket': '',
    '--policy-source-arn': '',
    '--action-names': '',
    '--resource-arns': '',
    '--role-arn': '',
    '--external-id': '-',
    '--permissions-boundary-policy-input-list': '-',
    '--analyzer-arn': '',
    '--type': '',
    '--filter': '',
  };
  let previous = '';
  for (const argument of argv) {
    if (previous in value) value[previous] = argument;
    previous = argument;
  }
  return [
    `${argv[0]} ${argv[1]}`,
    `rn=${value['--role-name']}`,
    `bk=${value['--bucket']}`,
    `sarn=${value['--policy-source-arn']}`,
    `act=${value['--action-names']}`,
    `res=${value['--resource-arns']}`,
    `rarn=${value['--role-arn']}`,
    `ext=${value['--external-id']}`,
    `nb=${value['--permissions-boundary-policy-input-list']}`,
    `an=${value['--analyzer-arn']}`,
    `typ=${value['--type']}`,
    `flt=${value['--filter']}`,
    `q=${value['--query']}`,
  ].join('|');
}

function ruleKey(call: AwsCall): string {
  const base = signature(call.argv);
  return call.argv[1] === 'list-objects-v2' ? `${base}|ak=${call.session?.id ?? ''}` : base;
}

// ---- Fixtures -------------------------------------------------------------------------------------

interface Fixture {
  world: World;
  /** aws replies by call key. */
  replies: Record<string, Reply>;
  /** terraform replies by output name. */
  outputs: Record<string, Reply>;
  /** The reply of `aws sts get-caller-identity`. */
  identity: Reply;
  awsEol: string;
  tfEol: string;
}

function healthy(options: { ext?: string; trusted?: string } = {}): Fixture {
  const world: World = { ext: options.ext ?? EXT, trusted: options.trusted ?? '' };
  const replies: Record<string, Reply> = {};
  for (const call of awsCalls(world)) replies[call.key] = call.pass;
  const values: Record<string, string> = {
    caller_role_arn: CALLER,
    target_role_arn: TARGET,
    reports_bucket_name: BUCKET,
    external_id: world.ext,
    trusted_account_id: world.trusted,
  };
  const outputs: Record<string, Reply> = {};
  for (const name of OUTPUT_NAMES) outputs[name] = ok(values[name] ?? '');
  return { world, replies, outputs, identity: ok(ACCT), awsEol: '\n', tfEol: '' };
}

const withTrusted = (): Fixture => healthy({ trusted: TRUSTED });

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
  reply: Reply;
  eol: string;
}

function ruleBody(dir: string, id: string, rule: Rule): string {
  writeFileSync(join(dir, `${id}.out`), rule.reply.quiet ? '' : rule.reply.out + rule.eol);
  if (rule.reply.err !== '') writeFileSync(join(dir, `${id}.err`), rule.reply.err + rule.eol);
  return [
    `cat "$D/${id}.out"`,
    rule.reply.err !== '' ? `cat "$D/${id}.err" >&2` : ':',
    `exit ${rule.reply.exit}`,
  ].join('\n    ');
}

function stubScript(
  name: string,
  prelude: string,
  keyExpression: string,
  rules: Rule[],
  rulesDir: string,
): string {
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

/** Logs the credential environment of the call, then builds $key, the same string as signature(). */
const AWS_PRELUDE = `ak="\${AWS_ACCESS_KEY_ID-<unset>}"
if [ -n "\${AWS_PROFILE+x}" ]; then pf=set; else pf=unset; fi
if [ -n "\${AWS_DEFAULT_PROFILE+x}" ]; then dpf=set; else dpf=unset; fi
printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$ak" "\${AWS_SECRET_ACCESS_KEY-<unset>}" "\${AWS_SESSION_TOKEN-<unset>}" "$pf" "$dpf" "\${AWS_REGION-<unset>}" "\${AWS_DEFAULT_REGION-<unset>}" "\${AWS_PAGER-<unset>}" >> "$FAKE_LOG_DIR/aws-env.log"
q=''; rn=''; bk=''; sarn=''; act=''; res=''; rarn=''; ext='-'; nb='-'; an=''; typ=''; flt=''
p=''
for a in "$@"; do
  case "$p" in
    --query) q="$a";;
    --role-name) rn="$a";;
    --bucket) bk="$a";;
    --policy-source-arn) sarn="$a";;
    --action-names) act="$a";;
    --resource-arns) res="$a";;
    --role-arn) rarn="$a";;
    --external-id) ext="$a";;
    --permissions-boundary-policy-input-list) nb="$a";;
    --analyzer-arn) an="$a";;
    --type) typ="$a";;
    --filter) flt="$a";;
  esac
  p="$a"
done
key="$1 $2|rn=$rn|bk=$bk|sarn=$sarn|act=$act|res=$res|rarn=$rarn|ext=$ext|nb=$nb|an=$an|typ=$typ|flt=$flt|q=$q"
if [ "$1 $2" = 's3api list-objects-v2' ]; then key="$key|ak=$ak"; fi`;

const TOOLS = ['terraform', 'aws'] as const;
type Tool = (typeof TOOLS)[number];

function writeStubs(fixture: Fixture, bin: string, rulesDir: string, tools: readonly Tool[]): void {
  const terraformRules: Rule[] = OUTPUT_NAMES.map((name) => ({
    key: `output -raw ${name}`,
    reply: fixture.outputs[name] ?? ok(''),
    eol: fixture.tfEol,
  }));
  const awsRules: Rule[] = [
    {
      key: signature(IDENTITY),
      reply: fixture.identity,
      eol: fixture.awsEol,
    },
    ...awsCalls(fixture.world).map((call) => ({
      key: ruleKey(call),
      reply: fixture.replies[call.key] ?? ok(''),
      eol: fixture.awsEol,
    })),
  ];
  const scripts: Record<Tool, string> = {
    terraform: stubScript('terraform', '', '"$1 $2 $3"', terraformRules, rulesDir),
    aws: stubScript('aws', AWS_PRELUDE, '"$key"', awsRules, rulesDir),
  };
  for (const tool of tools) writeFileSync(join(bin, tool), scripts[tool], { mode: 0o755 });
}

interface RunOptions {
  args?: string[];
  extraEnv?: Record<string, string>;
  /** Stubs that exist (default: both). */
  tools?: readonly Tool[];
  /** PATH holds only the stub directory (no system directories). */
  strictPath?: boolean;
  label?: string;
}

/** One aws call: its arguments (after `aws`) and the environment it saw. */
interface AwsRun {
  argv: string[];
  keyId: string;
  secret: string;
  token: string;
  profile: string;
  defaultProfile: string;
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
  /** Every stub call: [name, ...arguments]. */
  calls: string[][];
  /** Every aws call with the environment it saw. */
  aws: AwsRun[];
  /** Calls a stub had no answer for. */
  unexpected: string[];
}

const RUNS: { label: string; result: RunResult }[] = [];

function scriptPath(): string {
  const path = repoPath(...LAB, 'verify.sh');
  if (!existsSync(path)) throw new Error('missing file: labs/01-iam-assume-role/verify.sh');
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
      fail(new Error('verify.sh did not finish within 90 s'));
    }, 90_000);
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
  return callLines
    .filter((call) => call[0] === 'aws')
    .map((call, index) => {
      const [
        keyId = '',
        secret = '',
        token = '',
        profile = '',
        defaultProfile = '',
        region = '',
        defaultRegion = '',
        pager = '',
      ] = (envLines[index] ?? '').split('|');
      return {
        argv: call.slice(1),
        keyId,
        secret,
        token,
        profile,
        defaultProfile,
        region,
        defaultRegion,
        pager,
      };
    });
}

async function runVerify(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab01-verify-'));
  try {
    const work = join(dir, 'work');
    const logs = join(dir, 'logs');
    const bin = join(dir, 'bin');
    const rules = join(logs, 'rules');
    mkdirSync(work);
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
      } else if (key.startsWith('GIT_') || key.startsWith('AWS_') || key.startsWith('VERIFY_')) {
        delete env[key];
      }
    }
    env['PATH'] = options.strictPath === true ? bin : `${bin}${delimiter}${originalPath}`;
    env['FAKE_LOG_DIR'] = slash(logs);
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    const done = await execBash([script, ...(options.args ?? [])], work, env);
    const calls = readLines(join(logs, 'calls.log')).map((line) => line.split('\t'));
    const result: RunResult = {
      status: done.status,
      stdout: done.stdout,
      stderr: done.stderr,
      all: done.stdout + done.stderr,
      calls,
      aws: parseAws(calls, readLines(join(logs, 'aws-env.log'))),
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

const LIVE_ENV = { VERIFY_ASSUME: '1' };

/** The environment of a person who is signed in: the keys and profiles the live checks must not touch. */
const ORIGINAL_ENV: Record<string, string> = {
  AWS_ACCESS_KEY_ID: ORIGINAL_SESSION.id,
  AWS_SECRET_ACCESS_KEY: ORIGINAL_SESSION.secret,
  AWS_SESSION_TOKEN: ORIGINAL_SESSION.token,
  AWS_PROFILE: 'original-profile',
  AWS_DEFAULT_PROFILE: 'original-default-profile',
};

// ---- Assertions on a run --------------------------------------------------------------------------

function outLines(stdout: string): string[] {
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

interface Mode {
  /** VERIFY_ASSUME=1: the live checks run. */
  live?: boolean;
  /** trusted_account_id is set and its finding is found: check 13 is `ok`. */
  trusted?: boolean;
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
    } else if (id === 'external-access-finding') {
      line = mode.trusted === true ? `ok: ${id}` : `skip: ${id}: trusted_account_id is not set`;
    } else if ((LIVE_IDS as readonly string[]).includes(id) && mode.live !== true) {
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

/** The calls of the run that ask what `call` asks (for list-objects-v2: both sessions, in order). */
function runsOf(result: RunResult, call: AwsCall): AwsRun[] {
  return result.aws.filter((run) => signature(run.argv) === signature(call.argv));
}

function callOf(world: World, key: string): AwsCall {
  const call = awsCalls(world).find((candidate) => candidate.key === key);
  if (call === undefined) throw new Error(`no call ${key}`);
  return call;
}

function optionOf(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** True when stdout holds none of the lines a run that went on would print. */
const verdictLines = (stdout: string): string[] =>
  outLines(stdout).filter((line) => /^(ok|FAIL|skip|verify):/.test(line));

function leaks(text: string): string[] {
  const found: string[] = [];
  if (/\d{12}/.test(text)) found.push('a 12-digit number');
  for (const needle of ['arn:', BUCKET, 'field-guide-lab01-reports', STUB_ERR, ...SESSION_VALUES]) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

// =================================================================================================
// AC-16: healthy, nothing set
// =================================================================================================

describe('verify.sh: healthy stack, no trusted account, no live checks', () => {
  const EXPECTED_STDOUT = [
    ...CHECK_IDS.map((id) => `ok: ${id}`),
    'skip: external-access-finding: trusted_account_id is not set',
    ...LIVE_IDS.map((id) => `skip: ${id}: ${SKIP_LIVE}`),
    'verify: ok (12 passed, 7 skipped)',
  ];

  test.concurrent(
    'AC-16: stdout is the twelve ok lines, seven skip lines and the summary',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-16 healthy' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${EXPECTED_STDOUT.join('\n')}\n`);
      expect(result.unexpected).toEqual([]);
    },
  );

  test.concurrent('AC-16: the twelve ok lines come in the order of the spec table', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 order' });
    expectRun(result);
    expect(CHECK_IDS).toHaveLength(12);
  });

  test.concurrent('AC-16: no accessanalyzer call is made', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 no analyzer' });
    expect(result.aws.length).toBeGreaterThan(0);
    expect(result.aws.filter((run) => run.argv[0] === 'accessanalyzer')).toEqual([]);
  });

  test.concurrent('AC-16: no sts assume-role call is made', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 no assume-role' });
    expect(result.aws.length).toBeGreaterThan(0);
    expect(
      result.aws.filter((run) => run.argv[0] === 'sts' && run.argv[1] === 'assume-role'),
    ).toEqual([]);
  });

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
    expect(
      result.aws.filter((run) => run.argv[0] === 'sts' && run.argv[1] === 'assume-role'),
    ).toEqual([]);
  });
});

// =================================================================================================
// AC-17: a trusted account
// =================================================================================================

describe('verify.sh: with a trusted account', () => {
  test.concurrent('AC-17: a healthy run with a finding prints 13 ok lines', async () => {
    const result = await runVerify(withTrusted(), { label: 'AC-17 healthy' });
    expectRun(result, { trusted: true });
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (13 passed, 6 skipped)');
  });

  test.concurrent.each([
    { name: 'tab separated, own account first', answer: `${ROOT}\t${TRUSTED_ROOT}` },
    { name: 'tab separated, trusted account first', answer: `${TRUSTED_ROOT}\t${ROOT}` },
    { name: 'space separated, own account first', answer: `${ROOT} ${TRUSTED_ROOT}` },
    { name: 'space separated, trusted account first', answer: `${TRUSTED_ROOT} ${ROOT}` },
  ])('AC-17: target-principals is ok with both roots, $name', async ({ name, answer }) => {
    const fixture = withTrusted();
    fixture.replies['target-principals'] = ok(answer);
    const result = await runVerify(fixture, { label: `AC-17 principals ${name}` });
    expectRun(result, { trusted: true });
  });

  test.concurrent.each([
    { name: 'the trusted root is missing', answer: ROOT },
    { name: 'only the trusted root is present', answer: TRUSTED_ROOT },
    { name: 'a third principal is present', answer: `${ROOT}\t${TRUSTED_ROOT}\t${OTHER_ROOT}` },
    { name: 'another account replaces the trusted one', answer: `${ROOT}\t${OTHER_ROOT}` },
  ])('AC-17: target-principals fails when $name', async ({ name, answer }) => {
    const fixture = withTrusted();
    fixture.replies['target-principals'] = ok(answer);
    const result = await runVerify(fixture, { label: `AC-17 principals fail ${name}` });
    expectRun(result, { trusted: true }, { 'target-principals': true });
  });

  test.concurrent.each([
    { name: 'the bare account id', answer: TRUSTED },
    { name: 'the root ARN', answer: TRUSTED_ROOT },
    { name: 'a list that holds it', answer: `${OTHER_ROOT}\t${TRUSTED_ROOT}` },
  ])('AC-17: external-access-finding is ok with $name', async ({ name, answer }) => {
    const fixture = withTrusted();
    fixture.replies['external-access-finding'] = ok(answer);
    const result = await runVerify(fixture, { label: `AC-17 finding ok ${name}` });
    expectRun(result, { trusted: true });
  });

  test.concurrent.each([
    { name: 'empty', answer: '' },
    { name: 'None', answer: 'None' },
    { name: 'another account only', answer: OTHER_ROOT },
  ])(
    'AC-17: external-access-finding is skipped when the findings are $name',
    async ({ name, answer }) => {
      const fixture = withTrusted();
      fixture.replies['external-access-finding'] = ok(answer);
      const result = await runVerify(fixture, { label: `AC-17 finding skip ${name}` });
      expectRun(
        result,
        { trusted: true },
        { 'external-access-finding': `skip: external-access-finding: ${SKIP_FINDING}` },
      );
      expect(outLines(result.stdout).at(-1)).toBe('verify: ok (12 passed, 7 skipped)');
    },
  );

  test.concurrent.each([
    { name: 'empty', answer: '' },
    { name: 'None', answer: 'None' },
  ])(
    'AC-17: an analyzer list that is $name fails and list-findings is not called',
    async ({ name, answer }) => {
      const fixture = withTrusted();
      fixture.replies['external-access-finding/analyzers'] = ok(answer);
      const result = await runVerify(fixture, { label: `AC-17 no analyzer ${name}` });
      expectRun(
        result,
        { trusted: true },
        { 'external-access-finding': 'FAIL: external-access-finding: no active account analyzer' },
      );
      expect(result.aws.filter((run) => run.argv[1] === 'list-findings')).toEqual([]);
    },
  );

  test.concurrent.each([
    { name: 'list-analyzers', key: 'external-access-finding/analyzers' },
    { name: 'list-findings', key: 'external-access-finding' },
  ])('AC-17: $name exiting 254 fails with "could not ask AWS"', async ({ name, key }) => {
    const fixture = withTrusted();
    fixture.replies[key] = failing(254, `An error occurred (AccessDenied) ${STUB_ERR} ${TARGET}`);
    const result = await runVerify(fixture, { label: `AC-17 ${name} fails` });
    expectRun(
      result,
      { trusted: true },
      { 'external-access-finding': 'FAIL: external-access-finding: could not ask AWS' },
    );
  });

  test.concurrent('AC-17: list-findings gets the first analyzer of the list', async () => {
    const fixture = withTrusted();
    fixture.replies['external-access-finding/analyzers'] = ok(`${ANALYZER}\t${ANALYZER}-second`);
    const result = await runVerify(fixture, { label: 'AC-17 first analyzer' });
    expectRun(result, { trusted: true });
    const call = result.aws.find((run) => run.argv[1] === 'list-findings');
    expect(optionOf(call?.argv ?? [], '--analyzer-arn')).toBe(ANALYZER);
  });

  test.concurrent('AC-17: the --filter argument is exactly the JSON of the spec', async () => {
    const result = await runVerify(withTrusted(), { label: 'AC-17 filter' });
    const call = result.aws.find((run) => run.argv[1] === 'list-findings');
    expect(call, 'no list-findings call').toBeDefined();
    expect(optionOf(call?.argv ?? [], '--filter')).toBe(
      `{"resource":{"eq":["${TARGET}"]},"status":{"eq":["ACTIVE"]}}`,
    );
  });
});

// =================================================================================================
// AC-18: each of checks 1 to 12 fails on its own wrong answer
// =================================================================================================

interface Case {
  name: string;
  id: string;
  answer: string;
}

const wrong = (name: string, id: string, text: string): Case => ({ name, id, answer: text });

const AC18_CASES: Case[] = [
  wrong('the default role path', 'caller-role', `/\t${BOUNDARY}`),
  wrong('no permissions boundary', 'caller-role', '/lab/\tNone'),
  wrong('another permissions boundary', 'caller-role', `/lab/\tarn:aws:iam::${ACCT}:policy/other`),
  wrong('the default role path', 'target-role', `/\t${BOUNDARY}`),
  wrong('no permissions boundary', 'target-role', '/lab/\tNone'),
  wrong('another permissions boundary', 'target-role', `/lab/\tarn:aws:iam::${ACCT}:policy/other`),
  wrong('a Condition', 'caller-trust', `Allow\tsts:AssumeRole\t${ROOT}\t${EXT}`),
  wrong(
    'a second statement',
    'caller-trust',
    `Allow\tsts:AssumeRole\t${ROOT}\tNone\nAllow\tsts:AssumeRole\t${ROOT}\tNone`,
  ),
  wrong('another principal', 'caller-trust', `Allow\tsts:AssumeRole\t${OTHER_ROOT}\tNone`),
  wrong('another external id', 'target-trust', 'Allow\tsts:AssumeRole\tother-external-id'),
  wrong('no external id', 'target-trust', 'Allow\tsts:AssumeRole\tNone'),
  wrong(
    'two statements',
    'target-trust',
    `Allow\tsts:AssumeRole\t${EXT}\nAllow\tsts:AssumeRole\t${EXT}`,
  ),
  wrong('an extra principal', 'target-principals', `${ROOT}\t${OTHER_ROOT}`),
  wrong("another account's root", 'target-principals', OTHER_ROOT),
  wrong('one False', 'reports-bucket-private', 'True\tTrue\tFalse\tTrue'),
  wrong('the first False', 'reports-bucket-private', 'False\tTrue\tTrue\tTrue'),
  wrong('an implicit deny', 'caller-may-assume', 'implicitDeny'),
  wrong('an allowed decision', 'boundary-denies-create-user', 'allowed'),
  wrong('an implicit deny', 'boundary-denies-create-user', 'implicitDeny'),
  wrong('an explicit deny', 'identity-allows-create-user', 'explicitDeny'),
  wrong('an allowed decision', 'caller-cannot-list-reports', 'allowed'),
  wrong('an implicit deny', 'target-may-list-reports', 'implicitDeny'),
  wrong('an implicit deny', 'target-may-read-reports', 'implicitDeny'),
];

describe('verify.sh: wrong answers', () => {
  test.concurrent.each(AC18_CASES)(
    'AC-18: $id fails on $name',
    async ({ name, id, answer: text }) => {
      const fixture = healthy();
      fixture.replies[id] = ok(text);
      const result = await runVerify(fixture, { label: `AC-18 ${id} ${name}` });
      expectRun(result, {}, { [id]: true });
      expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
    },
  );

  test.concurrent.each(CHECK_IDS.map((id) => ({ id })))(
    'AC-18: $id answering exit 254 gives "could not ask AWS"',
    async ({ id }) => {
      const fixture = healthy();
      fixture.replies[id] = failing(254, `An error occurred (AccessDenied) ${STUB_ERR} ${CALLER}`);
      const result = await runVerify(fixture, { label: `AC-18 ${id} exit 254` });
      expectRun(result, {}, { [id]: `FAIL: ${id}: could not ask AWS` });
      expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
    },
  );
});

// =================================================================================================
// AC-19: the argv of every aws call
// =================================================================================================

describe('verify.sh: the arguments of every aws call', () => {
  const expectedArgv = (world: World, keys: string[]): string[][] =>
    awsCalls(world)
      .filter((call) => keys.includes(call.key))
      .map((call) => call.argv);

  const actualArgv = (result: RunResult): string[][] => checkRuns(result).map((run) => run.argv);

  test.concurrent(
    'AC-19: checks 1 to 12 call aws with the argv of the table, in order',
    async () => {
      const fixture = healthy();
      const result = await runVerify(fixture, { label: 'AC-19 default' });
      expect(actualArgv(result)).toEqual(expectedArgv(fixture.world, CHECK_KEYS));
    },
  );

  test.concurrent(
    'AC-19: with a trusted account check 13 adds its two calls, in order',
    async () => {
      const fixture = withTrusted();
      const result = await runVerify(fixture, { label: 'AC-19 trusted' });
      expect(actualArgv(result)).toEqual(
        expectedArgv(fixture.world, [...CHECK_KEYS, ...FINDING_KEYS]),
      );
    },
  );

  test.concurrent('AC-19: the live checks add their six calls, in order', async () => {
    const fixture = withTrusted();
    const result = await runVerify(fixture, { label: 'AC-19 live', extraEnv: LIVE_ENV });
    expect(actualArgv(result)).toEqual(
      expectedArgv(fixture.world, [...CHECK_KEYS, ...FINDING_KEYS, ...LIVE_IDS]),
    );
  });

  test.concurrent(
    'AC-19: identity-allows-create-user passes NOBOUNDARY as one argument, byte for byte',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-19 noboundary' });
      const run = result.aws.find(
        (candidate) =>
          candidate.argv.includes('iam:CreateUser') &&
          candidate.argv.includes('--permissions-boundary-policy-input-list'),
      );
      expect(run, 'no CreateUser simulation with a boundary input').toBeDefined();
      const argv = run?.argv ?? [];
      expect(argv[argv.indexOf('--permissions-boundary-policy-input-list') + 1]).toBe(NOBOUNDARY);
    },
  );

  test.concurrent(
    'AC-19: the account ID is asked once, with --query Account --output text',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-19 identity' });
      const asks = result.aws.filter(isIdentity);
      expect(asks.map((run) => run.argv)).toEqual([IDENTITY]);
    },
  );

  test.concurrent(
    'AC-19: every aws call runs in eu-west-1 with an empty pager, whatever the caller sets',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-19 environment',
        extraEnv: { AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'us-west-2', AWS_PAGER: 'less' },
      });
      expect(result.aws.length).toBeGreaterThan(0);
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
// AC-20, AC-21: the live checks
// =================================================================================================

describe('verify.sh: live checks (VERIFY_ASSUME=1)', () => {
  const LIVE_ORIGINAL = { ...LIVE_ENV, ...ORIGINAL_ENV };

  test.concurrent('AC-20: a healthy live run prints 18 ok lines and one skip', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 healthy', extraEnv: LIVE_ENV });
    expectRun(result, { live: true });
    expect(result.status).toBe(0);
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (18 passed, 1 skipped)');
  });

  test.concurrent(
    'AC-20: assume-caller runs with the environment of the test, untouched',
    async () => {
      const fixture = healthy();
      const result = await runVerify(fixture, { label: 'AC-20 original', extraEnv: LIVE_ORIGINAL });
      const [run] = runsOf(result, callOf(fixture.world, 'assume-caller'));
      expect(run, 'no assume-caller call').toBeDefined();
      expect([run?.keyId, run?.secret, run?.token]).toEqual([
        ORIGINAL_SESSION.id,
        ORIGINAL_SESSION.secret,
        ORIGINAL_SESSION.token,
      ]);
      expect([run?.profile, run?.defaultProfile]).toEqual(['set', 'set']);
    },
  );

  test.concurrent.each([
    { key: 'assume-target' },
    { key: 'wrong-external-id-denied' },
    { key: 'missing-external-id-denied' },
  ])('AC-20: $key runs with the caller session and without a profile', async ({ key }) => {
    const fixture = healthy();
    const result = await runVerify(fixture, { label: `AC-20 ${key} env`, extraEnv: LIVE_ORIGINAL });
    const [run] = runsOf(result, callOf(fixture.world, key));
    expect(run, `no ${key} call`).toBeDefined();
    expect([run?.keyId, run?.secret, run?.token]).toEqual([
      CALLER_SESSION.id,
      CALLER_SESSION.secret,
      CALLER_SESSION.token,
    ]);
    expect([run?.profile, run?.defaultProfile]).toEqual(['unset', 'unset']);
  });

  test.concurrent(
    'AC-20: target-lists-reports runs with the target session and without a profile',
    async () => {
      const fixture = healthy();
      const result = await runVerify(fixture, {
        label: 'AC-20 target env',
        extraEnv: LIVE_ORIGINAL,
      });
      const runs = runsOf(result, callOf(fixture.world, 'target-lists-reports'));
      expect(runs).toHaveLength(2);
      const target = runs.find((run) => run.keyId === TARGET_SESSION.id);
      expect(target, 'no list-objects call with the target session').toBeDefined();
      expect([target?.keyId, target?.secret, target?.token]).toEqual([
        TARGET_SESSION.id,
        TARGET_SESSION.secret,
        TARGET_SESSION.token,
      ]);
      expect([target?.profile, target?.defaultProfile]).toEqual(['unset', 'unset']);
    },
  );

  test.concurrent(
    'AC-20: caller-cannot-list-reports-live runs with the caller session and without a profile',
    async () => {
      const fixture = healthy();
      const result = await runVerify(fixture, {
        label: 'AC-20 caller list env',
        extraEnv: LIVE_ORIGINAL,
      });
      const runs = runsOf(result, callOf(fixture.world, 'caller-cannot-list-reports-live'));
      const caller = runs.find((run) => run.keyId === CALLER_SESSION.id);
      expect(caller, 'no list-objects call with the caller session').toBeDefined();
      expect([caller?.secret, caller?.token]).toEqual([
        CALLER_SESSION.secret,
        CALLER_SESSION.token,
      ]);
      expect([caller?.profile, caller?.defaultProfile]).toEqual(['unset', 'unset']);
    },
  );

  test.concurrent(
    'AC-20: the wrong-external-id call uses wrong-external-id and the missing one has no --external-id',
    async () => {
      const fixture = healthy();
      const result = await runVerify(fixture, { label: 'AC-20 external ids', extraEnv: LIVE_ENV });
      const wrong = runsOf(result, callOf(fixture.world, 'wrong-external-id-denied'));
      const missing = runsOf(result, callOf(fixture.world, 'missing-external-id-denied'));
      expect(wrong).toHaveLength(1);
      expect(missing).toHaveLength(1);
      expect(optionOf(wrong[0]?.argv ?? [], '--external-id')).toBe('wrong-external-id');
      expect(missing[0]?.argv ?? []).not.toContain('--external-id');
    },
  );

  test.concurrent('AC-20: the session keys never appear in an argv', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 argv', extraEnv: LIVE_ORIGINAL });
    expect(result.aws.length).toBeGreaterThan(CHECK_IDS.length);
    for (const run of result.aws) {
      for (const value of SESSION_VALUES) expect(run.argv.join(' '), value).not.toContain(value);
    }
    expect(result.calls.flat().join(' ')).not.toMatch(
      /CALLERKEYID|TARGETKEYID|SECRETVALUE|TOKENVALUE/,
    );
  });

  test.concurrent('AC-20: denied answers (exit 254, AccessDenied) give ok lines', async () => {
    const result = await runVerify(healthy(), { label: 'AC-20 denied', extraEnv: LIVE_ENV });
    const lines = outLines(result.stdout);
    for (const id of [
      'wrong-external-id-denied',
      'missing-external-id-denied',
      'caller-cannot-list-reports-live',
    ]) {
      expect(lines).toContain(`ok: ${id}`);
    }
  });

  // ---- AC-21 ----

  test.concurrent.each([
    { name: 'exit 254', reply: denied() },
    { name: 'two tokens', reply: ok('CALLERKEYIDVALUE\tCALLERSECRETVALUE') },
    { name: 'four tokens', reply: ok(`${tabs(CALLER_SESSION)}\textra`) },
    { name: 'an empty answer', reply: ok('') },
  ])(
    'AC-21: assume-caller with $name fails and skips the five checks after it',
    async ({ name, reply }) => {
      const fixture = healthy();
      fixture.replies['assume-caller'] = reply;
      const result = await runVerify(fixture, {
        label: `AC-21 assume-caller ${name}`,
        extraEnv: LIVE_ENV,
      });
      const skipped: Record<string, string> = {};
      for (const id of LIVE_IDS.slice(1)) skipped[id] = `skip: ${id}: assume-caller failed`;
      expectRun(result, { live: true }, { 'assume-caller': true, ...skipped });
      expect(
        result.aws.filter((run) => run.argv[0] === 'sts' && run.argv[1] === 'assume-role'),
      ).toHaveLength(1);
      expect(result.aws.filter((run) => run.argv[1] === 'list-objects-v2')).toEqual([]);
    },
  );

  test.concurrent.each([
    { name: 'exit 254', reply: denied() },
    { name: 'two tokens', reply: ok('TARGETKEYIDVALUE\tTARGETSECRETVALUE') },
  ])(
    'AC-21: assume-target with $name fails and skips only target-lists-reports',
    async ({ name, reply }) => {
      const fixture = healthy();
      fixture.replies['assume-target'] = reply;
      const result = await runVerify(fixture, {
        label: `AC-21 assume-target ${name}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(
        result,
        { live: true },
        {
          'assume-target': true,
          'target-lists-reports': 'skip: target-lists-reports: assume-target failed',
        },
      );
      expect(result.aws.filter((run) => run.argv[1] === 'list-objects-v2')).toHaveLength(1);
    },
  );

  test.concurrent.each([
    {
      id: 'wrong-external-id-denied',
      line: 'FAIL: wrong-external-id-denied: AssumeRole worked with a wrong external ID',
      reply: ok(tabs(TARGET_SESSION)),
    },
    {
      id: 'missing-external-id-denied',
      line: 'FAIL: missing-external-id-denied: AssumeRole worked without an external ID',
      reply: ok(tabs(TARGET_SESSION)),
    },
    {
      id: 'caller-cannot-list-reports-live',
      line: 'FAIL: caller-cannot-list-reports-live: the caller could list the bucket',
      reply: ok('0'),
    },
  ])('AC-21: $id answering exit 0 fails with the text of the spec', async ({ id, line, reply }) => {
    const fixture = healthy();
    fixture.replies[id] = reply;
    const result = await runVerify(fixture, { label: `AC-21 ${id} exit 0`, extraEnv: LIVE_ENV });
    expectRun(result, { live: true }, { [id]: line });
  });

  test.concurrent.each([
    { id: 'wrong-external-id-denied' },
    { id: 'missing-external-id-denied' },
    { id: 'caller-cannot-list-reports-live' },
  ])(
    'AC-21: $id exiting 255 without AccessDenied fails with "could not ask AWS"',
    async ({ id }) => {
      const fixture = healthy();
      fixture.replies[id] = failing(255, `Unable to locate credentials ${STUB_ERR}`);
      const result = await runVerify(fixture, {
        label: `AC-21 ${id} exit 255`,
        extraEnv: LIVE_ENV,
      });
      expectRun(result, { live: true }, { [id]: `FAIL: ${id}: could not ask AWS` });
    },
  );

  test.concurrent.each([
    { name: 'None', answer: 'None' },
    { name: 'abc', answer: 'abc' },
    { name: '-1', answer: '-1' },
  ])('AC-21: target-lists-reports answering $name fails', async ({ name, answer: text }) => {
    const fixture = healthy();
    fixture.replies['target-lists-reports'] = ok(text);
    const result = await runVerify(fixture, {
      label: `AC-21 list answer ${name}`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true }, { 'target-lists-reports': true });
  });

  test.concurrent('AC-21: target-lists-reports answering a count of 7 is ok', async () => {
    const fixture = healthy();
    fixture.replies['target-lists-reports'] = ok('7');
    const result = await runVerify(fixture, { label: 'AC-21 list 7', extraEnv: LIVE_ENV });
    expectRun(result, { live: true });
  });

  test.concurrent(
    'AC-21: an external ID of wrong-external-id makes the wrong call use wrong-external-id-2',
    async () => {
      const fixture = healthy({ ext: 'wrong-external-id' });
      const result = await runVerify(fixture, { label: 'AC-21 wrong-2', extraEnv: LIVE_ENV });
      expectRun(result, { live: true });
      const assumes = result.aws.filter(
        (run) => run.argv[0] === 'sts' && run.argv[1] === 'assume-role',
      );
      expect(assumes.map((run) => optionOf(run.argv, '--external-id'))).toEqual([
        undefined,
        'wrong-external-id',
        'wrong-external-id-2',
        undefined,
      ]);
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
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (12 passed, 7 skipped)');
  });

  test.concurrent('AC-23: CRLF answers give the stdout of AC-20 with the live checks', async () => {
    const result = await runVerify(crlf(healthy()), {
      label: 'AC-23 crlf live',
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true });
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (18 passed, 1 skipped)');
  });

  test.concurrent(
    'AC-23: CRLF answers with a trusted account give ok for the principals and the finding',
    async () => {
      const result = await runVerify(crlf(withTrusted()), { label: 'AC-23 crlf trusted' });
      expectRun(result, { trusted: true });
    },
  );

  test.concurrent('AC-23: a CRLF wrong answer still fails only that check', async () => {
    const fixture = crlf(healthy());
    fixture.replies['caller-role'] = ok(`/\t${BOUNDARY}x`);
    const result = await runVerify(fixture, { label: 'AC-23 crlf fail' });
    expectRun(result, {}, { 'caller-role': true });
  });
});

// =================================================================================================
// AC-24: the script cannot run
// =================================================================================================

describe('verify.sh: usage, tools, outputs and identity', () => {
  /** Nothing of a run happened: no check line, no summary. */
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

  test.concurrent.each(
    OUTPUT_NAMES.filter((name) => name !== 'trusted_account_id').map((name) => ({ name })),
  )('AC-24: an empty output $name stops the script with exit 2', async ({ name }) => {
    const fixture = healthy();
    fixture.outputs[name] = ok('');
    const result = await runVerify(fixture, { label: `AC-24 ${name} empty` });
    expect(result.stderr.split(/\r?\n/)).toContain(
      `verify: terraform output ${name} is empty; apply the stack first`,
    );
    expectCouldNotRun(result);
  });

  test.concurrent.each(
    OUTPUT_NAMES.filter((name) => name !== 'trusted_account_id').map((name) => ({ name })),
  )('AC-24: terraform output $name exiting 1 stops the script with exit 2', async ({ name }) => {
    const fixture = healthy();
    fixture.outputs[name] = failing(
      1,
      `Error: no outputs for ${CALLER} ${ACCT}, run apply first ${STUB_ERR}`,
    );
    const result = await runVerify(fixture, { label: `AC-24 ${name} fails` });
    expect(result.stderr.split(/\r?\n/)).toContain(
      `verify: terraform output ${name} is empty; apply the stack first`,
    );
    expectCouldNotRun(result);
  });

  test.concurrent(
    'AC-24: terraform output trusted_account_id exiting 1 stops the script with exit 2',
    async () => {
      const fixture = healthy();
      fixture.outputs['trusted_account_id'] = failing(
        1,
        `Error: no outputs for ${CALLER} ${ACCT} ${STUB_ERR}`,
      );
      const result = await runVerify(fixture, { label: 'AC-24 trusted_account_id fails' });
      expect(result.stderr).toContain('trusted_account_id');
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
    'AC-22: a failing aws call prints none of its stderr, nor an ARN, bucket or account ID',
    async () => {
      const fixture = healthy();
      fixture.replies['caller-role'] = failing(
        254,
        `An error occurred (AccessDenied) arn:aws:sts::${ACCT}:assumed-role/x ${BUCKET} ${STUB_ERR}`,
      );
      fixture.replies['reports-bucket-private'] = failing(255, `${BUCKET} ${ACCT} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-22 failing calls' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: mismatches on values that hold an ARN or the account ID print none of them',
    async () => {
      const fixture = withTrusted();
      fixture.replies['caller-role'] = ok(`/lab/\tarn:aws:iam::${ACCT}:policy/other`);
      fixture.replies['caller-trust'] = ok(`Allow\tsts:AssumeRole\t${OTHER_ROOT}\tNone`);
      fixture.replies['target-principals'] = ok(`${ROOT}\t${OTHER_ROOT}`);
      fixture.replies['external-access-finding'] = ok(OTHER_ROOT);
      const result = await runVerify(fixture, { label: 'AC-22 mismatches' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: a live run that fails after the assume calls prints no key, secret or token',
    async () => {
      const fixture = healthy();
      fixture.replies['wrong-external-id-denied'] = ok(tabs(TARGET_SESSION));
      fixture.replies['caller-cannot-list-reports-live'] = ok('3');
      const result = await runVerify(fixture, {
        label: 'AC-22 live failures',
        extraEnv: { ...LIVE_ENV, ...ORIGINAL_ENV },
      });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-22: a terraform output that fails with an ARN prints none of it',
    async () => {
      const fixture = healthy();
      fixture.outputs['target_role_arn'] = failing(1, `Error: ${TARGET} ${ACCT} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-22 terraform' });
      expect(result.status).toBe(2);
      expect(leaks(result.all)).toEqual([]);
    },
  );
});

describe('verify.sh: audit over every run of this file', () => {
  test('AC-22: no run printed a 12-digit number, an ARN, a bucket name, a key or a stub stderr', () => {
    expect(RUNS.length).toBeGreaterThan(60);
    const found = RUNS.flatMap(({ label, result }) =>
      leaks(result.all).map((needle) => `${label}: printed ${needle}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-22: no run made a call a stub had no answer for', () => {
    expect(RUNS.length).toBeGreaterThan(60);
    const found = RUNS.filter(({ result }) => result.unexpected.length > 0).map(
      ({ label, result }) => `${label}: ${result.unexpected.join('; ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-22: no run put a key, secret or token in an argv', () => {
    expect(RUNS.length).toBeGreaterThan(60);
    const found: string[] = [];
    for (const { label, result } of RUNS) {
      for (const call of result.calls) {
        const text = call.join(' ');
        for (const value of SESSION_VALUES)
          if (text.includes(value)) found.push(`${label}: ${value}`);
      }
    }
    expect(found).toEqual([]);
  });
});
