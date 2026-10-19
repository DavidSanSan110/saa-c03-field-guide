// What the Practice card of the start screen offers and how a set is labelled (spec 028).
import { leitnerSummary, listServices, practicePool } from '@field-guide/quiz-core';
import type { PoolFilter } from '@field-guide/quiz-core';
import { domains, getTask, tasks } from '@field-guide/schema';
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

export function practiceChoices(
  bank: readonly Question[],
  progress: Progress,
  now: number,
): PracticeChoices {
  const { boxes, due, nextDueAt } = leitnerSummary(bank, progress, now);
  return {
    domains: domains.map(({ id, title }) => ({
      id,
      title,
      count: practicePool(bank, progress, { kind: 'domain', domain: id }).length,
    })),
    tasks: tasks.map(({ id, title }) => ({
      id,
      title,
      count: practicePool(bank, progress, { kind: 'task', task: id }).length,
    })),
    services: listServices(bank),
    weak: { due, inBoxes: Object.values(boxes).reduce((sum, n) => sum + n, 0), nextDueAt },
  };
}

/** Questions in a set: all of the `available` ones for `'all'`, else at most `choice`. */
export function setSize(choice: number | 'all', available: number): number {
  return choice === 'all' ? available : Math.min(choice, available);
}

/** "Domain d: <title>", "Task <id>: <title>", "Service: <service>" or "Weak spots". */
export function poolLabel(filter: PoolFilter): string {
  switch (filter.kind) {
    case 'domain':
      return `Domain ${String(filter.domain)}: ${domains.find((d) => d.id === filter.domain)?.title ?? ''}`;
    case 'task':
      return `Task ${filter.task}: ${getTask(filter.task)?.title ?? ''}`;
    case 'service':
      return `Service: ${filter.service}`;
    case 'weak':
      return 'Weak spots';
  }
}
