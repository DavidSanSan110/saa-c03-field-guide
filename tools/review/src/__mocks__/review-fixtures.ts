// Test fixtures for the review tool: made-up draft questions written in the spec-022 template style
// (comments, a folded stem, block-style provenance), sidecars in the spec-020/022 formats, and
// temporary folders. Nothing here imports the code under test.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readBank, sidecarPath } from '@field-guide/questions/bank';
import { getTask } from '@field-guide/schema';
import type { Question } from '@field-guide/schema';
import { parse, stringify } from 'yaml';

export type Raw = Record<string, unknown>;

/**
 * Distinctive strings placed in the fields that must stay hidden before the reveal (why, cue,
 * references, the verifier's quote...), so that a test can prove they are absent or present.
 */
export const marks = {
  why: (key: string): string => `zqwhy${key.toLowerCase()}mark`,
  cue: 'zqcuemark',
  ref: 'zqrefmark',
  quote: 'zqquotemark',
  source: 'zqsourcemark',
  reason: 'zqreasonmark',
  notes: 'zqnotesmark',
  similar: 'zqsimilarmark',
} as const;

/** Every marker, for "none of these appears" assertions. */
export function allMarks(keys: string[] = ['A', 'B', 'C', 'D', 'E']): string[] {
  return [
    ...keys.map(marks.why),
    marks.cue,
    marks.ref,
    marks.quote,
    marks.source,
    marks.reason,
    marks.notes,
    marks.similar,
  ];
}

export const REVIEWER_NAME = 'review-user';

const SINGLE_OPTIONS: [string, string][] = [
  ['SSE-S3', 'AWS creates and owns the keys.'],
  ['SSE-KMS', 'The key lives in AWS KMS.'],
  ['SSE-C', 'The caller sends the key with each request.'],
  ['Client-side encryption', 'The client encrypts the data before the upload.'],
];

const MULTIPLE_OPTIONS: [string, string][] = [
  ['Turn on default encryption', 'New objects are encrypted without a header.'],
  ['Deny unencrypted uploads with a bucket policy', 'The policy rejects plain puts.'],
  ['Rotate the keys by hand every week', 'Manual rotation adds work and no control.'],
  ['Require TLS with the secure transport condition', 'It protects the data in transit.'],
  ['Make the bucket public', 'Public access does not protect anything.'],
];

export interface DraftSpec {
  /** `d<domain>-<task>-<nnnn>`: the domain and the task follow the id. */
  id: string;
  /** File name without extension; default `q<nnnn>`. */
  slug?: string;
  type?: 'single' | 'multiple';
  status?: 'draft' | 'verified' | 'reviewed';
  verifiedBy?: string;
  reviewedBy?: string;
}

export interface Draft {
  id: string;
  slug: string;
  /** `d<domain>/<task>/<slug>.yaml` */
  path: string;
  /** Path of the sidecar, `d<domain>/<task>/<slug>.check.yaml`. */
  sidecar: string;
  text: string;
  question: Question;
  task: string;
  taskTitle: string;
  type: 'single' | 'multiple';
  stem: string;
  /** Correct option keys, sorted. */
  correct: string[];
  /** The option texts, in order. */
  optionTexts: string[];
}

/** The reference URLs of every draft. */
export const REFERENCES = [
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/${marks.ref}.html`,
  `https://aws.amazon.com/s3/${marks.ref}-blog/`,
];

const ID_PARTS = /^d(\d)-(\d\.\d)-(\d{4})$/;

/** A valid draft question, as file text and as the question it holds. */
export function draft(spec: DraftSpec): Draft {
  const parts = ID_PARTS.exec(spec.id);
  if (parts === null) throw new Error(`bad fixture id ${spec.id}`);
  const domain = parts[1] as string;
  const task = parts[2] as string;
  const slug = spec.slug ?? `q${parts[3] as string}`;
  const type = spec.type ?? 'single';
  const status = spec.status ?? 'draft';
  const verifiedBy = spec.verifiedBy ?? (status === 'draft' ? undefined : 'claude-opus');
  const reviewedBy = spec.reviewedBy ?? (status === 'reviewed' ? 'someone-else' : undefined);

  const single = type === 'single';
  const options = single ? SINGLE_OPTIONS : MULTIPLE_OPTIONS;
  const correct = single ? ['C'] : ['B', 'D'];
  const stemLines = [
    'A company must encrypt objects in Amazon S3 at rest and keep the keys outside AWS.',
    single
      ? `Which option meets these requirements? (${spec.id})`
      : `Which two actions meet these requirements? Choose two. (${spec.id})`,
  ];

  const lines = [
    '# Draft written by the question-writer; keep the options in this order.',
    `id: ${spec.id}`,
    `domain: ${domain}`,
    `task: "${task}"`,
    'services: [s3, kms]',
    'difficulty: medium',
    `type: ${type}`,
    'stem: >-',
    ...stemLines.map((line) => `  ${line}`),
    'options:',
    ...options.flatMap(([text, why], index) => {
      const key = String.fromCharCode(65 + index);
      const comment = key === 'D' ? '  # keep this distractor' : '';
      return [
        `  - key: ${key}`,
        `    text: ${text}`,
        `    correct: ${String(correct.includes(key))}${comment}`,
        `    why: ${marks.why(key)} ${why}`,
      ];
    }),
    `cue: ${marks.cue} A key held by the caller points to SSE-C.`,
    'references:',
    ...REFERENCES.map((url) => `  - ${url}`),
    `status: ${status}`,
    'provenance:',
    '  generated_by: claude-sonnet # written by the generator',
    ...(verifiedBy === undefined ? [] : [`  verified_by: ${verifiedBy}`]),
    ...(reviewedBy === undefined ? [] : [`  reviewed_by: ${reviewedBy}`]),
  ];
  const text = `${lines.join('\n')}\n`;
  const path = `d${domain}/${task}/${slug}.yaml`;
  return {
    id: spec.id,
    slug,
    path,
    sidecar: sidecarPath(path),
    text,
    question: parse(text) as Question,
    task,
    taskTitle: getTask(task)?.title ?? '',
    type,
    stem: stemLines.join(' '),
    correct,
    optionTexts: options.map(([optionText]) => optionText),
  };
}

/** `text` with the first `from` replaced; throws when it is missing, so fixtures cannot drift. */
export function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture text does not contain "${from}"`);
  return text.replace(from, () => to);
}

/** The part of a draft's text from `stem:` to the line before `status:`. */
export function stemToStatus(text: string): string {
  return text.slice(text.indexOf('stem:'), text.indexOf('status:'));
}

/** The same question with a change applied to its parsed value, written back as YAML. */
export function mutated(d: Draft, change: (question: Raw) => void): string {
  const question = parse(d.text) as Raw;
  change(question);
  return stringify(question, { lineWidth: 0 });
}

// --- digest (an independent copy of the spec-022 definition) --------------------------------

export function digestOf(q: Pick<Question, 'type' | 'stem' | 'options'>): string {
  const payload = JSON.stringify({
    type: q.type,
    stem: q.stem,
    options: q.options.map((o) => ({ key: o.key, text: o.text, correct: o.correct })),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

// --- sidecars ------------------------------------------------------------------------------

/** A `verification` value (spec 022) that is `verified` for the draft's current content. */
export function verification(d: Draft, overrides: Raw = {}): Raw {
  return {
    result: 'verified',
    reasons: [],
    verifier: 'claude-opus',
    answer: [...d.correct],
    key: [...d.correct],
    quote: `Customer-provided keys ${marks.quote} are sent with every request.`,
    source: `https://docs.aws.amazon.com/AmazonS3/latest/userguide/${marks.source}.html`,
    quote_check: 'found',
    digest: digestOf(d.question),
    ...overrides,
  };
}

/** A `verification` value that flags the draft (the verifier answered A). */
export function flagged(
  d: Draft,
  result: 'mismatch' | 'unsupported' = 'mismatch',
  overrides: Raw = {},
): Raw {
  return verification(d, {
    result,
    reasons: [`The verifier answered A, the key is ${d.correct.join(', ')}. ${marks.reason}`],
    answer: ['A'],
    quote_check: 'not-found',
    notes: `Check the page again ${marks.notes}.`,
    ...overrides,
  });
}

/** A `dedupe` value (spec 020) with one bank twin and one draft twin. */
export function dedupe(overrides: Raw = {}): Raw {
  return {
    threshold: 0.5,
    similar: [
      { id: 'd1-1.3-0042', folder: 'bank', path: `d1/1.3/${marks.similar}-twin.yaml`, score: 0.62 },
      { id: 'd1-1.3-0009', folder: 'drafts', path: 'd1/1.3/another-draft.yaml', score: 0.55 },
    ],
    ...overrides,
  };
}

/** Sidecar text in block style, as the spec-020/022 tools write it. */
export function sidecarYaml(parts: Raw): string {
  return `# check file\n${stringify(parts, { lineWidth: 0 })}`;
}

// --- folders -------------------------------------------------------------------------------

export interface Item {
  draft: Draft;
  /** Sidecar content: a mapping (written in block style) or raw text. */
  sidecar?: Raw | string;
}

/** `path → text` for drafts and their sidecars. */
export function filesOf(...items: (Draft | Item)[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const item of items) {
    const { draft: d, sidecar } = 'draft' in item ? item : { draft: item, sidecar: undefined };
    files[d.path] = d.text;
    if (sidecar !== undefined) {
      files[d.sidecar] = typeof sidecar === 'string' ? sidecar : sidecarYaml(sidecar);
    }
  }
  return files;
}

const tempDirs: string[] = [];

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** A new temporary folder holding `files`; removed by `cleanTemp`. */
export function tempFolder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  tempDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

export function cleanTemp(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Every file under `dir` as `relative POSIX path → text` (to prove that nothing changed). */
export function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const full = join(dir, entry);
    if (statSync(full).isFile()) result[entry.replaceAll('\\', '/')] = readFileSync(full, 'utf8');
  }
  return result;
}

export function readText(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf8');
}

export function parsed(dir: string, path: string): Raw {
  return parse(readText(dir, path)) as Raw;
}

/** SHA-256 (hex) of the file's bytes: the etag of spec 023. */
export function etagOfFile(dir: string, path: string): string {
  return createHash('sha256')
    .update(readFileSync(join(dir, path)))
    .digest('hex');
}

/** The review log of a folder as parsed lines (`[]` when missing). */
export function readLog(dir: string): Raw[] {
  if (!existsSync(join(dir, 'review-log.jsonl'))) return [];
  return readText(dir, 'review-log.jsonl')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Raw);
}

/** The approved version of a draft that the tool must write, for parse-equality checks. */
export function approvedValue(d: Draft, verifiedBy: string, reviewedBy = REVIEWER_NAME): Raw {
  return {
    ...(parse(d.text) as Raw),
    status: 'reviewed',
    provenance: { generated_by: 'claude-sonnet', verified_by: verifiedBy, reviewed_by: reviewedBy },
  };
}

/** The `<path>: <message>` lines the page must list for the problem files of `files`. */
export function problemLines(files: Record<string, string>): string[] {
  return readBank(files, { publicOnly: false }).problems.map((problem) =>
    `${problem.file}: ${problem.message}`.split(/\s+/).join(' '),
  );
}
