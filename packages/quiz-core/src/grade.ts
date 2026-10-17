// Exact-set grading (interface stub: implementation pending, spec 016).
import type { Question } from '@field-guide/schema';

/** True only when the set of selected option keys equals the set of correct keys. */
export function gradeQuestion(question: Question, selected: readonly string[]): boolean {
  void question;
  void selected;
  throw new Error('not implemented');
}
