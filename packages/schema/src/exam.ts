// Exam catalog: implemented from private spec 001.
// Interface stubs only: the implementation is written after the tests (spec -> tests -> code).
/* eslint-disable @typescript-eslint/no-unused-vars -- stub parameters; remove with the implementation */

export type DomainId = 1 | 2 | 3 | 4;
export type TaskId =
  | '1.1'
  | '1.2'
  | '1.3'
  | '2.1'
  | '2.2'
  | '3.1'
  | '3.2'
  | '3.3'
  | '3.4'
  | '3.5'
  | '4.1'
  | '4.2'
  | '4.3'
  | '4.4';

export interface Domain {
  readonly id: DomainId;
  readonly title: string;
  readonly weight: number;
  readonly slug: string;
}

export interface Task {
  readonly id: TaskId;
  readonly domain: DomainId;
  readonly title: string;
  readonly shortTitle: string;
  readonly slug: string;
}

export const domains: readonly Domain[] = Object.freeze<Domain[]>([]);
export const tasks: readonly Task[] = Object.freeze<Task[]>([]);

export function isTaskId(_value: unknown): _value is TaskId {
  throw new Error('not implemented');
}

export function getTask(_id: string): Task | undefined {
  throw new Error('not implemented');
}

export function tasksByDomain(_domain: number): readonly Task[] {
  throw new Error('not implemented');
}

export function taskPath(_id: TaskId): string {
  throw new Error('not implemented');
}
