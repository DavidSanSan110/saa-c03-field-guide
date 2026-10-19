// The explanation block of a question (practice screen after the reveal, review screen) and the
// report line (spec 028). Every link opens in a new tab and says so in its accessible name.
import type { Question } from '@field-guide/schema';
import type { ReactNode } from 'react';
import { CheckIcon } from './Icons.tsx';
import { guideLinks, reportUrl } from './links.ts';
import type { LinksIndex } from './links.ts';
import type { QuestionReview } from './review.ts';

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener">
      {children}
      <span className="pt-sr"> (opens in a new tab)</span>
    </a>
  );
}

/** "Question ID <id>" (once the key is shown) and the link to the pre-filled issue form. */
export function ReportLine({ id, showId = false }: { id: string; showId?: boolean }) {
  return (
    <p className="pt-report">
      {showId && (
        <span className="pt-report-id">
          Question ID <code>{id}</code>
        </span>
      )}
      <ExternalLink href={reportUrl(id)}>Report a problem with this question</ExternalLink>
    </p>
  );
}

interface Props {
  review: QuestionReview;
  question: Question;
  index: LinksIndex;
  /** `import.meta.env.BASE_URL` with a trailing slash. */
  base: string;
  /** The practice card ends with its own report line, so the block leaves it out there. */
  withReport?: boolean;
}

export function ExplanationBlock({ review, question, index, base, withReport = true }: Props) {
  const links = guideLinks(question, index, base);
  return (
    <div className="pt-explain">
      <ul className="pt-answers" aria-label="Answer options">
        {review.options.map((option) => (
          <li
            key={option.key}
            className="pt-answer"
            data-correct={option.correct}
            data-selected={option.selected}
          >
            <span className="pt-opt-key">{option.letter}</span>
            <div className="pt-answer-body">
              <p className="pt-answer-text">{option.text}</p>
              {(option.correct || option.selected) && (
                <p className="pt-tags">
                  {option.correct && (
                    <span className="pt-chip pt-chip-ok">
                      <CheckIcon size={12} />
                      Correct answer
                    </span>
                  )}
                  {option.selected && <span className="pt-chip pt-chip-accent">Your answer</span>}
                </p>
              )}
              <p className="pt-why">{option.why}</p>
            </div>
          </li>
        ))}
      </ul>

      {review.cue !== null && (
        <>
          <h3 className="pt-h3">Exam cue</h3>
          <p className="pt-cue">{review.cue}</p>
        </>
      )}

      <h3 className="pt-h3">AWS documentation</h3>
      <ul className="pt-links">
        {review.references.map((url) => (
          <li key={url}>
            <ExternalLink href={url}>{url}</ExternalLink>
          </li>
        ))}
      </ul>

      {links.length > 0 && (
        <>
          <h3 className="pt-h3">In this guide</h3>
          <ul className="pt-links">
            {links.map((link) => (
              <li key={link.kind}>
                <ExternalLink href={link.href}>{link.text}</ExternalLink>
              </li>
            ))}
          </ul>
        </>
      )}

      {withReport && <ReportLine id={review.id} showId />}
    </div>
  );
}
