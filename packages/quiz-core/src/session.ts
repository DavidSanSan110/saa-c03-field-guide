// Exam session reducer: answer, flag, go to, reveal, submit and the deadline (spec 017).
// INTERFACE STUB: the functions are filled in by the implementation step.
import type { Exam } from './build.ts';
import type { Answers, AttemptScore } from './score.ts';

/** 130 minutes in milliseconds. */
export const EXAM_DURATION_MS = 7_800_000;

export type SessionMode = 'exam' | 'practice';

export interface Session {
  mode: SessionMode;
  exam: Exam;
  startedAt: number;
  deadline: number | null;
  current: number;
  answers: Answers;
  flagged: string[];
  revealed: string[];
  status: 'active' | 'submitted';
  submittedAt: number | null;
  submitReason: 'manual' | 'timeout' | null;
}

export type SessionAction =
  | { type: 'answer'; selected: readonly string[]; now: number }
  | { type: 'flag'; flagged: boolean; now: number }
  | { type: 'goTo'; index: number; now: number }
  | { type: 'reveal'; now: number }
  | { type: 'submit'; now: number }
  | { type: 'tick'; now: number };

export interface ReviewEntry {
  index: number;
  id: string;
  answered: boolean;
  flagged: boolean;
}

export interface ItemFeedback {
  correct: boolean;
  correctKeys: string[];
}

function notImplemented(...args: unknown[]): never {
  throw new Error(`not implemented (${String(args.length)} args)`);
}

export function startSession(
  exam: Exam,
  options: { mode: SessionMode; now: number; durationMs?: number },
): Session {
  return notImplemented(exam, options);
}

export function sessionReducer(session: Session, action: SessionAction): Session {
  return notImplemented(session, action);
}

export function remainingMs(session: Session, now: number): number | null {
  return notImplemented(session, now);
}

export function reviewList(session: Session): ReviewEntry[] {
  return notImplemented(session);
}

export function feedback(session: Session, index: number): ItemFeedback | null {
  return notImplemented(session, index);
}

export function sessionScore(session: Session): AttemptScore | null {
  return notImplemented(session);
}
