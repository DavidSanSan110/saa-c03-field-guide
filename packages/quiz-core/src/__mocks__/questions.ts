// Question fixtures for the quiz-core tests. Every question built here follows spec 002 and
// passes `publicQuestionSchema` (reviewed) or `questionSchema` (draft, verified).
import { getTask, tasksByDomain } from '@field-guide/schema';
import type { DomainId, Question, QuestionOption, TaskId } from '@field-guide/schema';

export interface QuestionSpec {
  /** Defaults to a unique `d<domain>-<task>-<4 digits>` id. */
  id?: string;
  /** Defaults to the domain of `task`, or 1. */
  domain?: DomainId;
  /** Defaults to the first task of `domain`. */
  task?: TaskId;
  /** Defaults to `single`. */
  type?: Question['type'];
  /** Defaults to `reviewed`. */
  status?: Question['status'];
  /** Defaults to 4 (single) or 5 (multiple). */
  optionCount?: number;
  /** Original option keys marked correct. Defaults to `A` (single) or `B` and `E` (multiple). */
  correct?: readonly string[];
}

let counter = 0;

function taskDomain(task: TaskId): DomainId {
  const found = getTask(task);
  if (found === undefined) throw new Error(`fixture: unknown task ${task}`);
  return found.domain;
}

function firstTask(domain: DomainId): TaskId {
  const first = tasksByDomain(domain)[0];
  if (first === undefined) throw new Error(`fixture: domain ${String(domain)} has no task`);
  return first.id;
}

function nextId(domain: DomainId, task: TaskId): string {
  counter += 1;
  if (counter > 9999) throw new Error('fixture: out of question ids');
  return `d${String(domain)}-${task}-${String(counter).padStart(4, '0')}`;
}

function provenanceFor(status: Question['status']): Question['provenance'] {
  const provenance: Question['provenance'] = { generated_by: 'fixture-generator' };
  if (status === 'verified' || status === 'reviewed') provenance.verified_by = 'fixture-verifier';
  if (status === 'reviewed') provenance.reviewed_by = 'fixture-reviewer';
  return provenance;
}

/** Builds one valid question. Each call without `id` gets a new unique id. */
export function makeQuestion(spec: QuestionSpec = {}): Question {
  const domain = spec.domain ?? (spec.task === undefined ? 1 : taskDomain(spec.task));
  const task = spec.task ?? firstTask(domain);
  if (taskDomain(task) !== domain) {
    throw new Error(`fixture: task ${task} does not belong to domain ${String(domain)}`);
  }
  const type = spec.type ?? 'single';
  const status = spec.status ?? 'reviewed';
  const id = spec.id ?? nextId(domain, task);
  const optionCount = spec.optionCount ?? (type === 'single' ? 4 : 5);
  const correct = spec.correct ?? (type === 'single' ? ['A'] : ['B', 'E']);

  const options: QuestionOption[] = Array.from({ length: optionCount }, (_, index) => {
    const key = String.fromCharCode(65 + index);
    return {
      key,
      text: `Option ${key} of ${id}`,
      correct: correct.includes(key),
      why: `Explanation for option ${key} of ${id}.`,
    };
  });

  return {
    id,
    domain,
    task,
    services: ['ec2'],
    difficulty: 'medium',
    type,
    stem: `Which solution meets the requirement described in question ${id}?`,
    options,
    references: ['https://docs.aws.amazon.com/ec2/'],
    status,
    provenance: provenanceFor(status),
  };
}

/**
 * Builds `counts[domain]` questions per domain, in domain order, spread over the tasks of the
 * domain. `each` can change the spec of any question (status, type, ...).
 */
export function makeBank(
  counts: Partial<Record<DomainId, number>>,
  each?: (domain: DomainId, index: number) => QuestionSpec,
): Question[] {
  const bank: Question[] = [];
  for (const domain of [1, 2, 3, 4] as const) {
    const domainTasks = tasksByDomain(domain);
    for (let index = 0; index < (counts[domain] ?? 0); index += 1) {
      const task = domainTasks[index % domainTasks.length]?.id ?? firstTask(domain);
      bank.push(makeQuestion({ domain, task, ...each?.(domain, index) }));
    }
  }
  return bank;
}

/** The original keys of the correct options. */
export function correctKeys(question: Question): string[] {
  return question.options.filter((option) => option.correct).map((option) => option.key);
}

/** The original keys of the options that are not correct. */
export function wrongKeys(question: Question): string[] {
  return question.options.filter((option) => !option.correct).map((option) => option.key);
}

/** Freezes `value` and everything reachable from it. Returns the same object. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
