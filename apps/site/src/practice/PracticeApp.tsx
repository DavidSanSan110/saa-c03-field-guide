// The practice-test island at /practice/: start screen, exam, review list and results (spec 027), practice
// sets, question review and progress (spec 028).
// The rules (building, grading, scoring, the deadline) live in quiz-core; this file wires them to the screens.
import {
  buildExam,
  buildPracticeExam,
  emptyProgress,
  practicePool,
  recordSession,
  sessionReducer,
  startSession,
} from '@field-guide/quiz-core';
import type { PoolFilter, Session } from '@field-guide/quiz-core';
import type { Progress, Question } from '@field-guide/schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './practice.css';
import { dashboardView } from './dashboard.ts';
import { ExamScreen } from './ExamScreen.tsx';
import type { LinksIndex } from './links.ts';
import { examDurationMs } from './plan.ts';
import { INITIAL_CHOICE } from './PracticeCard.tsx';
import type { PracticeChoice } from './PracticeCard.tsx';
import { PracticeResults } from './PracticeResults.tsx';
import { PracticeScreen } from './PracticeScreen.tsx';
import { ProgressScreen } from './ProgressScreen.tsx';
import type { Filter } from './QuestionsCard.tsx';
import { QuestionReviewScreen } from './QuestionReviewScreen.tsx';
import { ResultsScreen } from './ResultsScreen.tsx';
import { ReviewScreen } from './ReviewScreen.tsx';
import { StartScreen } from './StartScreen.tsx';
import { createPracticeStorage } from './storage.ts';
import type { PracticeStorage, RestoreFailure } from './storage.ts';

interface Ready {
  state: 'ready';
  bank: Question[];
  /** The guide pages and diagrams the questions link to; empty when `links.json` failed to load. */
  links: LinksIndex;
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
  | { type: 'reveal' }
  | { type: 'submit' };

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** `import.meta.env.BASE_URL` with a trailing slash. */
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');

async function fetchBank(): Promise<Question[]> {
  const response = await fetch(`${BASE}practice/bank.json`);
  if (!response.ok) throw new Error(`bank.json answered ${String(response.status)}`);
  const body = (await response.json()) as { questions?: Question[] };
  if (!Array.isArray(body.questions)) throw new Error('bank.json has no questions');
  return body.questions;
}

/** The guide and diagram links; the island works without them, so a failure gives an empty index. */
async function fetchLinks(): Promise<LinksIndex> {
  try {
    const response = await fetch(`${BASE}practice/links.json`);
    if (!response.ok) return { pages: {}, diagrams: {} };
    const body = (await response.json()) as Partial<LinksIndex>;
    return { pages: body.pages ?? {}, diagrams: body.diagrams ?? {} };
  } catch {
    return { pages: {}, diagrams: {} };
  }
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** Marks the screen on <html> so the page CSS can hide the page title during the exam and a practice set. */
function useScreenAttribute(screen: string): void {
  useEffect(() => {
    const root = document.documentElement;
    if (screen === 'exam' || screen === 'review' || screen === 'practice') {
      root.dataset['practiceScreen'] = screen;
    } else delete root.dataset['practiceScreen'];
    return () => {
      delete root.dataset['practiceScreen'];
    };
  }, [screen]);
}

export default function PracticeApp() {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [session, setSession] = useState<Session | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [focusOn, setFocusOn] = useState<'exam' | 'practice' | 'progress' | null>(null);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const progressRef = useRef(progress);
  const [now, setNow] = useState(Date.now);
  // Practice sets are never saved: their choice, label and views live here for the visit only.
  const [choice, setChoice] = useState<PracticeChoice>(INITIAL_CHOICE);
  const [label, setLabel] = useState('');
  const [showProgress, setShowProgress] = useState(false);
  /** The 0-based question of the attempt shown on the review screen, or null for the results. */
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [resultsFilter, setResultsFilter] = useState<Filter>('all');
  /** The question whose review was just left: the results give focus to its Review button. */
  const [returnTo, setReturnTo] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoaded({ state: 'loading' });
    Promise.all([fetchBank(), fetchLinks()]).then(
      ([bank, links]) => {
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
          links,
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

  // Save an active exam after every action; on submit record the attempt and, for an exam, drop the
  // saved copy. A practice set is never saved and leaves the saved exam alone.
  useEffect(() => {
    if (loaded.state !== 'ready' || session === null) return;
    if (session.status === 'active') {
      if (session.mode === 'exam') loaded.storage.saveSession(session);
      return;
    }
    if (session.mode === 'exam') loaded.storage.clearSession();
    // A set where nothing was answered and nothing was revealed leaves no trace.
    if (
      session.mode === 'practice' &&
      Object.keys(session.answers).length === 0 &&
      session.revealed.length === 0
    ) {
      return;
    }
    const next = recordSession(progressRef.current, session);
    if (next !== progressRef.current) {
      progressRef.current = next;
      loaded.storage.saveProgress(next);
      setProgress(next);
    }
  }, [loaded, session]);

  // The clock: refresh the time left every second and submit at the deadline (exams only).
  const active = session?.status === 'active' && session.mode === 'exam';
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
  const dashboard = useMemo(
    () => (bank === null ? null : dashboardView(bank, progress, now)),
    [bank, progress, now],
  );

  const screen =
    session === null
      ? showProgress
        ? 'progress'
        : 'start'
      : session.status === 'submitted'
        ? reviewIndex === null
          ? 'results'
          : 'question'
        : session.mode === 'practice'
          ? 'practice'
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
  if (loaded.state === 'error' || bank === null || plan === null || dashboard === null) {
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

  const { storage, saved, restoreFailed, links } = loaded;
  const patch = (changes: Partial<Ready>) => {
    setLoaded((previous) => (previous.state === 'ready' ? { ...previous, ...changes } : previous));
  };

  /** Back to a clean slate before a new attempt begins. */
  function resetViews(): void {
    setReviewing(false);
    setShowProgress(false);
    setReviewIndex(null);
    setReturnTo(null);
    setResultsFilter('all');
    setFocusOn(null);
  }

  function start(): void {
    if (bank === null) return;
    const exam = buildExam(bank, { seed: randomSeed() });
    const clock = Date.now();
    setNow(clock);
    resetViews();
    patch({ restoreFailed: null });
    setSession(
      startSession(exam, {
        mode: 'exam',
        now: clock,
        durationMs: examDurationMs(exam.items.length),
      }),
    );
  }

  function startPractice(filter: PoolFilter, poolText: string, size: number): void {
    if (bank === null) return;
    const exam = buildPracticeExam(practicePool(bank, progress, filter), {
      seed: randomSeed(),
      size,
    });
    if (exam.items.length === 0) return;
    const clock = Date.now();
    setNow(clock);
    resetViews();
    setLabel(poolText);
    setSession(startSession(exam, { mode: 'practice', now: clock }));
  }

  function resume(): void {
    resetViews();
    setSession(saved);
    patch({ saved: null });
  }

  function discard(): void {
    storage.clearSession();
    setFocusOn('exam');
    patch({ saved: null });
  }

  function goTo(index: number): void {
    setReviewing(false);
    act({ type: 'goTo', index });
  }

  /** Back to the start screen from the results; `focus` says where keyboard focus lands. */
  function toStart(focus: 'exam' | 'practice'): void {
    resetViews();
    setFocusOn(focus);
    setNow(Date.now());
    setSession(null);
  }

  const lastExam = progress.attempts.filter((attempt) => attempt.mode === 'exam').at(-1);

  return (
    <div className="pt">
      {session === null && !showProgress && (
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
          focusOn={focusOn}
          lastAttempt={lastExam}
          canSave={storage.available}
          bank={bank}
          progress={progress}
          dashboard={dashboard}
          now={now}
          choice={choice}
          onChoice={setChoice}
          onStart={start}
          onResume={resume}
          onDiscard={discard}
          onStartPractice={startPractice}
          onOpenProgress={() => {
            setShowProgress(true);
          }}
        />
      )}
      {session === null && showProgress && (
        <ProgressScreen
          view={dashboard}
          onBack={() => {
            setShowProgress(false);
            setFocusOn('progress');
          }}
        />
      )}
      {session?.status === 'active' && session.mode === 'practice' && (
        <PracticeScreen
          session={session}
          label={label}
          links={links}
          base={BASE}
          onAnswer={(selected) => {
            act({ type: 'answer', selected });
          }}
          onReveal={() => {
            act({ type: 'reveal' });
          }}
          onGoTo={goTo}
          onEnd={() => {
            act({ type: 'submit' });
          }}
        />
      )}
      {session?.status === 'active' &&
        session.mode === 'exam' &&
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
      {session?.status === 'submitted' && reviewIndex === null && session.mode === 'exam' && (
        <ResultsScreen
          session={session}
          filter={resultsFilter}
          onFilter={setResultsFilter}
          onReview={setReviewIndex}
          returnTo={returnTo}
          onNew={() => {
            toStart('exam');
          }}
        />
      )}
      {session?.status === 'submitted' && reviewIndex === null && session.mode === 'practice' && (
        <PracticeResults
          session={session}
          label={label}
          filter={resultsFilter}
          onFilter={setResultsFilter}
          onReview={setReviewIndex}
          returnTo={returnTo}
          onNew={() => {
            toStart('practice');
          }}
        />
      )}
      {session?.status === 'submitted' && reviewIndex !== null && (
        <QuestionReviewScreen
          session={session}
          index={reviewIndex}
          links={links}
          base={BASE}
          onMove={setReviewIndex}
          onBack={() => {
            setReturnTo(reviewIndex);
            setReviewIndex(null);
          }}
        />
      )}
    </div>
  );
}
