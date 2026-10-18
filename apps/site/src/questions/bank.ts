// Question bank loader for the site (spec 026): bank-level checks and the build-time bank.
// Pure Node, no Astro imports; runs at build and in tests.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readBank } from '@field-guide/questions/bank';
import type { FileMap } from '@field-guide/questions/bank';
import type { Question } from '@field-guide/schema';

export interface BankDirs {
  /** Repo `diagrams/`. */
  diagramsDir: string;
  /** `apps/site/src/content/docs`. */
  docsDir: string;
  /** Repo `labs/` (may not exist yet). */
  labsDir: string;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const QUESTION_PATH = /^d\d+\/[^/]+\/[^/]+\.yaml$/;
const NOT_A_QUESTION = 'only question files (d<domain>/<task>/<slug>.yaml) belong in questions/';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Code-unit order, the same on every machine (unlike localeCompare). */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The question files under `dir` (relative POSIX path -> text) and the problems found while walking. */
function walk(dir: string): { files: FileMap; problems: string[] } {
  const files: FileMap = {};
  const problems: string[] = [];
  const visit = (relative: string): void => {
    const here = relative === '' ? dir : join(dir, ...relative.split('/'));
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        problems.push(`${path}: symbolic links are not allowed`);
      } else if (entry.isDirectory()) {
        try {
          visit(path);
        } catch (error) {
          problems.push(`${path}: cannot be read: ${messageOf(error)}`);
        }
      } else if (!QUESTION_PATH.test(path) || path.endsWith('.check.yaml')) {
        problems.push(`${path}: ${NOT_A_QUESTION}`);
      } else {
        try {
          files[path] = readFileSync(join(dir, ...path.split('/')), 'utf8');
        } catch (error) {
          problems.push(`${path}: cannot be read: ${messageOf(error)}`);
        }
      }
    }
  };
  visit('');
  return { files, problems };
}

/** The problems with the `links` of a question (none when all resolve). */
function linkProblem(links: NonNullable<Question['links']>, dirs: BankDirs): string[] {
  const problems: string[] = [];
  const { diagram, guide, lab } = links;
  if (
    diagram !== undefined &&
    !(SLUG.test(diagram) && isFile(join(dirs.diagramsDir, `${diagram}.yaml`)))
  ) {
    problems.push(`links.diagram '${diagram}' has no diagrams/${diagram}.yaml`);
  }
  if (guide !== undefined && !isGuidePage(guide, dirs.docsDir)) {
    problems.push(`links.guide '${guide}' is not a guide page`);
  }
  if (lab !== undefined && !(SLUG.test(lab) && isDirectory(join(dirs.labsDir, lab)))) {
    problems.push(`links.lab '${lab}' has no labs/${lab}/`);
  }
  return problems;
}

function isGuidePage(guide: string, docsDir: string): boolean {
  if (guide.includes('\\')) return false;
  const path = (guide.split('#', 1)[0] ?? '').replace(/\/$/, '');
  if (/[A-Z]/.test(path)) return false;
  const segments = path.replace(/^\//, '').split('/');
  if (segments.includes('') || segments.includes('..')) return false;
  const base = join(docsDir, ...segments);
  return [`${base}.md`, `${base}.mdx`, join(base, 'index.md'), join(base, 'index.mdx')].some(
    isFile,
  );
}

function check(dir: string, dirs: BankDirs): { problems: string[]; questions: Question[] } {
  let walked: ReturnType<typeof walk>;
  try {
    walked = walk(dir);
  } catch (error) {
    return {
      problems: [`Questions folder '${dir}' cannot be read: ${messageOf(error)}`],
      questions: [],
    };
  }
  const bank = readBank(walked.files, { publicOnly: true });
  const problems = [
    ...walked.problems,
    ...bank.problems.map(({ file, message }) => `${file}: ${message}`),
  ];
  for (const { path, question } of bank.entries) {
    if (question.links === undefined) continue;
    for (const message of linkProblem(question.links, dirs)) problems.push(`${path}: ${message}`);
  }
  return {
    problems: problems.sort(compare),
    questions: bank.entries.map((entry) => entry.question).sort((a, b) => compare(a.id, b.id)),
  };
}

/** Every problem in a questions folder as `<path>: <message>` lines (POSIX path relative to dir), sorted; [] when all is well. */
export function checkQuestionFiles(dir: string, dirs: BankDirs): string[] {
  return check(dir, dirs).problems;
}

/** The reviewed questions sorted by id; throws one Error listing every problem line when there is any. */
export function loadQuestionBank(dir: string, dirs: BankDirs): Question[] {
  const { problems, questions } = check(dir, dirs);
  if (problems.length > 0) {
    throw new Error(`The question bank has ${problems.length} problem(s):\n${problems.join('\n')}`);
  }
  return questions;
}
