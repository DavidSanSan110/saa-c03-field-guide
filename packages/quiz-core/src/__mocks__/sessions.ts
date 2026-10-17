// Exam and session fixtures for the progress, pool and saved-session tests (spec 018).
// Built on the question factory of `questions.ts`; no counter ids, so equal calls give equal data.
import { tasksByDomain } from '@field-guide/schema';
import type { DomainId, Question } from '@field-guide/schema';
import type { Exam } from '../build.ts';
import { sessionReducer } from '../session.ts';
import type { Session, SessionAction } from '../session.ts';
import { makeQuestion } from './questions.ts';
import type { QuestionSpec } from './questions.ts';

const DOMAIN_IDS = [1, 2, 3, 4] as const;
const SINGLE_KEYS = ['A', 'C', 'B', 'D'] as const;

/**
 * `count` questions in DESCENDING id order, so the item order of an exam built from them is the
 * reverse of the order of the ids (a "sorted by id" bug shows). Ids look like `d4-4.1-9000`:
 * the domain goes 4, 3, 2, 1 along the list and the number goes down, so ids are strictly
 * descending. Even indexes are `single` questions (4 options), odd ones `multiple` (5 options).
 * `each` can override the spec of any question.
 */
export function makeDescendingQuestions(
  count: number,
  each?: (index: number) => QuestionSpec,
): Question[] {
  return Array.from({ length: count }, (_, index) => {
    const domain = (4 - Math.floor((index * 4) / count)) as DomainId;
    const task = tasksByDomain(domain)[0]?.id;
    if (task === undefined) throw new Error(`fixture: domain ${String(domain)} has no task`);
    const id = `d${String(domain)}-${task}-${String(9000 - index)}`;
    const type = index % 2 === 0 ? 'single' : 'multiple';
    const correct =
      type === 'single'
        ? [SINGLE_KEYS[(index / 2) % 4] ?? 'A']
        : index % 4 === 1
          ? ['B', 'E']
          : ['A', 'D'];
    return makeQuestion({ id, domain, task, type, correct, ...each?.(index) });
  });
}

/**
 * An `Exam` built by hand from questions: a known layout, original option order unless
 * `optionOrders` gives the order of an item index. `meta` sets the seed and the requested size
 * (`size` defaults to the number of questions).
 */
export function makeExam(
  questions: readonly Question[],
  optionOrders: Readonly<Record<number, string[]>> = {},
  meta: { seed?: number; size?: number } = {},
): Exam {
  const size = meta.size ?? questions.length;
  const byDomain = {} as Exam['byDomain'];
  for (const domain of DOMAIN_IDS) {
    const count = questions.filter((question) => question.domain === domain).length;
    byDomain[domain] = { quota: count, available: count, picked: count, short: 0 };
  }
  return {
    seed: meta.seed ?? 1,
    size,
    items: questions.map((question, index) => ({
      question,
      optionOrder: optionOrders[index] ?? question.options.map((option) => option.key),
    })),
    complete: questions.length === size,
    byDomain,
  };
}

/** Applies the actions one after the other. */
export function playActions(session: Session, ...actions: SessionAction[]): Session {
  return actions.reduce((state, action) => sessionReducer(state, action), session);
}

/** Moves to item `index`, then sets its answer. The session ends up on that item. */
export function answerItem(
  session: Session,
  index: number,
  selected: readonly string[],
  now = 1_000,
): Session {
  return playActions(session, { type: 'goTo', index, now }, { type: 'answer', selected, now });
}
