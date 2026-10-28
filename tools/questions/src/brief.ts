// The brief of the question writer (spec 022): the studied gate (section map, completion date of
// the notes), the ids to hand out and the Markdown text. No file system access:
// tools/questions/src/cli.ts does the I/O.
import { getTask, isTaskId } from '@field-guide/schema';
import type { TaskId } from '@field-guide/schema';
import { parse } from 'yaml';
import { nextId } from './bank.ts';

export interface SectionMap {
  sections: { folder: string; tasks: TaskId[] }[];
}

/** Code-unit order, the same on every machine (unlike localeCompare). */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The problem with one section of the map, if any; else the checked task list. */
function checkSection(folder: string, value: unknown): { tasks: TaskId[] } | { problem: string } {
  if (folder === '' || folder === '.' || folder === '..' || /[/\\]/.test(folder)) {
    return { problem: `"${folder}" is not a plain folder name` };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { problem: `${folder}: must be a non-empty list of task ids` };
  }
  const tasks: TaskId[] = [];
  for (const task of value as unknown[]) {
    if (!isTaskId(task)) {
      return { problem: `${folder}: ${String(task)} is not a task id of the catalog (quote it)` };
    }
    if (tasks.includes(task)) return { problem: `${folder}: task ${task} is listed twice` };
    tasks.push(task);
  }
  return { tasks };
}

/** Parses the section map (`<folder>: [<task id>, …]`, main task first). */
export function parseSectionMap(text: string): { map?: SectionMap; problems: string[] } {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return {
      problems: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { problems: ['the section map must be a mapping from folder name to task ids'] };
  }
  const sections: SectionMap['sections'] = [];
  const problems: string[] = [];
  for (const [folder, value] of Object.entries(data)) {
    const checked = checkSection(folder, value);
    if ('problem' in checked) problems.push(checked.problem);
    else sections.push({ folder, tasks: checked.tasks });
  }
  if (problems.length > 0) return { problems };
  sections.sort((a, b) => compare(a.folder, b.folder));
  return { map: { sections }, problems };
}

/** The `**Date completed:** DD/MM/YYYY` date of a notes file as `YYYY-MM-DD`, if it is real. */
export function completedDate(notes: string): string | undefined {
  const line = /^\*\*Date completed:\*\*(.*)$/m.exec(notes.replace(/\r\n?/g, '\n'));
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(line?.[1]?.trim() ?? '');
  if (parts === null) return undefined;
  const [day, month, year] = parts.slice(1).map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? `${parts[3]}-${parts[2]}-${parts[1]}` : undefined;
}

/** Folders whose list holds the task: main sections first, then the others, each by name. */
export function feedingSections(map: SectionMap, task: TaskId): string[] {
  const folders = (match: (tasks: TaskId[]) => boolean): string[] =>
    map.sections
      .filter((section) => match(section.tasks))
      .map((section) => section.folder)
      .sort(compare);
  return [
    ...folders((tasks) => tasks[0] === task),
    ...folders((tasks) => tasks.slice(1).includes(task)),
  ];
}

/** The next `count` free ids of the task, consecutive from the highest used number plus one. */
export function nextIds(task: TaskId, ids: Iterable<string>, count: number): string[] {
  const used = [...ids];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId(task, used);
    result.push(id);
    used.push(id);
  }
  return result;
}

export interface BriefInput {
  task: TaskId;
  ids: string[];
  draftsDir: string;
  existing: { id: string; where: 'bank' | 'draft' | 'rejected'; stem: string }[];
  notes: { folder: string; text: string; aiDraft?: boolean }[];
}

/** True when a line of the notes starts with `**AI draft:**`. */
export function hasAiDraftLine(notes: string): boolean {
  throw new Error(`not implemented (${String(notes.length)} chars)`);
}

export type NotesStatus = 'studied' | 'ai-draft' | 'not-finished';

/** studied (a real Date completed) > ai-draft (an AI draft line) > not-finished. */
export function notesStatus(notes: string): NotesStatus {
  throw new Error(`not implemented (${String(notes.length)} chars)`);
}

const RULES = [
  'Write scenario-style stems like the real exam: a company, a workload and a requirement, then the question.',
  'A `single` question has 4 options and 1 correct. A `multiple` question has 5-6 options and 2-3 correct, and its stem says "Choose two." or "Choose three.".',
  'Make the distractors plausible: real services that fit the scenario but miss one requirement.',
  'Give every option a `why`: for the correct ones what makes them right, for the others what they miss.',
  'Add at least one reference on docs.aws.amazon.com. Open the page (WebFetch) and check that it supports the key; do not cite a page you did not read.',
  'Write in your own words, from the topics of the notes and the AWS documentation. Never reuse wording from courses, practice exams or exam dumps, and never copy sentences from the notes.',
  'Do not write a question that repeats one of the existing questions below, not even with other words.',
  'Use `status: draft` and the provenance exactly as in the format; keep it in block style.',
];

function formatTemplate(task: TaskId, domain: number): string {
  const option = (key: string, correct: boolean): string[] => [
    `  - key: ${key}`,
    `    text: "<text of option ${key}>"`,
    `    correct: ${String(correct)}`,
    `    why: "<why option ${key} is ${correct ? 'right' : 'wrong'}>"`,
  ];
  return [
    '```yaml',
    'id: "<one of the ids above>"',
    `domain: ${String(domain)}`,
    `task: "${task}"`,
    'services:',
    '  - "<lowercase service slug, for example s3>"',
    'difficulty: medium # easy | medium | hard',
    'type: single # single | multiple',
    'stem: "<scenario-style question, at least 20 characters>"',
    'options:',
    ...option('A', false),
    ...option('B', false),
    ...option('C', true),
    ...option('D', false),
    'cue: "<short hint: the words of the stem that point to the answer>"',
    'references:',
    '  - "https://docs.aws.amazon.com/<page you opened>"',
    'status: draft',
    'provenance:',
    '  generated_by: claude-sonnet',
    '```',
  ].join('\n');
}

/** The Markdown brief for the question writer. */
export function renderBrief(input: BriefInput): string {
  const { task, ids, draftsDir, existing, notes } = input;
  const info = getTask(task);
  const domain = info?.domain ?? Number(task.slice(0, 1));
  const existingLines = [...existing]
    .sort((a, b) => compare(a.id, b.id))
    .map(({ id, where, stem }) => `- ${id} (${where}) ${stem.replace(/\s+/g, ' ').trim()}`);
  const studyNotes = notes.map(({ folder, text }) => `### ${folder}\n\n${text.trimEnd()}`);

  const sections = [
    `# Brief: task ${task} · ${info?.title ?? ''} (domain ${String(domain)})`,
    ['## Ids', ids.join('\n')],
    [
      '## Write to',
      `${draftsDir}/d${String(domain)}/${task}/<slug>.yaml   (one question per file; slug: lowercase words and digits joined by -)`,
    ],
    ['## Format', formatTemplate(task, domain)],
    ['## Rules', RULES.map((rule, index) => `${String(index + 1)}. ${rule}`).join('\n')],
    ['## Existing questions for this task', existingLines.join('\n') || '(none)'],
    ['## Study notes', studyNotes.join('\n\n')],
  ];
  return `${sections.map((part) => (typeof part === 'string' ? part : part.join('\n\n'))).join('\n\n')}\n`;
}
