// Smoke test CLI: reads the expected headers, runs the checks, prints, sets the exit code
// (0 all good, 1 a check failed, 2 usage error or unreadable headers file). The logic is in smoke.ts.
import { readFileSync } from 'node:fs';
import { parseArgs } from './args.ts';
import { formatResults, runSmoke } from './smoke.ts';

const HEADERS_FILE = new URL('../../../apps/site/headers.json', import.meta.url);

function fail(message: string): never {
  process.stderr.write(`smoke: ${message}\n`);
  process.exit(2);
}

/** The headers the site must send: a JSON object of string values. */
function readHeaders(): Record<string, string> {
  let headers: unknown;
  try {
    headers = JSON.parse(readFileSync(HEADERS_FILE, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${HEADERS_FILE.pathname}: ${(error as Error).message}`);
  }
  const isObject = typeof headers === 'object' && headers !== null && !Array.isArray(headers);
  if (!isObject || !Object.values(headers as object).every((value) => typeof value === 'string')) {
    return fail(`${HEADERS_FILE.pathname} must be a JSON object of string values`);
  }
  return headers as Record<string, string>;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  fail(
    `${parsed.error}\nusage: pnpm smoke --url <https://host> [--cloudfront-domain <name>.cloudfront.net]`,
  );
} else {
  const { text, exitCode } = formatResults(
    await runSmoke({ ...parsed.options, headers: readHeaders() }),
  );
  process.stdout.write(text);
  process.exitCode = exitCode;
}
