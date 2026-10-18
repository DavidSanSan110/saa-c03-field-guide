// Test-control preload for the spawned CLI (spec 022 AC-34, AC-36): like fetch-stub.mjs, and it also
// records how `fetch` was called and can answer with a different final URL (a redirect). It never
// touches the network. Loaded with `NODE_OPTIONS=--import <file URL>`.
//
// FETCH_REC_MAP  path of a JSON file:
//                { "<url>": { "status": 200, "body": "<html>", "finalUrl": "<url after redirects>" }
//                         | "network-error" }
// FETCH_REC_LOG  path of a file that gets one JSON line per call:
//                { "url": "<url>", "redirect": "<init.redirect>", "signal": <init.signal is an AbortSignal> }
//
// A URL that is not in the map behaves like a network error (and is logged all the same).
import { appendFileSync, readFileSync } from 'node:fs';

const mapPath = process.env.FETCH_REC_MAP;
const logPath = process.env.FETCH_REC_LOG;

if (mapPath !== undefined && mapPath !== '') {
  const answers = JSON.parse(readFileSync(mapPath, 'utf8'));

  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input.href ?? input.url);
    if (logPath !== undefined && logPath !== '') {
      const entry = {
        url,
        redirect: init?.redirect ?? null,
        signal: init?.signal instanceof AbortSignal,
      };
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    }
    const answer = Object.hasOwn(answers, url) ? answers[url] : 'network-error';
    if (answer === 'network-error') {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const response = new Response(answer.body ?? '', {
      status: answer.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    // `Response.url` is read-only and empty for a constructed response: set what a real fetch would.
    Object.defineProperty(response, 'url', { value: answer.finalUrl ?? url });
    return Promise.resolve(response);
  };
}
