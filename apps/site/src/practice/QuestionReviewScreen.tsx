// The review of one question of the attempt just finished: status, options with their why and links (spec 028).
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useRef } from 'react';
import { ExplanationBlock } from './Explanation.tsx';
import { CheckIcon, ChevronLeft, ChevronRight, CrossIcon } from './Icons.tsx';
import type { LinksIndex } from './links.ts';
import { questionReview } from './review.ts';

interface Props {
  session: Session;
  /** The 0-based question reviewed. */
  index: number;
  links: LinksIndex;
  base: string;
  onMove: (index: number) => void;
  onBack: () => void;
}

const STATUS_TEXT = { correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Not answered' };

export function QuestionReviewScreen({ session, index, links, base, onMove, onBack }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [index]);

  const item = session.exam.items[index];
  if (item === undefined) return null;
  const review = questionReview(session, index);
  const multiple = review.type === 'multiple';

  return (
    <section className="pt-card pt-qreview" aria-labelledby="pt-qreview-title">
      <h2 className="pt-h2 pt-h2-tight" id="pt-qreview-title" tabIndex={-1} ref={heading}>
        Question {review.number} of {review.total}
      </h2>
      <p className="pt-qreview-status">
        <span className={review.status === 'correct' ? 'pt-ok-text' : 'pt-bad-text'}>
          {review.status === 'correct' ? <CheckIcon size={14} /> : <CrossIcon size={14} />}
          {STATUS_TEXT[review.status]}
        </span>{' '}
        <span className="pt-review-domain">
          Domain {review.domain} · Task {review.task}
        </span>
      </p>
      <p className="pt-q-meta">
        <span className={multiple ? 'pt-chip pt-chip-accent' : 'pt-chip'}>
          {multiple ? `Choose ${String(review.need)}` : 'Single answer'}
        </span>
      </p>
      <p className="pt-stem">{review.stem}</p>

      <ExplanationBlock review={review} question={item.question} index={links} base={base} />

      <div className="pt-q-nav">
        <button
          type="button"
          className="pt-btn pt-btn-secondary"
          disabled={index === 0}
          onClick={() => {
            onMove(index - 1);
          }}
        >
          <ChevronLeft />
          Previous question
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-secondary"
          disabled={index === review.total - 1}
          onClick={() => {
            onMove(index + 1);
          }}
        >
          Next question
          <ChevronRight />
        </button>
      </div>
      <div className="pt-q-end">
        <button type="button" className="pt-btn pt-btn-primary" onClick={onBack}>
          Back to results
        </button>
      </div>
    </section>
  );
}
