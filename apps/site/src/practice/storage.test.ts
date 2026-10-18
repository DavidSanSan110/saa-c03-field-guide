import {
  buildExam,
  emptyProgress,
  recordSession,
  saveSession,
  sessionReducer,
  startSession,
} from '@field-guide/quiz-core';
import type { Session } from '@field-guide/quiz-core';
import type { DomainId, Question, TaskId } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { PROGRESS_KEY, SESSION_KEY, createPracticeStorage } from './storage.ts';

const START = 5_000_000;
const TASK_OF: Record<DomainId, TaskId> = { 1: '1.1', 2: '2.1', 3: '3.1', 4: '4.1' };

function question(domain: DomainId, serial: number): Question {
  return {
    id: `d${String(domain)}-${TASK_OF[domain]}-${String(serial).padStart(4, '0')}`,
    domain,
    task: TASK_OF[domain],
    services: [],
    difficulty: 'medium',
    type: 'single',
    stem: `Stem ${String(serial)}`,
    options: ['A', 'B', 'C', 'D'].map((key) => ({
      key,
      text: `Option ${key}`,
      correct: key === 'A',
      why: 'Because.',
    })),
    references: ['https://docs.aws.amazon.com/'],
    status: 'reviewed',
    provenance: { generated_by: 'fixture', verified_by: 'fixture', reviewed_by: 'fixture' },
  };
}

/** One question per domain. */
function bankOf(firstSerial: number): Question[] {
  return ([1, 2, 3, 4] as const).map((domain, index) => question(domain, firstSerial + index));
}

const BANK = bankOf(1);

function activeSession(): Session {
  const exam = buildExam(BANK, { seed: 3, size: 4 });
  let session = startSession(exam, { mode: 'exam', now: START, durationMs: 480_000 });
  session = sessionReducer(session, { type: 'answer', selected: ['B'], now: START + 1 });
  session = sessionReducer(session, { type: 'flag', flagged: true, now: START + 2 });
  session = sessionReducer(session, { type: 'goTo', index: 2, now: START + 3 });
  return session;
}

function submittedSession(): Session {
  return sessionReducer(activeSession(), { type: 'submit', now: START + 60_000 });
}

type Method = 'getItem' | 'setItem' | 'removeItem';

/** An in-memory Storage whose chosen methods throw. */
function fakeStorage(
  initial: Record<string, string> = {},
  throwing: readonly Method[] = [],
): { storage: Storage; data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const guard = (method: Method): void => {
    if (throwing.includes(method)) throw new DOMException(`${method} is blocked`, 'SecurityError');
  };
  const storage = {
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key: string) => {
      guard('getItem');
      return data.get(key) ?? null;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      guard('removeItem');
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      guard('setItem');
      data.set(key, value);
    },
  } as Storage;
  return { storage, data };
}

describe('createPracticeStorage: a working storage', () => {
  test('AC-5: a working storage is available', () => {
    expect(createPracticeStorage(fakeStorage().storage).available).toBe(true);
  });

  test('AC-5: nothing saved loads as "none"', () => {
    const helpers = createPracticeStorage(fakeStorage().storage);

    expect(helpers.loadSession(BANK)).toEqual({ kind: 'none' });
  });

  test('AC-5: a saved session round-trips through the storage', () => {
    const { storage } = fakeStorage();
    const session = activeSession();

    createPracticeStorage(storage).saveSession(session);
    // A new helper object over the same storage: nothing is kept in memory.
    const loaded = createPracticeStorage(storage).loadSession(BANK);

    expect(loaded.kind).toBe('restored');
    if (loaded.kind === 'restored') expect(loaded.session).toEqual(session);
  });

  test('AC-5: the session is stored as the JSON of saveSession under field-guide:practice:session', () => {
    const { storage, data } = fakeStorage();
    const session = activeSession();

    createPracticeStorage(storage).saveSession(session);

    expect(SESSION_KEY).toBe('field-guide:practice:session');
    expect(JSON.parse(data.get('field-guide:practice:session') ?? 'null')).toEqual(
      JSON.parse(JSON.stringify(saveSession(session))),
    );
  });

  test('AC-5: saving again replaces the stored session', () => {
    const { storage } = fakeStorage();
    const helpers = createPracticeStorage(storage);
    const first = activeSession();
    const second = sessionReducer(first, { type: 'goTo', index: 1, now: START + 10 });

    helpers.saveSession(first);
    helpers.saveSession(second);
    const loaded = helpers.loadSession(BANK);

    expect(loaded.kind === 'restored' && loaded.session.current).toBe(1);
  });

  test('AC-5: clearSession removes the saved exam', () => {
    const { storage, data } = fakeStorage();
    const helpers = createPracticeStorage(storage);
    helpers.saveSession(activeSession());

    helpers.clearSession();

    expect(data.has(SESSION_KEY)).toBe(false);
    expect(helpers.loadSession(BANK)).toEqual({ kind: 'none' });
  });

  test('AC-5: a saved exam whose questions are not in the bank is unrestorable and is removed', () => {
    const { storage, data } = fakeStorage();
    const helpers = createPracticeStorage(storage);
    helpers.saveSession(activeSession());

    const loaded = helpers.loadSession(bankOf(50));

    expect(loaded).toEqual({ kind: 'unrestorable' });
    expect(data.has(SESSION_KEY)).toBe(false);
    expect(helpers.loadSession(BANK)).toEqual({ kind: 'none' });
  });

  test('AC-5: unreadable stored data is unrestorable and is removed', () => {
    const { storage, data } = fakeStorage({ [SESSION_KEY]: '{not json' });

    const loaded = createPracticeStorage(storage).loadSession(BANK);

    expect(loaded).toEqual({ kind: 'unrestorable' });
    expect(data.has(SESSION_KEY)).toBe(false);
  });

  test('AC-5: stored JSON that is not a saved session is unrestorable and is removed', () => {
    const { storage, data } = fakeStorage({ [SESSION_KEY]: JSON.stringify({ hello: 'world' }) });

    const loaded = createPracticeStorage(storage).loadSession(BANK);

    expect(loaded).toEqual({ kind: 'unrestorable' });
    expect(data.has(SESSION_KEY)).toBe(false);
  });
});

describe('createPracticeStorage: progress', () => {
  test('AC-5: no stored progress loads as an empty one', () => {
    expect(createPracticeStorage(fakeStorage().storage).loadProgress()).toEqual(emptyProgress());
  });

  test('AC-5: saved progress round-trips and sits under field-guide:practice:progress', () => {
    const { storage, data } = fakeStorage();
    const progress = recordSession(emptyProgress(), submittedSession());

    createPracticeStorage(storage).saveProgress(progress);

    expect(PROGRESS_KEY).toBe('field-guide:practice:progress');
    expect(JSON.parse(data.get('field-guide:practice:progress') ?? 'null')).toEqual(progress);
    expect(createPracticeStorage(storage).loadProgress()).toEqual(progress);
    expect(progress.attempts).toHaveLength(1);
  });

  test('AC-5: unreadable progress starts from an empty one', () => {
    const { storage } = fakeStorage({ [PROGRESS_KEY]: 'garbage{' });

    expect(createPracticeStorage(storage).loadProgress()).toEqual(emptyProgress());
  });

  test('AC-5: progress that fails validation starts from an empty one', () => {
    const { storage } = fakeStorage({
      [PROGRESS_KEY]: JSON.stringify({ version: 1, attempts: 'many', questions: {} }),
    });

    expect(createPracticeStorage(storage).loadProgress()).toEqual(emptyProgress());
  });

  test('AC-5: the session and the progress do not touch each other', () => {
    const { storage, data } = fakeStorage();
    const helpers = createPracticeStorage(storage);

    helpers.saveProgress(recordSession(emptyProgress(), submittedSession()));
    helpers.saveSession(activeSession());
    helpers.clearSession();

    expect(data.has(PROGRESS_KEY)).toBe(true);
    expect(data.has(SESSION_KEY)).toBe(false);
  });
});

describe('createPracticeStorage: storage that throws', () => {
  const cases: [string, readonly Method[]][] = [
    ['getItem, setItem and removeItem', ['getItem', 'setItem', 'removeItem']],
    ['getItem', ['getItem']],
    ['setItem', ['setItem']],
    ['removeItem', ['removeItem']],
  ];

  test.each(cases)(
    'AC-5: when %s throw, creating the helpers does not throw',
    (_name, throwing) => {
      const { storage } = fakeStorage({}, throwing);

      expect(() => createPracticeStorage(storage)).not.toThrow();
    },
  );

  test.each(cases)(
    'AC-5: when %s throw, the storage is reported unavailable',
    (_name, throwing) => {
      const { storage } = fakeStorage({}, throwing);

      expect(createPracticeStorage(storage).available).toBe(false);
    },
  );

  test.each(cases)('AC-5: when %s throw, no helper throws', (_name, throwing) => {
    const { storage } = fakeStorage({ [SESSION_KEY]: 'x', [PROGRESS_KEY]: 'y' }, throwing);
    const helpers = createPracticeStorage(storage);

    expect(() => helpers.loadSession(BANK)).not.toThrow();
    expect(() => {
      helpers.saveSession(activeSession());
    }).not.toThrow();
    expect(() => {
      helpers.clearSession();
    }).not.toThrow();
    expect(() => helpers.loadProgress()).not.toThrow();
    expect(() => {
      helpers.saveProgress(emptyProgress());
    }).not.toThrow();
  });

  test('AC-5: when every access throws, loading gives "none" and an empty progress', () => {
    const { storage } = fakeStorage({}, ['getItem', 'setItem', 'removeItem']);
    const helpers = createPracticeStorage(storage);

    expect(helpers.loadSession(BANK)).toEqual({ kind: 'none' });
    expect(helpers.loadProgress()).toEqual(emptyProgress());
  });

  test('AC-5: when saving fails the exam still loads as "none", not as an old copy', () => {
    const { storage } = fakeStorage({}, ['setItem']);
    const helpers = createPracticeStorage(storage);

    helpers.saveSession(activeSession());

    expect(helpers.loadSession(BANK)).toEqual({ kind: 'none' });
  });

  test('AC-5: without any storage (undefined) everything is unavailable but safe', () => {
    const helpers = createPracticeStorage(undefined);

    expect(helpers.available).toBe(false);
    expect(helpers.loadSession(BANK)).toEqual({ kind: 'none' });
    expect(helpers.loadProgress()).toEqual(emptyProgress());
    expect(() => {
      helpers.saveSession(activeSession());
      helpers.clearSession();
      helpers.saveProgress(emptyProgress());
    }).not.toThrow();
  });
});
