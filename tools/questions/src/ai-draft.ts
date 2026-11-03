// The AI-draft marker of a draft's check file (spec 044): which AI-draft notes fed its brief. No file
// system access: tools/questions/src/cli.ts does the I/O.
/* eslint-disable @typescript-eslint/no-unused-vars -- interface stub of spec 044, to be replaced */
import type { TaskId } from '@field-guide/schema';
import type { SectionMap } from './brief.ts';

/** `existing` (or nothing) with the top-level key `ai_draft` set to `{ sections }`. */
export function withAiDraft(_existing: string | undefined, _sections: string[]): string {
  throw new Error('not implemented');
}

/**
 * The folders from `feedingSections(map, task)` whose notes exist and have the status `ai-draft`,
 * in that order.
 */
export function aiDraftSections(
  _map: SectionMap,
  _task: TaskId,
  _readNotes: (folder: string) => string | undefined,
): string[] {
  throw new Error('not implemented');
}
