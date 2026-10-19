// The "Questions" list of the exam and practice results: filter, one row per question, Review button.
import { useEffect, useRef } from 'react';
import { CheckIcon, CrossIcon, FlagIcon } from './Icons.tsx';
import type { ItemRow, ResultsView } from './results.ts';

export type Filter = 'all' | 'incorrect' | 'flagged';

const STATUS_TEXT = { correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Not answered' };

function showRow(filter: Filter, row: ItemRow): boolean {
  if (filter === 'incorrect') return row.status !== 'correct';
  if (filter === 'flagged') return row.flagged;
  return true;
}

interface Props {
  view: ResultsView;
  /** The filters offered, in order (practice sets have no flags). */
  filters: readonly Filter[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onReview: (index: number) => void;
  /** Coming back from a review: the 0-based question to give focus to, or null. */
  returnTo: number | null;
}

export function QuestionsCard({ view, filters, filter, onFilter, onReview, returnTo }: Props) {
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Back from a review: the Review button of that question, or the heading when the filter hides it.
  useEffect(() => {
    if (returnTo === null) return;
    const button = card.current?.querySelector<HTMLElement>(`[data-review="${String(returnTo)}"]`);
    (button ?? heading.current)?.focus();
  }, [returnTo]);

  const counts = {
    all: view.counts.all,
    incorrect: view.counts.incorrect,
    flagged: view.counts.flagged,
  };
  const labels = { all: 'All', incorrect: 'Incorrect', flagged: 'Flagged' };

  return (
    <section className="pt-card" aria-labelledby="pt-review-title" ref={card}>
      <div className="pt-review-head">
        <h2 className="pt-h2" id="pt-review-title" tabIndex={-1} ref={heading}>
          Questions
        </h2>
        <div className="pt-seg" role="group" aria-label="Show questions">
          {filters.map((value) => (
            <button
              key={value}
              type="button"
              className="pt-seg-btn"
              aria-pressed={value === filter}
              onClick={() => {
                onFilter(value);
              }}
            >
              {labels[value]} {counts[value]}
            </button>
          ))}
        </div>
      </div>
      <ol className="pt-review">
        {view.items
          .filter((row) => showRow(filter, row))
          .map((row) => (
            <li key={row.id} className="pt-review-row" data-status={row.status}>
              <span className="pt-review-mark" aria-hidden="true">
                {row.status === 'correct' ? <CheckIcon size={16} /> : <CrossIcon size={16} />}
              </span>
              <div className="pt-review-main">
                <p className="pt-review-title">
                  <strong>Question {row.number}</strong>{' '}
                  <span className={row.status === 'correct' ? 'pt-ok-text' : 'pt-bad-text'}>
                    {STATUS_TEXT[row.status]}
                  </span>
                  <span className="pt-review-domain">
                    Domain {row.domain} · Task {row.task}
                  </span>
                  {row.flagged && (
                    <span className="pt-review-flag">
                      <FlagIcon size={13} />
                      Flagged
                    </span>
                  )}
                </p>
                <p className="pt-review-stem">{row.stem}</p>
                <p className="pt-review-answer">
                  Your answer{' '}
                  <strong>
                    {row.yourLetters.length > 0 ? row.yourLetters.join(', ') : 'none'}
                  </strong>
                  {row.status !== 'correct' && (
                    <>
                      {' '}
                      · Correct <strong>{row.correctLetters.join(', ')}</strong>
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                className="pt-btn pt-btn-secondary pt-review-btn"
                aria-label={`Review question ${String(row.number)}`}
                data-review={row.number - 1}
                onClick={() => {
                  onReview(row.number - 1);
                }}
              >
                Review
              </button>
            </li>
          ))}
      </ol>
    </section>
  );
}
