// Test-control preload for the spawned CLI (spec 022 AC-30): replaces `globalThis.fetch`, so that
// no test ever touches the network. Loaded with `NODE_OPTIONS=--import <file URL>`.
//
// FETCH_STUB_MAP  path of a JSON file: { "<url>": { "status": 200, "body": "<html>" } | "network-error" }
// FETCH_STUB_LOG  path of a file that gets one line per fetched URL (appended before answering)
//
// A URL that is not in the map behaves like a network error (and is logged all the same).
import { appendFileSync, readFileSync } from 'node:fs';

const mapPath = process.env.FETCH_STUB_MAP;
const logPath = process.env.FETCH_STUB_LOG;

if (mapPath !== undefined && mapPath !== '') {
  const answers = JSON.parse(readFileSync(mapPath, 'utf8'));

  globalThis.fetch = (input) => {
    const url = typeof input === 'string' ? input : (input.href ?? input.url);
    if (logPath !== undefined && logPath !== '') appendFileSync(logPath, `${url}\n`);
    const answer = Object.hasOwn(answers, url) ? answers[url] : 'network-error';
    if (answer === 'network-error') {
      return Promise.reject(new TypeError('fetch failed'));
    }
    return Promise.resolve(
      new Response(answer.body ?? '', {
        status: answer.status ?? 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
  };
}
