// Lab janitor (spec 043): finds lab resources older than N hours and keeps one GitHub issue current.
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.
// Nothing a failed `aws` or `gh` call says is ever printed: it can hold an ARN or an account ID.

export const REGIONS = ['eu-west-1', 'us-east-1'];
export const ISSUE_TITLE = 'Forgotten lab resources';
export const DEFAULT_MAX_AGE_HOURS = 12;

export class JanitorError extends Error {}

export type ExecResult = { code: number; stdout: string };
export type Exec = (file: 'aws' | 'gh', args: string[], input?: string) => Promise<ExecResult>;
export type Deps = {
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
};
export type Finding = { lab: string; region: string; type: string; ageHours: number | null };

/** The line printed when anything but a JanitorError escapes a step; the caught error is never shown. */
const UNEXPECTED = 'janitor: unexpected failure';

/** A failed step; the message is the line to print, so it never holds anything from AWS or GitHub. */
const stepFailed = (step: string): JanitorError => new JanitorError(`janitor: ${step} failed`);

/** The labs that live on purpose: the website and the two bootstrap stacks. */
const SKIPPED_LABS = ['00-site-hosting', 'bootstrap-management', 'bootstrap-workload'];

const LAB_ID = /^[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
const TYPE = /^[a-z0-9-]+(:[a-z0-9-]+)?$/;
const MAX_AGE_HOURS = 2160;
const HOUR_MS = 3_600_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMaxAgeHours(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_MAX_AGE_HOURS;
  const hours = /^[0-9]+$/.test(value) ? Number(value) : 0;
  if (hours < 1 || hours > MAX_AGE_HOURS) {
    throw new JanitorError(
      `JANITOR_MAX_AGE_HOURS must be a whole number from 1 to ${MAX_AGE_HOURS}`,
    );
  }
  return hours;
}

export function resourceType(arn: string): string {
  const fields = arn.split(':');
  const service = fields[2] ?? '';
  const resource = fields.slice(5).join(':');
  const text = /^([^/:]*)[/:]/.exec(resource)?.[1] ?? '';
  const type = text === '' ? service : `${service}:${text}`;
  return TYPE.test(type) ? type : 'other';
}

export function resourceName(arn: string): string {
  return arn.split(/[/:]/).pop() ?? '';
}

/** The fourth `:`-separated field of the ARN; '' when it has none. */
export function arnRegion(arn: string): string {
  return arn.split(':')[3] ?? '';
}

export function labLabel(value: string): string {
  return LAB_ID.test(value) ? value : 'unknown';
}

export function formatAge(ageHours: number | null): string {
  if (ageHours === null) return 'unknown';
  if (ageHours < 48) {
    const hours = Math.floor(ageHours);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${Math.floor(ageHours / 24)} days`;
}

/** UTC, `2026-11-02 07:00 UTC`. */
export function formatTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function reportBody(findings: Finding[], maxAgeHours: number, now: Date): string {
  const groups = new Map<string, Finding[]>();
  for (const found of findings) {
    const key = JSON.stringify([found.lab, found.region, found.type]);
    groups.set(key, [...(groups.get(key) ?? []), found]);
  }
  const rows = [...groups.values()]
    .sort(
      ([a], [b]) =>
        compare(a?.lab ?? '', b?.lab ?? '') ||
        compare(a?.region ?? '', b?.region ?? '') ||
        compare(a?.type ?? '', b?.type ?? ''),
    )
    .map((group) => {
      const ages = group.map((found) => found.ageHours);
      const oldest = ages.includes(null) ? null : Math.max(...(ages as number[]));
      const { lab, region, type } = group[0] as Finding;
      return `| ${lab} | ${region} | ${type} | ${group.length} | ${formatAge(oldest)} |`;
    });
  return [
    `Lab resources older than ${maxAgeHours} hours, as of ${formatTime(now)}.`,
    '',
    '| Lab | Region | Type | Count | Oldest |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Unknown means CloudTrail shows no event for the resource in the last 90 days.',
    '',
    'To remove a lab, dispatch `infra.yml` with the action `destroy`. ' +
      'This issue updates on each run and closes when nothing is left.',
    '',
  ].join('\n');
}

/** The JSON array in stdout; empty stdout and `null` are an empty one. Anything else fails the step. */
function parseList(stdout: string, step: string): unknown[] {
  if (stdout.trim() === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw stepFailed(step);
  }
  if (value === null) return [];
  if (!Array.isArray(value)) throw stepFailed(step);
  return value;
}

/** What the scan keeps of a tagging entry. */
interface Tagged {
  arn: string;
  lab: string;
  scanRegion: string;
}

/** Every resource of one Region's tagging reply; throws unless each has an `arn` and a tag list. */
function taggedIn(region: string, entries: unknown[]): Tagged[] {
  return entries.map((entry) => {
    if (!isObject(entry) || typeof entry['arn'] !== 'string' || !Array.isArray(entry['tags'])) {
      throw stepFailed('tagging scan');
    }
    const tag = (entry['tags'] as unknown[]).find(
      (each) => isObject(each) && each['Key'] === 'lab',
    );
    const lab = isObject(tag) && typeof tag['Value'] === 'string' ? tag['Value'] : '';
    return { arn: entry['arn'], lab, scanRegion: region };
  });
}

/** Hours from the oldest event of a lookup to `now`; null when the lookup has no event. */
async function lookupAge(deps: Deps, region: string, name: string): Promise<number | null> {
  await deps.sleep(600);
  const result = await deps.exec('aws', [
    'cloudtrail',
    'lookup-events',
    '--region',
    region,
    '--lookup-attributes',
    `AttributeKey=ResourceName,AttributeValue=${name}`,
    '--max-items',
    '500',
    '--query',
    'Events[].EventTime',
    '--output',
    'json',
  ]);
  if (result.code !== 0) throw stepFailed('event lookup');
  const times = parseList(result.stdout, 'event lookup').map((time) =>
    typeof time === 'string' ? Date.parse(time) : NaN,
  );
  if (times.some(Number.isNaN)) throw stepFailed('event lookup');
  if (times.length === 0) return null;
  return (deps.now().getTime() - Math.min(...times)) / HOUR_MS;
}

export async function scan(deps: Deps, maxAgeHours: number): Promise<Finding[]> {
  const seen = new Map<string, Tagged>();
  let total = 0;
  for (const region of REGIONS) {
    const result = await deps.exec('aws', [
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
    ]);
    if (result.code !== 0) throw stepFailed('tagging scan');
    const found = taggedIn(region, parseList(result.stdout, 'tagging scan'));
    total += found.length;
    for (const each of found) if (!seen.has(each.arn)) seen.set(each.arn, each);
  }
  // The website lab is always there, so an empty scan means the scan is broken, not all clear.
  if (total === 0) {
    throw new JanitorError('janitor: the scan found nothing at all, not even the skipped labs');
  }

  const findings: Finding[] = [];
  for (const { arn, lab, scanRegion } of seen.values()) {
    if (SKIPPED_LABS.includes(lab)) continue;
    const own = arnRegion(arn);
    const other = REGIONS.find((region) => region !== scanRegion) ?? scanRegion;
    let ageHours: number | null = null;
    for (const region of own === '' ? [scanRegion, other] : [own]) {
      ageHours = await lookupAge(deps, region, resourceName(arn));
      if (ageHours !== null) break;
    }
    if (ageHours === null || ageHours >= maxAgeHours) {
      findings.push({
        lab: labLabel(lab),
        region: own === '' ? scanRegion : own,
        type: resourceType(arn),
        ageHours,
      });
    }
  }
  return findings;
}

/** The issues in the `gh issue list` output. Strict: empty output and `null` are not an empty list. */
function parseIssues(stdout: string): { number: number; title: string }[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw stepFailed('issue update');
  }
  if (!Array.isArray(value)) throw stepFailed('issue update');
  return value.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      typeof entry['number'] !== 'number' ||
      typeof entry['title'] !== 'string'
    ) {
      throw stepFailed('issue update');
    }
    return { number: entry['number'], title: entry['title'] };
  });
}

export async function syncIssue(
  deps: Deps,
  body: string | null,
  closeComment: string,
): Promise<'created' | 'updated' | 'closed' | 'none'> {
  const listed = await deps.exec('gh', [
    'issue',
    'list',
    '--state',
    'open',
    '--author',
    'app/github-actions',
    '--search',
    `in:title "${ISSUE_TITLE}"`,
    '--json',
    'number,title',
    '--limit',
    '20',
  ]);
  if (listed.code !== 0) throw stepFailed('issue update');
  // The search is fuzzy, so the title is checked again; the lowest number is the oldest issue.
  const numbers = parseIssues(listed.stdout)
    .filter((issue) => issue.title === ISSUE_TITLE)
    .map((issue) => issue.number);
  const open = numbers.length === 0 ? undefined : String(Math.min(...numbers));

  if (body === null && open === undefined) return 'none';
  const [args, input]: [string[], string | undefined] =
    body === null
      ? [['issue', 'close', String(open), '--comment', closeComment], undefined]
      : open === undefined
        ? [['issue', 'create', '--title', ISSUE_TITLE, '--body-file', '-'], body]
        : [['issue', 'edit', open, '--body-file', '-'], body];
  const result = await deps.exec('gh', args, input);
  if (result.code !== 0) throw stepFailed('issue update');
  if (body === null) return 'closed';
  return open === undefined ? 'created' : 'updated';
}

export async function runJanitor(deps: Deps): Promise<number> {
  let maxAgeHours;
  try {
    maxAgeHours = parseMaxAgeHours(deps.env['JANITOR_MAX_AGE_HOURS']);
  } catch (error) {
    deps.err(error instanceof JanitorError ? error.message : UNEXPECTED);
    return 2;
  }

  try {
    const findings = await scan(deps, maxAgeHours);
    const now = deps.now();
    const body = findings.length === 0 ? null : reportBody(findings, maxAgeHours, now);
    const closeComment = `Nothing older than ${maxAgeHours} hours is left as of ${formatTime(now)}.`;
    const issue = await syncIssue(deps, body, closeComment);
    const labs = new Set(findings.map((found) => found.lab)).size;
    deps.out(`janitor: ${findings.length} resources in ${labs} labs, issue ${issue}`);
    return 0;
  } catch (error) {
    deps.err(error instanceof JanitorError ? error.message : UNEXPECTED);
    return 1;
  }
}
