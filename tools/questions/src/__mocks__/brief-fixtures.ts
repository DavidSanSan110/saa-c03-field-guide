// Fixtures for the brief tests (spec 022): made-up study notes and section maps. The text is
// invented for the tests; it is not taken from any real notes.
import { stringify } from 'yaml';

/**
 * The text of a made-up `notes.md`. `completed` is the value after `**Date completed:**`
 * (use `undefined` for a file without that line). The topics carry the `tag` so that tests can
 * tell sections apart.
 */
export function notesText(tag: string, completed: string | undefined = '07/09/2026'): string {
  return [
    `# Notes ${tag}`,
    '',
    `**Date completed:** ${completed}`,
    '',
    `## Topic ${tag} one`,
    `- the ${tag} widget keeps the ${tag}-sprocket aligned`,
    `- remember the ${tag} limits before the ${tag} deadline`,
    '',
    `## Topic ${tag} two`,
    `A longer line about ${tag} gears, written for the tests only.`,
    '',
  ].join('\n');
}

/** The same notes without the completed line. */
export function unfinishedNotes(tag: string): string {
  return notesText(tag).replace(/^\*\*Date completed:\*\*.*\n\n/m, '');
}

/** The text of a `sections.yaml` from `folder -> task ids`, in the given key order. */
export function sectionsYaml(map: Record<string, string[]>): string {
  return stringify(map);
}
