// The practice-test island at /practice/: start screen, exam, review list and results (spec 027).
// The rules (building, grading, scoring, the deadline) live in quiz-core; this file wires them to the screens.
import {
  buildExam,
  emptyProgress,
  recordSession,
  sessionReducer,
  startSession,
} from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import type { Progress, Question } from '@field-guide/schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './practice.css';
import { ExamScreen } from './ExamScreen.tsx';
import { examDurationMs } from './plan.ts';
import { ResultsScreen } from './ResultsScreen.tsx';
import { ReviewScreen } from './ReviewScreen.tsx';
import { StartScreen } from './StartScreen.tsx';
import { createPracticeStorage } from './storage.ts';
import type { PracticeStorage, RestoreFailure } from './storage.ts';

interface Ready {
  state: 'ready';
  bank: Question[];
  storage: PracticeStorage;
  /** The saved exam waiting to be resumed. */
  saved: Session | null;
  restoreFailed: RestoreFailure | null;
}
type Loaded = { state: 'loading' } | { state: 'error' } | Ready;

/** What the screens can ask for; the app adds the clock reading. */
type Act =
  | { type: 'answer'; selected: readonly string[] }
  | { type: 'flag'; flagged: boolean }
  | { type: 'goTo'; index: number }
  | { type: 'submit' };

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

async function fetchBank(): Promise<Question[]> {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const response = await fetch(`${base}practice/bank.json`);
  if (!response.ok) throw new Error(`bank.json answered ${String(response.status)}`);
  const body = (await response.json()) as { questions?: Question[] };
  if (!Array.isArray(body.questions)) throw new Error('bank.json has no questions');
  return body.questions;
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** Marks the screen on <html> so the page CSS can hide the page title during the exam. */
function useScreenAttribute(screen: string): void {
  useEffect(() => {
    const root = document.documentElement;
    if (screen === 'exam' || screen === 'review') root.dataset['practiceScreen'] = screen;
    else delete root.dataset['practiceScreen'];
    return () => {
      delete root.dataset['practiceScreen'];
    };
  }, [screen]);
}

export default function PracticeApp() {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [session, setSession] = useState<Session | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [focusStart, setFocusStart] = useState(false);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const progressRef = useRef(progress);
  const [now, setNow] = useState(Date.now);

  const load = useCallback(() => {
    setLoaded({ state: 'loading' });
    fetchBank().then(
      (bank) => {
        const storage = createPracticeStorage(browserStorage());
        const stored = storage.loadSession(bank);
        const clock = Date.now();
        let saved: Session | null = null;
        if (stored.kind === 'restored' && stored.session.status === 'active') {
          // A deadline that passed while the page was closed submits the exam as a timeout.
          const checked = sessionReducer(stored.session, { type: 'tick', now: clock });
          if (checked.status === 'submitted') setSession(checked);
          else saved = checked;
        } else if (stored.kind === 'restored') {
          storage.clearSession();
        }
        progressRef.current = storage.loadProgress();
        setProgress(progressRef.current);
        setNow(clock);
        setLoaded({
          state: 'ready',
          bank,
          storage,
          saved,
          restoreFailed: stored.kind === 'unrestorable' ? storage.lastRestoreFailure() : null,
        });
      },
      () => {
        setLoaded({ state: 'error' });
      },
    );
  }, []);

  useEffect(load, [load]);

  // Save an active exam after every action; on submit record the attempt and drop the saved exam.
  useEffect(() => {
    if (loaded.state !== 'ready' || session === null) return;
    if (session.status === 'active') {
      loaded.storage.saveSession(session);
      return;
    }
    loaded.storage.clearSession();
    const next = recordSession(progressRef.current, session);
    if (next !== progressRef.current) {
      progressRef.current = next;
      loaded.storage.saveProgress(next);
      setProgress(next);
    }
  }, [loaded, session]);

  // The clock: refresh the time left every second and submit at the deadline.
  const active = session?.status === 'active';
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const clock = Date.now();
      setNow(clock);
      setSession((current) => current && sessionReducer(current, { type: 'tick', now: clock }));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [active]);

  const act = useCallback((action: Act) => {
    const clock = Date.now();
    setNow(clock);
    setSession((current) => current && sessionReducer(current, { ...action, now: clock }));
  }, []);

  // What the bank allows: its size and per-domain plan do not depend on the seed.
  const bank = loaded.state === 'ready' ? loaded.bank : null;
  const plan = useMemo(() => (bank === null ? null : buildExam(bank, { seed: 1 })), [bank]);

  const screen =
    session === null
      ? 'start'
      : session.status === 'submitted'
        ? 'results'
        : reviewing
          ? 'review'
          : 'exam';
  useScreenAttribute(screen);

  if (loaded.state === 'loading') {
    return (
      <div className="pt pt-loading">
        <p className="pt-status" role="status">
          Loading questions…
        </p>
      </div>
    );
  }
  if (loaded.state === 'error' || bank === null || plan === null) {
    return (
      <div className="pt">
        <div className="pt-card pt-error">
          <p role="alert">The questions could not be loaded.</p>
          <button type="button" className="pt-btn pt-btn-primary" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { storage, saved, restoreFailed } = loaded;
  const patch = (changes: Partial<Ready>) => {
    setLoaded((previous) => (previous.state === 'ready' ? { ...previous, ...changes } : previous));
  };

  function start(): void {
    if (bank === null) return;
    const exam = buildExam(bank, { seed: randomSeed() });
    const clock = Date.now();
    setNow(clock);
    setReviewing(false);
    patch({ restoreFailed: null });
    setFocusStart(false);
    setSession(
      startSession(exam, {
        mode: 'exam',
        now: clock,
        durationMs: examDurationMs(exam.items.length),
      }),
    );
  }

  function resume(): void {
    setReviewing(false);
    setSession(saved);
    patch({ saved: null });
  }

  function discard(): void {
    storage.clearSession();
    setFocusStart(true);
    patch({ saved: null });
  }

  function goTo(index: number): void {
    setReviewing(false);
    act({ type: 'goTo', index });
  }

  return (
    <div className="pt">
      {session === null && (
        <StartScreen
          plan={plan}
          saved={
            saved === null
              ? null
              : {
                  question: saved.current + 1,
                  total: saved.exam.items.length,
                  leftMs: Math.max(0, (saved.deadline ?? now) - now),
                }
          }
          restoreFailed={restoreFailed}
          focusStart={focusStart}
          lastAttempt={progress.attempts.at(-1)}
          canSave={storage.available}
          onStart={start}
          onResume={resume}
          onDiscard={discard}
        />
      )}
      {session?.status === 'active' &&
        (reviewing ? (
          <ReviewScreen
            session={session}
            now={now}
            onGoTo={goTo}
            onBack={() => {
              setReviewing(false);
            }}
            onSubmit={() => {
              act({ type: 'submit' });
            }}
          />
        ) : (
          <ExamScreen
            session={session}
            now={now}
            onAnswer={(selected) => {
              act({ type: 'answer', selected });
            }}
            onFlag={(flagged) => {
              act({ type: 'flag', flagged });
            }}
            onGoTo={goTo}
            onEnd={() => {
              setReviewing(true);
            }}
          />
        ))}
      {session?.status === 'submitted' && (
        <ResultsScreen
          session={session}
          onNew={() => {
            setFocusStart(true);
            setSession(null);
          }}
        />
      )}
    </div>
  );
}
