// The AI-draft marker of a draft's check file (spec 044): which AI-draft notes fed its brief. No file
// system access: tools/questions/src/cli.ts does the I/O.
import type { TaskId } from '@field-guide/schema';
import { feedingSections, notesStatus } from './brief.ts';
import type { SectionMap } from './brief.ts';
import { withSidecarKey } from './sidecar.ts';

/** `existing` (or nothing) with the top-level key `ai_draft` set to `{ sections }`. */
export function withAiDraft(existing: string | undefined, sections: string[]): string {
  return withSidecarKey(existing, 'ai_draft', { sections });
}

/**
 * The folders from `feedingSections(map, task)` whose notes exist and have the status `ai-draft`,
 * in that order.
 */
export function aiDraftSections(
  map: SectionMap,
  task: TaskId,
  readNotes: (folder: string) => string | undefined,
): string[] {
  return feedingSections(map, task).filter((folder) => {
    const text = readNotes(folder);
    return text !== undefined && notesStatus(text) === 'ai-draft';
  });
}
