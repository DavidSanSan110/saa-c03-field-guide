// Entry of the "Export lab variables" step of infra.yml (spec 035). Runs with plain Node, no install:
//   REPO_VARS='<toJSON(vars)>' GITHUB_ENV=<file> \
//     node --experimental-strip-types tools/guardrails/src/tf-vars-cli.ts
// Appends one name=value line per TF_VAR_ repository variable to the GITHUB_ENV file, so the later
// steps of the job run terraform with them. Prints names, never values.
import { appendFileSync } from 'node:fs';
import { TfVarsError, tfVarsFromRepoVars } from './tf-vars.ts';

function main(): number {
  const envFile = process.env['GITHUB_ENV'];
  if (envFile === undefined || envFile === '') {
    process.stderr.write('GITHUB_ENV is not set, so nothing can be exported\n');
    return 1;
  }

  let vars;
  try {
    vars = tfVarsFromRepoVars(process.env['REPO_VARS'] ?? '');
  } catch (error) {
    if (!(error instanceof TfVarsError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (vars.length === 0) {
    process.stdout.write('no TF_VAR_ repository variables\n');
    return 0;
  }
  appendFileSync(envFile, vars.map(({ name, value }) => `${name}=${value}\n`).join(''));
  for (const { name } of vars) process.stdout.write(`exported ${name}\n`);
  return 0;
}

process.exitCode = main();
