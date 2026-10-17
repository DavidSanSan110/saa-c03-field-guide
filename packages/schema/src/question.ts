// Question schema: one zod schema for practice questions, shared by CI, guardrails and tools.
import { z } from 'zod';

import { getTask, isTaskId } from './exam.ts';
import type { DomainId, TaskId } from './exam.ts';

export interface QuestionOption {
  key: string;
  text: string;
  correct: boolean;
  why: string;
}

export interface QuestionLinks {
  guide?: string;
  diagram?: string;
  lab?: string;
}

export interface QuestionProvenance {
  generated_by: string;
  verified_by?: string;
  reviewed_by?: string;
}

export interface Question {
  id: string;
  domain: DomainId;
  task: TaskId;
  services: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  type: 'single' | 'multiple';
  stem: string;
  options: QuestionOption[];
  cue?: string;
  references: string[];
  links?: QuestionLinks;
  status: 'draft' | 'verified' | 'reviewed';
  provenance: QuestionProvenance;
}

export type ValidationResult = { ok: true; question: Question } | { ok: false; errors: string[] };

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ID_PATTERN = /^d[1-4]-[1-4]\.\d-\d{4}$/;
const DOCS_HOST = 'docs.aws.amazon.com';

/** A string with at least one non-whitespace character. */
const nonEmpty = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be empty or blank',
});

const domainSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const taskSchema = z.custom<TaskId>(isTaskId, { message: 'not a task of the exam catalog' });

const optionSchema = z.strictObject({
  key: nonEmpty,
  text: nonEmpty,
  correct: z.boolean(),
  why: nonEmpty,
});

const linksSchema = z.strictObject({
  guide: nonEmpty
    .refine((value) => value.startsWith('/'), { message: 'must start with /' })
    .exactOptional(),
  diagram: nonEmpty.exactOptional(),
  lab: nonEmpty.exactOptional(),
});

const provenanceSchema = z.strictObject({
  generated_by: nonEmpty,
  verified_by: nonEmpty.exactOptional(),
  reviewed_by: nonEmpty.exactOptional(),
});

type Ctx = z.RefinementCtx;

function fail(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

function parseHttpsUrl(value: string): URL | undefined {
  if (!value.startsWith('https://') || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === 'https:' ? url : undefined;
}

function checkServices(services: string[], ctx: Ctx): void {
  if (new Set(services).size !== services.length) {
    fail(ctx, [], 'services must be unique');
  }
}

function checkReferences(references: string[], ctx: Ctx): void {
  const urls = references.map(parseHttpsUrl);
  urls.forEach((url, index) => {
    if (url === undefined) fail(ctx, [index], 'must be an https:// URL');
  });
  if (!urls.some((url) => url?.hostname === DOCS_HOST)) {
    fail(ctx, [], `at least one reference must be on ${DOCS_HOST}`);
  }
}

function checkIdMatches(question: Question, ctx: Ctx): void {
  if (!question.id.startsWith(`d${String(question.domain)}-${question.task}-`)) {
    fail(ctx, ['id'], 'domain and task in the id must match the domain and task fields');
  }
}

function checkTaskBelongsToDomain(question: Question, ctx: Ctx): void {
  if (getTask(question.task)?.domain !== question.domain) {
    fail(
      ctx,
      ['task'],
      `task ${question.task} does not belong to domain ${String(question.domain)}`,
    );
  }
}

function checkOptionKeys(options: QuestionOption[], ctx: Ctx): void {
  const inOrder = options.every((option, index) => option.key === String.fromCharCode(65 + index));
  if (!inOrder) fail(ctx, ['options'], 'keys must be A, B, C... in order with no gaps');
}

function checkOptionCounts(question: Question, ctx: Ctx): void {
  const total = question.options.length;
  const correct = question.options.filter((option) => option.correct).length;
  if (question.type === 'single') {
    if (total !== 4) fail(ctx, ['options'], 'single-answer questions need exactly 4 options');
    if (correct !== 1) {
      fail(ctx, ['options'], 'single-answer questions need exactly 1 correct option');
    }
  } else {
    if (total < 5 || total > 6) {
      fail(ctx, ['options'], 'multiple-answer questions need 5 or 6 options');
    }
    if (correct < 2 || correct > 3) {
      fail(ctx, ['options'], 'multiple-answer questions need 2 or 3 correct options');
    }
  }
}

function checkProvenance(question: Question, ctx: Ctx): void {
  const { status, provenance } = question;
  const needsVerifier = status === 'verified' || status === 'reviewed';
  if (needsVerifier && provenance.verified_by === undefined) {
    fail(ctx, ['provenance', 'verified_by'], `status ${status} requires verified_by`);
  }
  if (status === 'reviewed' && provenance.reviewed_by === undefined) {
    fail(ctx, ['provenance', 'reviewed_by'], 'status reviewed requires reviewed_by');
  }
}

function checkQuestion(question: Question, ctx: Ctx): void {
  checkIdMatches(question, ctx);
  checkTaskBelongsToDomain(question, ctx);
  checkOptionKeys(question.options, ctx);
  checkOptionCounts(question, ctx);
  checkProvenance(question, ctx);
}

/** Any status. */
export const questionSchema: z.ZodType<Question> = z
  .strictObject({
    id: z.string().regex(ID_PATTERN, 'must look like d<domain>-<task>-<4 digits>'),
    domain: domainSchema,
    task: taskSchema,
    services: z
      .array(z.string().regex(SLUG_PATTERN, 'must be a lowercase slug'))
      .min(1)
      .superRefine(checkServices),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    type: z.enum(['single', 'multiple']),
    stem: z.string().refine((value) => value.trim().length >= 20, {
      message: 'must have at least 20 characters after trimming',
    }),
    options: z.array(optionSchema),
    cue: nonEmpty.exactOptional(),
    references: z.array(z.string()).min(1).superRefine(checkReferences),
    links: linksSchema.exactOptional(),
    status: z.enum(['draft', 'verified', 'reviewed']),
    provenance: provenanceSchema,
  })
  .superRefine(checkQuestion);

/** Only `status: 'reviewed'`. */
export const publicQuestionSchema: z.ZodType<Question> = questionSchema.refine(
  (question) => question.status === 'reviewed',
  { message: 'only reviewed questions are allowed here', path: ['status'] },
);

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/** The issues of a failed parse as `path: message` strings. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map(formatIssue);
}

export function validateQuestion(data: unknown, opts?: { publicOnly?: boolean }): ValidationResult {
  const schema = opts?.publicOnly === true ? publicQuestionSchema : questionSchema;
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, question: result.data };
  return { ok: false, errors: formatIssues(result.error.issues) };
}
