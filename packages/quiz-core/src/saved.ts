// Save and restore an unfinished session (spec 018).
// Interface stub: the functions throw until they are implemented.
import type { Question, SavedSession } from '@field-guide/schema';
import type { Session } from './session.ts';

export function saveSession(session: Session): SavedSession {
  void session;
  throw new Error('not implemented');
}

export type RestoreResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'version' | 'invalid' | 'missing' | 'changed'; errors: string[] };

export function restoreSession(data: unknown, bank: readonly Question[]): RestoreResult {
  void [data, bank];
  throw new Error('not implemented');
}
