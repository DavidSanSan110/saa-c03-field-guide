// Terraform inputs from repository Actions variables (spec 035). Pure: no I/O.
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.

export class TfVarsError extends Error {}

export interface TfVar {
  name: string;
  value: string;
}

const PREFIX = 'TF_VAR_';

/** What may follow the prefix: Terraform variable names, ASCII only. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The environment variables to export from the JSON of GitHub's `vars` context.
 *
 * Only keys that start with `TF_VAR_` (any case) are used; the output name is `TF_VAR_` plus the
 * rest in lower case, sorted by name. Anything odd throws a TfVarsError whose message names the
 * key and never a value: a line break in a value would let it write a second line into GITHUB_ENV.
 */
export function tfVarsFromRepoVars(json: string): TfVar[] {
  if (json.trim() === '' || json.trim() === 'null') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Not the parser's message: it can quote a piece of the text, and the text holds values.
    throw new TfVarsError('REPO_VARS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TfVarsError('REPO_VARS must be a JSON object of strings');
  }

  const entries = Object.entries(parsed);
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      throw new TfVarsError(`the value of ${key} is not a string`);
    }
  }

  const byName = new Map<string, { key: string; value: string }>();
  for (const [key, value] of entries as [string, string][]) {
    if (key.slice(0, PREFIX.length).toUpperCase() !== PREFIX) continue;
    const rest = key.slice(PREFIX.length);
    if (!NAME_PATTERN.test(rest)) {
      throw new TfVarsError(
        `${key}: the name after ${PREFIX} must start with a letter and use only letters, digits and _`,
      );
    }
    if (/[\r\n\0]/.test(value)) {
      throw new TfVarsError(`${key}: the value has a line break or a NUL character`);
    }
    const name = `${PREFIX}${rest.toLowerCase()}`;
    const earlier = byName.get(name);
    if (earlier !== undefined) {
      throw new TfVarsError(`${earlier.key} and ${key} both give ${name}`);
    }
    byName.set(name, { key, value });
  }

  return [...byName.entries()]
    .map(([name, { value }]) => ({ name, value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
