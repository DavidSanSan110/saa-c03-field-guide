// Question bank loader for the site (spec 026): bank-level checks and the build-time bank. Interface stub.
import type { Question } from '@field-guide/schema';

export interface BankDirs {
  /** Repo `diagrams/`. */
  diagramsDir: string;
  /** `apps/site/src/content/docs`. */
  docsDir: string;
  /** Repo `labs/` (may not exist yet). */
  labsDir: string;
}

/** Every problem in a questions folder as `<path>: <message>` lines (POSIX path relative to dir), sorted; [] when all is well. */
export function checkQuestionFiles(dir: string, dirs: BankDirs): string[] {
  void dir;
  void dirs;
  throw new Error('not implemented');
}

/** The reviewed questions sorted by id; throws one Error listing every problem line when there is any. */
export function loadQuestionBank(dir: string, dirs: BankDirs): Question[] {
  void dir;
  void dirs;
  throw new Error('not implemented');
}
