// Exam session reducer: answer, flag, go to, reveal, submit and the deadline (spec 017).
// Time is a number of milliseconds given by the caller; nothing here reads a clock.
import type { Exam, ExamItem } from './build.ts';
import { gradeQuestion } from './grade.ts';
import { scoreAttempt } from './score.ts';
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

function assertNow(now: number): void {
  if (!Number.isFinite(now)) throw new RangeError(`now must be a finite number, got ${now}`);
}

/** The item at `index`, or RangeError when the index is not an integer inside the exam. */
function itemAt(exam: Exam, index: number): ExamItem {
  const item = Number.isInteger(index) ? exam.items[index] : undefined;
  if (item === undefined) throw new RangeError(`no question at index ${index}`);
  return item;
}

/** The stored selection for a question id (empty when unanswered). */
function selectedOf(session: Session, id: string): readonly string[] {
  return (Object.hasOwn(session.answers, id) && session.answers[id]) || [];
}

/** The ids of `ids`, in exam item order. */
function inItemOrder(exam: Exam, ids: ReadonlySet<string>): string[] {
  return exam.items.map((item) => item.question.id).filter((id) => ids.has(id));
}

/**
 * Starts an attempt on item 0. Exam mode sets `deadline = now + durationMs`; practice mode has none.
 * RangeError for a `now` that is not finite, a `durationMs` that is not a positive integer, or an
 * exam without items.
 */
export function startSession(
  exam: Exam,
  options: { mode: SessionMode; now: number; durationMs?: number },
): Session {
  const { mode, now, durationMs = EXAM_DURATION_MS } = options;
  assertNow(now);
  if (!Number.isInteger(durationMs) || durationMs < 1) {
    throw new RangeError(`durationMs must be a positive integer, got ${durationMs}`);
  }
  if (exam.items.length === 0) throw new RangeError('the exam has no questions');
  return {
    mode,
    exam,
    startedAt: now,
    deadline: mode === 'exam' ? now + durationMs : null,
    current: 0,
    answers: {},
    flagged: [],
    revealed: [],
    status: 'active',
    submittedAt: null,
    submitReason: null,
  };
}

function answerCurrent(session: Session, selected: readonly string[]): Session {
  const { question } = itemAt(session.exam, session.current);
  const keys = question.options.map((option) => option.key);
  if (!selected.every((key) => keys.includes(key))) {
    throw new RangeError(`selected keys are not all options of ${question.id}`);
  }
  // Original option order, duplicates removed.
  const stored = keys.filter((key) => selected.includes(key));
  if (question.type === 'single' && stored.length > 1) {
    throw new RangeError(`${question.id} is a single-answer question`);
  }
  if (session.revealed.includes(question.id)) return session;
  if (selectedOf(session, question.id).join() === stored.join()) return session;

  const entries = Object.entries(session.answers).filter(([id]) => id !== question.id);
  if (stored.length > 0) entries.push([question.id, stored]);
  return { ...session, answers: Object.fromEntries(entries) };
}

function flagCurrent(session: Session, flagged: boolean): Session {
  const { id } = itemAt(session.exam, session.current).question;
  if (session.flagged.includes(id) === flagged) return session;
  const ids = new Set(session.flagged);
  if (flagged) ids.add(id);
  else ids.delete(id);
  return { ...session, flagged: inItemOrder(session.exam, ids) };
}

function goTo(session: Session, index: number): Session {
  itemAt(session.exam, index);
  return index === session.current ? session : { ...session, current: index };
}

function revealCurrent(session: Session): Session {
  const { id } = itemAt(session.exam, session.current).question;
  if (session.mode !== 'practice' || session.revealed.includes(id)) return session;
  return { ...session, revealed: inItemOrder(session.exam, new Set([...session.revealed, id])) };
}

/**
 * Applies one action. Order: `now` is checked, then a submitted session only accepts `goTo`, then
 * an exam-mode deadline at or before `now` submits it (`submittedAt` is the deadline) and drops the
 * action. An action that changes nothing returns the same session object.
 */
export function sessionReducer(session: Session, action: SessionAction): Session {
  assertNow(action.now);
  if (session.status === 'submitted') {
    return action.type === 'goTo' ? goTo(session, action.index) : session;
  }
  if (session.deadline !== null && action.now >= session.deadline) {
    return {
      ...session,
      status: 'submitted',
      submittedAt: session.deadline,
      submitReason: 'timeout',
    };
  }
  switch (action.type) {
    case 'answer':
      return answerCurrent(session, action.selected);
    case 'flag':
      return flagCurrent(session, action.flagged);
    case 'goTo':
      return goTo(session, action.index);
    case 'reveal':
      return revealCurrent(session);
    case 'submit':
      return { ...session, status: 'submitted', submittedAt: action.now, submitReason: 'manual' };
    case 'tick':
      return session;
  }
}

/**
 * Time left: `null` in practice mode, else `max(0, deadline - now)`. A submitted session is frozen
 * at the moment it ended, whatever `now` is.
 */
export function remainingMs(session: Session, now: number): number | null {
  assertNow(now);
  if (session.deadline === null) return null;
  return Math.max(0, session.deadline - (session.submittedAt ?? now));
}

/** The flagged or unanswered questions, in exam item order. */
export function reviewList(session: Session): ReviewEntry[] {
  return session.exam.items
    .map(({ question }, index) => ({
      index,
      id: question.id,
      answered: Object.hasOwn(session.answers, question.id),
      flagged: session.flagged.includes(question.id),
    }))
    .filter((entry) => !entry.answered || entry.flagged);
}

/**
 * The key of one question, or `null` while it is hidden: shown after submission, and in practice
 * mode for revealed questions.
 */
export function feedback(session: Session, index: number): ItemFeedback | null {
  const { question } = itemAt(session.exam, index);
  const visible =
    session.status === 'submitted' ||
    (session.mode === 'practice' && session.revealed.includes(question.id));
  if (!visible) return null;
  return {
    correct: gradeQuestion(question, selectedOf(session, question.id)),
    correctKeys: question.options.filter((option) => option.correct).map((option) => option.key),
  };
}

/** The attempt score after submission, `null` while active. */
export function sessionScore(session: Session): AttemptScore | null {
  if (session.status === 'active') return null;
  return scoreAttempt(
    session.exam.items.map((item) => item.question),
    session.answers,
  );
}
