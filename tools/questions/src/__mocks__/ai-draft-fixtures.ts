// Fixtures for the AI-draft tests of `brief` (spec 038): made-up notes that carry the
// `**AI draft:**` marker line. The text is invented for the tests; it is not taken from any real
// notes. They build on notesText/unfinishedNotes of the spec-022 fixtures.
import { notesText, unfinishedNotes } from './brief-fixtures.ts';

/** The marker line of AI-draft notes (what follows `**AI draft:**` does not matter). */
export const AI_DRAFT_LINE = '**AI draft:** 2026-10-28 — made-up text';

/** The one-line paragraph that `brief` prints under `## Study notes` (spec 038, exactly). */
export const PARAGRAPH =
  'Sections marked "(AI draft, not studied yet)" hold AI-written draft notes that the owner has not studied or checked yet. Use them only to pick topics: check every fact you rely on (limits, defaults, prices, feature support) against the AWS documentation page you cite, and if the docs disagree with the notes, follow the docs. Never reuse their wording.';

/** The heading line of a note of an AI-draft section. */
export function aiDraftHeading(folder: string): string {
  return `### ${folder} (AI draft, not studied yet)`;
}

/**
 * Notes with a `**Date completed:**` line holding `completed` (empty by default) followed by the
 * AI-draft marker line: the status is `ai-draft` unless `completed` is a real date.
 */
export function aiDraftNotes(tag: string, completed = ''): string {
  return notesText(tag, completed).replace(
    /^\*\*Date completed:\*\*.*$/m,
    (line) => `${line.trimEnd()}\n${AI_DRAFT_LINE}`,
  );
}

/** Notes with a real Date completed and the marker line still there: the status is `studied`. */
export function studiedAiDraftNotes(tag: string): string {
  return aiDraftNotes(tag, '07/09/2026');
}

/** AI-draft notes without any `**Date completed:**` line. */
export function aiDraftNotesNoDateLine(tag: string): string {
  return unfinishedNotes(tag).replace(/^# .*$/m, (title) => `${title}\n\n${AI_DRAFT_LINE}`);
}

/** The three lines of the `brief` entry of the usage text after its first line, trimmed. */
export const BRIEF_USAGE_FIRST_LINE =
  'questions brief <task> [--count <n>] [--notes <dir>] [--map <file>] [--studied-only]';
export const BRIEF_USAGE_NOTE_LINES = [
  'print the brief of the question writer for a task',
  '(studied and AI-draft sections; --studied-only',
  'leaves the AI-draft ones out)',
];
