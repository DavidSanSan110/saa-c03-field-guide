import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// Spec 037 (issue #83): labs/00-site-hosting/verify.sh, break-it.md and the reader sections of the
// lab README.
//
// verify.sh is executed with bash and stub `terraform`, `aws` and `curl` binaries on PATH (the
// approach of deploy-workflow.test.ts). Every stub appends one tab separated line to calls.log, then
// answers from a table: the aws stub by subcommand + target + the value of `--query`, the terraform
// stub by `output -raw <name>`, the curl stub by its LAST argument (the URL).
//
// The aws stub expects the separated form of the options, as in the spec tables:
// `--query <value>`, `--bucket <name>`, `--id <id>`, `--role-name <name>`, `--output text`.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const slash = (path: string): string => path.replace(/\\/g, '/');

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

/** Reads a repo file; a missing file fails the test with a readable message. */
function readRepoFile(...segments: string[]): string {
  const path = repoPath(...segments);
  if (!existsSync(path)) throw new Error(`missing file: ${segments.join('/')}`);
  return readFileSync(path, 'utf8');
}

const LAB = ['labs', '00-site-hosting'];

// ---- Fixture data ---------------------------------------------------------------------------------

const ACCOUNT = '111122223333';
const SITE = `field-guide-site-${ACCOUNT}`;
const LOGS = `field-guide-site-logs-${ACCOUNT}`;
const DIST = 'E2EXAMPLE123';
const DIST_DOMAIN = 'd111111abcdef8.cloudfront.net';
const DOMAIN = 'site.example.com';
const ROLE = 'fg-site-deploy';
const WAIT_LINE = 'verify: waiting for the distribution to deploy';
const USAGE = 'usage: bash verify.sh (no arguments; run it from the stack directory)';

/** domain: a custom domain is set; plain: only the cloudfront.net name. */
type Mode = 'domain' | 'plain';

const siteUrlOf = (mode: Mode): string =>
  mode === 'domain' ? `https://${DOMAIN}` : `https://${DIST_DOMAIN}`;
const hostOf = (mode: Mode): string => siteUrlOf(mode).replace('https://', '');

const OUTPUT_NAMES = [
  'site_bucket_name',
  'log_bucket_name',
  'distribution_id',
  'distribution_domain_name',
  'site_url',
] as const;

const BPA_QUERY =
  'PublicAccessBlockConfiguration.[BlockPublicAcls,IgnorePublicAcls,BlockPublicPolicy,RestrictPublicBuckets]';
const BPA_PASS = 'True\tTrue\tTrue\tTrue';
const STATUS_QUERY = 'Distribution.Status';
const TLS_DOMAIN_QUERY =
  'Distribution.DistributionConfig.ViewerCertificate.[MinimumProtocolVersion,SSLSupportMethod]';
const TLS_PLAIN_QUERY =
  'Distribution.DistributionConfig.ViewerCertificate.CloudFrontDefaultCertificate';
const FUNCTION_QUERY =
  "Distribution.DistributionConfig.DefaultCacheBehavior.FunctionAssociations.Items[?EventType=='viewer-request'].FunctionARN";

const POLICY_OK = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowCloudFrontServicePrincipalReadOnly',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Resource: `arn:aws:s3:::${SITE}/*`,
      Condition: {
        StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST}` },
      },
    },
  ],
});

function policyWith(service: string, distribution: string): string {
  return POLICY_OK.replace('cloudfront.amazonaws.com', service).replace(
    `distribution/${DIST}"`,
    `distribution/${distribution}"`,
  );
}

const FUNCTION_ARN = `arn:aws:cloudfront::${ACCOUNT}:function/fg-site-viewer-request`;
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/fg-workload-boundary`;
const SITE_ORIGIN_DOMAIN = `${SITE}.s3.eu-west-1.amazonaws.com`;

interface AwsCheck {
  id: string;
  service: string;
  op: string;
  /** The value of --bucket, --id or --role-name. */
  target: string;
  query: (mode: Mode) => string;
  pass: (mode: Mode) => string;
}

/** The AWS table of the spec, in order. */
const AWS_CHECKS: AwsCheck[] = [
  {
    id: 'site-public-access-block',
    service: 's3api',
    op: 'get-public-access-block',
    target: SITE,
    query: () => BPA_QUERY,
    pass: () => BPA_PASS,
  },
  {
    id: 'site-policy-not-public',
    service: 's3api',
    op: 'get-bucket-policy-status',
    target: SITE,
    query: () => 'PolicyStatus.IsPublic',
    pass: () => 'False',
  },
  {
    id: 'site-policy-oac',
    service: 's3api',
    op: 'get-bucket-policy',
    target: SITE,
    query: () => 'Policy',
    pass: () => POLICY_OK,
  },
  {
    id: 'site-versioning',
    service: 's3api',
    op: 'get-bucket-versioning',
    target: SITE,
    query: () => 'Status',
    pass: () => 'Enabled',
  },
  {
    id: 'site-encryption',
    service: 's3api',
    op: 'get-bucket-encryption',
    target: SITE,
    query: () =>
      'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm',
    pass: () => 'AES256',
  },
  {
    id: 'logs-public-access-block',
    service: 's3api',
    op: 'get-public-access-block',
    target: LOGS,
    query: () => BPA_QUERY,
    pass: () => BPA_PASS,
  },
  {
    id: 'distribution',
    service: 'cloudfront',
    op: 'get-distribution',
    target: DIST,
    query: () =>
      'Distribution.[Status,DistributionConfig.Enabled,DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy]',
    pass: () => 'Deployed\tTrue\tredirect-to-https',
  },
  {
    id: 'distribution-origin',
    service: 'cloudfront',
    op: 'get-distribution',
    target: DIST,
    query: () =>
      'Distribution.DistributionConfig.Origins.Items[0].[OriginAccessControlId,DomainName]',
    pass: () => `E3OACEXAMPLE\t${SITE_ORIGIN_DOMAIN}`,
  },
  {
    id: 'distribution-function',
    service: 'cloudfront',
    op: 'get-distribution',
    target: DIST,
    query: () => FUNCTION_QUERY,
    pass: () => FUNCTION_ARN,
  },
  {
    id: 'distribution-tls',
    service: 'cloudfront',
    op: 'get-distribution',
    target: DIST,
    query: (mode) => (mode === 'domain' ? TLS_DOMAIN_QUERY : TLS_PLAIN_QUERY),
    pass: (mode) => (mode === 'domain' ? 'TLSv1.2_2021\tsni-only' : 'True'),
  },
  {
    id: 'deploy-role',
    service: 'iam',
    op: 'get-role',
    target: ROLE,
    query: () => 'Role.[Path,PermissionsBoundary.PermissionsBoundaryArn]',
    pass: () => `/lab/\t${BOUNDARY_ARN}`,
  },
];

interface HttpCheck {
  id: string;
  /** undefined: no request in this mode. */
  url: (mode: Mode) => string | undefined;
  status: number;
  location: (mode: Mode) => string | undefined;
}

/** The HTTP table of the spec, in order. */
const HTTP_CHECKS: HttpCheck[] = [
  {
    id: 'bucket-direct',
    url: () => `https://${SITE}.s3.eu-west-1.amazonaws.com/index.html`,
    status: 403,
    location: () => undefined,
  },
  {
    id: 'http-to-https',
    url: (mode) => `http://${hostOf(mode)}/verify-probe/`,
    status: 301,
    location: (mode) => `https://${hostOf(mode)}/verify-probe/`,
  },
  {
    id: 'redirect-protocol-relative',
    url: (mode) => `${siteUrlOf(mode)}//evil%E3%80%82com`,
    status: 301,
    location: () => '/evil%E3%80%82com/',
  },
  {
    id: 'redirect-backslash',
    url: (mode) => `${siteUrlOf(mode)}/%5Cevil`,
    status: 301,
    location: () => '/%5Cevil/',
  },
  {
    id: 'redirect-query-encoded',
    url: (mode) => `${siteUrlOf(mode)}/verify-probe?a=b%26c`,
    status: 301,
    location: () => '/verify-probe/?a=b%26c',
  },
  {
    id: 'redirect-to-domain',
    url: (mode) => (mode === 'domain' ? `https://${DIST_DOMAIN}/verify-probe?a=b%26c` : undefined),
    status: 301,
    location: () => `https://${DOMAIN}/verify-probe/?a=b%26c`,
  },
];

const ALL_IDS = [...AWS_CHECKS.map((c) => c.id), ...HTTP_CHECKS.map((c) => c.id)];
const LOCATION_IDS = HTTP_CHECKS.filter((c) => c.location('domain') !== undefined).map((c) => c.id);

// ---- Replies and fixtures -------------------------------------------------------------------------

/** What a stub answers: `out` is one answer per call (the last repeats), then exit code and stderr. */
interface Reply {
  out: string[];
  exit: number;
  err: string;
  /** No stdout at all (not even the line end). */
  quiet: boolean;
}

const ok = (...out: string[]): Reply => ({ out, exit: 0, err: '', quiet: false });
const failing = (exit: number, err: string): Reply => ({ out: [''], exit, err, quiet: true });

const REASONS: Record<number, string> = {
  200: 'OK',
  301: 'Moved Permanently',
  302: 'Found',
  403: 'Forbidden',
};

interface DumpStyle {
  crlf?: boolean;
  h2?: boolean;
  locationName?: string;
  extra?: boolean;
  padded?: boolean;
  /** A second, different location header after the first. */
  second?: string;
}

/** The text curl writes with `--dump-header -`. */
function dump(status: number, location: string | undefined, style: DumpStyle = {}): string {
  const eol = style.crlf === true ? '\r\n' : '\n';
  const first =
    style.h2 === true ? `HTTP/2 ${status}` : `HTTP/1.1 ${status} ${REASONS[status] ?? 'Status'}`;
  const lines = [first];
  if (style.extra === true) lines.push('x-cache: Miss from cloudfront');
  lines.push('server: CloudFront', 'content-type: text/html');
  if (location !== undefined) {
    const padded = style.padded === true;
    lines.push(
      `${style.locationName ?? 'Location'}:${padded ? '   ' : ' '}${location}${padded ? '  ' : ''}`,
    );
    if (style.second !== undefined) lines.push(`Location: ${style.second}`);
  }
  if (style.extra === true)
    lines.push('via: 1.1 abc.cloudfront.net (CloudFront)', 'content-length: 0');
  return lines.join(eol) + eol + eol;
}

interface Fixture {
  mode: Mode;
  /** terraform output replies by output name. */
  outputs: Record<string, Reply>;
  /** aws replies by check id, plus `status` for the wait query. */
  aws: Record<string, Reply>;
  /** curl replies by check id. */
  http: Record<string, Reply>;
  awsEol: string;
  tfEol: string;
}

function healthy(mode: Mode = 'domain'): Fixture {
  const outputValues: Record<string, string> = {
    site_bucket_name: SITE,
    log_bucket_name: LOGS,
    distribution_id: DIST,
    distribution_domain_name: DIST_DOMAIN,
    site_url: siteUrlOf(mode),
  };
  const outputs: Record<string, Reply> = {};
  for (const name of OUTPUT_NAMES) outputs[name] = ok(outputValues[name] as string);
  const aws: Record<string, Reply> = { status: ok('Deployed') };
  for (const check of AWS_CHECKS) aws[check.id] = ok(check.pass(mode));
  const fixture: Fixture = { mode, outputs, aws, http: {}, awsEol: '\n', tfEol: '' };
  setDumps(fixture, {});
  return fixture;
}

/** Replaces every passing curl answer by the same dump in another style. */
function setDumps(fixture: Fixture, style: DumpStyle): void {
  fixture.http = {};
  for (const check of HTTP_CHECKS) {
    if (check.url(fixture.mode) === undefined) continue;
    fixture.http[check.id] = ok(dump(check.status, check.location(fixture.mode), style));
  }
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
}

function ruleBody(dir: string, id: string, rule: Rule): string {
  const outs = rule.reply.out.length > 0 ? rule.reply.out : [''];
  outs.forEach((out, index) => {
    const text = rule.reply.quiet ? '' : out + rule.eol;
    writeFileSync(join(dir, `${id}.out.${index + 1}`), text);
  });
  if (rule.reply.err !== '') writeFileSync(join(dir, `${id}.err`), rule.reply.err);
  const last = outs.length;
  return [
    `c=0; if [ -f "$D/${id}.count" ]; then c=$(<"$D/${id}.count"); fi; c=$((c + 1)); printf '%s' "$c" > "$D/${id}.count"`,
    `i=$c; if [ "$i" -gt ${last} ]; then i=${last}; fi`,
    `cat "$D/${id}.out.$i"`,
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

const AWS_PRELUDE = `printf '%s|%s|%s\\n' "\${AWS_REGION-<unset>}" "\${AWS_DEFAULT_REGION-<unset>}" "\${AWS_PAGER-<unset>}" >> "$FAKE_LOG_DIR/aws-env.log"
t=''; q=''; p=''
for a in "$@"; do
  case "$p" in
    --query) q="$a";;
    --bucket|--id|--role-name) t="$a";;
  esac
  p="$a"
done`;

const TOOLS = ['terraform', 'aws', 'curl'] as const;
type Tool = (typeof TOOLS)[number];

function awsKey(check: AwsCheck, mode: Mode): string {
  return `${check.service} ${check.op}|${check.target}|${check.query(mode)}`;
}

function writeStubs(fixture: Fixture, bin: string, rulesDir: string, tools: readonly Tool[]): void {
  const mode = fixture.mode;
  const terraformRules: Rule[] = OUTPUT_NAMES.map((name) => ({
    key: `output -raw ${name}`,
    reply: fixture.outputs[name] ?? ok(''),
    eol: fixture.tfEol,
  }));
  const awsRules: Rule[] = [
    {
      key: `cloudfront get-distribution|${DIST}|${STATUS_QUERY}`,
      reply: fixture.aws['status'] ?? ok('Deployed'),
      eol: fixture.awsEol,
    },
    ...AWS_CHECKS.map((check) => ({
      key: awsKey(check, mode),
      reply: fixture.aws[check.id] ?? ok(''),
      eol: fixture.awsEol,
    })),
  ];
  const curlRules: Rule[] = [];
  for (const check of HTTP_CHECKS) {
    const url = check.url(mode);
    const reply = fixture.http[check.id];
    if (url !== undefined && reply !== undefined) curlRules.push({ key: url, reply, eol: '' });
  }
  const scripts: Record<Tool, string> = {
    terraform: stubScript('terraform', '', '"$1 $2 $3"', terraformRules, rulesDir),
    aws: stubScript('aws', AWS_PRELUDE, '"$1 $2|$t|$q"', awsRules, rulesDir),
    curl: stubScript('curl', '', '"${@: -1}"', curlRules, rulesDir),
  };
  for (const tool of tools) writeFileSync(join(bin, tool), scripts[tool], { mode: 0o755 });
}

interface RunOptions {
  args?: string[];
  extraEnv?: Record<string, string>;
  /** Stubs that exist (default: all three). */
  tools?: readonly Tool[];
  /** PATH holds only the stub directory (no system directories). */
  strictPath?: boolean;
  label?: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together. */
  all: string;
  /** Every stub call: [name, ...arguments]. */
  calls: string[][];
  /** One `region|default region|pager` line per aws call. */
  awsEnv: string[];
  /** Calls a stub had no answer for. */
  unexpected: string[];
}

const RUNS: { label: string; result: RunResult }[] = [];

function scriptPath(): string {
  const path = repoPath(...LAB, 'verify.sh');
  if (!existsSync(path)) throw new Error('missing file: labs/00-site-hosting/verify.sh');
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

async function runVerify(fixture: Fixture, options: RunOptions = {}): Promise<RunResult> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab00-verify-'));
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
    env['VERIFY_POLL_SECONDS'] = '0';
    for (const [key, value] of Object.entries(options.extraEnv ?? {})) env[key] = value;

    const done = await execBash([script, ...(options.args ?? [])], work, env);
    const result: RunResult = {
      status: done.status,
      stdout: done.stdout,
      stderr: done.stderr,
      all: done.stdout + done.stderr,
      calls: readLines(join(logs, 'calls.log')).map((line) => line.split('\t')),
      awsEnv: readLines(join(logs, 'aws-env.log')),
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

/** stdout lines without the wait lines. */
function checkLines(result: RunResult): string[] {
  return outLines(result.stdout).filter((line) => line !== WAIT_LINE);
}

function waitCount(result: RunResult): number {
  return outLines(result.stdout).filter((line) => line === WAIT_LINE).length;
}

/**
 * The lines every run must print: one per check in table order, then the summary. `failures` maps a
 * check id to its exact line, a RegExp for the line, or `true` for "FAIL: <id>: <some reason>".
 */
function expectChecks(
  result: RunResult,
  mode: Mode,
  failures: Record<string, string | RegExp | true> = {},
): void {
  const expected: string[] = [];
  const actual = checkLines(result);
  let ran = 0;
  let skipped = 0;
  let failed = 0;
  ALL_IDS.forEach((id, index) => {
    if (id === 'redirect-to-domain' && mode === 'plain') {
      expected.push('skip: redirect-to-domain: no custom domain');
      skipped += 1;
      return;
    }
    ran += 1;
    const failure = failures[id];
    if (failure === undefined) {
      expected.push(`ok: ${id}`);
      return;
    }
    failed += 1;
    const line = actual[index] ?? '';
    if (typeof failure === 'string') {
      expected.push(failure);
    } else {
      expect(line).toMatch(failure === true ? new RegExp(`^FAIL: ${id}: \\S`) : failure);
      expected.push(line);
    }
  });
  expected.push(
    failed === 0
      ? `verify: ok (${ran} passed, ${skipped} skipped)`
      : `verify: ${failed} of ${ran} checks failed`,
  );
  expect(actual).toEqual(expected);
  expect(result.status).toBe(failed === 0 ? 0 : 1);
  expect(result.unexpected, 'a stub was called in a way the test has no answer for').toEqual([]);
}

function awsCalls(result: RunResult): string[][] {
  return result.calls.filter((call) => call[0] === 'aws');
}

function curlCalls(result: RunResult): string[][] {
  return result.calls.filter((call) => call[0] === 'curl');
}

function queryOf(call: string[]): string | undefined {
  const index = call.indexOf('--query');
  return index === -1 ? undefined : call[index + 1];
}

const FORBIDDEN_CURL_SHORT = ['L', 'I', 'X', 'd', 'T', 'F', 'S'];
const FORBIDDEN_CURL_LONG = [
  '--location',
  '--location-trusted',
  '--head',
  '--request',
  '--upload-file',
  '--form',
  '--show-error',
];

/** Forbidden curl options in one call (the URL, its last argument, is not an option). */
function forbiddenCurlOptions(call: string[]): string[] {
  const found: string[] = [];
  for (const arg of call.slice(1, -1)) {
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0] as string;
      if (FORBIDDEN_CURL_LONG.includes(name) || name.startsWith('--data')) found.push(arg);
    } else if (/^-[A-Za-z]+$/.test(arg)) {
      if ([...arg.slice(1)].some((letter) => FORBIDDEN_CURL_SHORT.includes(letter)))
        found.push(arg);
    }
  }
  return found;
}

function leaks(text: string): string[] {
  return [ACCOUNT, SITE, LOGS, 'arn:aws:'].filter((needle) => text.includes(needle));
}

// =================================================================================================
// AC-1 ... AC-3: healthy stacks
// =================================================================================================

describe('verify.sh: healthy stacks', () => {
  test.concurrent(
    'AC-1: a healthy stack with a domain prints 17 ok lines and the summary',
    async () => {
      const result = await runVerify(healthy('domain'), { label: 'AC-1' });
      expect(result.status).toBe(0);
      const expected = [...ALL_IDS.map((id) => `ok: ${id}`), 'verify: ok (17 passed, 0 skipped)'];
      expect(result.stdout).toBe(`${expected.join('\n')}\n`);
      expect(ALL_IDS).toHaveLength(17);
      expect(result.unexpected).toEqual([]);
    },
  );

  test.concurrent(
    'AC-2: without a domain redirect-to-domain is skipped and the summary counts it',
    async () => {
      const result = await runVerify(healthy('plain'), { label: 'AC-2 plain' });
      expectChecks(result, 'plain');
      const lines = checkLines(result);
      expect(lines).toContain('skip: redirect-to-domain: no custom domain');
      expect(lines.at(-1)).toBe('verify: ok (16 passed, 1 skipped)');
    },
  );

  test.concurrent('AC-2: without a domain no request is made for redirect-to-domain', async () => {
    const result = await runVerify(healthy('plain'), { label: 'AC-2 requests' });
    // The cloudfront.net name is the site itself in this mode, so five requests still go to it:
    // exactly the five other HTTP checks, none more.
    expect(curlCalls(result).map((call) => call.at(-1))).toEqual([
      `https://${SITE}.s3.eu-west-1.amazonaws.com/index.html`,
      `http://${DIST_DOMAIN}/verify-probe/`,
      `https://${DIST_DOMAIN}//evil%E3%80%82com`,
      `https://${DIST_DOMAIN}/%5Cevil`,
      `https://${DIST_DOMAIN}/verify-probe?a=b%26c`,
    ]);
  });

  test.concurrent(
    'AC-2: without a domain the TLS check asks for CloudFrontDefaultCertificate only',
    async () => {
      const result = await runVerify(healthy('plain'), { label: 'AC-2 tls' });
      const queries = awsCalls(result).map(queryOf);
      expect(queries).toContain(TLS_PLAIN_QUERY);
      expect(queries).not.toContain(TLS_DOMAIN_QUERY);
    },
  );

  test.concurrent(
    'AC-2: without a domain a default certificate answer of False fails distribution-tls',
    async () => {
      const fixture = healthy('plain');
      fixture.aws['distribution-tls'] = ok('False');
      const result = await runVerify(fixture, { label: 'AC-2 tls false' });
      expect(checkLines(result).at(-1)).toBe('verify: 1 of 16 checks failed');
      expectChecks(result, 'plain', { 'distribution-tls': true });
    },
  );

  test.concurrent('AC-3: with a domain the TLS check asks for protocol and SNI only', async () => {
    const result = await runVerify(healthy('domain'), { label: 'AC-3 query' });
    const queries = awsCalls(result).map(queryOf);
    expect(queries).toContain(TLS_DOMAIN_QUERY);
    expect(queries).not.toContain(TLS_PLAIN_QUERY);
  });

  test.concurrent.each([
    { name: 'an old minimum protocol', answer: 'TLSv1\tsni-only' },
    { name: 'a dedicated IP (vip)', answer: 'TLSv1.2_2021\tvip' },
  ])('AC-3: $name fails distribution-tls', async ({ answer }) => {
    const fixture = healthy('domain');
    fixture.aws['distribution-tls'] = ok(answer);
    const result = await runVerify(fixture, { label: `AC-3 ${answer}` });
    expectChecks(result, 'domain', { 'distribution-tls': true });
  });
});

// =================================================================================================
// AC-4: each AWS check fails on its own wrong answer
// =================================================================================================

interface Case {
  name: string;
  id: string;
  mutate: (fixture: Fixture) => void;
}

const awsCase = (name: string, id: string, answer: string): Case => ({
  name,
  id,
  mutate: (fixture) => {
    fixture.aws[id] = ok(answer);
  },
});

const AC4_CASES: Case[] = [
  awsCase(
    'site block public access with one False',
    'site-public-access-block',
    'True\tTrue\tFalse\tTrue',
  ),
  awsCase(
    'site block public access with the first False',
    'site-public-access-block',
    'False\tTrue\tTrue\tTrue',
  ),
  awsCase(
    'site block public access with three fields',
    'site-public-access-block',
    'True\tTrue\tTrue',
  ),
  awsCase(
    'logs block public access with one False',
    'logs-public-access-block',
    'True\tTrue\tTrue\tFalse',
  ),
  awsCase(
    'logs block public access with three fields',
    'logs-public-access-block',
    'True\tTrue\tTrue',
  ),
  awsCase('a public bucket policy status', 'site-policy-not-public', 'True'),
  awsCase(
    'a policy without the cloudfront service principal',
    'site-policy-oac',
    policyWith('ec2.amazonaws.com', DIST),
  ),
  awsCase(
    'a policy naming another distribution with the same prefix',
    'site-policy-oac',
    policyWith('cloudfront.amazonaws.com', `${DIST}4`),
  ),
  awsCase('suspended versioning', 'site-versioning', 'Suspended'),
  awsCase('KMS encryption', 'site-encryption', 'aws:kms'),
  {
    name: 'a distribution still in progress on every ask',
    id: 'distribution',
    mutate: (fixture) => {
      fixture.aws['status'] = ok('InProgress');
      fixture.aws['distribution'] = ok('InProgress\tTrue\tredirect-to-https');
    },
  },
  awsCase('a disabled distribution', 'distribution', 'Deployed\tFalse\tredirect-to-https'),
  awsCase('a viewer policy of allow-all', 'distribution', 'Deployed\tTrue\tallow-all'),
  awsCase(
    'an origin access control id of None',
    'distribution-origin',
    `None\t${SITE_ORIGIN_DOMAIN}`,
  ),
  awsCase('an empty origin access control id', 'distribution-origin', `\t${SITE_ORIGIN_DOMAIN}`),
  awsCase(
    'the origin domain of another bucket',
    'distribution-origin',
    'E3OACEXAMPLE\tsome-other-bucket.s3.eu-west-1.amazonaws.com',
  ),
  awsCase('no function association', 'distribution-function', ''),
  awsCase('two function associations', 'distribution-function', `${FUNCTION_ARN}\t${FUNCTION_ARN}`),
  awsCase('an old function name', 'distribution-function', `${FUNCTION_ARN}-old`),
  awsCase('a role with the default path', 'deploy-role', `/\t${BOUNDARY_ARN}`),
  awsCase(
    'a role with another permissions boundary',
    'deploy-role',
    `/lab/\tarn:aws:iam::${ACCOUNT}:policy/some-other-boundary`,
  ),
];

describe('verify.sh: wrong AWS answers', () => {
  test.concurrent.each(AC4_CASES)('AC-4: $name fails only $id', async ({ name, id, mutate }) => {
    const fixture = healthy('domain');
    mutate(fixture);
    const result = await runVerify(fixture, { label: `AC-4 ${name}` });
    expectChecks(result, 'domain', { [id]: true });
  });
});

// =================================================================================================
// AC-5, AC-6: HTTP checks and the header dump
// =================================================================================================

const httpCase = (name: string, id: string, text: string): Case => ({
  name,
  id,
  mutate: (fixture) => {
    fixture.http[id] = ok(text);
  },
});

const AC5_CASES: Case[] = [
  httpCase('a direct bucket request answered 200', 'bucket-direct', dump(200, undefined)),
  httpCase('http answered 200', 'http-to-https', dump(200, undefined)),
  httpCase('http redirected to http', 'http-to-https', dump(301, `http://${DOMAIN}/verify-probe/`)),
  httpCase(
    'a protocol-relative redirect',
    'redirect-protocol-relative',
    dump(301, '//evil%E3%80%82com/'),
  ),
  httpCase(
    'the right protocol-relative location with status 302',
    'redirect-protocol-relative',
    dump(302, '/evil%E3%80%82com/'),
  ),
  httpCase('a decoded backslash location', 'redirect-backslash', dump(301, '/\\evil/')),
  httpCase('a location without the backslash', 'redirect-backslash', dump(301, '/evil/')),
  httpCase('a decoded query', 'redirect-query-encoded', dump(301, '/verify-probe/?a=b&c')),
  httpCase(
    'a query with an extra equals sign',
    'redirect-query-encoded',
    dump(301, '/verify-probe/?a=b%26c='),
  ),
  httpCase(
    'a redirect to another host',
    'redirect-to-domain',
    dump(301, 'https://evil.example/verify-probe/?a=b%26c'),
  ),
  httpCase(
    'a relative redirect from the cloudfront.net name',
    'redirect-to-domain',
    dump(301, '/verify-probe/?a=b%26c'),
  ),
];

describe('verify.sh: wrong HTTP answers', () => {
  test.concurrent.each(AC5_CASES)('AC-5: $name fails only $id', async ({ name, id, mutate }) => {
    const fixture = healthy('domain');
    mutate(fixture);
    const result = await runVerify(fixture, { label: `AC-5 ${name}` });
    expectChecks(result, 'domain', { [id]: true });
  });
});

describe('verify.sh: parsing the header dump', () => {
  const STYLES: { name: string; style: DumpStyle }[] = [
    { name: 'CRLF line ends', style: { crlf: true } },
    { name: 'a LOCATION header in capitals', style: { locationName: 'LOCATION' } },
    { name: 'a location header in lower case', style: { locationName: 'location' } },
    { name: 'a LoCaTiOn header in mixed case', style: { locationName: 'LoCaTiOn' } },
    { name: 'extra headers around the location', style: { extra: true } },
    { name: 'an HTTP/2 status line', style: { h2: true } },
    { name: 'spaces around the location value', style: { padded: true } },
    { name: 'HTTP/2 with CRLF and extra headers', style: { h2: true, crlf: true, extra: true } },
  ];

  test.concurrent.each(STYLES)(
    'AC-6: $name parses like plain HTTP/1.1',
    async ({ name, style }) => {
      const fixture = healthy('domain');
      setDumps(fixture, style);
      const result = await runVerify(fixture, { label: `AC-6 ${name}` });
      expectChecks(result, 'domain');
    },
  );

  test.concurrent('AC-6: the first location header is the one that counts', async () => {
    const fixture = healthy('domain');
    setDumps(fixture, { second: '//evil.example/' });
    const result = await runVerify(fixture, { label: 'AC-6 two locations' });
    expectChecks(result, 'domain');
  });

  test.concurrent('AC-6: a dump with no location header gives an empty location', async () => {
    const fixture = healthy('domain');
    for (const check of HTTP_CHECKS) {
      if (check.location('domain') !== undefined)
        fixture.http[check.id] = ok(dump(check.status, undefined));
    }
    const result = await runVerify(fixture, { label: 'AC-6 no location' });
    const failures: Record<string, true> = {};
    for (const id of LOCATION_IDS) failures[id] = true;
    expectChecks(result, 'domain', failures);
    expect(checkLines(result).at(-1)).toBe('verify: 5 of 17 checks failed');
  });
});

// =================================================================================================
// AC-7, AC-8: what is requested and asked
// =================================================================================================

describe('verify.sh: requests and queries', () => {
  const DOMAIN_URLS = [
    'https://field-guide-site-111122223333.s3.eu-west-1.amazonaws.com/index.html',
    'http://site.example.com/verify-probe/',
    'https://site.example.com//evil%E3%80%82com',
    'https://site.example.com/%5Cevil',
    'https://site.example.com/verify-probe?a=b%26c',
    'https://d111111abcdef8.cloudfront.net/verify-probe?a=b%26c',
  ];

  test.concurrent(
    'AC-7: the requested URLs are exactly the six of the spec, as the last argument',
    async () => {
      const result = await runVerify(healthy('domain'), { label: 'AC-7 urls' });
      expect(curlCalls(result).map((call) => call.at(-1))).toEqual(DOMAIN_URLS);
    },
  );

  test.concurrent(
    'AC-7: every curl call has --path-as-is, --max-time and --dump-header',
    async () => {
      const result = await runVerify(healthy('domain'), { label: 'AC-7 flags' });
      const calls = curlCalls(result);
      expect(calls).toHaveLength(6);
      for (const call of calls) {
        expect(call).toContain('--path-as-is');
        expect(call).toContain('--dump-header');
        const timeout = call[call.indexOf('--max-time') + 1];
        expect(call).toContain('--max-time');
        expect(timeout).toMatch(/^\d+$/);
      }
    },
  );

  test.concurrent(
    'AC-7: no curl call follows redirects, uses another method, sends data or shows errors',
    async () => {
      const result = await runVerify(healthy('domain'), { label: 'AC-7 forbidden' });
      const calls = curlCalls(result);
      expect(calls).toHaveLength(6);
      for (const call of calls) expect(forbiddenCurlOptions(call), call.at(-1)).toEqual([]);
    },
  );

  test.concurrent('AC-8: every aws call carries its exact query and --output text', async () => {
    const result = await runVerify(healthy('domain'), { label: 'AC-8 queries' });
    const expectedQueries = [
      STATUS_QUERY,
      ...new Set(AWS_CHECKS.map((check) => check.query('domain'))),
    ];
    const calls = awsCalls(result);
    expect(calls.length).toBeGreaterThanOrEqual(AWS_CHECKS.length + 1);
    for (const call of calls) {
      expect(expectedQueries, call.join(' ')).toContain(queryOf(call));
      expect(call[call.indexOf('--output') + 1]).toBe('text');
    }
    expect(new Set(calls.map(queryOf))).toEqual(new Set(expectedQueries));
  });

  test.concurrent(
    'AC-8: aws runs with eu-west-1 and no pager whatever the caller sets',
    async () => {
      const result = await runVerify(healthy('domain'), {
        label: 'AC-8 environment',
        extraEnv: {
          AWS_REGION: 'us-west-2',
          AWS_DEFAULT_REGION: 'us-west-2',
          AWS_PAGER: 'less',
        },
      });
      expect(result.awsEnv.length).toBeGreaterThan(0);
      expect(new Set(result.awsEnv)).toEqual(new Set(['eu-west-1|eu-west-1|']));
      expectChecks(result, 'domain');
    },
  );
});

// =================================================================================================
// AC-9: failing commands
// =================================================================================================

describe('verify.sh: failing commands', () => {
  const AWS_FAILURES = [
    {
      id: 'site-versioning',
      exit: 255,
      message: 'aws s3api get-bucket-versioning failed (exit 255)',
    },
    {
      id: 'logs-public-access-block',
      exit: 255,
      message: 'aws s3api get-public-access-block failed (exit 255)',
    },
    { id: 'distribution', exit: 255, message: 'aws cloudfront get-distribution failed (exit 255)' },
    {
      id: 'distribution-tls',
      exit: 255,
      message: 'aws cloudfront get-distribution failed (exit 255)',
    },
    { id: 'deploy-role', exit: 255, message: 'aws iam get-role failed (exit 255)' },
    { id: 'site-encryption', exit: 1, message: 'aws s3api get-bucket-encryption failed (exit 1)' },
  ];

  test.concurrent.each(AWS_FAILURES)(
    'AC-9: an aws error in $id is reported with its exit code and the other checks still run',
    async ({ id, exit, message }) => {
      const fixture = healthy('domain');
      fixture.aws[id] = failing(
        exit,
        `An error occurred (AccessDenied) when calling the Operation operation: User: arn:aws:sts::${ACCOUNT}:assumed-role/x is not authorized`,
      );
      const result = await runVerify(fixture, { label: `AC-9 aws ${id}` });
      expectChecks(result, 'domain', { [id]: `FAIL: ${id}: ${message}` });
    },
  );

  const CURL_FAILURES = [
    { id: 'bucket-direct', exit: 28 },
    { id: 'redirect-backslash', exit: 6 },
    { id: 'redirect-to-domain', exit: 35 },
  ];

  test.concurrent.each(CURL_FAILURES)(
    'AC-9: a curl error in $id is reported with its exit code and the other checks still run',
    async ({ id, exit }) => {
      const fixture = healthy('domain');
      fixture.http[id] = failing(
        exit,
        `curl: (${exit}) Operation timed out after 20001 milliseconds with 0 bytes received from ${SITE}.s3.eu-west-1.amazonaws.com`,
      );
      const result = await runVerify(fixture, { label: `AC-9 curl ${id}` });
      expectChecks(result, 'domain', { [id]: `FAIL: ${id}: request failed (curl exit ${exit})` });
    },
  );
});

// =================================================================================================
// AC-11, AC-12, AC-13: the script cannot run
// =================================================================================================

describe('verify.sh: usage, tools and outputs', () => {
  test.concurrent.each(TOOLS.map((name) => ({ name })))(
    'AC-11: without $name on PATH the script says so, exits 2 and calls no stub',
    async ({ name }) => {
      const tools = TOOLS.filter((tool) => tool !== name);
      const result = await runVerify(healthy('domain'), {
        label: `AC-11 ${name}`,
        tools,
        strictPath: true,
      });
      expect(result.stderr.split(/\r?\n/)).toContain(`verify: ${name} is not installed`);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );

  test.concurrent.each([
    { missing: ['terraform', 'aws'], first: 'terraform' },
    { missing: ['aws', 'curl'], first: 'aws' },
    { missing: ['terraform', 'curl'], first: 'terraform' },
    { missing: ['terraform', 'aws', 'curl'], first: 'terraform' },
  ])(
    'AC-11: with $missing missing the first of terraform, aws, curl is named',
    async ({ missing, first }) => {
      const tools = TOOLS.filter((tool) => !missing.includes(tool));
      const result = await runVerify(healthy('domain'), {
        label: `AC-11 several ${missing.join(',')}`,
        tools,
        strictPath: true,
      });
      expect(result.stderr.split(/\r?\n/)).toContain(`verify: ${first} is not installed`);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
    },
  );

  const OUTPUT_FAILURES = OUTPUT_NAMES.flatMap((name) => [
    { name, kind: 'empty' },
    { name, kind: 'failing' },
  ]);

  test.concurrent.each(OUTPUT_FAILURES)(
    'AC-12: terraform output $name $kind stops the script with exit 2',
    async ({ name, kind }) => {
      const fixture = healthy('domain');
      fixture.outputs[name] =
        kind === 'empty'
          ? ok('')
          : failing(1, `Error: no outputs for arn:aws:iam::${ACCOUNT}:role/x, run apply first`);
      const result = await runVerify(fixture, { label: `AC-12 ${name} ${kind}` });
      expect(result.stderr.split(/\r?\n/)).toContain(
        `verify: terraform output ${name} is empty; apply the stack first`,
      );
      expect(result.status).toBe(2);
      expect(result.calls.filter((call) => call[0] !== 'terraform')).toEqual([]);
      const terraformNames = result.calls.map((call) => call[3]);
      expect(terraformNames).toEqual(OUTPUT_NAMES.slice(0, terraformNames.length));
      expect(terraformNames).toContain(name);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent.each([
    { name: 'http', value: 'http://site.example.com' },
    { name: 'a trailing slash', value: 'https://site.example.com/' },
    { name: 'a path', value: 'https://site.example.com/x' },
    { name: 'an upper case host', value: 'https://Site.example.com' },
  ])('AC-12: a site_url with $name is not an https origin', async ({ name, value }) => {
    const fixture = healthy('domain');
    fixture.outputs['site_url'] = ok(value);
    const result = await runVerify(fixture, { label: `AC-12 site_url ${name}` });
    expect(result.stderr.split(/\r?\n/)).toContain('verify: site_url is not an https origin');
    expect(result.status).toBe(2);
    expect(result.calls.filter((call) => call[0] !== 'terraform')).toEqual([]);
  });

  test.concurrent.each([
    { name: 'on a normal PATH', strictPath: false, tools: TOOLS, args: ['--help'] },
    { name: 'on a PATH without any tool', strictPath: true, tools: [] as Tool[], args: ['--help'] },
    { name: 'with several arguments', strictPath: false, tools: TOOLS, args: ['a', 'b'] },
    { name: 'with an empty argument', strictPath: false, tools: TOOLS, args: [''] },
  ])(
    'AC-13: an argument $name prints the usage and exits 2',
    async ({ name, strictPath, tools, args }) => {
      const result = await runVerify(healthy('domain'), {
        label: `AC-13 ${name}`,
        args,
        tools,
        strictPath,
      });
      expect(result.stderr.startsWith('usage: bash verify.sh')).toBe(true);
      expect(result.stderr.split(/\r?\n/)[0]).toBe(USAGE);
      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe('');
    },
  );
});

// =================================================================================================
// AC-14: static checks and the call log
// =================================================================================================

describe('verify.sh: shape of the script and of its calls', () => {
  test('AC-14: the first line is the env bash shebang', () => {
    const text = readRepoFile(...LAB, 'verify.sh');
    expect(text.split('\n')[0]).toBe('#!/usr/bin/env bash');
  });

  test('AC-14: the script sets set -euo pipefail', () => {
    expect(readRepoFile(...LAB, 'verify.sh')).toContain('set -euo pipefail');
  });

  test('AC-14: bash -n finds no syntax error', () => {
    const path = scriptPath();
    const result = spawnSync(bashPath(), ['-n', path], { encoding: 'utf8', windowsHide: true });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('AC-14: no command position runs jq, python or node', () => {
    const lines = readRepoFile(...LAB, 'verify.sh')
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line));
    const offenders = lines.filter((line) =>
      /(?:^|\||;|&&|\$\()\s*(?:jq|python[0-9.]*|node)\b/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  test.concurrent('AC-14: terraform is only asked for the five outputs, in order', async () => {
    const result = await runVerify(healthy('domain'), { label: 'AC-14 terraform' });
    const calls = result.calls.filter((call) => call[0] === 'terraform');
    expect(calls).toEqual(OUTPUT_NAMES.map((name) => ['terraform', 'output', '-raw', name]));
  });

  test.concurrent('AC-14: every aws call is a get- call of s3api, cloudfront or iam', async () => {
    const result = await runVerify(healthy('domain'), { label: 'AC-14 aws' });
    const calls = awsCalls(result);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(['s3api', 'cloudfront', 'iam'], call.join(' ')).toContain(call[1]);
      expect(call[2], call.join(' ')).toMatch(/^get-/);
    }
  });
});

// =================================================================================================
// AC-20: CRLF output and waiting for the distribution
// =================================================================================================

describe('verify.sh: CRLF and waiting', () => {
  test.concurrent(
    'AC-20: terraform and aws answers that end in CRLF give the result of AC-1',
    async () => {
      const fixture = healthy('domain');
      fixture.awsEol = '\r\n';
      fixture.tfEol = '\r\n';
      const result = await runVerify(fixture, { label: 'AC-20 crlf' });
      const expected = [...ALL_IDS.map((id) => `ok: ${id}`), 'verify: ok (17 passed, 0 skipped)'];
      expect(result.stdout).toBe(`${expected.join('\n')}\n`);
      expect(result.status).toBe(0);
    },
  );

  test.concurrent('AC-20: CRLF answers of a wrong value still fail only that check', async () => {
    const fixture = healthy('domain');
    fixture.awsEol = '\r\n';
    fixture.tfEol = '\r\n';
    fixture.aws['site-versioning'] = ok('Suspended');
    const result = await runVerify(fixture, { label: 'AC-20 crlf fail' });
    expectChecks(result, 'domain', { 'site-versioning': true });
  });

  test.concurrent(
    'AC-20: two InProgress answers print two wait lines, then the checks run',
    async () => {
      const fixture = healthy('domain');
      fixture.aws['status'] = ok('InProgress', 'InProgress', 'Deployed');
      const result = await runVerify(fixture, { label: 'AC-20 wait twice' });
      const lines = outLines(result.stdout);
      expect(lines.slice(0, 2)).toEqual([WAIT_LINE, WAIT_LINE]);
      expect(lines.slice(2)).toEqual([
        ...ALL_IDS.map((id) => `ok: ${id}`),
        'verify: ok (17 passed, 0 skipped)',
      ]);
      expect(result.status).toBe(0);
      const asks = awsCalls(result).filter((call) => queryOf(call) === STATUS_QUERY);
      expect(asks).toHaveLength(3);
    },
  );

  test.concurrent(
    'AC-20: a distribution that stays InProgress is asked 30 times, then distribution fails',
    async () => {
      const fixture = healthy('domain');
      fixture.aws['status'] = ok('InProgress');
      fixture.aws['distribution'] = ok('InProgress\tTrue\tredirect-to-https');
      const result = await runVerify(fixture, { label: 'AC-20 wait forever' });
      const asks = awsCalls(result).filter((call) => queryOf(call) === STATUS_QUERY);
      expect(asks).toHaveLength(30);
      expect(waitCount(result)).toBeGreaterThanOrEqual(29);
      expect(waitCount(result)).toBeLessThanOrEqual(30);
      expectChecks(result, 'domain', { distribution: true });
    },
  );

  test.concurrent('AC-20: a failing status call goes on at once', async () => {
    const fixture = healthy('domain');
    fixture.aws['status'] = failing(
      255,
      `An error occurred (AccessDenied) arn:aws:sts::${ACCOUNT}:x`,
    );
    const result = await runVerify(fixture, { label: 'AC-20 status fails' });
    const asks = awsCalls(result).filter((call) => queryOf(call) === STATUS_QUERY);
    expect(asks).toHaveLength(1);
    expect(waitCount(result)).toBe(0);
    expectChecks(result, 'domain');
  });

  test.concurrent('AC-20: any other status answer goes on at once', async () => {
    const fixture = healthy('domain');
    fixture.aws['status'] = ok('None');
    const result = await runVerify(fixture, { label: 'AC-20 status none' });
    const asks = awsCalls(result).filter((call) => queryOf(call) === STATUS_QUERY);
    expect(asks).toHaveLength(1);
    expect(waitCount(result)).toBe(0);
    expectChecks(result, 'domain');
  });
});

// =================================================================================================
// AC-10 and the audits over every run above
// =================================================================================================

describe('verify.sh: nothing private is printed', () => {
  test.concurrent('AC-10: a healthy run prints no account id, bucket name or ARN', async () => {
    const result = await runVerify(healthy('domain'), { label: 'AC-10 healthy' });
    expect(result.status).toBe(0);
    expect(leaks(result.all)).toEqual([]);
  });

  test.concurrent(
    'AC-10: a failing aws call prints none of them, whatever its stderr holds',
    async () => {
      const fixture = healthy('domain');
      fixture.aws['site-versioning'] = failing(
        255,
        `An error occurred (AccessDenied) ... arn:aws:sts::${ACCOUNT}:assumed-role/x ${SITE} ${LOGS}`,
      );
      fixture.http['bucket-direct'] = failing(
        28,
        `curl: (28) Connection timed out ... ${SITE}.s3.eu-west-1.amazonaws.com`,
      );
      const result = await runVerify(fixture, { label: 'AC-10 failing calls' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-10: mismatches on values that hold an account id or a bucket name print none of them',
    async () => {
      const fixture = healthy('domain');
      fixture.aws['site-policy-oac'] = ok(policyWith('ec2.amazonaws.com', `${DIST}4`));
      fixture.aws['distribution-origin'] = ok(`None\t${LOGS}.s3.eu-west-1.amazonaws.com`);
      fixture.aws['distribution-function'] = ok(`${FUNCTION_ARN}-old`);
      fixture.aws['deploy-role'] = ok(`/\tarn:aws:iam::${ACCOUNT}:policy/other`);
      fixture.http['bucket-direct'] = ok(dump(200, undefined));
      const result = await runVerify(fixture, { label: 'AC-10 mismatches' });
      expect(result.status).toBe(1);
      expect(leaks(result.all)).toEqual([]);
    },
  );

  test.concurrent(
    'AC-10: a terraform output that fails with an ARN prints none of it',
    async () => {
      const fixture = healthy('domain');
      fixture.outputs['log_bucket_name'] = failing(1, `Error: arn:aws:s3:::${LOGS} ${ACCOUNT}`);
      const result = await runVerify(fixture, { label: 'AC-10 terraform' });
      expect(result.status).toBe(2);
      expect(leaks(result.all)).toEqual([]);
    },
  );
});

describe('verify.sh: audits over every run of this file', () => {
  test('AC-10: no run printed an account id, a bucket name or an ARN', () => {
    expect(RUNS.length).toBeGreaterThan(40);
    const found = RUNS.flatMap(({ label, result }) =>
      leaks(result.all).map((needle) => `${label}: printed ${needle}`),
    );
    expect(found).toEqual([]);
  });

  test('AC-14: no run made an aws call other than get- or a terraform call other than output -raw', () => {
    expect(RUNS.length).toBeGreaterThan(40);
    const found: string[] = [];
    for (const { label, result } of RUNS) {
      for (const call of result.calls) {
        if (call[0] === 'aws') {
          const allowed =
            ['s3api', 'cloudfront', 'iam'].includes(call[1] ?? '') && /^get-/.test(call[2] ?? '');
          if (!allowed) found.push(`${label}: ${call.join(' ')}`);
        } else if (call[0] === 'terraform') {
          if (call[1] !== 'output' || call[2] !== '-raw' || call.length !== 4) {
            found.push(`${label}: ${call.join(' ')}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  test('AC-7: no run used a forbidden curl option', () => {
    expect(RUNS.length).toBeGreaterThan(40);
    const found: string[] = [];
    for (const { label, result } of RUNS) {
      for (const call of curlCalls(result)) {
        for (const option of forbiddenCurlOptions(call)) found.push(`${label}: ${option}`);
      }
    }
    expect(found).toEqual([]);
  });
});

// =================================================================================================
// AC-15 ... AC-19: README.md and break-it.md
// =================================================================================================

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
function sectionOf(markdown: string, level: number, title: string | RegExp): string | undefined {
  const { headings, lines } = scan(markdown);
  const start = headings.find(
    (heading) =>
      heading.level === level &&
      (typeof title === 'string' ? heading.text === title : title.test(heading.text)),
  );
  if (start === undefined) return undefined;
  const end = headings.find((heading) => heading.line > start.line && heading.level <= level);
  return lines.slice(start.line + 1, end === undefined ? lines.length : end.line).join('\n');
}

function headingLine(markdown: string, level: number, title: string): number {
  const found = scan(markdown).headings.find(
    (heading) => heading.level === level && heading.text === title,
  );
  return found === undefined ? -1 : found.line;
}

function readme(): string {
  return readRepoFile(...LAB, 'README.md');
}

function breakIt(): string {
  return readRepoFile(...LAB, 'break-it.md');
}

function need(text: string | undefined, what: string): string {
  if (text === undefined) throw new Error(`missing: ${what}`);
  return text;
}

describe('lab 00 reader docs', () => {
  const QUICK = '## Quick start in your own account';

  test('AC-15: the README has a mermaid flowchart naming the pieces of the lab', () => {
    const block = scan(readme()).blocks.find((candidate) => candidate.lang === 'mermaid');
    expect(block, 'no mermaid code block').toBeDefined();
    const body = block?.body ?? '';
    expect(body).toContain('flowchart');
    for (const word of ['CloudFront', 'Function', 'OAC', 'bucket', 'fg-site-deploy']) {
      expect(body, word).toContain(word);
    }
  });

  test('AC-15: the flowchart sits under the title, before What it creates', () => {
    const text = readme();
    const block = scan(text).blocks.find((candidate) => candidate.lang === 'mermaid');
    expect(block, 'no mermaid code block').toBeDefined();
    const creates = headingLine(text, 2, 'What it creates');
    expect(creates).toBeGreaterThan(-1);
    expect(block?.line ?? Infinity).toBeLessThan(creates);
  });

  test('AC-16: the quick start sits between Inputs and How CI applies it', () => {
    const text = readme();
    const inputs = headingLine(text, 2, 'Inputs');
    const quick = headingLine(text, 2, QUICK.slice(3));
    const ci = headingLine(text, 2, 'How CI applies it');
    expect(inputs).toBeGreaterThan(-1);
    expect(quick, 'no "Quick start in your own account" heading').toBeGreaterThan(inputs);
    expect(ci).toBeGreaterThan(quick);
  });

  function quickStart(): string {
    return need(sectionOf(readme(), 2, 'Quick start in your own account'), QUICK);
  }

  test('AC-16: the quick start links to the README of bootstrap/workload', () => {
    expect(quickStart()).toMatch(/\]\(\.\.\/\.\.\/bootstrap\/workload\/README\.md(?:#[^)\s]*)?\)/);
  });

  test.each(['fg-workload-boundary', 'bootstrap/management'])(
    'AC-16: the quick start mentions %s',
    (needle) => {
      expect(quickStart()).toContain(needle);
    },
  );

  /** The two backend_override.tf commands, read from the README of bootstrap/workload. */
  function overrideCommands(): { bash: string; powershell: string } {
    const lines = readRepoFile('bootstrap', 'workload', 'README.md')
      .split(/\r?\n/)
      .map((line) => line.trim());
    const bash = lines.find((line) => line.startsWith("printf 'terraform {"));
    const powershell = lines.find((line) => line.startsWith('Set-Content backend_override.tf'));
    if (bash === undefined || powershell === undefined) {
      throw new Error(
        'bootstrap/workload/README.md no longer holds the backend_override.tf commands',
      );
    }
    return { bash, powershell };
  }

  test('AC-16: the quick start has the bash backend_override.tf command exactly as bootstrap/workload', () => {
    expect(quickStart()).toContain(overrideCommands().bash);
  });

  test('AC-16: the quick start has the PowerShell backend_override.tf command exactly as bootstrap/workload', () => {
    expect(quickStart()).toContain(overrideCommands().powershell);
  });

  test.each([
    'terraform plan -out lab.tfplan',
    'terraform apply lab.tfplan',
    'pnpm build',
    'aws s3 sync ../../apps/site/dist',
    'create-invalidation',
    'MSYS_NO_PATHCONV=1',
    'bash verify.sh',
    'pnpm smoke --url',
    'terraform destroy',
  ])('AC-16: the quick start says "%s"', (needle) => {
    expect(quickStart()).toContain(needle);
  });

  /** The two Cache-Control values the deploy workflow uploads with. */
  function cacheValues(): string[] {
    const text = readRepoFile('.github', 'workflows', 'deploy.yml');
    const values = new Set<string>();
    for (const match of text.matchAll(/^\s*(?:asset|page)_cache="([^"]+)"/gm)) {
      values.add(match[1] as string);
    }
    if (values.size === 0) {
      for (const match of text.matchAll(/--cache-control\s+"([^"$][^"]*)"/g)) {
        values.add(match[1] as string);
      }
    }
    if (values.size !== 2) {
      throw new Error(`expected two Cache-Control values in deploy.yml, found ${values.size}`);
    }
    return [...values];
  }

  test('AC-16: the quick start uploads with both Cache-Control values of deploy.yml', () => {
    const section = quickStart();
    for (const value of cacheValues()) expect(section, value).toContain(value);
  });

  test('AC-16: the quick start links to break-it.md', () => {
    expect(quickStart()).toMatch(/\]\((?:\.\/)?break-it\.md(?:#[^)\s]*)?\)/);
  });

  test('AC-16: the terraform.tfvars block sets github_sub_prefix and neither domain_name nor hosted_zone_id', () => {
    const blocks = scan(quickStart()).blocks.filter((block) =>
      /github_sub_prefix\s*=/.test(block.body),
    );
    expect(blocks, 'no code block that sets github_sub_prefix').not.toHaveLength(0);
    for (const block of blocks) {
      expect(block.body).not.toContain('domain_name');
      expect(block.body).not.toContain('hosted_zone_id');
    }
  });

  test.each(['-out tfplan', '-out=', 'apply tfplan'])(
    'AC-16: the quick start never contains "%s"',
    (needle) => {
      expect(quickStart()).not.toContain(needle);
    },
  );

  test('AC-17: Verify sits after Deploying the site and its subsections, before Cost', () => {
    const text = readme();
    const verify = headingLine(text, 2, 'Verify');
    expect(verify, 'no "## Verify" heading').toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(headingLine(text, 2, 'Deploying the site'));
    expect(verify).toBeGreaterThan(headingLine(text, 3, 'Rolling back'));
    expect(verify).toBeGreaterThan(headingLine(text, 3, 'Changing the headers'));
    expect(verify).toBeLessThan(headingLine(text, 2, 'Cost'));
  });

  test.each(['verify.sh', 'fg-tf-plan', 'infra.yml', 'InProgress', '%26'])(
    'AC-17: the Verify section names %s',
    (needle) => {
      expect(need(sectionOf(readme(), 2, 'Verify'), '## Verify')).toContain(needle);
    },
  );

  test.each(['0', '1', '2'])('AC-17: the Verify section gives the exit code %s', (code) => {
    const section = need(sectionOf(readme(), 2, 'Verify'), '## Verify');
    expect(section).toMatch(/exit/i);
    expect(section).toMatch(new RegExp(`(?:^|[^\\w.])${code}(?![\\w.])`));
  });

  test('AC-17: Cost mentions the quick start and bootstrap/workload', () => {
    const section = need(sectionOf(readme(), 2, 'Cost'), '## Cost');
    expect(section.toLowerCase()).toContain('quick start');
    expect(section).toContain('bootstrap/workload');
  });

  test('AC-17: Destroy links to the quick start', () => {
    const section = need(sectionOf(readme(), 2, 'Destroy'), '## Destroy');
    expect(section).toContain('#quick-start-in-your-own-account');
  });

  test('AC-18: break-it.md starts with its title', () => {
    const first = breakIt()
      .split(/\r?\n/)
      .find((line) => line.trim() !== '');
    expect(first).toBe('# Break lab 00 on purpose');
  });

  test.each(['terraform apply', 'terraform plan'])('AC-18: break-it.md says "%s"', (needle) => {
    expect(breakIt()).toContain(needle);
  });

  function breakSections(): { number: number; text: string; subs: string[] }[] {
    const text = breakIt();
    const { headings } = scan(text);
    const sections = headings.filter(
      (heading) => heading.level === 2 && /^\d+\./.test(heading.text),
    );
    return sections.map((heading) => {
      const body = need(sectionOf(text, 2, heading.text), heading.text);
      const subs = scan(body)
        .headings.filter((sub) => sub.level === 3)
        .map((sub) => sub.text);
      return { number: Number.parseInt(heading.text, 10), text: body, subs };
    });
  }

  test('AC-18: break-it.md has exactly four numbered sections, 1 to 4', () => {
    expect(breakSections().map((section) => section.number)).toEqual([1, 2, 3, 4]);
  });

  test('AC-18: every section has the five headings, in order, and no other level 3 heading', () => {
    const sections = breakSections();
    expect(sections).toHaveLength(4);
    for (const section of sections) {
      expect(section.subs, `section ${section.number}`).toEqual([
        'Break it',
        'What happens',
        'Why',
        'Put it back',
        'Exam angle',
      ]);
    }
  });

  test.each([
    { n: 1, needles: ['AWS:SourceArn', 'create-invalidation'] },
    { n: 2, needles: ['BlockPublicPolicy', 'AccessDenied'] },
    { n: 3, needles: ['x-cache', 's-maxage=86400', 'immutable'] },
    { n: 4, needles: ['default_root_object', 'Lambda@Edge'] },
  ])('AC-18: section $n mentions $needles', ({ n, needles }) => {
    const section = breakSections().find((candidate) => candidate.number === n);
    expect(section, `no section ${n}`).toBeDefined();
    for (const needle of needles) expect(section?.text, needle).toContain(needle);
  });

  const DOC_FILES = ['README.md', 'break-it.md', 'verify.sh'];

  test.each(DOC_FILES)('AC-19: %s holds no 12-digit number', (file) => {
    expect(readRepoFile(...LAB, file)).not.toMatch(/\b\d{12}\b/);
  });

  test.each(DOC_FILES)('AC-19: %s holds no AWS access key id', (file) => {
    expect(readRepoFile(...LAB, file)).not.toMatch(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/);
  });

  test.each(DOC_FILES)('AC-19: %s names no custom domain of the owner', (file) => {
    const owner = 'tech-leads' + '.lol';
    expect(readRepoFile(...LAB, file)).not.toContain(owner);
  });

  test.each(['README.md', 'break-it.md'])('AC-19: every relative link of %s resolves', (file) => {
    const text = readRepoFile(...LAB, file)
      .replace(/^\s*```[\s\S]*?^\s*```/gm, '')
      .replace(/`[^`\n]*`/g, '');
    const targets = [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
      (m) => m[1] as string,
    );
    const relative = targets.filter(
      (target) => !/^https?:\/\//.test(target) && !target.startsWith('#'),
    );
    const missing = relative.filter((target) => {
      const path = decodeURI(target.split('#')[0] as string);
      return !existsSync(resolve(repoPath(...LAB), path));
    });
    expect(missing).toEqual([]);
  });
});

// =================================================================================================
// AC-21: the wait really sleeps (review round 1)
// =================================================================================================

/**
 * Runs verify.sh with a `sleep` stub that logs its arguments, and with VERIFY_POLL_SECONDS removed
 * from the environment unless `poll` is given. Returns the arguments of every sleep call.
 */
async function sleepCalls(statusAnswers: string[], poll: string | undefined): Promise<string[]> {
  const script = scriptPath();
  const dir = mkdtempSync(join(tmpdir(), 'lab00-sleep-'));
  try {
    const work = join(dir, 'work');
    const logs = join(dir, 'logs');
    const bin = join(dir, 'bin');
    const rules = join(logs, 'rules');
    mkdirSync(work);
    mkdirSync(logs);
    mkdirSync(bin);
    mkdirSync(rules);
    const fixture = healthy('domain');
    fixture.aws['status'] = ok(...statusAnswers);
    writeStubs(fixture, bin, rules, TOOLS);
    writeFileSync(
      join(bin, 'sleep'),
      `#!${stubShebang()}\necho "sleep $*" >> "$FAKE_LOG_DIR/sleep.log"\nexit 0\n`,
      { mode: 0o755 },
    );

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
    env['PATH'] = `${bin}${delimiter}${originalPath}`;
    env['FAKE_LOG_DIR'] = slash(logs);
    if (poll !== undefined) env['VERIFY_POLL_SECONDS'] = poll;
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'VERIFY_POLL_SECONDS')).toBe(
      poll !== undefined,
    );

    const done = await execBash([script], work, env);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    return readLines(join(logs, 'sleep.log')).map((line) => line.replace(/^sleep /, ''));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp dir must not fail a test.
    }
  }
}

describe('verify.sh: the wait sleeps between asks', () => {
  test.concurrent(
    'AC-21: two InProgress answers sleep twice, for 20 seconds when VERIFY_POLL_SECONDS is unset',
    async () => {
      const calls = await sleepCalls(['InProgress', 'InProgress', 'Deployed'], undefined);
      expect(calls).toEqual(['20', '20']);
    },
  );

  test.concurrent(
    'AC-21: two InProgress answers sleep twice, for 3 seconds when VERIFY_POLL_SECONDS is 3',
    async () => {
      const calls = await sleepCalls(['InProgress', 'InProgress', 'Deployed'], '3');
      expect(calls).toEqual(['3', '3']);
    },
  );

  test.concurrent('AC-21: a first answer of Deployed never sleeps', async () => {
    const calls = await sleepCalls(['Deployed'], undefined);
    expect(calls).toEqual([]);
  });
});
