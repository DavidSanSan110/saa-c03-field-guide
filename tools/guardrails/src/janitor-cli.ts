// Entry of the "Lab janitor" workflow (spec 043). Runs with plain Node, no install:
//   GH_TOKEN=<token> GH_REPO=<owner/repo> JANITOR_MAX_AGE_HOURS=<hours> \
//     node --experimental-strip-types tools/guardrails/src/janitor-cli.ts
// Calls `aws` and `gh` without a shell. A failed call is only an exit code here: its output can hold
// an ARN or an account ID, so it never leaves this file.
import { execFile } from 'node:child_process';
import { runJanitor } from './janitor.ts';
import type { Exec } from './janitor.ts';

// Tagging output can be large.
const MAX_BUFFER = 64 * 1024 * 1024;

const exec: Exec = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        // The child's stderr is the callback's third argument, and it is dropped on purpose.
        if (error === null) {
          resolve({ code: 0, stdout });
          return;
        }
        resolve({
          code: typeof error.code === 'number' && error.code !== 0 ? error.code : 1,
          stdout,
        });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });

process.exitCode = await runJanitor({
  exec,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
