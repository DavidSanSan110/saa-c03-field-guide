// A practice question: the answer and the explanation are shown after "Check answer" (spec 028).
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useId, useRef } from 'react';
import { ExplanationBlock, ReportLine } from './Explanation.tsx';
import { ChevronLeft, ChevronRight } from './Icons.tsx';
import type { LinksIndex } from './links.ts';
import { QuestionBody } from './QuestionBody.tsx';
import { questionReview } from './review.ts';

interface Props {
  session: Session;
  /** The pool label, e.g. "Domain 2: Design Resilient Architectures". */
  label: string;
  links: LinksIndex;
  base: string;
  onAnswer: (selected: string[]) => void;
  onReveal: () => void;
  onGoTo: (index: number) => void;
  /** Finish practice and End practice. */
  onEnd: () => void;
}

const FEEDBACK = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  unanswered: 'Not answered: this counts as a miss.',
};

export function PracticeScreen({
  session,
  label,
  links,
  base,
  onAnswer,
  onReveal,
  onGoTo,
  onEnd,
}: Props) {
  const { exam, current } = session;
  const total = exam.items.length;
  const item = exam.items[current];
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLHeadingElement>(null);
  const focusFeedback = useRef(false);
  const stemId = useId();
  const id = item?.question.id ?? '';
  const revealed = session.revealed.includes(id);

  // The "Question n of N" heading takes focus when the screen opens and after every move; the
  // feedback heading takes it after a reveal.
  useEffect(() => {
    heading.current?.focus();
  }, [current]);
  useEffect(() => {
    if (revealed && focusFeedback.current) feedback.current?.focus();
    focusFeedback.current = false;
  }, [revealed]);

  if (item === undefined) return null;
  const { question } = item;
  const selected = session.answers[question.id] ?? [];
  const review = revealed ? questionReview(session, current) : null;

  function reveal(): void {
    focusFeedback.current = true;
    onReveal();
  }

  return (
    <div className="pt-exam">
      <div className="pt-strip pt-strip-practice" role="group" aria-label="Practice status">
        <h2 className="pt-count" tabIndex={-1} ref={heading}>
          Question <strong>{current + 1}</strong> of {total}
        </h2>
        <p className="pt-checked">
          {session.revealed.length} of {total} checked
        </p>
        <p className="pt-pool">
          <span className="pt-chip pt-chip-accent">Practice · {label}</span>
        </p>
      </div>

      <div className="pt-exam-body pt-exam-body-single">
        <section className="pt-card pt-question" aria-labelledby={stemId}>
          <QuestionBody
            item={item}
            stemId={stemId}
            selected={selected}
            hideOptions={revealed}
            onChoose={onAnswer}
          />

          {review !== null && (
            <div className="pt-feedback" data-status={review.status}>
              <h3 className="pt-feedback-title" tabIndex={-1} ref={feedback}>
                {FEEDBACK[review.status]}
              </h3>
              <ExplanationBlock
                review={review}
                question={question}
                index={links}
                base={base}
                withReport={false}
              />
            </div>
          )}

          <div className="pt-q-nav">
            <button
              type="button"
              className="pt-btn pt-btn-secondary"
              disabled={current === 0}
              onClick={() => {
                onGoTo(current - 1);
              }}
            >
              <ChevronLeft />
              Previous
            </button>
            <div className="pt-q-nav-end">
              {!revealed && (
                <button
                  type="button"
                  className={
                    selected.length > 0 ? 'pt-btn pt-btn-primary' : 'pt-btn pt-btn-secondary'
                  }
                  onClick={reveal}
                >
                  {selected.length > 0 ? 'Check answer' : 'Show answer'}
                </button>
              )}
              {current === total - 1 ? (
                <button
                  type="button"
                  className={revealed ? 'pt-btn pt-btn-primary' : 'pt-btn pt-btn-secondary'}
                  onClick={onEnd}
                >
                  Finish practice
                </button>
              ) : (
                <button
                  type="button"
                  className={revealed ? 'pt-btn pt-btn-primary' : 'pt-btn pt-btn-secondary'}
                  onClick={() => {
                    onGoTo(current + 1);
                  }}
                >
                  Next
                  <ChevronRight />
                </button>
              )}
            </div>
          </div>
          <div className="pt-q-end">
            <button type="button" className="pt-btn pt-btn-secondary" onClick={onEnd}>
              End practice
            </button>
          </div>
          <ReportLine id={question.id} showId={revealed} />
        </section>
      </div>
    </div>
  );
}
