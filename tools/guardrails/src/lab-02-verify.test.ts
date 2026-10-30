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

// Spec 041 (issue #111), AC-16 to AC-24: labs/02-s3-kms-encryption/verify.sh.
//
// verify.sh is executed with bash and stub `terraform` and `aws` binaries on PATH (the approach of
// lab-01-verify.test.ts). Every stub appends one tab separated line to calls.log. The aws stub also
// logs, per call, the three credential variables, whether AWS_PROFILE / AWS_DEFAULT_PROFILE are set,
// and the region and pager variables (aws-env.log, same order as the aws lines of calls.log), and,
// for a call with --body, the content of the body file at that moment (body-<line number>).
//
// The aws stub answers by what the call asks, not by the order of its arguments: the service and
// operation plus the value of each option the spec uses (--role-name, --bucket, --key-id,
// --policy-source-arn, --action-names, --resource-arns, --role-arn, --server-side-encryption,
// --ssekms-key-id, --endpoint-url, --key, --context-entries, --query). The exact argv, in the exact
// order, is checked by AC-18. A stub that "uploads" keeps the body it was given and the stub that
// "downloads" writes it to the out file, as S3 would.
//
// Every run gets its own TMPDIR: after the run nothing may be left in it, and the body and out files
// seen in the argv must be gone (AC-19).

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const slash = (path: string): string => path.replace(/\\/g, '/');

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

const LAB = ['labs', '02-s3-kms-encryption'];

// ---- Fixture data ---------------------------------------------------------------------------------

const ACCT = '111122223333';
const OTHER_ACCT = '777788889999';
const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const KEY = `arn:aws:kms:eu-west-1:${ACCT}:key/${KEY_ID}`;
const OTHER_KEY = `arn:aws:kms:eu-west-1:${ACCT}:key/abcdef01-ab12-cd34-ef56-0123456789ab`;
const ZERO_KEY = `arn:aws:kms:eu-west-1:${ACCT}:key/00000000-0000-0000-0000-000000000000`;
const DATA = `field-guide-lab02-data-${ACCT}`;
const LOGS = `field-guide-lab02-logs-${ACCT}`;
const PREFIX = 's3-access/';
const ALIAS = 'alias/fg-lab02-data';
const ROOT = `arn:aws:iam::${ACCT}:root`;
const OTHER_ROOT = `arn:aws:iam::${OTHER_ACCT}:root`;
const CLIENT = `arn:aws:iam::${ACCT}:role/lab/fg-lab02-client`;
const BOUNDARY = `arn:aws:iam::${ACCT}:policy/fg-workload-boundary`;
const OBJECT_KEY = 'verify-probe.txt';
const BODY_TEXT = 'lab 02 verify probe';
const VIA_S3 = 's3.eu-west-1.amazonaws.com';
const CONTEXT = `ContextKeyName=kms:ViaService,ContextKeyValues=${VIA_S3},ContextKeyType=string`;
const PUT_QUERY = '[ServerSideEncryption,SSEKMSKeyId,BucketKeyEnabled]';
const STUB_ERR = 'stub-stderr-must-never-be-printed';
const USAGE = 'usage: bash verify.sh (no arguments; run it from the stack directory)';
const SKIP_LIVE = 'set VERIFY_ASSUME=1 to try it for real (needs sts:AssumeRole and s3:PutObject)';
const BODY = '<body>';
const OUT = '<out>';

interface Session {
  id: string;
  secret: string;
  token: string;
}

const CLIENT_SESSION: Session = {
  id: 'CLIENTKEYIDVALUE',
  secret: 'CLIENTSECRETVALUE',
  token: 'CLIENTTOKENVALUE',
};
const ORIGINAL_SESSION: Session = {
  id: 'ORIGINALKEYIDVALUE',
  secret: 'ORIGINALSECRETVALUE',
  token: 'ORIGINALTOKENVALUE',
};
const SESSION_VALUES = [CLIENT_SESSION, ORIGINAL_SESSION].flatMap((session) => [
  session.id,
  session.secret,
  session.token,
]);

const tabs = (session: Session): string => `${session.id}\t${session.secret}\t${session.token}`;

const OUTPUT_NAMES = [
  'client_role_arn',
  'data_bucket_name',
  'log_bucket_name',
  'log_prefix',
  'kms_key_arn',
  'kms_key_alias',
] as const;

const OUTPUT_VALUES: Record<(typeof OUTPUT_NAMES)[number], string> = {
  client_role_arn: CLIENT,
  data_bucket_name: DATA,
  log_bucket_name: LOGS,
  log_prefix: PREFIX,
  kms_key_arn: KEY,
  kms_key_alias: ALIAS,
};

/** The order of the checks in the spec tables, and so of the stdout lines. */
const ORDER = [
  'client-role',
  'client-trust',
  'kms-key',
  'kms-key-rotation',
  'kms-key-alias',
  'data-default-encryption',
  'data-sse-c-blocked',
  'data-bucket-private',
  'data-bucket-policy',
  'access-logging',
  'log-bucket-private',
  'log-bucket-encryption',
  'log-bucket-policy',
  'log-expiry',
  'client-may-put',
  'client-key-via-s3',
  'client-key-only-via-s3',
  'assume-client',
  'default-upload',
  'named-key-upload',
  'sse-s3-upload-denied',
  'kms-without-key-denied',
  'other-key-denied',
  'http-denied',
  'download',
] as const;
const CHECK_IDS: string[] = ORDER.slice(0, 17);
const LIVE_IDS: string[] = ORDER.slice(17);
const AFTER_ASSUME_IDS = LIVE_IDS.slice(1);
const DENIED_IDS = [
  'sse-s3-upload-denied',
  'kms-without-key-denied',
  'other-key-denied',
  'http-denied',
];

// ---- The bucket policies, as jsonencode writes them (compact, keys sorted) ---------------------

const DATA_ARN = `arn:aws:s3:::${DATA}`;
const LOGS_ARN = `arn:aws:s3:::${LOGS}`;

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
        Action: 's3:PutObject',
        Condition: {
          StringNotEqualsIfExists: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
        Effect: 'Deny',
        Principal: '*',
        Resource: `${DATA_ARN}/*`,
        Sid: 'DenyOtherEncryption',
      },
      {
        Action: 's3:PutObject',
        Condition: {
          ArnNotEqualsIfExists: { 's3:x-amz-server-side-encryption-aws-kms-key-id': KEY },
        },
        Effect: 'Deny',
        Principal: '*',
        Resource: `${DATA_ARN}/*`,
        Sid: 'DenyOtherKmsKey',
      },
      {
        Action: 's3:PutObject',
        Condition: {
          Null: { 's3:x-amz-server-side-encryption-aws-kms-key-id': 'true' },
          StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
        Effect: 'Deny',
        Principal: '*',
        Resource: `${DATA_ARN}/*`,
        Sid: 'DenyKmsWithoutKeyId',
      },
    ],
    Version: '2012-10-17',
  });
}

function logPolicy(): string {
  return JSON.stringify({
    Statement: [
      {
        Action: 's3:PutObject',
        Condition: {
          ArnLike: { 'aws:SourceArn': DATA_ARN },
          StringEquals: { 'aws:SourceAccount': ACCT },
        },
        Effect: 'Allow',
        Principal: { Service: 'logging.s3.amazonaws.com' },
        Resource: `${LOGS_ARN}/s3-access/*`,
        Sid: 'AllowServerAccessLogs',
      },
      {
        Action: 's3:*',
        Condition: {
          Bool: { 'aws:PrincipalIsAWSService': 'false', 'aws:SecureTransport': 'false' },
        },
        Effect: 'Deny',
        Principal: '*',
        Resource: [LOGS_ARN, `${LOGS_ARN}/*`],
        Sid: 'DenyInsecureTransport',
      },
    ],
    Version: '2012-10-17',
  });
}

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
  /** For the download only: the exact content of the out file (default: what was uploaded). */
  file?: string;
}

const ok = (out: string): Reply => ({ out, exit: 0, err: '', quiet: false });
const failing = (exit: number, err: string): Reply => ({ out: '', exit, err, quiet: true });

/** S3's same-account AccessDenied when a bucket policy denies the request. */
const bucketPolicyDenied = (operation = 'PutObject'): Reply =>
  failing(
    254,
    `An error occurred (AccessDenied) when calling the ${operation} operation: User: arn:aws:sts::${ACCT}:assumed-role/fg-lab02-client/lab02-verify is not authorized to perform: s3:${operation} on resource: "${DATA_ARN}/${OBJECT_KEY}" with an explicit deny in a resource-based policy ${STUB_ERR}`,
  );

/** AccessDenied that does not come from the bucket policy: KMS, or a missing identity allow. */
const kmsDenied = (): Reply =>
  failing(
    254,
    `An error occurred (AccessDenied) when calling the PutObject operation: User: arn:aws:sts::${ACCT}:assumed-role/fg-lab02-client/lab02-verify is not authorized to perform: kms:GenerateDataKey on resource: ${KEY} because no identity-based policy allows the kms:GenerateDataKey action ${STUB_ERR}`,
  );
const identityDenied = (): Reply =>
  failing(
    254,
    `An error occurred (AccessDenied) when calling the PutObject operation: User: arn:aws:sts::${ACCT}:assumed-role/fg-lab02-client/lab02-verify is not authorized to perform: s3:PutObject on resource: "${DATA_ARN}/${OBJECT_KEY}" because no identity-based policy allows the s3:PutObject action ${STUB_ERR}`,
  );

// ---- The aws calls of the spec tables -------------------------------------------------------------

const getRole = (query: string): string[] => [
  'iam',
  'get-role',
  '--role-name',
  'fg-lab02-client',
  '--query',
  query,
  '--output',
  'text',
];

const bucketPublicAccess = (bucket: string): string[] => [
  's3api',
  'get-public-access-block',
  '--bucket',
  bucket,
  '--query',
  'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]',
  '--output',
  'text',
];

const bucketPolicyOf = (bucket: string): string[] => [
  's3api',
  'get-bucket-policy',
  '--bucket',
  bucket,
  '--query',
  'Policy',
  '--output',
  'text',
];

const simulate = (action: string, resource: string, extra: string[] = []): string[] => [
  'iam',
  'simulate-principal-policy',
  '--policy-source-arn',
  CLIENT,
  '--action-names',
  action,
  '--resource-arns',
  resource,
  ...extra,
  '--query',
  'EvaluationResults[0].EvalDecision',
  '--output',
  'text',
];

const putObject = (extra: string[], query = true): string[] => [
  's3api',
  'put-object',
  '--bucket',
  DATA,
  '--key',
  OBJECT_KEY,
  '--body',
  BODY,
  ...extra,
  ...(query ? ['--query', PUT_QUERY, '--output', 'text'] : []),
];

const IDENTITY = ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'];

interface Check {
  id: string;
  argv: string[];
  pass: Reply;
  /** The stub keeps the body of an upload / writes the out file of a download. */
  kind?: 'upload' | 'download';
}

/** Every aws call of checks 1 to 25, in table order. `<body>` and `<out>` stand for the temp files. */
function checks(): Check[] {
  return [
    {
      id: 'client-role',
      argv: getRole('Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]'),
      pass: ok(`/lab/\t${BOUNDARY}`),
    },
    {
      id: 'client-trust',
      argv: getRole(
        'Role.AssumeRolePolicyDocument.Statement[].[Effect,Action,Principal.AWS,Condition]',
      ),
      pass: ok(`Allow\tsts:AssumeRole\t${ROOT}\tNone`),
    },
    {
      id: 'kms-key',
      argv: [
        'kms',
        'describe-key',
        '--key-id',
        KEY,
        '--query',
        'KeyMetadata.[KeyState,KeyManager,KeySpec,KeyUsage,MultiRegion]',
        '--output',
        'text',
      ],
      pass: ok('Enabled\tCUSTOMER\tSYMMETRIC_DEFAULT\tENCRYPT_DECRYPT\tFalse'),
    },
    {
      id: 'kms-key-rotation',
      argv: [
        'kms',
        'get-key-rotation-status',
        '--key-id',
        KEY,
        '--query',
        'KeyRotationEnabled',
        '--output',
        'text',
      ],
      pass: ok('True'),
    },
    {
      id: 'kms-key-alias',
      argv: [
        'kms',
        'list-aliases',
        '--key-id',
        KEY,
        '--query',
        'Aliases[].AliasName',
        '--output',
        'text',
      ],
      pass: ok(ALIAS),
    },
    {
      id: 'data-default-encryption',
      argv: [
        's3api',
        'get-bucket-encryption',
        '--bucket',
        DATA,
        '--query',
        'ServerSideEncryptionConfiguration.Rules[0].[ApplyServerSideEncryptionByDefault.SSEAlgorithm,ApplyServerSideEncryptionByDefault.KMSMasterKeyID,BucketKeyEnabled]',
        '--output',
        'text',
      ],
      pass: ok(`aws:kms\t${KEY}\tTrue`),
    },
    {
      id: 'data-sse-c-blocked',
      argv: [
        's3api',
        'get-bucket-encryption',
        '--bucket',
        DATA,
        '--query',
        'ServerSideEncryptionConfiguration.Rules[0].BlockedEncryptionTypes.EncryptionType',
        '--output',
        'text',
      ],
      pass: ok('SSE-C'),
    },
    {
      id: 'data-bucket-private',
      argv: bucketPublicAccess(DATA),
      pass: ok('True\tTrue\tTrue\tTrue'),
    },
    { id: 'data-bucket-policy', argv: bucketPolicyOf(DATA), pass: ok(dataPolicy()) },
    {
      id: 'access-logging',
      argv: [
        's3api',
        'get-bucket-logging',
        '--bucket',
        DATA,
        '--query',
        'LoggingEnabled.[TargetBucket,TargetPrefix]',
        '--output',
        'text',
      ],
      pass: ok(`${LOGS}\t${PREFIX}`),
    },
    {
      id: 'log-bucket-private',
      argv: bucketPublicAccess(LOGS),
      pass: ok('True\tTrue\tTrue\tTrue'),
    },
    {
      id: 'log-bucket-encryption',
      argv: [
        's3api',
        'get-bucket-encryption',
        '--bucket',
        LOGS,
        '--query',
        'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm',
        '--output',
        'text',
      ],
      pass: ok('AES256'),
    },
    { id: 'log-bucket-policy', argv: bucketPolicyOf(LOGS), pass: ok(logPolicy()) },
    {
      id: 'log-expiry',
      argv: [
        's3api',
        'get-bucket-lifecycle-configuration',
        '--bucket',
        LOGS,
        '--query',
        "Rules[?ID=='expire-access-logs'].[Status,Expiration.Days]",
        '--output',
        'text',
      ],
      pass: ok('Enabled\t7'),
    },
    {
      id: 'client-may-put',
      argv: simulate('s3:PutObject', `${DATA_ARN}/${OBJECT_KEY}`),
      pass: ok('allowed'),
    },
    {
      id: 'client-key-via-s3',
      argv: simulate('kms:GenerateDataKey', KEY, ['--context-entries', CONTEXT]),
      pass: ok('allowed'),
    },
    {
      id: 'client-key-only-via-s3',
      argv: simulate('kms:Decrypt', KEY),
      pass: ok('implicitDeny'),
    },
    {
      id: 'assume-client',
      argv: [
        'sts',
        'assume-role',
        '--role-arn',
        CLIENT,
        '--role-session-name',
        'lab02-verify',
        '--query',
        'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]',
        '--output',
        'text',
      ],
      pass: ok(tabs(CLIENT_SESSION)),
    },
    {
      id: 'default-upload',
      argv: putObject([]),
      pass: ok(`aws:kms\t${KEY}\tTrue`),
      kind: 'upload',
    },
    {
      id: 'named-key-upload',
      argv: putObject(['--server-side-encryption', 'aws:kms', '--ssekms-key-id', KEY]),
      pass: ok(`aws:kms\t${KEY}\tTrue`),
      kind: 'upload',
    },
    {
      id: 'sse-s3-upload-denied',
      argv: putObject(['--server-side-encryption', 'AES256'], false),
      pass: bucketPolicyDenied(),
    },
    {
      id: 'kms-without-key-denied',
      argv: putObject(['--server-side-encryption', 'aws:kms'], false),
      pass: bucketPolicyDenied(),
    },
    {
      id: 'other-key-denied',
      argv: putObject(['--server-side-encryption', 'aws:kms', '--ssekms-key-id', ZERO_KEY], false),
      pass: bucketPolicyDenied(),
    },
    {
      id: 'http-denied',
      argv: [
        's3api',
        'get-object',
        '--bucket',
        DATA,
        '--key',
        OBJECT_KEY,
        '--endpoint-url',
        'http://s3.eu-west-1.amazonaws.com',
        OUT,
      ],
      pass: bucketPolicyDenied('GetObject'),
    },
    {
      id: 'download',
      argv: [
        's3api',
        'get-object',
        '--bucket',
        DATA,
        '--key',
        OBJECT_KEY,
        OUT,
        '--query',
        'ServerSideEncryption',
        '--output',
        'text',
      ],
      pass: ok('aws:kms'),
      kind: 'download',
    },
  ];
}

function checkOf(id: string): Check {
  const check = checks().find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

/**
 * The options the stub answers by, as `name=value` pairs; the shell in AWS_PRELUDE builds the same
 * string. Options are matched by name wherever they stand, so the order of the arguments is free.
 */
const SIGNATURE_OPTIONS: [string, string][] = [
  ['--query', 'q'],
  ['--role-name', 'rn'],
  ['--bucket', 'bk'],
  ['--key-id', 'kid'],
  ['--policy-source-arn', 'sarn'],
  ['--action-names', 'act'],
  ['--resource-arns', 'res'],
  ['--role-arn', 'rarn'],
  ['--server-side-encryption', 'sse'],
  ['--ssekms-key-id', 'sid'],
  ['--endpoint-url', 'ep'],
  ['--key', 'obj'],
  ['--context-entries', 'ctx'],
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
  /** aws replies by check id. */
  replies: Record<string, Reply>;
  /** terraform replies by output name. */
  outputs: Record<string, Reply>;
  /** The reply of `aws sts get-caller-identity`. */
  identity: Reply;
  awsEol: string;
  tfEol: string;
}

function healthy(): Fixture {
  const replies: Record<string, Reply> = {};
  for (const check of checks()) replies[check.id] = check.pass;
  const outputs: Record<string, Reply> = {};
  for (const name of OUTPUT_NAMES) outputs[name] = ok(OUTPUT_VALUES[name]);
  return { replies, outputs, identity: ok(ACCT), awsEol: '\n', tfEol: '' };
}

/** A healthy fixture where the answer of one check is replaced. */
function answering(id: string, reply: Reply): Fixture {
  const fixture = healthy();
  fixture.replies[id] = reply;
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
  reply: Reply;
  eol: string;
  kind?: 'upload' | 'download';
}

function ruleBody(dir: string, id: string, rule: Rule): string {
  writeFileSync(join(dir, `${id}.out`), rule.reply.quiet ? '' : rule.reply.out + rule.eol);
  if (rule.reply.err !== '') writeFileSync(join(dir, `${id}.err`), rule.reply.err + rule.eol);
  const lines: string[] = [];
  if (rule.kind === 'upload' && rule.reply.exit === 0) {
    lines.push(
      'if [ -n "$bodyfile" ] && [ -f "$bodyfile" ]; then cp "$bodyfile" "$FAKE_LOG_DIR/stored"; fi',
    );
  }
  if (rule.kind === 'download' && rule.reply.exit === 0) {
    if (rule.reply.file !== undefined) {
      writeFileSync(join(dir, `${id}.file`), rule.reply.file);
      lines.push(`cat "$D/${id}.file" > "$pos"`);
    } else {
      lines.push(
        'if [ -f "$FAKE_LOG_DIR/stored" ]; then cp "$FAKE_LOG_DIR/stored" "$pos"; else : > "$pos"; fi',
      );
    }
  }
  lines.push(`cat "$D/${id}.out"`);
  lines.push(rule.reply.err !== '' ? `cat "$D/${id}.err" >&2` : ':');
  lines.push(`exit ${rule.reply.exit}`);
  return lines.join('\n    ');
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

/** Logs the call's environment, then builds $key (the same string as signature()) and $bodyfile, $pos. */
const AWS_PRELUDE = `ak="\${AWS_ACCESS_KEY_ID-<unset>}"
if [ -n "\${AWS_PROFILE+x}" ]; then pf=set; else pf=unset; fi
if [ -n "\${AWS_DEFAULT_PROFILE+x}" ]; then dpf=set; else dpf=unset; fi
printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$ak" "\${AWS_SECRET_ACCESS_KEY-<unset>}" "\${AWS_SESSION_TOKEN-<unset>}" "$pf" "$dpf" "\${AWS_REGION-<unset>}" "\${AWS_DEFAULT_REGION-<unset>}" "\${AWS_PAGER-<unset>}" >> "$FAKE_LOG_DIR/aws-env.log"
q=''; rn=''; bk=''; kid=''; sarn=''; act=''; res=''; rarn=''; sse=''; sid=''; ep=''; obj=''; ctx=''
bodyfile=''; pos=''
p=''
for a in "$@"; do
  case "$p" in
    --query) q="$a";;
    --role-name) rn="$a";;
    --bucket) bk="$a";;
    --key-id) kid="$a";;
    --policy-source-arn) sarn="$a";;
    --action-names) act="$a";;
    --resource-arns) res="$a";;
    --role-arn) rarn="$a";;
    --server-side-encryption) sse="$a";;
    --ssekms-key-id) sid="$a";;
    --endpoint-url) ep="$a";;
    --key) obj="$a";;
    --context-entries) ctx="$a";;
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
key="$1 $2|q=$q|rn=$rn|bk=$bk|kid=$kid|sarn=$sarn|act=$act|res=$res|rarn=$rarn|sse=$sse|sid=$sid|ep=$ep|obj=$obj|ctx=$ctx"`;

const TOOLS = ['terraform', 'aws'] as const;
type Tool = (typeof TOOLS)[number];

function writeStubs(fixture: Fixture, bin: string, rulesDir: string, tools: readonly Tool[]): void {
  const terraformRules: Rule[] = OUTPUT_NAMES.map((name) => ({
    key: `output -raw ${name}`,
    reply: fixture.outputs[name] ?? ok(''),
    eol: fixture.tfEol,
  }));
  const awsRules: Rule[] = [
    { key: signature(IDENTITY), reply: fixture.identity, eol: fixture.awsEol },
    ...checks().map((check) => ({
      key: signature(check.argv),
      reply: fixture.replies[check.id] ?? ok(''),
      eol: fixture.awsEol,
      ...(check.kind === undefined ? {} : { kind: check.kind }),
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
  /** The content of the --body file when the call started, if the call has one. */
  body: string | undefined;
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
  /** Files still in the run's TMPDIR, and body / out files of the argv that still exist. */
  leftovers: string[];
}

const RUNS: { label: string; result: RunResult }[] = [];

function scriptPath(): string {
  const path = repoPath(...LAB, 'verify.sh');
  if (!existsSync(path)) throw new Error('missing file: labs/02-s3-kms-encryption/verify.sh');
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

function parseAws(callLines: string[][], envLines: string[], logs: string): AwsRun[] {
  const runs: AwsRun[] = [];
  let index = 0;
  callLines.forEach((call, lineIndex) => {
    if (call[0] !== 'aws') return;
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
    const bodyFile = join(logs, `body-${lineIndex + 1}`);
    runs.push({
      argv: call.slice(1),
      keyId,
      secret,
      token,
      profile,
      defaultProfile,
      region,
      defaultRegion,
      pager,
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

async function runVerify(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab02-verify-'));
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
    env['FAKE_LOG_DIR'] = slash(logs);
    env['TMPDIR'] = slash(temp);
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    const done = await execBash([script, ...(options.args ?? [])], work, env);
    const calls = readLines(join(logs, 'calls.log')).map((line) => line.split('\t'));
    const aws = parseAws(calls, readLines(join(logs, 'aws-env.log')), logs);
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
      calls,
      aws,
      unexpected: readLines(join(logs, 'unexpected.log')),
      leftovers,
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

const LIVE_ORIGINAL = { ...LIVE_ENV, ...ORIGINAL_ENV };

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

/** The calls of the run that ask what `check` asks. */
function runsOf(result: RunResult, id: string): AwsRun[] {
  const wanted = signature(checkOf(id).argv);
  return result.aws.filter((run) => signature(run.argv) === wanted);
}

function optionOf(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const isOp = (run: AwsRun, service: string, operation: string): boolean =>
  run.argv[0] === service && run.argv[1] === operation;

/** Lines a run that went on would print. */
const verdictLines = (stdout: string): string[] =>
  outLines(stdout).filter((line) => /^(ok|FAIL|skip|verify):/.test(line));

function leaks(text: string): string[] {
  const found: string[] = [];
  if (/\d{12}/.test(text)) found.push('a 12-digit number');
  for (const needle of [
    'arn:',
    DATA,
    LOGS,
    'field-guide-lab02',
    KEY_ID,
    '1234abcd',
    STUB_ERR,
    ...SESSION_VALUES,
  ]) {
    if (text.includes(needle)) found.push(needle);
  }
  return found;
}

// =================================================================================================
// AC-16: healthy, no VERIFY_ASSUME
// =================================================================================================

describe('verify.sh: healthy stack, no live checks', () => {
  const EXPECTED_STDOUT = [
    ...CHECK_IDS.map((id) => `ok: ${id}`),
    ...LIVE_IDS.map((id) => `skip: ${id}: ${SKIP_LIVE}`),
    'verify: ok (17 passed, 8 skipped)',
  ];

  test.concurrent(
    'AC-16: stdout is the 17 ok lines, the 8 skip lines and the summary',
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
    expect(CHECK_IDS).toHaveLength(17);
    expect(LIVE_IDS).toHaveLength(8);
  });

  test.concurrent('AC-16: no sts assume-role, put-object or get-object call is made', async () => {
    const result = await runVerify(healthy(), { label: 'AC-16 no live call' });
    expect(result.aws.length).toBeGreaterThan(0);
    expect(result.aws.filter((run) => isOp(run, 'sts', 'assume-role'))).toEqual([]);
    expect(result.aws.filter((run) => isOp(run, 's3api', 'put-object'))).toEqual([]);
    expect(result.aws.filter((run) => isOp(run, 's3api', 'get-object'))).toEqual([]);
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
    expect(result.aws.filter((run) => isOp(run, 'sts', 'assume-role'))).toEqual([]);
    expect(result.aws.filter((run) => isOp(run, 's3api', 'put-object'))).toEqual([]);
  });
});

// =================================================================================================
// AC-17: each of checks 1 to 17 fails on its own wrong answer
// =================================================================================================

interface Case {
  name: string;
  id: string;
  answer: string;
}

const wrong = (name: string, id: string, text: string): Case => ({ name, id, answer: text });

/** The healthy text of a policy check with one substring replaced. */
const dataPolicyWith = (from: string, to: string): string => dataPolicy().replaceAll(from, to);
const logPolicyWith = (from: string, to: string): string => logPolicy().replaceAll(from, to);

const AC17_CASES: Case[] = [
  wrong('the default role path', 'client-role', `/\t${BOUNDARY}`),
  wrong('no permissions boundary', 'client-role', '/lab/\tNone'),
  wrong('another permissions boundary', 'client-role', `/lab/\tarn:aws:iam::${ACCT}:policy/other`),
  wrong('a Condition', 'client-trust', `Allow\tsts:AssumeRole\t${ROOT}\tsomething`),
  wrong(
    'a second statement',
    'client-trust',
    `Allow\tsts:AssumeRole\t${ROOT}\tNone\nAllow\tsts:AssumeRole\t${ROOT}\tNone`,
  ),
  wrong('another principal', 'client-trust', `Allow\tsts:AssumeRole\t${OTHER_ROOT}\tNone`),
  wrong(
    'a disabled key',
    'kms-key',
    'Disabled\tCUSTOMER\tSYMMETRIC_DEFAULT\tENCRYPT_DECRYPT\tFalse',
  ),
  wrong('an AWS managed key', 'kms-key', 'Enabled\tAWS\tSYMMETRIC_DEFAULT\tENCRYPT_DECRYPT\tFalse'),
  wrong(
    'a multi-Region key',
    'kms-key',
    'Enabled\tCUSTOMER\tSYMMETRIC_DEFAULT\tENCRYPT_DECRYPT\tTrue',
  ),
  wrong('an asymmetric key', 'kms-key', 'Enabled\tCUSTOMER\tRSA_2048\tENCRYPT_DECRYPT\tFalse'),
  wrong('a key for signing', 'kms-key', 'Enabled\tCUSTOMER\tSYMMETRIC_DEFAULT\tSIGN_VERIFY\tFalse'),
  wrong('rotation off', 'kms-key-rotation', 'False'),
  wrong('no alias', 'kms-key-alias', ''),
  wrong('another alias', 'kms-key-alias', 'alias/other'),
  wrong('two aliases', 'kms-key-alias', `${ALIAS}\talias/other`),
  wrong('SSE-S3', 'data-default-encryption', `AES256\t${KEY}\tTrue`),
  wrong('another key', 'data-default-encryption', `aws:kms\t${OTHER_KEY}\tTrue`),
  wrong('the Bucket Key off', 'data-default-encryption', `aws:kms\t${KEY}\tFalse`),
  wrong('one False', 'data-bucket-private', 'True\tTrue\tFalse\tTrue'),
  wrong('the first False', 'data-bucket-private', 'False\tTrue\tTrue\tTrue'),
  wrong('another bucket', 'access-logging', `other-bucket\t${PREFIX}`),
  wrong('another prefix', 'access-logging', `${LOGS}\tother/`),
  wrong('no logging', 'access-logging', 'None'),
  wrong('one False', 'log-bucket-private', 'True\tFalse\tTrue\tTrue'),
  wrong('the first False', 'log-bucket-private', 'False\tTrue\tTrue\tTrue'),
  wrong('SSE-KMS', 'log-bucket-encryption', 'aws:kms'),
  wrong('a disabled rule', 'log-expiry', 'Disabled\t7'),
  wrong('30 days', 'log-expiry', 'Enabled\t30'),
  wrong('no rule', 'log-expiry', ''),
  wrong('an implicit deny', 'client-may-put', 'implicitDeny'),
  wrong('an implicit deny', 'client-key-via-s3', 'implicitDeny'),
  wrong('an allowed decision', 'client-key-only-via-s3', 'allowed'),
];

const POLICY_CASES: Case[] = [
  ...['DenyInsecureTransport', 'DenyOtherEncryption', 'DenyOtherKmsKey', 'DenyKmsWithoutKeyId'].map(
    (sid) =>
      wrong(
        `the Sid ${sid} missing`,
        'data-bucket-policy',
        dataPolicyWith(`"Sid":"${sid}"`, '"Sid":"Renamed"'),
      ),
  ),
  wrong('the lab key missing', 'data-bucket-policy', dataPolicyWith(KEY, OTHER_KEY)),
  wrong(
    'aws:SecureTransport missing',
    'data-bucket-policy',
    dataPolicyWith('aws:SecureTransport', 'aws:Other'),
  ),
  wrong(
    'no log delivery principal',
    'log-bucket-policy',
    logPolicyWith('logging.s3.amazonaws.com', 'other.amazonaws.com'),
  ),
  wrong(
    'another source bucket',
    'log-bucket-policy',
    logPolicyWith(`arn:aws:s3:::${DATA}`, 'arn:aws:s3:::other-bucket'),
  ),
];

describe('verify.sh: wrong answers', () => {
  test.concurrent.each([...AC17_CASES, wrong('none', 'data-sse-c-blocked', 'None')])(
    'AC-17: $id fails on $name',
    async ({ name, id, answer: text }) => {
      const result = await runVerify(answering(id, ok(text)), { label: `AC-17 ${id} ${name}` });
      expectRun(result, {}, { [id]: true });
      expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
    },
  );

  test.concurrent.each(POLICY_CASES)('AC-17: $id fails on $name', async ({ name, id, answer }) => {
    const result = await runVerify(answering(id, ok(answer)), { label: `AC-17 ${id} ${name}` });
    expectRun(result, {}, { [id]: true });
    expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
  });

  test.concurrent.each([
    { name: 'NONE', answer: 'NONE' },
    { name: 'SSE-C and NONE', answer: 'SSE-C\tNONE' },
  ])(
    'AC-17: data-sse-c-blocked fails with "SSE-C is not blocked" when the answer is $name',
    async ({ name, answer }) => {
      const result = await runVerify(answering('data-sse-c-blocked', ok(answer)), {
        label: `AC-17 sse-c ${name}`,
      });
      expectRun(
        result,
        {},
        { 'data-sse-c-blocked': 'FAIL: data-sse-c-blocked: SSE-C is not blocked' },
      );
    },
  );

  test.concurrent(
    'AC-17: data-sse-c-blocked answering None tells to update the AWS CLI',
    async () => {
      const result = await runVerify(answering('data-sse-c-blocked', ok('None')), {
        label: 'AC-17 sse-c none',
      });
      expectRun(
        result,
        {},
        {
          'data-sse-c-blocked':
            'FAIL: data-sse-c-blocked: SSE-C is not reported as blocked (an older AWS CLI drops this field: update the AWS CLI)',
        },
      );
    },
  );

  test.concurrent.each([
    'DenyInsecureTransport',
    'DenyOtherEncryption',
    'DenyOtherKmsKey',
    'DenyKmsWithoutKeyId',
  ])('AC-17: data-bucket-policy without the Sid %s says so', async (sid) => {
    const text = dataPolicyWith(`"Sid":"${sid}"`, '"Sid":"Renamed"');
    const result = await runVerify(answering('data-bucket-policy', ok(text)), {
      label: `AC-17 policy lacks ${sid}`,
    });
    expectRun(
      result,
      {},
      { 'data-bucket-policy': `FAIL: data-bucket-policy: the bucket policy lacks ${sid}` },
    );
  });

  test.concurrent(
    'AC-17: with two Sids missing, data-bucket-policy names the first one of the table',
    async () => {
      const text = dataPolicyWith('"Sid":"DenyKmsWithoutKeyId"', '"Sid":"R1"').replace(
        '"Sid":"DenyOtherKmsKey"',
        '"Sid":"R2"',
      );
      const result = await runVerify(answering('data-bucket-policy', ok(text)), {
        label: 'AC-17 policy lacks two Sids',
      });
      expectRun(
        result,
        {},
        {
          'data-bucket-policy': 'FAIL: data-bucket-policy: the bucket policy lacks DenyOtherKmsKey',
        },
      );
    },
  );

  test.concurrent('AC-17: data-bucket-policy without the lab key says so', async () => {
    const result = await runVerify(
      answering('data-bucket-policy', ok(dataPolicyWith(KEY, OTHER_KEY))),
      { label: 'AC-17 policy lacks key' },
    );
    expectRun(
      result,
      {},
      {
        'data-bucket-policy':
          'FAIL: data-bucket-policy: the bucket policy does not name the lab key',
      },
    );
  });

  test.concurrent('AC-17: data-bucket-policy without aws:SecureTransport says so', async () => {
    const result = await runVerify(
      answering('data-bucket-policy', ok(dataPolicyWith('aws:SecureTransport', 'aws:Other'))),
      { label: 'AC-17 policy lacks SecureTransport' },
    );
    expectRun(result, {}, { 'data-bucket-policy': true });
    expect(outLines(result.stdout)[8]).toContain('aws:SecureTransport');
  });

  test.concurrent.each([
    { name: 'pretty printed', text: pretty(dataPolicy()) },
    { name: 'spaces around the colons', text: spaced(dataPolicy()) },
    { name: 'line ends around the colons and commas', text: lined(dataPolicy()) },
  ])('AC-17: data-bucket-policy is ok when the text is $name', async ({ name, text }) => {
    const result = await runVerify(answering('data-bucket-policy', ok(text)), {
      label: `AC-17 policy ${name}`,
    });
    expectRun(result);
  });

  test.concurrent(
    'AC-17: log-bucket-policy without the log delivery principal says so',
    async () => {
      const text = logPolicyWith('logging.s3.amazonaws.com', 'other.amazonaws.com');
      const result = await runVerify(answering('log-bucket-policy', ok(text)), {
        label: 'AC-17 log policy lacks delivery',
      });
      expectRun(
        result,
        {},
        {
          'log-bucket-policy':
            'FAIL: log-bucket-policy: the log bucket policy does not allow S3 log delivery',
        },
      );
    },
  );

  test.concurrent('AC-17: log-bucket-policy without the data bucket says so', async () => {
    const text = logPolicyWith(`arn:aws:s3:::${DATA}`, 'arn:aws:s3:::other-bucket');
    const result = await runVerify(answering('log-bucket-policy', ok(text)), {
      label: 'AC-17 log policy lacks data bucket',
    });
    expectRun(result, {}, { 'log-bucket-policy': true });
    expect(outLines(result.stdout)[12]).toMatch(/data bucket/);
  });

  test.concurrent('AC-17: log-bucket-policy is ok when the text is pretty printed', async () => {
    const result = await runVerify(answering('log-bucket-policy', ok(pretty(logPolicy()))), {
      label: 'AC-17 log policy pretty',
    });
    expectRun(result);
  });

  test.concurrent.each(CHECK_IDS.map((id) => ({ id })))(
    'AC-17: $id answering exit 254 gives "could not ask AWS"',
    async ({ id }) => {
      const reply = failing(254, `An error occurred (AccessDenied) ${STUB_ERR} ${CLIENT}`);
      const result = await runVerify(answering(id, reply), { label: `AC-17 ${id} exit 254` });
      expectRun(result, {}, { [id]: `FAIL: ${id}: could not ask AWS` });
      expect(outLines(result.stdout).at(-1)).toMatch(/^verify: FAIL \(1 failed,/);
    },
  );
});

// =================================================================================================
// AC-18: the argv of every aws call
// =================================================================================================

describe('verify.sh: the arguments of every aws call', () => {
  const expectedArgv = (ids: string[]): string[][] =>
    ids.map((id) => checkOf(id).argv).map((argv) => normalize(argv));

  const actualArgv = (result: RunResult): string[][] =>
    checkRuns(result).map((run) => normalize(run.argv));

  test.concurrent(
    'AC-18: checks 1 to 17 call aws with the argv of the table, in order',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 default' });
      expect(actualArgv(result)).toEqual(expectedArgv(CHECK_IDS));
    },
  );

  test.concurrent('AC-18: the live checks add their eight calls, in order', async () => {
    const result = await runVerify(healthy(), { label: 'AC-18 live', extraEnv: LIVE_ENV });
    expect(actualArgv(result)).toEqual(expectedArgv([...CHECK_IDS, ...LIVE_IDS]));
  });

  test.concurrent('AC-18: the --context-entries value is one argument, byte for byte', async () => {
    const result = await runVerify(healthy(), { label: 'AC-18 context' });
    const [run] = runsOf(result, 'client-key-via-s3');
    expect(run, 'no client-key-via-s3 call').toBeDefined();
    expect(optionOf(run?.argv ?? [], '--context-entries')).toBe(CONTEXT);
  });

  test.concurrent('AC-18: client-key-only-via-s3 passes no --context-entries', async () => {
    const result = await runVerify(healthy(), { label: 'AC-18 no context' });
    const [run] = runsOf(result, 'client-key-only-via-s3');
    expect(run, 'no client-key-only-via-s3 call').toBeDefined();
    expect(run?.argv ?? []).not.toContain('--context-entries');
  });

  test.concurrent(
    'AC-18: the lifecycle JMESPath query is one argument, byte for byte',
    async () => {
      const result = await runVerify(healthy(), { label: 'AC-18 jmespath' });
      const [run] = runsOf(result, 'log-expiry');
      expect(run, 'no log-expiry call').toBeDefined();
      expect(optionOf(run?.argv ?? [], '--query')).toBe(
        "Rules[?ID=='expire-access-logs'].[Status,Expiration.Days]",
      );
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
    'AC-18: every aws call runs in eu-west-1 with an empty pager, whatever the caller sets',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-18 environment',
        extraEnv: {
          ...LIVE_ENV,
          AWS_REGION: 'us-west-2',
          AWS_DEFAULT_REGION: 'us-west-2',
          AWS_PAGER: 'less',
        },
      });
      expect(result.aws.length).toBeGreaterThan(CHECK_IDS.length);
      for (const run of result.aws) {
        expect([run.region, run.defaultRegion, run.pager], run.argv.join(' ')).toEqual([
          'eu-west-1',
          'eu-west-1',
          '',
        ]);
      }
      expectRun(result, { live: true });
    },
  );
});

// =================================================================================================
// AC-19: the live checks, healthy
// =================================================================================================

describe('verify.sh: live checks (VERIFY_ASSUME=1)', () => {
  test.concurrent('AC-19: a healthy live run prints 25 ok lines and no skip', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 healthy', extraEnv: LIVE_ENV });
    expectRun(result, { live: true });
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (25 passed, 0 skipped)');
  });

  test.concurrent(
    'AC-19: assume-client runs with the environment of the test, untouched',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-19 original',
        extraEnv: LIVE_ORIGINAL,
      });
      const [run] = runsOf(result, 'assume-client');
      expect(run, 'no assume-client call').toBeDefined();
      expect([run?.keyId, run?.secret, run?.token]).toEqual([
        ORIGINAL_SESSION.id,
        ORIGINAL_SESSION.secret,
        ORIGINAL_SESSION.token,
      ]);
      expect([run?.profile, run?.defaultProfile]).toEqual(['set', 'set']);
    },
  );

  test.concurrent.each(LIVE_IDS.slice(1).map((id) => ({ id })))(
    'AC-19: $id runs with the client session and without a profile',
    async ({ id }) => {
      const result = await runVerify(healthy(), {
        label: `AC-19 ${id} env`,
        extraEnv: LIVE_ORIGINAL,
      });
      const runs = runsOf(result, id);
      expect(runs, `no ${id} call`).toHaveLength(1);
      const [run] = runs;
      expect([run?.keyId, run?.secret, run?.token]).toEqual([
        CLIENT_SESSION.id,
        CLIENT_SESSION.secret,
        CLIENT_SESSION.token,
      ]);
      expect([run?.profile, run?.defaultProfile]).toEqual(['unset', 'unset']);
    },
  );

  test.concurrent.each(DENIED_IDS.map((id) => ({ id })))(
    'AC-19: $id answering exit 254 with AccessDenied from a resource-based policy gives ok',
    async ({ id }) => {
      const result = await runVerify(healthy(), {
        label: `AC-19 ${id} denied`,
        extraEnv: LIVE_ENV,
      });
      expect(outLines(result.stdout)).toContain(`ok: ${id}`);
    },
  );

  test.concurrent('AC-19: the --body file holds the probe text while the upload runs', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 body', extraEnv: LIVE_ENV });
    const [run] = runsOf(result, 'default-upload');
    expect(run, 'no default-upload call').toBeDefined();
    expect(run?.body, 'the body file did not exist during the upload').toBeDefined();
    expect((run?.body ?? '').replace(/\r?\n$/, '')).toBe(BODY_TEXT);
  });

  test.concurrent('AC-19: both temp files are gone after the run', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 temp files', extraEnv: LIVE_ENV });
    const body = optionOf(runsOf(result, 'default-upload')[0]?.argv ?? [], '--body');
    const out = (result.aws.find((run) => isOp(run, 's3api', 'get-object'))?.argv ?? [])[
      positionalIndex(result.aws.find((run) => isOp(run, 's3api', 'get-object'))?.argv ?? [])
    ];
    expect(body, 'no --body argument').toBeTruthy();
    expect(out, 'no out file argument').toBeTruthy();
    expect(body).not.toBe(out);
    expect(result.leftovers).toEqual([]);
  });

  test.concurrent('AC-19: the temp files are gone after a run that fails too', async () => {
    const fixture = answering('named-key-upload', ok(`AES256\tNone\tNone`));
    const result = await runVerify(fixture, {
      label: 'AC-19 temp files after fail',
      extraEnv: LIVE_ENV,
    });
    expect(result.status).toBe(1);
    expect(result.aws.filter((run) => isOp(run, 's3api', 'put-object')).length).toBeGreaterThan(0);
    expect(result.leftovers).toEqual([]);
  });

  test.concurrent('AC-19: the session keys never appear in an argv', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 argv', extraEnv: LIVE_ORIGINAL });
    expect(result.aws.length).toBeGreaterThan(CHECK_IDS.length);
    for (const run of result.aws) {
      for (const value of SESSION_VALUES) expect(run.argv.join(' '), value).not.toContain(value);
    }
    expect(result.calls.flat().join(' ')).not.toMatch(
      /CLIENTKEYID|ORIGINALKEYID|SECRETVALUE|TOKENVALUE/,
    );
  });

  test.concurrent('AC-19: no aws call is delete-object', async () => {
    const result = await runVerify(healthy(), { label: 'AC-19 no delete', extraEnv: LIVE_ENV });
    expect(result.aws.length).toBeGreaterThan(CHECK_IDS.length);
    for (const run of result.aws)
      expect(run.argv.join(' '), run.argv.join(' ')).not.toContain('delete-object');
  });

  test.concurrent.each([
    { name: 'the text of the probe', file: BODY_TEXT },
    { name: 'the text of the probe and a line end', file: `${BODY_TEXT}\n` },
  ])('AC-19: download is ok when the out file holds $name', async ({ name, file }) => {
    const reply: Reply = { ...ok('aws:kms'), file };
    const result = await runVerify(answering('download', reply), {
      label: `AC-19 download ${name}`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true });
  });
});

// =================================================================================================
// AC-20: live failures
// =================================================================================================

describe('verify.sh: live failures', () => {
  const skipped = (): Record<string, string> => {
    const lines: Record<string, string> = {};
    for (const id of AFTER_ASSUME_IDS) lines[id] = `skip: ${id}: assume-client failed`;
    return lines;
  };

  test.concurrent.each([
    { name: 'exit 254', reply: bucketPolicyDenied('AssumeRole') },
    { name: 'two tokens', reply: ok('CLIENTKEYIDVALUE\tCLIENTSECRETVALUE') },
    { name: 'four tokens', reply: ok(`${tabs(CLIENT_SESSION)}\textra`) },
    { name: 'an empty answer', reply: ok('') },
  ])(
    'AC-20: assume-client with $name fails and skips the seven checks after it',
    async ({ name, reply }) => {
      const result = await runVerify(answering('assume-client', reply), {
        label: `AC-20 assume-client ${name}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(result, { live: true }, { 'assume-client': true, ...skipped() });
      expect(result.aws.filter((run) => isOp(run, 'sts', 'assume-role'))).toHaveLength(1);
      expect(result.aws.filter((run) => isOp(run, 's3api', 'put-object'))).toEqual([]);
      expect(result.aws.filter((run) => isOp(run, 's3api', 'get-object'))).toEqual([]);
    },
  );

  test.concurrent.each([
    { id: 'default-upload', name: 'another key', answer: `aws:kms\t${OTHER_KEY}\tTrue` },
    { id: 'default-upload', name: 'SSE-S3', answer: 'AES256\tNone\tNone' },
    { id: 'default-upload', name: 'the Bucket Key off', answer: `aws:kms\t${KEY}\tFalse` },
    { id: 'named-key-upload', name: 'another key', answer: `aws:kms\t${OTHER_KEY}\tTrue` },
    { id: 'named-key-upload', name: 'SSE-S3', answer: 'AES256\tNone\tNone' },
    { id: 'named-key-upload', name: 'the Bucket Key off', answer: `aws:kms\t${KEY}\tFalse` },
  ])('AC-20: $id answering $name fails', async ({ id, name, answer }) => {
    const result = await runVerify(answering(id, ok(answer)), {
      label: `AC-20 ${id} ${name}`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true }, { [id]: true });
  });

  test.concurrent.each(['default-upload', 'named-key-upload', 'download'].map((id) => ({ id })))(
    'AC-20: $id exiting 254 fails',
    async ({ id }) => {
      const result = await runVerify(answering(id, kmsDenied()), {
        label: `AC-20 ${id} exit 254`,
        extraEnv: LIVE_ENV,
      });
      expectRun(result, { live: true }, { [id]: true });
    },
  );

  test.concurrent.each([
    {
      id: 'sse-s3-upload-denied',
      line: 'FAIL: sse-s3-upload-denied: an SSE-S3 upload was accepted',
    },
    {
      id: 'kms-without-key-denied',
      line: 'FAIL: kms-without-key-denied: an upload without a key ID was accepted',
    },
    {
      id: 'other-key-denied',
      line: 'FAIL: other-key-denied: an upload with another KMS key was accepted',
    },
    { id: 'http-denied', line: 'FAIL: http-denied: a plain-HTTP request was accepted' },
  ])('AC-20: $id answering exit 0 fails with the text of the spec', async ({ id, line }) => {
    const result = await runVerify(answering(id, ok('')), {
      label: `AC-20 ${id} exit 0`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true }, { [id]: line });
  });

  test.concurrent.each(
    DENIED_IDS.flatMap((id) => [
      { id, name: 'a KMS failure', reply: kmsDenied() },
      { id, name: 'a missing identity allow', reply: identityDenied() },
    ]),
  )(
    'AC-20: $id denied by $name fails with "denied, but not by the bucket policy"',
    async ({ id, name, reply }) => {
      const result = await runVerify(answering(id, reply), {
        label: `AC-20 ${id} ${name}`,
        extraEnv: LIVE_ENV,
      });
      expectRun(
        result,
        { live: true },
        { [id]: `FAIL: ${id}: denied, but not by the bucket policy` },
      );
    },
  );

  test.concurrent.each(DENIED_IDS.map((id) => ({ id })))(
    'AC-20: $id exiting 255 without AccessDenied fails with "could not ask AWS"',
    async ({ id }) => {
      const reply = failing(255, `Unable to locate credentials ${STUB_ERR}`);
      const result = await runVerify(answering(id, reply), {
        label: `AC-20 ${id} exit 255`,
        extraEnv: LIVE_ENV,
      });
      expectRun(result, { live: true }, { [id]: `FAIL: ${id}: could not ask AWS` });
    },
  );

  test.concurrent.each(DENIED_IDS.map((id) => ({ id })))(
    'AC-20: $id exiting 254 without AccessDenied fails with "could not ask AWS"',
    async ({ id }) => {
      const reply = failing(
        254,
        `An error occurred (NoSuchBucket) when calling the operation ${STUB_ERR}`,
      );
      const result = await runVerify(answering(id, reply), {
        label: `AC-20 ${id} exit 254 other`,
        extraEnv: LIVE_ENV,
      });
      expectRun(result, { live: true }, { [id]: `FAIL: ${id}: could not ask AWS` });
    },
  );

  test.concurrent('AC-20: download answering AES256 fails', async () => {
    const result = await runVerify(answering('download', ok('AES256')), {
      label: 'AC-20 download AES256',
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true }, { download: true });
  });

  test.concurrent.each([
    { name: 'other text', file: 'something else' },
    { name: 'an empty file', file: '' },
  ])('AC-20: download fails when the out file holds $name', async ({ name, file }) => {
    const reply: Reply = { ...ok('aws:kms'), file };
    const result = await runVerify(answering('download', reply), {
      label: `AC-20 download ${name}`,
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true }, { download: true });
  });
});

// =================================================================================================
// AC-22: CRLF
// =================================================================================================

describe('verify.sh: CRLF answers', () => {
  const crlf = (fixture: Fixture): Fixture => ({ ...fixture, awsEol: '\r\n', tfEol: '\r\n' });

  test.concurrent('AC-22: CRLF answers give the stdout of AC-16', async () => {
    const result = await runVerify(crlf(healthy()), { label: 'AC-22 crlf' });
    expectRun(result);
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (17 passed, 8 skipped)');
  });

  test.concurrent('AC-22: CRLF answers give the stdout of AC-19 with the live checks', async () => {
    const result = await runVerify(crlf(healthy()), {
      label: 'AC-22 crlf live',
      extraEnv: LIVE_ENV,
    });
    expectRun(result, { live: true });
    expect(outLines(result.stdout).at(-1)).toBe('verify: ok (25 passed, 0 skipped)');
  });

  test.concurrent('AC-22: a CRLF wrong answer still fails only that check', async () => {
    const fixture = crlf(healthy());
    fixture.replies['client-role'] = ok(`/lab/\t${BOUNDARY}x`);
    const result = await runVerify(fixture, { label: 'AC-22 crlf fail' });
    expectRun(result, {}, { 'client-role': true });
  });

  test.concurrent('AC-22: CRLF denials still count as denied by the bucket policy', async () => {
    const result = await runVerify(crlf(healthy()), {
      label: 'AC-22 crlf denied',
      extraEnv: LIVE_ENV,
    });
    for (const id of DENIED_IDS) expect(outLines(result.stdout)).toContain(`ok: ${id}`);
  });
});

// =================================================================================================
// AC-23: the script cannot run
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
    'AC-23: an argument $name prints the usage and exits 2',
    async ({ name, strictPath, tools, args }) => {
      const result = await runVerify(healthy(), {
        label: `AC-23 argument ${name}`,
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
    'AC-23: without $name on PATH the script says so and exits 2',
    async ({ name }) => {
      const tools = TOOLS.filter((tool) => tool !== name);
      const result = await runVerify(healthy(), {
        label: `AC-23 no ${name}`,
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
    'AC-23: an empty output $name stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = ok('');
      const result = await runVerify(fixture, { label: `AC-23 ${name} empty` });
      expect(result.stderr.split(/\r?\n/)).toContain(
        `verify: terraform output ${name} is empty; apply the stack first`,
      );
      expectCouldNotRun(result);
    },
  );

  test.concurrent.each(OUTPUT_NAMES.map((name) => ({ name })))(
    'AC-23: terraform output $name exiting 1 stops the script with exit 2',
    async ({ name }) => {
      const fixture = healthy();
      fixture.outputs[name] = failing(
        1,
        `Error: no outputs for ${CLIENT} ${ACCT}, run apply first ${STUB_ERR}`,
      );
      const result = await runVerify(fixture, { label: `AC-23 ${name} fails` });
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
  ])('AC-23: get-caller-identity $name stops the script with exit 2', async ({ name, reply }) => {
    const fixture = healthy();
    fixture.identity = reply;
    const result = await runVerify(fixture, { label: `AC-23 identity ${name}` });
    expectCouldNotRun(result);
  });
});

// =================================================================================================
// AC-21 and the audits over every run of this file
// =================================================================================================

describe('verify.sh: nothing private is printed', () => {
  test.concurrent(
    'AC-21: a failing aws call prints none of its stderr, nor an ARN, bucket or account ID',
    async () => {
      const fixture = healthy();
      fixture.replies['client-role'] = failing(
        254,
        `An error occurred (AccessDenied) arn:aws:sts::${ACCT}:assumed-role/x ${DATA} ${STUB_ERR}`,
      );
      fixture.replies['data-bucket-private'] = failing(255, `${DATA} ${ACCT} ${KEY} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-21 failing calls' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-21: mismatches on values that hold an ARN, a bucket or the key print none of them',
    async () => {
      const fixture = healthy();
      fixture.replies['client-role'] = ok(`/lab/\tarn:aws:iam::${ACCT}:policy/other`);
      fixture.replies['client-trust'] = ok(`Allow\tsts:AssumeRole\t${OTHER_ROOT}\tNone`);
      fixture.replies['data-default-encryption'] = ok(`aws:kms\t${OTHER_KEY}\tTrue`);
      fixture.replies['access-logging'] = ok(`${DATA}\tother/`);
      fixture.replies['data-bucket-policy'] = ok(dataPolicyWith(KEY, OTHER_KEY));
      fixture.replies['log-bucket-policy'] = ok(logPolicyWith(`arn:aws:s3:::${DATA}`, 'x'));
      const result = await runVerify(fixture, { label: 'AC-21 mismatches' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-21: a live run that fails after the assume call prints no key, secret or token',
    async () => {
      const fixture = healthy();
      fixture.replies['named-key-upload'] = ok(`aws:kms\t${OTHER_KEY}\tTrue`);
      fixture.replies['sse-s3-upload-denied'] = kmsDenied();
      fixture.replies['http-denied'] = ok('');
      fixture.replies['download'] = ok('AES256');
      const result = await runVerify(fixture, {
        label: 'AC-21 live failures',
        extraEnv: LIVE_ORIGINAL,
      });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-21: a live run where assume-client fails prints no key, secret or token',
    async () => {
      const result = await runVerify(
        answering('assume-client', ok(`${tabs(CLIENT_SESSION)}\textra`)),
        { label: 'AC-21 assume fails', extraEnv: LIVE_ORIGINAL },
      );
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-21: a terraform output that fails with an ARN prints none of it',
    async () => {
      const fixture = healthy();
      fixture.outputs['kms_key_arn'] = failing(1, `Error: ${KEY} ${ACCT} ${STUB_ERR}`);
      const result = await runVerify(fixture, { label: 'AC-21 terraform' });
      expect(result.status).toBe(2);
      expect(leaks(result.all)).toEqual([]);
    },
  );
});

describe('verify.sh: audit over every run of this file', () => {
  test('AC-21: no run printed a 12-digit number, an ARN, a bucket name, a key ID, a session value or a stub stderr', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.flatMap(({ label, result }) =>
      leaks(result.all).map((needle) => `${label}: printed ${needle}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-21: no run made a call a stub had no answer for', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) => result.unexpected.length > 0).map(
      ({ label, result }) => `${label}: ${result.unexpected.join('; ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-21: no run put a key, secret or token in an argv', () => {
    expect(RUNS.length).toBeGreaterThan(100);
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

  test('AC-19: no run left a temp file behind', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) => result.leftovers.length > 0).map(
      ({ label, result }) => `${label}: ${result.leftovers.join(', ')}`,
    );
    expect(found).toEqual([]);
  });

  test('AC-19: no run called delete-object', () => {
    expect(RUNS.length).toBeGreaterThan(100);
    const found = RUNS.filter(({ result }) =>
      result.aws.some((run) => run.argv.includes('delete-object')),
    ).map(({ label }) => label);
    expect(found).toEqual([]);
  });
});

// =================================================================================================
// AC-24: no xtrace leak
// =================================================================================================

describe('verify.sh: no xtrace leak', () => {
  test('AC-24: set +x comes right after set -euo pipefail', () => {
    const path = scriptPath();
    expect(readFileSync(path, 'utf8')).toMatch(
      /^set -euo pipefail[ \t]*(?:;[ \t]*|\n(?:[ \t]*\n)*)set \+x\b/m,
    );
  });

  test.concurrent(
    'AC-24: a live run with SHELLOPTS=xtrace exported still prints no ID, ARN or key',
    async () => {
      const result = await runVerify(healthy(), {
        label: 'AC-24 xtrace',
        extraEnv: { ...LIVE_ORIGINAL, SHELLOPTS: 'xtrace' },
      });
      expect(leaks(result.all)).toEqual([]);
      expectRun(result, { live: true });
    },
  );
});
