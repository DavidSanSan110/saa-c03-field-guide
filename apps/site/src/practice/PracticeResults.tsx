// The results of a practice set: what was right, the list of questions and a way to start another (spec 028).
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useMemo, useRef } from 'react';
import { QuestionsCard } from './QuestionsCard.tsx';
import type { Filter } from './QuestionsCard.tsx';
import { resultsView } from './results.ts';

const FILTERS: readonly Filter[] = ['all', 'incorrect'];

interface Props {
  session: Session;
  /** The label of the pool, e.g. "Domain 2: Design Resilient Architectures". */
  label: string;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onReview: (index: number) => void;
  /** Coming back from a review of this 0-based question; null for a fresh result. */
  returnTo: number | null;
  onNew: () => void;
}

export function PracticeResults({
  session,
  label,
  filter,
  onFilter,
  onReview,
  returnTo,
  onNew,
}: Props) {
  const view = useMemo(() => resultsView(session), [session]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (returnTo === null) heading.current?.focus();
  }, [returnTo]);

  return (
    <div className="pt-results">
      <section className="pt-card" aria-labelledby="pt-practice-results">
        <h2 className="pt-h2 pt-h2-tight" id="pt-practice-results" tabIndex={-1} ref={heading}>
          Practice results
        </h2>
        <p className="pt-pool-line">{label}</p>
        <dl className="pt-stats pt-stats-two">
          <div>
            <dt>Correct</dt>
            <dd>
              <strong>{view.percent}%</strong>
              <span>
                {view.correct} of {view.total}
              </span>
            </dd>
          </div>
          <div>
            <dt>Not answered</dt>
            <dd>
              <strong>{view.unanswered}</strong>
              <span>questions</span>
            </dd>
          </div>
        </dl>
        <p className="pt-footnote">Missed questions come back in Weak spots.</p>
      </section>

      <QuestionsCard
        view={view}
        filters={FILTERS}
        filter={filter}
        onFilter={onFilter}
        onReview={onReview}
        returnTo={returnTo}
      />

      <div className="pt-actions">
        <button type="button" className="pt-btn pt-btn-primary" onClick={onNew}>
          New practice set
        </button>
      </div>
    </div>
  );
}
