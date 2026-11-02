// Entry of the "Lab janitor" workflow (spec 043). Runs with plain Node, no install:
//   GH_TOKEN=<token> GH_REPO=<owner/repo> JANITOR_MAX_AGE_HOURS=<hours> \
//     node --experimental-strip-types tools/guardrails/src/janitor-cli.ts
// Runs `aws` and `gh` through janitor-exec.ts, which keeps their output from leaving the process.
import { runProgram } from './janitor-exec.ts';
import { runJanitor } from './janitor.ts';

process.exitCode = await runJanitor({
  exec: runProgram,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
