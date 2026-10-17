// Save and restore an unfinished session (spec 018).
// The saved copy keeps the item list (ids and option order), not the questions: they are looked up
// again in the bank on restore.
import { SAVED_SESSION_VERSION, formatIssues, savedSessionSchema } from '@field-guide/schema';
import type { Question, SavedSession } from '@field-guide/schema';
import { assertUniqueIds, hasOtherVersion, perDomain } from './internal.ts';
import type { Session } from './session.ts';

/** Plain JSON data for a session in any state. The session is not changed. */
export function saveSession(session: Session): SavedSession {
  const { exam } = session;
  return {
    version: SAVED_SESSION_VERSION,
    mode: session.mode,
    startedAt: session.startedAt,
    deadline: session.deadline,
    current: session.current,
    exam: {
      seed: exam.seed,
      size: exam.size,
      complete: exam.complete,
      byDomain: perDomain((id) => ({ ...exam.byDomain[id] })),
      items: exam.items.map((item) => ({
        id: item.question.id,
        optionOrder: [...item.optionOrder],
      })),
    },
    answers: Object.fromEntries(
      Object.entries(session.answers).map(([id, keys]) => [id, [...keys]]),
    ),
    flagged: [...session.flagged],
    revealed: [...session.revealed],
    status: session.status,
    submittedAt: session.submittedAt,
    submitReason: session.submitReason,
  };
}

export type RestoreResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'version' | 'invalid' | 'missing' | 'changed'; errors: string[] };

interface Entry {
  question: Question;
  optionOrder: string[];
  selected: string[] | undefined;
}

/** What no longer fits in one item: its option order, or its stored answer. */
function problems({ question, optionOrder, selected }: Entry): string[] {
  const keys = question.options.map((option) => option.key);
  const errors: string[] = [];
  if (optionOrder.length !== keys.length || !keys.every((key) => optionOrder.includes(key))) {
    errors.push(`${question.id}: optionOrder does not match the options of the question`);
  }
  if (selected?.some((key) => !keys.includes(key)) === true) {
    errors.push(`${question.id}: the answer uses a key the question does not have`);
  } else if (question.type === 'single' && (selected?.length ?? 0) > 1) {
    errors.push(`${question.id}: a single-answer question has more than one key`);
  }
  return errors;
}

/**
 * Rebuilds a session from a saved copy and the current bank, without reading the clock. Never
 * throws for bad data. `missing`: an item is not a reviewed question of the bank; `changed`: the
 * question no longer fits the saved option order or answers.
 */
export function restoreSession(data: unknown, bank: readonly Question[]): RestoreResult {
  assertUniqueIds(bank);
  const parsed = savedSessionSchema.safeParse(data);
  if (!parsed.success) {
    const reason = hasOtherVersion(data, SAVED_SESSION_VERSION) ? 'version' : 'invalid';
    return { ok: false, reason, errors: formatIssues(parsed.error.issues) };
  }
  const saved = parsed.data;

  const reviewed = new Map(
    bank.filter((question) => question.status === 'reviewed').map((q) => [q.id, q]),
  );
  const missing = saved.exam.items.filter(({ id }) => !reviewed.has(id));
  if (missing.length > 0) {
    const errors = missing.map(({ id }) => `${id}: not a reviewed question of the bank`);
    return { ok: false, reason: 'missing', errors };
  }
  // Item ids match the id pattern, so a plain lookup in `answers` cannot hit the prototype.
  const entries = saved.exam.items.map(({ id, optionOrder }) => ({
    question: reviewed.get(id) as Question,
    optionOrder,
    selected: saved.answers[id],
  }));
  const errors = entries.flatMap(problems);
  if (errors.length > 0) return { ok: false, reason: 'changed', errors };

  const inItemOrder = (ids: readonly string[]) =>
    entries.map((entry) => entry.question.id).filter((id) => ids.includes(id));
  const answers = Object.fromEntries(
    entries.flatMap(({ question, selected }) =>
      selected === undefined
        ? []
        : [[question.id, question.options.map((o) => o.key).filter((k) => selected.includes(k))]],
    ),
  );

  return {
    ok: true,
    session: {
      mode: saved.mode,
      exam: {
        ...saved.exam,
        items: entries.map(({ question, optionOrder }) => ({ question, optionOrder })),
      },
      startedAt: saved.startedAt,
      deadline: saved.deadline,
      current: saved.current,
      answers,
      flagged: inItemOrder(saved.flagged),
      revealed: inItemOrder(saved.revealed),
      status: saved.status,
      submittedAt: saved.submittedAt,
      submitReason: saved.submitReason,
    },
  };
}
