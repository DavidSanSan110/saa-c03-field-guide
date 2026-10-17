// Weighted exam builder (interface stub: implementation pending, spec 016).
import type { DomainId, Question } from '@field-guide/schema';

export const EXAM_SIZE = 65;

/** Largest-remainder split of `size` by the domain weights. `size` is an integer >= 1. */
export function domainQuotas(size: number): Record<DomainId, number> {
  void size;
  throw new Error('not implemented');
}

export interface ExamItem {
  question: Question;
  optionOrder: string[];
}

export interface DomainPlan {
  quota: number;
  available: number;
  picked: number;
  short: number;
}

export interface Exam {
  seed: number;
  size: number;
  items: ExamItem[];
  complete: boolean;
  byDomain: Record<DomainId, DomainPlan>;
}

export function buildExam(
  bank: readonly Question[],
  options: { seed: number; size?: number; shuffleOptions?: boolean },
): Exam {
  void bank;
  void options;
  throw new Error('not implemented');
}
