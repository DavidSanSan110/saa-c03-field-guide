// Interface stub (spec 022): the implementation comes after the tests.
import type { TaskId } from '@field-guide/schema';

export interface SectionMap {
  sections: { folder: string; tasks: TaskId[] }[];
}

/** Parses the section map (`<folder>: [<task id>, …]`, main task first). */
export function parseSectionMap(text: string): { map?: SectionMap; problems: string[] } {
  void text;
  throw new Error('not implemented');
}

/** The `**Date completed:** DD/MM/YYYY` date of a notes file as `YYYY-MM-DD`, if it is real. */
export function completedDate(notes: string): string | undefined {
  void notes;
  throw new Error('not implemented');
}

/** Folders whose list holds the task: main sections first, then the others, each by name. */
export function feedingSections(map: SectionMap, task: TaskId): string[] {
  void [map, task];
  throw new Error('not implemented');
}

/** The next `count` free ids of the task, consecutive from the highest used number plus one. */
export function nextIds(task: TaskId, ids: Iterable<string>, count: number): string[] {
  void [task, ids, count];
  throw new Error('not implemented');
}

export interface BriefInput {
  task: TaskId;
  ids: string[];
  draftsDir: string;
  existing: { id: string; where: 'bank' | 'draft' | 'rejected'; stem: string }[];
  notes: { folder: string; text: string }[];
}

/** The Markdown brief for the question writer. */
export function renderBrief(input: BriefInput): string {
  void input;
  throw new Error('not implemented');
}
