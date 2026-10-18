// Browser storage for the practice-test island (spec 027).
import type { Progress, Question } from '@field-guide/schema';
import { emptyProgress, parseProgress, restoreSession, saveSession } from '@field-guide/quiz-core';
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

export type RestoreFailure = 'changed' | 'other';

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
  /**
   * Why the last `loadSession` returned `unrestorable`: `changed` when the saved questions are
   * missing from the bank or differ from it, `other` for unreadable, invalid or foreign-version
   * data. `null` when the last load was not unrestorable.
   */
  lastRestoreFailure(): RestoreFailure | null;
  /** Removes the saved exam. */
  clearSession(): void;
  /** The stored attempt history; `emptyProgress()` when absent or unreadable. */
  loadProgress(): Progress;
  /** Stores the attempt history. */
  saveProgress(progress: Progress): void;
}

const PROBE_KEY = 'field-guide:practice:probe';

/** Runs `action`, returning `fallback` when the storage throws. */
function attempt<T>(fallback: T, action: () => T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

/** `storage` is `window.localStorage`, or `undefined` when the browser denies access to it. */
export function createPracticeStorage(storage: Storage | undefined): PracticeStorage {
  const available =
    storage !== undefined &&
    attempt(false, () => {
      storage.setItem(PROBE_KEY, '1');
      const read = storage.getItem(PROBE_KEY);
      storage.removeItem(PROBE_KEY);
      return read === '1';
    });
  /** The stored text of `key`, or `null` when absent or unreadable. */
  const read = (key: string): string | null =>
    available ? attempt<string | null>(null, () => storage.getItem(key)) : null;
  const write = (key: string, value: string): void => {
    if (available)
      attempt(undefined, () => {
        storage.setItem(key, value);
      });
  };
  const remove = (key: string): void => {
    if (available)
      attempt(undefined, () => {
        storage.removeItem(key);
      });
  };

  let failure: RestoreFailure | null = null;

  return {
    available,
    loadSession(bank) {
      failure = null;
      const text = read(SESSION_KEY);
      if (text === null) return { kind: 'none' };
      const restored = attempt(undefined, () => restoreSession(JSON.parse(text) as unknown, bank));
      if (restored?.ok === true) return { kind: 'restored', session: restored.session };
      remove(SESSION_KEY);
      failure =
        restored?.ok === false && (restored.reason === 'missing' || restored.reason === 'changed')
          ? 'changed'
          : 'other';
      return { kind: 'unrestorable' };
    },
    lastRestoreFailure() {
      return failure;
    },
    saveSession(session) {
      write(SESSION_KEY, JSON.stringify(saveSession(session)));
    },
    clearSession() {
      remove(SESSION_KEY);
    },
    loadProgress() {
      const text = read(PROGRESS_KEY);
      const parsed =
        text === null
          ? undefined
          : attempt(undefined, () => parseProgress(JSON.parse(text) as unknown));
      return parsed?.ok === true ? parsed.progress : emptyProgress();
    },
    saveProgress(progress) {
      write(PROGRESS_KEY, JSON.stringify(progress));
    },
  };
}
