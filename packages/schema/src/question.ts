// Question schema: stubs for private spec 002 (tests first, implementation follows).
import { z } from 'zod';

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

/** Any status. */
export const questionSchema: z.ZodType<Question> = z.never();

/** Only `status: 'reviewed'`. */
export const publicQuestionSchema: z.ZodType<Question> = z.never();

export function validateQuestion(data: unknown, opts?: { publicOnly?: boolean }): ValidationResult {
  void data;
  void opts;
  throw new Error('not implemented');
}
