// Entry of the plan digest/summary CLI (spec 033). Runs with plain Node, no install:
//   node --experimental-strip-types tools/guardrails/src/terraform-plan-cli.ts <command> ...
import { readFileSync } from 'node:fs';
import { runTfPlan } from './terraform-plan.ts';

process.exitCode = runTfPlan(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
