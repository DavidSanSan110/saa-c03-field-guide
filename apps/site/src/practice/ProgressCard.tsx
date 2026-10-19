// The Progress card of the start screen: a summary and the way to the progress view (spec 028).
import { useEffect, useRef } from 'react';
import type { DashboardView } from './dashboard.ts';

interface Props {
  view: DashboardView;
  /** Move keyboard focus to View progress (after Back to the start). */
  focusButton: boolean;
  onOpen: () => void;
}

export function ProgressCard({ view, focusButton, onOpen }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusButton) button.current?.focus();
  }, [focusButton]);

  const { overall, attempts } = view;
  return (
    <section className="pt-card" aria-labelledby="pt-progress-card-title">
      <h2 className="pt-h2 pt-h2-tight" id="pt-progress-card-title">
        Your progress
      </h2>
      {attempts.total === 0 ? (
        <p className="pt-note pt-note-tight">
          No answers yet. Take a mock exam or a practice set and your progress shows here.
        </p>
      ) : (
        <>
          <p className="pt-note pt-note-tight">
            {`Seen ${String(overall.seen)} of ${String(overall.questions)} questions${
              overall.percent === null ? '' : ` · ${String(overall.percent)}% of answers correct`
            }`}
          </p>
          <div className="pt-actions pt-actions-top">
            <button type="button" className="pt-btn pt-btn-secondary" ref={button} onClick={onOpen}>
              View progress
            </button>
          </div>
        </>
      )}
    </section>
  );
}
