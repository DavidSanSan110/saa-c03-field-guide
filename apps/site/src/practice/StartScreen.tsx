// The start screen of the practice test (spec 027).
import type { Exam } from '@field-guide/quiz-core';
import { PASS_MARK } from '@field-guide/quiz-core';
import { domains } from '@field-guide/schema';
import type { AttemptRecord } from '@field-guide/schema';
import { useEffect, useRef } from 'react';
import { formatClock } from './format.ts';
import { examDurationMs } from './plan.ts';

export interface SavedExamInfo {
  /** 1-based question the saved exam is on. */
  question: number;
  total: number;
  leftMs: number;
}

interface Props {
  /** The exam the bank allows (for its size and its plan), built with any seed. */
  plan: Exam;
  saved: SavedExamInfo | null;
  /** Why the saved exam was dropped; null when it was not. */
  restoreFailed: 'changed' | 'other' | null;
  /** Move keyboard focus to Start exam (after Discard or Start a new exam). */
  focusStart: boolean;
  lastAttempt: AttemptRecord | undefined;
  canSave: boolean;
  onStart: () => void;
  onResume: () => void;
  onDiscard: () => void;
}

export function StartScreen(props: Props) {
  const { plan, saved, restoreFailed, lastAttempt, canSave } = props;
  const size = plan.items.length;
  const startButton = useRef<HTMLButtonElement>(null);
  const canStart = saved === null;
  useEffect(() => {
    if (props.focusStart && canStart) startButton.current?.focus();
  }, [props.focusStart, canStart]);
  return (
    <div className="pt-start">
      <section className="pt-card" aria-labelledby="pt-start-title">
        <h2 className="pt-h2" id="pt-start-title">
          Mock exam
        </h2>
        <dl className="pt-facts">
          <div>
            <dt>Questions</dt>
            <dd>
              <strong>{size} questions</strong>
              <span>drawn by domain weight</span>
            </dd>
          </div>
          <div>
            <dt>Time limit</dt>
            <dd>
              <strong>{size > 0 ? formatClock(examDurationMs(size)) : '0:00:00'}</strong>
              <span>2 minutes per question</span>
            </dd>
          </div>
          <div>
            <dt>Pass mark</dt>
            <dd>
              <strong>{PASS_MARK}</strong>
              <span>on a scale of 100 to 1000</span>
            </dd>
          </div>
          <div>
            <dt>Weighting</dt>
            <dd>
              {domains.map(({ id, weight }) => (
                <span className="pt-weight" key={id}>
                  Domain {id} <strong>{weight}%</strong>
                </span>
              ))}
            </dd>
          </div>
        </dl>
        <p className="pt-note">
          The score is an estimate: the real exam uses scaled scoring and includes unscored
          questions.
        </p>

        {!plan.complete && (
          <div className="pt-notice" role="note">
            <p>
              This exam is shorter than the real one ({size} of 65 questions): the question bank
              doesn't have enough questions yet to fill every domain's share. Questions per domain:
            </p>
            <ul>
              {domains.map(({ id, title }) => (
                <li key={id}>
                  Domain {id}: {title}: {plan.byDomain[id].picked} of {plan.byDomain[id].quota}
                </li>
              ))}
            </ul>
          </div>
        )}

        {restoreFailed !== null && (
          <p className="pt-notice" role="status">
            {restoreFailed === 'changed'
              ? 'Your saved exam could not be restored because the questions changed.'
              : 'Your saved exam could not be restored.'}
          </p>
        )}
        {!canSave && <p className="pt-notice">Progress can't be saved in this browser.</p>}

        {saved !== null && (
          <div className="pt-resume">
            <p>
              Question {saved.question} of {saved.total} · {formatClock(saved.leftMs)} left
            </p>
            <div className="pt-actions">
              <button type="button" className="pt-btn pt-btn-primary" onClick={props.onResume}>
                Resume exam
              </button>
              <button type="button" className="pt-btn pt-btn-secondary" onClick={props.onDiscard}>
                Discard
              </button>
            </div>
          </div>
        )}

        {saved === null && (
          <div className="pt-actions">
            <button
              type="button"
              className="pt-btn pt-btn-primary"
              ref={startButton}
              disabled={size === 0}
              onClick={props.onStart}
            >
              Start exam
            </button>
          </div>
        )}

        {lastAttempt !== undefined && (
          <p className="pt-last">
            Last exam: {lastAttempt.estimated} (
            {lastAttempt.estimated >= PASS_MARK ? 'PASS' : 'FAIL'}) ·{' '}
            {new Date(lastAttempt.submittedAt).toLocaleDateString()}
          </p>
        )}
      </section>
    </div>
  );
}
