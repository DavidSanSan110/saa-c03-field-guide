// The results screen: estimated score, domains and the list of questions (spec 027).
import { PASS_MARK } from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useMemo, useRef } from 'react';
import { formatClock } from './format.ts';
import { CheckIcon, CrossIcon } from './Icons.tsx';
import { QuestionsCard } from './QuestionsCard.tsx';
import type { Filter } from './QuestionsCard.tsx';
import { resultsView } from './results.ts';

const FILTERS: readonly Filter[] = ['all', 'incorrect', 'flagged'];

interface Props {
  session: Session;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onReview: (index: number) => void;
  /** Coming back from a review of this 0-based question; null for a fresh result. */
  returnTo: number | null;
  onNew: () => void;
}

export function ResultsScreen({ session, filter, onFilter, onReview, returnTo, onNew }: Props) {
  const view = useMemo(() => resultsView(session), [session]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (returnTo === null) heading.current?.focus();
  }, [returnTo]);

  const scorePos = ((view.estimated - 100) / 900) * 100;
  const passPos = ((PASS_MARK - 100) / 900) * 100;

  return (
    <div className="pt-results">
      <h2 className="pt-sr" tabIndex={-1} ref={heading}>
        Exam results
      </h2>
      {view.timedOut && (
        <p className="pt-notice" role="status">
          Time is up: the exam was submitted automatically.
        </p>
      )}
      <section className="pt-card pt-score" aria-labelledby="pt-score-label">
        <div className="pt-score-main">
          <p className="pt-eyebrow" id="pt-score-label">
            Estimated score
          </p>
          <p className="pt-score-value">
            <span className="pt-score-num">{view.estimated}</span>
            <span className="pt-score-max">/ 1000</span>
          </p>
          <p className={view.passed ? 'pt-verdict is-pass' : 'pt-verdict is-fail'}>
            {view.passed ? <CheckIcon size={16} /> : <CrossIcon size={16} />}
            {view.passed ? 'PASS' : 'FAIL'}
            <span className="pt-verdict-note">pass mark {PASS_MARK}</span>
          </p>
        </div>

        <div className="pt-scale" aria-hidden="true">
          <div className="pt-scale-track">
            <div className="pt-scale-fill" style={{ width: `${scorePos}%` }} />
            <div className="pt-scale-pass" style={{ left: `${passPos}%` }} />
          </div>
          <div className="pt-scale-labels">
            <span>100</span>
            <span className="pt-scale-pass-label" style={{ left: `${passPos}%` }}>
              720 to pass
            </span>
            <span>1000</span>
          </div>
        </div>

        <dl className="pt-stats">
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
            <dt>Time used</dt>
            <dd>
              <strong>{formatClock(view.timeUsedMs)}</strong>
              <span>of {formatClock(view.timeLimitMs)}</span>
            </dd>
          </div>
          <div>
            <dt>Flagged</dt>
            <dd>
              <strong>{view.flagged}</strong>
              <span>questions</span>
            </dd>
          </div>
          <div>
            <dt>Unanswered</dt>
            <dd>
              <strong>{view.unanswered}</strong>
              <span>questions</span>
            </dd>
          </div>
        </dl>
        <p className="pt-footnote">
          An estimate, not an official result: the real exam uses scaled scoring and includes
          unscored questions.
        </p>
      </section>

      <section className="pt-card" aria-labelledby="pt-domains-title">
        <h2 className="pt-h2" id="pt-domains-title">
          By domain
        </h2>
        <ul className="pt-domains">
          {view.domains.map((row) => {
            const percent = row.raw === null ? null : Math.round(row.raw * 100);
            return (
              <li key={row.id} className="pt-domain" data-weak={row.needsWork}>
                <div className="pt-domain-head">
                  <p className="pt-domain-name">
                    <span className="pt-domain-num">Domain {row.id}</span>
                    {row.title}
                  </p>
                  <p className="pt-domain-pct">{percent === null ? '—' : `${String(percent)}%`}</p>
                </div>
                <div className="pt-bar pt-domain-bar" aria-hidden="true">
                  <div
                    className="pt-bar-fill"
                    style={{ width: `${String((row.raw ?? 0) * 100)}%` }}
                  />
                </div>
                <p className="pt-domain-sub">
                  <span>
                    {row.weight}% of the exam · {row.correct} of {row.total} correct
                  </span>
                  {row.needsWork && <span className="pt-chip pt-chip-warn">Needs work</span>}
                </p>
              </li>
            );
          })}
        </ul>
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
          Start a new exam
        </button>
      </div>
    </div>
  );
}
