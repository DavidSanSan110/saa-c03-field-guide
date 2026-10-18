// The review list: every question with its state, and the Submit button with its confirmation (spec 027).
import { remainingMs } from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useRef, useState } from 'react';
import { formatClock } from './format.ts';
import { FlagIcon } from './Icons.tsx';

interface Props {
  session: Session;
  now: number;
  onGoTo: (index: number) => void;
  onBack: () => void;
  onSubmit: () => void;
}

function ConfirmDialog(props: {
  unanswered: number;
  flagged: number;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="pt-dialog"
      role="alertdialog"
      aria-labelledby="pt-confirm-title"
      aria-describedby="pt-confirm-text"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
    >
      <h2 className="pt-h2" id="pt-confirm-title">
        Submit the exam?
      </h2>
      <p id="pt-confirm-text">
        You have {props.unanswered} unanswered and {props.flagged} flagged questions. Submit anyway?
      </p>
      <div className="pt-actions">
        <button type="button" className="pt-btn pt-btn-secondary" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="pt-btn pt-btn-primary" onClick={props.onSubmit}>
          Submit
        </button>
      </div>
    </dialog>
  );
}

export function ReviewScreen({ session, now, onGoTo, onBack, onSubmit }: Props) {
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const total = session.exam.items.length;
  const flagged = session.flagged.length;
  const unanswered = total - Object.keys(session.answers).length;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  function submit(): void {
    if (unanswered > 0 || flagged > 0) setConfirming(true);
    else onSubmit();
  }

  return (
    <section className="pt-card pt-review-screen" aria-labelledby="pt-review-heading">
      <div className="pt-review-top">
        <h2 className="pt-h2" id="pt-review-heading" tabIndex={-1} ref={heading}>
          Review your answers
        </h2>
        <p className="pt-timer">
          <span className="pt-sr">Time remaining:</span>
          <time className="pt-timer-value">{formatClock(remainingMs(session, now) ?? 0)}</time>
          <span className="pt-timer-label" aria-hidden="true">
            left
          </span>
        </p>
      </div>
      <p className="pt-review-counts">
        <span>
          <strong>{unanswered}</strong> unanswered
        </span>
        <span>
          <strong>{flagged}</strong> flagged
        </span>
      </p>
      <ol className="pt-review-list">
        {session.exam.items.map(({ question }, index) => {
          const answered = Object.hasOwn(session.answers, question.id);
          const isFlagged = session.flagged.includes(question.id);
          const name = [
            `Question ${String(index + 1)}`,
            answered ? 'answered' : 'not answered',
            ...(isFlagged ? ['flagged'] : []),
          ].join(', ');
          return (
            <li key={question.id}>
              <button
                type="button"
                className="pt-review-item"
                data-answered={answered}
                aria-label={name}
                onClick={() => {
                  onGoTo(index);
                }}
              >
                <span className="pt-review-num">{index + 1}</span>
                <span className="pt-review-stem-line">{question.stem}</span>
                <span className="pt-review-state">
                  <span className={answered ? 'pt-chip pt-chip-accent' : 'pt-chip'}>
                    {answered ? 'Answered' : 'Not answered'}
                  </span>
                  {isFlagged && (
                    <span className="pt-chip pt-chip-warn">
                      <FlagIcon size={12} />
                      Flagged
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="pt-actions">
        <button type="button" className="pt-btn pt-btn-primary" ref={submitButton} onClick={submit}>
          Submit exam
        </button>
        <button type="button" className="pt-btn pt-btn-secondary" onClick={onBack}>
          Back to the exam
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          unanswered={unanswered}
          flagged={flagged}
          onCancel={() => {
            setConfirming(false);
            submitButton.current?.focus();
          }}
          onSubmit={onSubmit}
        />
      )}
    </section>
  );
}
