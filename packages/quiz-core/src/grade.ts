// Exact-set grading: no partial credit, as on the real exam (spec 016).
import type { Question } from '@field-guide/schema';

/** True only when the set of selected option keys equals the set of correct keys. */
export function gradeQuestion(question: Question, selected: readonly string[]): boolean {
  const correct = new Set(question.options.filter((o) => o.correct).map((o) => o.key));
  const chosen = new Set(selected);
  return chosen.size === correct.size && [...chosen].every((key) => correct.has(key));
}
