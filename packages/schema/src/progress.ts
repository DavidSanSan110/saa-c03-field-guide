// Progress and saved-session schemas: what the practice-test app keeps between visits (spec 018).
// Interface stub: the constants hold placeholder values and the schemas reject everything.
import { z } from 'zod';

import type { DomainId } from './exam.ts';

export const PROGRESS_VERSION: number = 0;
export const SAVED_SESSION_VERSION: number = 0;
export const MAX_ATTEMPTS: number = 0;

/** 0 = not under review. */
export type LeitnerBox = 0 | 1 | 2 | 3 | 4 | 5;

export interface QuestionStats {
  answered: number;
  correct: number;
  lastAnsweredAt: number;
  box: LeitnerBox;
  dueAt: number | null;
}

export interface DomainTally {
  total: number;
  answered: number;
  correct: number;
}

export interface AttemptRecord {
  mode: 'exam' | 'practice';
  seed: number;
  size: number;
  startedAt: number;
  submittedAt: number;
  submitReason: 'manual' | 'timeout';
  total: number;
  answered: number;
  correct: number;
  estimated: number;
  byDomain: Record<DomainId, DomainTally>;
}

export interface Progress {
  version: 1;
  attempts: AttemptRecord[];
  questions: Record<string, QuestionStats>;
}

export interface SavedItem {
  id: string;
  optionOrder: string[];
}

export interface SavedSession {
  version: 1;
  mode: 'exam' | 'practice';
  startedAt: number;
  deadline: number | null;
  current: number;
  exam: {
    seed: number;
    size: number;
    complete: boolean;
    byDomain: Record<DomainId, { quota: number; available: number; picked: number; short: number }>;
    items: SavedItem[];
  };
  answers: Record<string, string[]>;
  flagged: string[];
  revealed: string[];
  status: 'active' | 'submitted';
  submittedAt: number | null;
  submitReason: 'manual' | 'timeout' | null;
}

export const progressSchema: z.ZodType<Progress> = z.never();

export const savedSessionSchema: z.ZodType<SavedSession> = z.never();
