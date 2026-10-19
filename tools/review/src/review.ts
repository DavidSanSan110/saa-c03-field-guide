// Pure logic of the review tool (spec 023): the queue, the verification state, the key check and
// the safe rewrite of a draft on approve or edit. No file system access: server.ts does the I/O.
import { isDeepStrictEqual } from 'node:util';
import { readBank } from '@field-guide/questions/bank';
import { questionDigest } from '@field-guide/questions/verify';
import type { BankEntry, FileMap, Problem } from '@field-guide/questions/bank';
import { formatIssues, questionSchema } from '@field-guide/schema';
import type { Question } from '@field-guide/schema';
import { isMap, isScalar, parse, parseDocument, stringify } from 'yaml';

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Code-unit order, the same on every machine (unlike localeCompare). */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// The digest is defined once, in tools/questions (spec 022); re-exported for the callers here.
export { questionDigest } from '@field-guide/questions/verify';

export type VerificationState = 'verified' | 'changed' | 'flagged' | 'none';

export function verificationState(q: Question, sidecar: unknown): VerificationState {
  const verification = isMapping(sidecar) ? sidecar['verification'] : undefined;
  if (!isMapping(verification)) return 'none';
  const { result, digest } = verification;
  if (result === 'mismatch' || result === 'unsupported') return 'flagged';
  if (result !== 'verified') return 'none';
  return digest === questionDigest(q) ? 'verified' : 'changed';
}

/** The drafts still to review (sorted by id), the reviewed ones waiting for promote, the problems. */
export function buildQueue(files: FileMap): {
  items: BankEntry[];
  waiting: number;
  problems: Problem[];
} {
  const { entries, problems } = readBank(files, { publicOnly: false });
  const items = entries
    .filter((entry) => entry.question.status !== 'reviewed')
    .sort((a, b) => compare(a.question.id, b.question.id));
  return { items, waiting: entries.length - items.length, problems };
}

/** Exact set match of the picked keys with the correct options; order and case do not matter. */
export function isCorrect(q: Question, answer: string[]): boolean {
  const picked = new Set(answer.map((key) => key.toUpperCase()));
  const correct = q.options.filter((option) => option.correct).map((option) => option.key);
  return picked.size === correct.length && correct.every((key) => picked.has(key));
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function scalarText(value: string): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

/** The text of the line holding `offset`, without its line break: where an inserted line goes. */
function endOfLine(text: string, offset: number): number {
  const lineBreak = text.indexOf('\n', offset);
  if (lineBreak === -1) return text.length;
  return text[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak;
}

/** Replaces the value of a scalar pair in place, or says which pair is missing. */
function replaceValue(pair: { value: unknown }, value: string): Edit | undefined {
  const node = pair.value;
  if (!isScalar(node) || node.range == null) return undefined;
  return { start: node.range[0], end: node.range[1], text: scalarText(value) };
}

function applyEdits(text: string, edits: Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text);
}

/**
 * The draft with `status: reviewed`, `provenance.reviewed_by` and `provenance.verified_by`
 * (the verifier, or the reviewer when there is none). Only those values change in the text, so
 * comments, the stem and the options stay as written. Throws when the text is not a single YAML
 * mapping or cannot be rewritten without changing anything else.
 */
export function approvedText(text: string, by: { reviewer: string; verifier?: string }): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`invalid YAML: ${doc.errors[0]?.message ?? ''}`);
  if (!isMap(doc.contents)) throw new Error('the YAML top level must be a mapping');

  const status = doc.contents.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === 'status',
  );
  const provenance = doc.contents.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === 'provenance',
  );
  const statusEdit = status === undefined ? undefined : replaceValue(status, 'reviewed');
  if (statusEdit === undefined) throw new Error('status must be a plain value');
  const block = provenance?.value;
  if (!isMap(block) || block.flow === true || block.items.length === 0) {
    throw new Error('provenance must be a block mapping');
  }

  const wanted: [string, string][] = [
    ['verified_by', by.verifier ?? by.reviewer],
    ['reviewed_by', by.reviewer],
  ];
  const edits: Edit[] = [statusEdit];
  const added: [string, string][] = [];
  for (const [key, value] of wanted) {
    const pair = block.items.find((item) => isScalar(item.key) && item.key.value === key);
    if (pair === undefined) {
      added.push([key, value]);
      continue;
    }
    const edit = replaceValue(pair, value);
    if (edit === undefined) throw new Error(`provenance.${key} must be a plain value`);
    edits.push(edit);
  }

  if (added.length > 0) {
    const first = block.items[0]?.key;
    const last = block.items[block.items.length - 1]?.value;
    if (!isScalar(first) || first.range == null || !isScalar(last) || last.range == null) {
      throw new Error('provenance must hold plain values');
    }
    const indent = text.slice(text.lastIndexOf('\n', first.range[0]) + 1, first.range[0]);
    if (indent.trim() !== '') throw new Error('provenance must be a block mapping');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const at = endOfLine(text, last.range[1]);
    const lines = added.map(([key, value]) => `${eol}${indent}${key}: ${scalarText(value)}`);
    edits.push({ start: at, end: at, text: lines.join('') });
  }

  const out = applyEdits(text, edits);
  const before = parse(text) as Mapping;
  const expected = {
    ...before,
    status: 'reviewed',
    provenance: {
      ...(before['provenance'] as Mapping),
      verified_by: by.verifier ?? by.reviewer,
      reviewed_by: by.reviewer,
    },
  };
  if (!isDeepStrictEqual(parse(out), expected)) {
    throw new Error('the draft cannot be rewritten safely, edit it by hand');
  }
  return out;
}

const LOCKED_FIELDS = ['id', 'domain', 'task', 'status', 'provenance'] as const;

/** Checks the text typed in the editor: valid YAML, a valid question, locked fields unchanged. */
export function checkEdit(
  old: Question,
  text: string,
): { ok: true; question: Question } | { ok: false; errors: string[] } {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`invalid YAML: ${message}`] };
  }
  if (!isMapping(value)) return { ok: false, errors: ['the YAML top level must be a mapping'] };

  const errors: string[] = [];
  const parsed = questionSchema.safeParse(value);
  if (!parsed.success) errors.push(...formatIssues(parsed.error.issues));
  for (const field of LOCKED_FIELDS) {
    if (!isDeepStrictEqual(value[field], old[field])) {
      errors.push(`${field}: cannot be changed in the editor`);
    }
  }
  if (errors.length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, question: parsed.data };
}
