// The numbers of the question review screen and of the explanation block (spec 028).
import { feedback } from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import type { DomainId, Question, TaskId } from '@field-guide/schema';
import { letterAt } from './format.ts';
import type { ItemStatus } from './results.ts';

/** One option of a question, in the display order of the attempt. */
export interface ReviewOption {
  /** A, B, C… by display position. */
  letter: string;
  /** The key of the option in the bank. */
  key: string;
  text: string;
  why: string;
  correct: boolean;
  selected: boolean;
}

export interface QuestionReview {
  /** 1-based position in the attempt. */
  number: number;
  total: number;
  id: string;
  status: ItemStatus;
  domain: DomainId;
  task: TaskId;
  type: Question['type'];
  /** Number of correct options. */
  need: number;
  stem: string;
  options: ReviewOption[];
  cue: string | null;
  references: string[];
}

/**
 * What the review screen and the explanation block show for question `index` (0-based).
 * RangeError whenever `feedback(session, index)` is `null`: the key is not visible yet.
 */
export function questionReview(session: Session, index: number): QuestionReview {
  const result = feedback(session, index);
  const item = session.exam.items[index];
  if (result === null || item === undefined) {
    throw new RangeError(`the key of question ${String(index)} is not visible yet`);
  }
  const { question, optionOrder } = item;
  const selected =
    (Object.hasOwn(session.answers, question.id) && session.answers[question.id]) || [];
  return {
    number: index + 1,
    total: session.exam.items.length,
    id: question.id,
    status: selected.length === 0 ? 'unanswered' : result.correct ? 'correct' : 'incorrect',
    domain: question.domain,
    task: question.task,
    type: question.type,
    need: result.correctKeys.length,
    stem: question.stem,
    options: optionOrder.flatMap((key, position) => {
      const option = question.options.find((candidate) => candidate.key === key);
      return option === undefined
        ? []
        : [
            {
              letter: letterAt(position),
              key,
              text: option.text,
              why: option.why,
              correct: option.correct,
              selected: selected.includes(key),
            },
          ];
    }),
    cue: question.cue ?? null,
    references: question.references,
  };
}
