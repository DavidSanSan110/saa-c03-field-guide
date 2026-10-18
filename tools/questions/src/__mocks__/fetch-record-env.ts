// Test side of the recording fetch preload (fetch-record.mjs).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'fetch-record.mjs');

export type RecordedAnswer = { status: number; body: string; finalUrl?: string } | 'network-error';

export interface FetchCall {
  url: string;
  /** `init.redirect` as the CLI passed it, `null` when it passed none. */
  redirect: string | null;
  /** Whether `init.signal` was an AbortSignal. */
  signal: boolean;
}

export interface FetchRecorder {
  /** Environment variables to pass to `runCli`. */
  env: Record<string, string>;
  /** Every call the CLI made, in order. */
  calls: () => FetchCall[];
}

/** Writes the answer map and the log path into `dir` (a scratch directory the CLI does not read). */
export function recordFetch(dir: string, answers: Record<string, RecordedAnswer>): FetchRecorder {
  const mapPath = join(dir, 'fetch-record-answers.json');
  const logPath = join(dir, 'fetch-record-log.jsonl');
  writeFileSync(mapPath, JSON.stringify(answers));
  return {
    env: {
      NODE_OPTIONS: `--import ${pathToFileURL(PRELOAD).href}`,
      FETCH_REC_MAP: mapPath,
      FETCH_REC_LOG: logPath,
    },
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as FetchCall)
        : [],
  };
}
