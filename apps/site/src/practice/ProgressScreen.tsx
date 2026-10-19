// The progress view: attempts over time and accuracy per domain and task, from this browser's history (spec 028).
import { PASS_MARK } from '@field-guide/quiz-core';
import { useEffect, useRef } from 'react';
import type { DashboardView } from './dashboard.ts';

const BOXES = [
  { box: 1, label: 'due at once' },
  { box: 2, label: '1 day' },
  { box: 3, label: '3 days' },
  { box: 4, label: '7 days' },
  { box: 5, label: '14 days' },
] as const;

const date = (ms: number): string => new Date(ms).toLocaleDateString();
const percentText = (percent: number | null): string =>
  percent === null ? '—' : `${String(percent)}%`;

/** Scores 100 to 1000 on a small inline chart; one mark per mock exam, oldest left. */
function ScoreChart({ scores }: { scores: DashboardView['examScores'] }) {
  const width = 360;
  const height = 180;
  const left = 36;
  const right = 12;
  const top = 12;
  const bottom = 12;
  const y = (score: number): number => top + ((1000 - score) / 900) * (height - top - bottom);
  const x = (index: number): number =>
    scores.length === 1
      ? (left + width - right) / 2
      : left + (index / (scores.length - 1)) * (width - left - right);
  const points = scores.map(
    ({ estimated }, index) => `${String(x(index))},${String(y(estimated))}`,
  );
  return (
    <svg className="pt-chart" viewBox={`0 0 ${String(width)} ${String(height)}`} aria-hidden="true">
      {[100, 1000].map((tick) => (
        <g key={tick}>
          <line className="pt-chart-grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
          <text className="pt-chart-label" x={left - 6} y={y(tick)} textAnchor="end" dy="0.35em">
            {tick}
          </text>
        </g>
      ))}
      <line
        className="pt-chart-pass"
        x1={left}
        x2={width - right}
        y1={y(PASS_MARK)}
        y2={y(PASS_MARK)}
      />
      <text className="pt-chart-label" x={left - 6} y={y(PASS_MARK)} textAnchor="end" dy="0.35em">
        {PASS_MARK}
      </text>
      {scores.length > 1 && <polyline className="pt-chart-line" points={points.join(' ')} />}
      {scores.map(({ submittedAt, estimated }, index) => (
        <circle
          key={`${String(submittedAt)}-${String(index)}`}
          className="pt-chart-mark"
          data-score={estimated}
          cx={x(index)}
          cy={y(estimated)}
          r="4"
        />
      ))}
    </svg>
  );
}

export function ProgressScreen({ view, onBack }: { view: DashboardView; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const { overall, attempts, leitner } = view;

  return (
    <div className="pt-results">
      <section className="pt-card" aria-labelledby="pt-progress-title">
        <h2 className="pt-h2 pt-h2-tight" id="pt-progress-title" tabIndex={-1} ref={heading}>
          Your progress
        </h2>
        <p className="pt-note pt-note-tight">Progress is kept in this browser only.</p>
        <dl className="pt-stats pt-overview">
          <div>
            <dt>Questions seen</dt>
            <dd>
              <strong>
                {overall.seen} of {overall.questions}
              </strong>
            </dd>
          </div>
          <div>
            <dt>Correct answers</dt>
            <dd>
              {overall.percent === null ? (
                <strong>—</strong>
              ) : (
                <>
                  <strong>{overall.percent}%</strong>
                  <span>
                    {overall.correct} of {overall.answered}
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Due for another try</dt>
            <dd>
              <strong>{overall.due}</strong>
              <span>questions</span>
            </dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>
              <strong>{attempts.total}</strong>
              <span>
                {attempts.exam} mock exams · {attempts.practice} practice sets
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="pt-card" aria-labelledby="pt-scores-title">
        <h3 className="pt-h2" id="pt-scores-title">
          Mock exam scores
        </h3>
        {view.examScores.length === 0 ? (
          <p className="pt-note pt-note-tight">No mock exams yet.</p>
        ) : (
          <ScoreChart scores={view.examScores} />
        )}
      </section>

      <section className="pt-card" aria-labelledby="pt-recent-title">
        <h3 className="pt-h2" id="pt-recent-title">
          Recent attempts
        </h3>
        <table className="pt-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Mode</th>
              <th scope="col">Correct</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {view.recent.map((row, index) => (
              <tr key={`${String(row.submittedAt)}-${String(index)}`}>
                <td>{date(row.submittedAt)}</td>
                <td>{row.mode === 'exam' ? 'Mock exam' : 'Practice'}</td>
                <td>
                  {row.correct} of {row.total}
                </td>
                <td>
                  {row.estimated === null
                    ? '—'
                    : `${String(row.estimated)} (${row.passed === true ? 'PASS' : 'FAIL'})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="pt-card" aria-labelledby="pt-bydomain-title">
        <h3 className="pt-h2" id="pt-bydomain-title">
          By domain
        </h3>
        <ul className="pt-domains">
          {view.domains.map((row) => (
            <li key={row.id} className="pt-domain" data-weak={row.needsWork}>
              <div className="pt-domain-head">
                <p className="pt-domain-name">
                  <span className="pt-domain-num">Domain {row.id}</span>
                  {row.title}
                </p>
                <p className="pt-domain-pct">{percentText(row.percent)}</p>
              </div>
              <div className="pt-bar pt-domain-bar" aria-hidden="true">
                <div
                  className="pt-bar-fill"
                  style={{ width: `${String((row.raw ?? 0) * 100)}%` }}
                />
              </div>
              <p className="pt-domain-sub">
                <span>
                  {`${String(row.seen)} of ${String(row.questions)} questions seen · ${String(row.weak)} in weak spots`}
                </span>
                {row.needsWork && <span className="pt-chip pt-chip-warn">Needs work</span>}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="pt-card" aria-labelledby="pt-bytask-title">
        <h3 className="pt-h2" id="pt-bytask-title">
          By task
        </h3>
        <table className="pt-table">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Seen</th>
              <th scope="col">Correct</th>
              <th scope="col">In weak spots</th>
            </tr>
          </thead>
          <tbody>
            {view.tasks.map((row) => (
              <tr key={row.id}>
                <th scope="row">{`${row.id} ${row.title}`}</th>
                <td>{`${String(row.seen)} of ${String(row.questions)}`}</td>
                <td>{percentText(row.percent)}</td>
                <td>{row.weak}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="pt-card" aria-labelledby="pt-weak-title">
        <h3 className="pt-h2" id="pt-weak-title">
          Weak spots
        </h3>
        <ul className="pt-boxes">
          {BOXES.map(({ box, label }) => (
            <li key={box}>
              {`Box ${String(box)} (${label}): `}
              <strong>{leitner.boxes[box]}</strong>
            </li>
          ))}
        </ul>
        <p className="pt-weak-line">{`${String(leitner.due)} due now.`}</p>
        {leitner.nextDueAt !== null && (
          <p className="pt-weak-line">{`Next due: ${date(leitner.nextDueAt)}.`}</p>
        )}
        <p className="pt-note pt-note-tight">
          Questions you miss go to box 1. Each right answer moves a question up one box and waits
          longer; a right answer in box 5 takes it out.
        </p>
      </section>

      <div className="pt-actions">
        <button type="button" className="pt-btn pt-btn-primary" onClick={onBack}>
          Back to the start
        </button>
      </div>
    </div>
  );
}
