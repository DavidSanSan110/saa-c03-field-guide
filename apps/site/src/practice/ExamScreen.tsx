// The exam screen: status strip, question with its options and the question navigator (spec 027).
import { remainingMs } from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useId, useRef, useState } from 'react';
import { formatClock, letterAt } from './format.ts';
import { ChevronDown, ChevronLeft, ChevronRight, ClockIcon, FlagIcon } from './Icons.tsx';

interface Props {
  session: Session;
  /** The current time in ms, refreshed every second by the app. */
  now: number;
  onAnswer: (selected: string[]) => void;
  onFlag: (flagged: boolean) => void;
  onGoTo: (index: number) => void;
  onEnd: () => void;
}

export function ExamScreen({ session, now, onAnswer, onFlag, onGoTo, onEnd }: Props) {
  const { exam, current } = session;
  const total = exam.items.length;
  const item = exam.items[current];
  const heading = useRef<HTMLHeadingElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const navId = useId();
  const stemId = useId();

  // Focus the "Question n of N" heading when the screen opens and after every move.
  useEffect(() => {
    heading.current?.focus();
  }, [current]);

  if (item === undefined) return null;
  const { question } = item;
  const need = question.options.filter((option) => option.correct).length;
  const selected = session.answers[question.id] ?? [];
  const answeredCount = Object.keys(session.answers).length;
  const flaggedCount = session.flagged.length;
  const isFlagged = session.flagged.includes(question.id);
  const multiple = question.type === 'multiple';

  function choose(key: string): void {
    if (!multiple) onAnswer([key]);
    else onAnswer(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  const summary = `${String(answeredCount)} answered · ${String(flaggedCount)} flagged`;

  return (
    <div className="pt-exam">
      <div className="pt-strip" role="group" aria-label="Exam status">
        <h2 className="pt-count" tabIndex={-1} ref={heading}>
          Question <strong>{current + 1}</strong> of {total}
        </h2>
        <p className="pt-timer">
          <ClockIcon />
          <span className="pt-sr">Time remaining:</span>
          <time className="pt-timer-value">{formatClock(remainingMs(session, now) ?? 0)}</time>
          <span className="pt-timer-label" aria-hidden="true">
            left
          </span>
        </p>
        <button
          type="button"
          className="pt-flag-btn"
          aria-pressed={isFlagged}
          aria-label="Flag for review"
          onClick={() => {
            onFlag(!isFlagged);
          }}
        >
          <FlagIcon size={16} />
          <span className="pt-flag-long" aria-hidden="true">
            Flag for review
          </span>
          <span className="pt-flag-short" aria-hidden="true">
            Flag
          </span>
        </button>
        <div className="pt-progress">
          <div
            className="pt-bar"
            role="progressbar"
            aria-label="Questions answered"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={answeredCount}
            aria-valuetext={`${String(answeredCount)} of ${String(total)} answered`}
          >
            <div className="pt-bar-fill" style={{ width: `${(answeredCount / total) * 100}%` }} />
          </div>
          <span className="pt-progress-label">
            {answeredCount} of {total} answered
          </span>
        </div>
      </div>

      <div className="pt-exam-body">
        <section className="pt-card pt-question" aria-labelledby={stemId}>
          <div className="pt-q-meta">
            <span className={multiple ? 'pt-chip pt-chip-accent' : 'pt-chip'}>
              {multiple ? `Choose ${String(need)}` : 'Single answer'}
            </span>
            {multiple && (
              <span className="pt-q-count" aria-live="polite">
                {selected.length} of {need} selected
              </span>
            )}
          </div>
          <p className="pt-stem" id={stemId}>
            {question.stem}
          </p>
          <fieldset className="pt-options" key={question.id}>
            <legend className="pt-sr">
              {multiple ? `Select ${String(need)} answers` : 'Select one answer'}
            </legend>
            {item.optionOrder.map((key, position) => {
              const option = question.options.find((candidate) => candidate.key === key);
              if (option === undefined) return null;
              const checked = selected.includes(key);
              return (
                <label
                  key={key}
                  className={multiple ? 'pt-opt is-multi' : 'pt-opt is-single'}
                  data-checked={checked}
                >
                  <input
                    className="pt-opt-input"
                    type={multiple ? 'checkbox' : 'radio'}
                    name={`q-${question.id}`}
                    value={key}
                    checked={checked}
                    onChange={() => {
                      choose(key);
                    }}
                  />
                  <span className="pt-opt-key">{letterAt(position)}</span>
                  <span className="pt-sr">: </span>
                  <span className="pt-opt-text">{option.text}</span>
                </label>
              );
            })}
          </fieldset>
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
            {current === total - 1 ? (
              <button type="button" className="pt-btn pt-btn-primary" onClick={onEnd}>
                Review answers
              </button>
            ) : (
              <button
                type="button"
                className="pt-btn pt-btn-primary"
                onClick={() => {
                  onGoTo(current + 1);
                }}
              >
                Next
                <ChevronRight />
              </button>
            )}
          </div>
        </section>

        <nav className="pt-card pt-nav" aria-label="Question navigator" data-open={navOpen}>
          <div className="pt-nav-head">
            <h3 className="pt-nav-title">Questions</h3>
            <p className="pt-nav-summary">{summary}</p>
          </div>
          <button
            type="button"
            className="pt-nav-toggle"
            aria-expanded={navOpen}
            aria-controls={navId}
            onClick={() => {
              setNavOpen((open) => !open);
            }}
          >
            <span>
              <strong>All questions</strong>
              <span className="pt-nav-toggle-sub">{summary}</span>
            </span>
            <ChevronDown />
          </button>
          <div className="pt-nav-body" id={navId}>
            <ol className="pt-grid">
              {exam.items.map((entry, index) => {
                const id = entry.question.id;
                const answered = Object.hasOwn(session.answers, id);
                const flagged = session.flagged.includes(id);
                const isCurrent = index === current;
                const name = [
                  `Question ${String(index + 1)}`,
                  answered ? 'answered' : 'not answered',
                  ...(flagged ? ['flagged'] : []),
                  ...(isCurrent ? ['current'] : []),
                ].join(', ');
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="pt-cell"
                      data-answered={answered}
                      data-flagged={flagged}
                      aria-current={isCurrent ? 'step' : undefined}
                      aria-label={name}
                      onClick={() => {
                        onGoTo(index);
                      }}
                    >
                      {index + 1}
                    </button>
                  </li>
                );
              })}
            </ol>
            <ul className="pt-legend" aria-label="Legend">
              <li>
                <span className="pt-cell pt-swatch" data-answered="true" aria-hidden="true" />
                Answered
              </li>
              <li>
                <span className="pt-cell pt-swatch" aria-hidden="true" />
                Not answered
              </li>
              <li>
                <span className="pt-cell pt-swatch" data-flagged="true" aria-hidden="true" />
                Flagged
              </li>
              <li>
                <span className="pt-cell pt-swatch" data-current="true" aria-hidden="true" />
                Current
              </li>
            </ul>
            <button type="button" className="pt-btn pt-btn-secondary pt-end" onClick={onEnd}>
              End exam
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}
