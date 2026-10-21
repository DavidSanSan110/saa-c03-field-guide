// Change-set digest and summary of `terraform show -json <planfile>` (spec 033).
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.
import { createHash } from 'node:crypto';

export interface PlanChange {
  address: string;
  actions: string[];
  previousAddress: string | null;
  importing: boolean;
}

export class PlanFormatError extends Error {}

type Json = Record<string, unknown>;

/** A validated resource_changes entry. */
interface Entry {
  address: string;
  previous: string | null;
  change: Json & { actions: string[] };
}

/** The rows a summary lists before it points to the job log. */
const MAX_ROWS = 50;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every resource_changes entry, validated; throws PlanFormatError for anything else. */
function entriesOf(plan: unknown): Entry[] {
  if (!isObject(plan) || typeof plan['format_version'] !== 'string') {
    throw new PlanFormatError('not a Terraform plan in JSON form: format_version is missing');
  }
  if (plan['errored'] === true) throw new PlanFormatError('terraform reported an errored plan');
  const changes = plan['resource_changes'];
  if (changes === undefined) return [];
  if (!Array.isArray(changes)) throw new PlanFormatError('resource_changes is not an array');
  return changes.map((item: unknown): Entry => {
    const change = isObject(item) ? item['change'] : undefined;
    const actions = isObject(change) ? change['actions'] : undefined;
    if (
      !isObject(item) ||
      typeof item['address'] !== 'string' ||
      !isObject(change) ||
      !Array.isArray(actions) ||
      !actions.every((action: unknown) => typeof action === 'string')
    ) {
      throw new PlanFormatError(
        'a resource_changes entry needs an address and change.actions as a list of strings',
      );
    }
    const previous = item['previous_address'];
    return {
      address: item['address'],
      previous: typeof previous === 'string' ? previous : null,
      change: { ...change, actions },
    };
  });
}

/** The entries that change state, sorted by address (UTF-16 code unit order). */
function changedEntries(plan: unknown): Entry[] {
  return entriesOf(plan)
    .filter(({ previous, change }) => {
      const noop = change.actions.length === 1 && change.actions[0] === 'no-op';
      return !noop || previous !== null || isObject(change['importing']);
    })
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/** The change set: entries of resource_changes that change state, sorted by address. */
export function changeSet(plan: unknown): PlanChange[] {
  return changedEntries(plan).map(({ address, previous, change }) => ({
    address,
    actions: change.actions,
    previousAddress: previous,
    importing: isObject(change['importing']),
  }));
}

/** JSON with object keys sorted recursively, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Lowercase 64-hex SHA-256 of the canonical change set. */
export function planDigest(plan: unknown): string {
  const field = (change: Json, key: string): unknown => change[key] ?? null;
  const entries = changedEntries(plan).map(({ address, previous, change }) => ({
    address,
    previous_address: previous,
    actions: change.actions,
    before: field(change, 'before'),
    after: field(change, 'after'),
    after_unknown: field(change, 'after_unknown'),
    before_sensitive: field(change, 'before_sensitive'),
    after_sensitive: field(change, 'after_sensitive'),
    replace_paths: field(change, 'replace_paths'),
    importing: field(change, 'importing'),
  }));
  return createHash('sha256').update(canonical(entries), 'utf8').digest('hex');
}

/** An HTML code span: the characters Markdown or HTML would act on are escaped. */
function code(text: string): string {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('|', '&#124;')
    .replace(/[\r\n]+/g, ' ');
  return `<code>${escaped}</code>`;
}

const isActions = (change: PlanChange, ...expected: string[]): boolean =>
  change.actions.length === expected.length &&
  change.actions.every((action, index) => action === expected[index]);

const isReplace = (change: PlanChange): boolean =>
  isActions(change, 'delete', 'create') || isActions(change, 'create', 'delete');

function actionLabel(change: PlanChange): string {
  let label = isReplace(change) ? 'replace' : change.actions.join('+');
  if (change.importing) label += ', import';
  if (change.previousAddress !== null) label += `, moved from ${code(change.previousAddress)}`;
  return label;
}

function countLine(changes: PlanChange[]): string {
  const count = (matches: (change: PlanChange) => boolean): number =>
    changes.filter(matches).length;
  const add = count((change) => isActions(change, 'create'));
  const update = count((change) => isActions(change, 'update'));
  const destroy = count((change) => isActions(change, 'delete'));
  const replace = count(isReplace);
  return `Plan: ${add} to add, ${update} to change, ${destroy} to destroy, ${replace} to replace.`;
}

/** Markdown for the PR comment and the run page; never contains attribute values. */
export function planSummary(plan: unknown, stack: string): string {
  const changes = changeSet(plan);
  const lines = [`### ${code(stack)}`, ''];
  if (changes.length === 0) {
    lines.push('No changes.', '');
  } else {
    lines.push(countLine(changes), '', '| Action | Resource |', '|---|---|');
    for (const change of changes.slice(0, MAX_ROWS)) {
      lines.push(`| ${actionLabel(change)} | ${code(change.address)} |`);
    }
    // The blank line keeps Markdown from reading this line as one more table row.
    if (changes.length > MAX_ROWS) {
      lines.push('', `…and ${changes.length - MAX_ROWS} more (see the job log).`);
    }
    lines.push('');
  }
  lines.push(`Change set digest: ${code(planDigest(plan))}`, '');
  return lines.join('\n');
}

const USAGE = `Usage:
  terraform-plan-cli digest <plan.json>
  terraform-plan-cli summary <plan.json> <stack>
  terraform-plan-cli changed <plan.json>
`;

/** CLI dispatcher used by the entry file: returns the exit code. */
export function runTfPlan(
  argv: string[],
  io: { readFile(path: string): string; stdout(text: string): void; stderr(text: string): void },
): number {
  const [command, file, stack, ...extra] = argv;
  const operands = command === 'summary' ? 2 : 1;
  const known = command === 'digest' || command === 'changed' || command === 'summary';
  if (!known || argv.length !== operands + 1 || file === undefined || extra.length > 0) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const plan: unknown = JSON.parse(io.readFile(file));
    let output: string;
    if (command === 'digest') output = `${planDigest(plan)}\n`;
    else if (command === 'changed') output = `${changeSet(plan).length > 0}\n`;
    else output = planSummary(plan, stack ?? '');
    io.stdout(output);
    return 0;
  } catch (error) {
    const reason = error instanceof SyntaxError ? `${file} is not valid JSON` : String(error);
    io.stderr(`terraform-plan-cli: ${error instanceof PlanFormatError ? error.message : reason}\n`);
    return 1;
  }
}
