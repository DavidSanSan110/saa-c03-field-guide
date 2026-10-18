// The results screen: estimated score, domains and the list of questions (spec 027).
import { PASS_MARK } from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from './format.ts';
import { CheckIcon, CrossIcon, FlagIcon } from './Icons.tsx';
import { resultsView } from './results.ts';
import type { ItemRow } from './results.ts';

type Filter = 'all' | 'incorrect' | 'flagged';

const STATUS_TEXT = { correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Not answered' };

function showRow(filter: Filter, row: ItemRow): boolean {
  if (filter === 'incorrect') return row.status !== 'correct';
  if (filter === 'flagged') return row.flagged;
  return true;
}

export function ResultsScreen({ session, onNew }: { session: Session; onNew: () => void }) {
  const view = useMemo(() => resultsView(session), [session]);
  const [filter, setFilter] = useState<Filter>('all');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const scorePos = ((view.estimated - 100) / 900) * 100;
  const passPos = ((PASS_MARK - 100) / 900) * 100;
  const filters: { value: Filter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: view.counts.all },
    { value: 'incorrect', label: 'Incorrect', count: view.counts.incorrect },
    { value: 'flagged', label: 'Flagged', count: view.counts.flagged },
  ];

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

      <section className="pt-card" aria-labelledby="pt-review-title">
        <div className="pt-review-head">
          <h2 className="pt-h2" id="pt-review-title">
            Questions
          </h2>
          <div className="pt-seg" role="group" aria-label="Show questions">
            {filters.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className="pt-seg-btn"
                aria-pressed={entry.value === filter}
                onClick={() => {
                  setFilter(entry.value);
                }}
              >
                {entry.label} {entry.count}
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
              </li>
            ))}
        </ol>
      </section>

      <div className="pt-actions">
        <button type="button" className="pt-btn pt-btn-primary" onClick={onNew}>
          Start a new exam
        </button>
      </div>
    </div>
  );
}
