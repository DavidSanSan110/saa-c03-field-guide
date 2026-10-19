// The Practice card of the start screen: pick one part of the exam and a set size (spec 028).
import { practicePool } from '@field-guide/quiz-core';
import type { PoolFilter } from '@field-guide/quiz-core';
import type { DomainId, Progress, Question, TaskId } from '@field-guide/schema';
import { useEffect, useId, useMemo, useRef } from 'react';
import { SET_SIZES, poolLabel, practiceChoices, setSize } from './setup.ts';

export type PracticeBy = 'domain' | 'task' | 'service' | 'weak';

/** What the visitor picked. `task` and `service` are null until they pick: the first enabled one is used. */
export interface PracticeChoice {
  by: PracticeBy;
  domain: DomainId;
  task: TaskId | null;
  service: string | null;
  size: number | 'all';
}

export const INITIAL_CHOICE: PracticeChoice = {
  by: 'domain',
  domain: 1,
  task: null,
  service: null,
  size: SET_SIZES[0] ?? 10,
};

const BY_OPTIONS: { value: PracticeBy; label: string }[] = [
  { value: 'domain', label: 'Domain' },
  { value: 'task', label: 'Task' },
  { value: 'service', label: 'Service' },
  { value: 'weak', label: 'Weak spots' },
];

interface Props {
  bank: readonly Question[];
  progress: Progress;
  now: number;
  choice: PracticeChoice;
  onChoice: (choice: PracticeChoice) => void;
  /** Move keyboard focus to Start practice (after New practice set). */
  focusStart: boolean;
  onStart: (filter: PoolFilter, label: string, size: number) => void;
}

export function PracticeCard({
  bank,
  progress,
  now,
  choice,
  onChoice,
  focusStart,
  onStart,
}: Props) {
  const ids = { by: useId(), choice: useId(), size: useId() };
  const startButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const choices = useMemo(() => practiceChoices(bank, progress, now), [bank, progress, now]);

  const task = choice.task ?? choices.tasks.find(({ count }) => count > 0)?.id ?? null;
  const service = choice.service ?? choices.services[0]?.service ?? null;
  const filter: PoolFilter | null =
    choice.by === 'domain'
      ? { kind: 'domain', domain: choice.domain }
      : choice.by === 'task'
        ? task === null
          ? null
          : { kind: 'task', task }
        : choice.by === 'service'
          ? service === null
            ? null
            : { kind: 'service', service }
          : { kind: 'weak', now };
  const available = filter === null ? 0 : practicePool(bank, progress, filter).length;
  const count = setSize(choice.size, available);

  // After New practice set: Start practice, or the card title when nothing can be started.
  useEffect(() => {
    if (!focusStart) return;
    (startButton.current?.disabled === false ? startButton.current : heading.current)?.focus();
  }, [focusStart]);

  const { weak } = choices;
  const weakText =
    weak.due >= 1
      ? weak.due === 1
        ? '1 question is due for another try.'
        : `${String(weak.due)} questions are due for another try.`
      : weak.inBoxes === 0 || weak.nextDueAt === null
        ? 'No weak spots yet. Questions you miss come back here at once, then 1, 3, 7 and 14 days after each right answer.'
        : `Nothing is due now. The next question is due on ${new Date(weak.nextDueAt).toLocaleDateString()}.`;

  return (
    <section className="pt-card" aria-labelledby="pt-practice-title">
      <h2 className="pt-h2 pt-h2-tight" id="pt-practice-title" tabIndex={-1} ref={heading}>
        Practice
      </h2>
      <p className="pt-note pt-note-tight">
        Questions from one part of the exam, with the answer and the explanations after each one. No
        timer.
      </p>

      <fieldset className="pt-fieldset">
        <legend className="pt-label">Practice by</legend>
        <div className="pt-radios">
          {BY_OPTIONS.map(({ value, label }) => (
            <label key={value} className="pt-radio">
              <input
                type="radio"
                name={ids.by}
                value={value}
                checked={choice.by === value}
                onChange={() => {
                  onChoice({ ...choice, by: value });
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="pt-fields">
        {choice.by === 'domain' && (
          <div className="pt-field">
            <label className="pt-label" htmlFor={ids.choice}>
              Domain
            </label>
            <select
              id={ids.choice}
              className="pt-select"
              value={choice.domain}
              onChange={(event) => {
                onChoice({ ...choice, domain: Number(event.target.value) as DomainId });
              }}
            >
              {choices.domains.map((row) => (
                <option key={row.id} value={row.id}>
                  {`Domain ${String(row.id)}: ${row.title} (${String(row.count)})`}
                </option>
              ))}
            </select>
          </div>
        )}
        {choice.by === 'task' && (
          <div className="pt-field">
            <label className="pt-label" htmlFor={ids.choice}>
              Task
            </label>
            <select
              id={ids.choice}
              className="pt-select"
              value={task ?? ''}
              onChange={(event) => {
                onChoice({ ...choice, task: event.target.value as TaskId });
              }}
            >
              {choices.tasks.map((row) => (
                <option key={row.id} value={row.id} disabled={row.count === 0}>
                  {`${row.id} ${row.title} (${String(row.count)})`}
                </option>
              ))}
            </select>
          </div>
        )}
        {choice.by === 'service' && (
          <div className="pt-field">
            <label className="pt-label" htmlFor={ids.choice}>
              Service
            </label>
            <select
              id={ids.choice}
              className="pt-select"
              value={service ?? ''}
              onChange={(event) => {
                onChoice({ ...choice, service: event.target.value });
              }}
            >
              {choices.services.map((row) => (
                <option key={row.service} value={row.service}>
                  {`${row.service} (${String(row.count)})`}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="pt-field">
          <label className="pt-label" htmlFor={ids.size}>
            Number of questions
          </label>
          <select
            id={ids.size}
            className="pt-select"
            value={String(choice.size)}
            onChange={(event) => {
              const value = event.target.value;
              onChoice({ ...choice, size: value === 'all' ? 'all' : Number(value) });
            }}
          >
            {SET_SIZES.map((size) => (
              <option key={size} value={size}>
                {String(size)}
              </option>
            ))}
            <option value="all">{`All (${String(available)})`}</option>
          </select>
        </div>
      </div>

      {choice.by === 'weak' && <p className="pt-weak-text">{weakText}</p>}
      <p className="pt-set-line" aria-live="polite">
        {available === 0
          ? 'No questions match this choice yet.'
          : count === 1
            ? '1 question in this set.'
            : `${String(count)} questions in this set.`}
      </p>

      <div className="pt-actions">
        <button
          type="button"
          className="pt-btn pt-btn-primary"
          ref={startButton}
          disabled={available === 0 || filter === null}
          onClick={() => {
            // The weak-spots pool is built with the time of the click, not of the last render.
            if (filter === null) return;
            const at = filter.kind === 'weak' ? { ...filter, now: Date.now() } : filter;
            onStart(at, poolLabel(at), count);
          }}
        >
          Start practice
        </button>
      </div>
    </section>
  );
}
