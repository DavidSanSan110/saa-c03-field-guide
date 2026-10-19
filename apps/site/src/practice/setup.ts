// What the Practice card of the start screen offers and how a set is labelled (spec 028). Stub.
import type { PoolFilter } from '@field-guide/quiz-core';
import type { DomainId, Progress, Question, TaskId } from '@field-guide/schema';

export interface PracticeChoices {
  /** The four domains with the number of reviewed questions of each. */
  domains: { id: DomainId; title: string; count: number }[];
  /** The 14 tasks in catalog order; tasks without a question stay with count 0. */
  tasks: { id: TaskId; title: string; count: number }[];
  /** The services of the reviewed questions (`listServices`). */
  services: { service: string; count: number }[];
  /** The weak spots (`leitnerSummary`): due now, in boxes 1 to 5, and when the next one is due. */
  weak: { due: number; inBoxes: number; nextDueAt: number | null };
}

/** The sizes offered next to "All". */
export const SET_SIZES: readonly number[] = [10, 20, 30];

export const practiceChoices: (
  bank: readonly Question[],
  progress: Progress,
  now: number,
) => PracticeChoices = () => {
  throw new Error('not implemented');
};

/** Questions in a set: all of the `available` ones for `'all'`, else at most `choice`. */
export const setSize: (choice: number | 'all', available: number) => number = () => {
  throw new Error('not implemented');
};

/** "Domain d: <title>", "Task <id>: <title>", "Service: <service>" or "Weak spots". */
export const poolLabel: (filter: PoolFilter) => string = () => {
  throw new Error('not implemented');
};
