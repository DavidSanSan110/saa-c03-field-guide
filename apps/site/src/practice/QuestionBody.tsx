// The question itself, shared by the exam and the practice screens: type label, stem and options.
import type { ExamItem } from '@field-guide/quiz-core';
import { letterAt } from './format.ts';

interface Props {
  item: ExamItem;
  /** The id the card's `aria-labelledby` points at. */
  stemId: string;
  selected: readonly string[];
  /** Practice, after the reveal: the explanation block lists the options instead. */
  hideOptions?: boolean;
  onChoose: (selected: string[]) => void;
}

export function QuestionBody({ item, stemId, selected, hideOptions = false, onChoose }: Props) {
  const { question, optionOrder } = item;
  const need = question.options.filter((option) => option.correct).length;
  const multiple = question.type === 'multiple';

  function choose(key: string): void {
    if (!multiple) onChoose([key]);
    else onChoose(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  return (
    <>
      <div className="pt-q-meta">
        <span className={multiple ? 'pt-chip pt-chip-accent' : 'pt-chip'}>
          {multiple ? `Choose ${String(need)}` : 'Single answer'}
        </span>
        {multiple && !hideOptions && (
          <span className="pt-q-count" aria-live="polite">
            {selected.length} of {need} selected
          </span>
        )}
      </div>
      <p className="pt-stem" id={stemId}>
        {question.stem}
      </p>
      {!hideOptions && (
        <fieldset className="pt-options" key={question.id}>
          <legend className="pt-sr">
            {multiple ? `Select ${String(need)} answers` : 'Select one answer'}
          </legend>
          {optionOrder.map((key, position) => {
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
                  value={letterAt(position)}
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
      )}
    </>
  );
}
