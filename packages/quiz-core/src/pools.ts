// Practice pools by domain, task, service and weak spots (spec 018).
// Interface stub: the functions throw until they are implemented.
import type { DomainId, Progress, Question, TaskId } from '@field-guide/schema';
import type { Exam } from './build.ts';

export type PoolFilter =
  | { kind: 'domain'; domain: DomainId }
  | { kind: 'task'; task: TaskId }
  | { kind: 'service'; service: string }
  | { kind: 'weak'; now: number };

export function practicePool(
  bank: readonly Question[],
  progress: Progress,
  filter: PoolFilter,
): Question[] {
  void [bank, progress, filter];
  throw new Error('not implemented');
}

export function listServices(bank: readonly Question[]): { service: string; count: number }[] {
  void bank;
  throw new Error('not implemented');
}

export function buildPracticeExam(
  pool: readonly Question[],
  options: { seed: number; size: number; shuffleOptions?: boolean },
): Exam {
  void [pool, options];
  throw new Error('not implemented');
}
