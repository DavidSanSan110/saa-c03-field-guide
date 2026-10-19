// The numbers of the question review screen and of the explanation block (spec 028). Stub.
import type { Session } from '@field-guide/quiz-core';
import type { DomainId, Question, TaskId } from '@field-guide/schema';
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
export const questionReview: (session: Session, index: number) => QuestionReview = () => {
  throw new Error('not implemented');
};
