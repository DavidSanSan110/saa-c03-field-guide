// Test side of the fetch stub preload (fetch-stub.mjs): the environment for a spawned CLI and the
// list of URLs it fetched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'fetch-stub.mjs');

export type StubAnswer = { status: number; body: string } | 'network-error';

export interface FetchStub {
  /** Environment variables to pass to `runCli`. */
  env: Record<string, string>;
  /** The URLs the CLI fetched, in order, one entry per call. */
  fetched: () => string[];
}

/**
 * Writes the answer map and the log path into `dir` (outside the folders the CLI reads, so pass a
 * separate scratch directory) and returns the environment that makes the CLI use them.
 */
export function stubFetch(dir: string, answers: Record<string, StubAnswer>): FetchStub {
  const mapPath = join(dir, 'fetch-answers.json');
  const logPath = join(dir, 'fetch-log.txt');
  writeFileSync(mapPath, JSON.stringify(answers));
  return {
    env: {
      NODE_OPTIONS: `--import ${pathToFileURL(PRELOAD).href}`,
      FETCH_STUB_MAP: mapPath,
      FETCH_STUB_LOG: logPath,
    },
    fetched: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
        : [],
  };
}
