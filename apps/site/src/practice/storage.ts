// Browser storage for the practice-test island (spec 027). Stub until implemented.
import type { Progress, Question } from '@field-guide/schema';
import type { Session } from '@field-guide/quiz-core';

/** localStorage key of the active exam (the `saveSession` output as JSON). */
export const SESSION_KEY = 'field-guide:practice:session';
/** localStorage key of the attempt history (the `Progress` as JSON). */
export const PROGRESS_KEY = 'field-guide:practice:progress';

/**
 * What the saved exam turned out to be:
 * - `none`: nothing is stored;
 * - `restored`: a session rebuilt with `restoreSession` against the bank;
 * - `unrestorable`: something is stored but cannot be restored (changed or missing questions,
 *   invalid or unreadable data). The stored copy has been removed.
 */
export type SessionLoad =
  { kind: 'none' } | { kind: 'restored'; session: Session } | { kind: 'unrestorable' };

/**
 * The storage helpers. No method throws, whatever the underlying storage does; when it fails the
 * app keeps working without saving.
 */
export interface PracticeStorage {
  /**
   * False when there is no storage or a probe made at creation (write, read and remove of a
   * throwaway key) failed. The start screen then says "Progress can't be saved in this browser."
   */
  readonly available: boolean;
  /** The saved exam against the current bank. Unreadable or unrestorable data is removed. */
  loadSession(bank: readonly Question[]): SessionLoad;
  /** Stores the session (`saveSession` as JSON). */
  saveSession(session: Session): void;
  /** Removes the saved exam. */
  clearSession(): void;
  /** The stored attempt history; `emptyProgress()` when absent or unreadable. */
  loadProgress(): Progress;
  /** Stores the attempt history. */
  saveProgress(progress: Progress): void;
}

/** `storage` is `window.localStorage`, or `undefined` when the browser denies access to it. */
export function createPracticeStorage(storage: Storage | undefined): PracticeStorage {
  void storage;
  throw new Error('not implemented');
}
