// Fixtures for the review round 1 regression tests (spec 023, AC-33 to AC-41).
import { parse } from 'yaml';
import { draft, flagged, mutated, replaceOnce, verification } from './review-fixtures.ts';
import type { Draft, Item, Raw } from './review-fixtures.ts';

/** HTML that must be shown as text and never become elements. */
export const PAYLOAD = '<b>x</b><img src=x>';

export const JS_URL = 'javascript:alert(1)';

/** The same draft with a flow-style provenance (valid YAML, valid question). */
export function withFlowProvenance(d: Draft): Draft {
  const text = replaceOnce(
    d.text,
    'provenance:\n  generated_by: claude-sonnet # written by the generator\n',
    'provenance: { generated_by: claude-sonnet }\n',
  );
  return { ...d, text, question: parse(text) as Draft['question'] };
}

/** A `verified` item whose verifier is blank, so that approving would write a bad question. */
export function blankVerifier(d: Draft, verifier: string): Item {
  return { draft: d, sidecar: { verification: verification(d, { verifier }) } };
}

/** A draft and a flagged sidecar whose texts all carry the HTML payload. */
export function injected(id: string, slug: string): Item & { draft: Draft } {
  const base = draft({ id, slug });
  const text = mutated(base, (q) => {
    q['stem'] = `${PAYLOAD} ${base.stem}`;
    const options = q['options'] as Raw[];
    const first = options[0] as Raw;
    first['why'] = `${PAYLOAD} ${String(first['why'])}`;
  });
  const question = parse(text) as Draft['question'];
  const d: Draft = { ...base, text, question, stem: question.stem };
  return {
    draft: d,
    sidecar: {
      verification: flagged(d, 'mismatch', {
        quote: `Quote ${PAYLOAD}`,
        reasons: [`Reason ${PAYLOAD}`],
        source: JS_URL,
      }),
    },
  };
}

/** The sidecar text that is not valid YAML, and the first line of the parser's message. */
export const BROKEN_SIDECAR = 'verification: [unclosed\n';

export function parseErrorLine(text: string): string {
  try {
    parse(text);
  } catch (error) {
    return (error as Error).message.split('\n')[0] ?? '';
  }
  throw new Error('the text parses');
}
