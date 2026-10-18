// Review CLI: argument parsing and start-up only; the work is in server.ts and review.ts.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.ts';

const USAGE = `Usage: review --reviewer <name> [--drafts <dir>] [--port <n>]

  --reviewer <name>  GitHub user written to provenance.reviewed_by (required)
  --drafts <dir>     drafts folder (default private/questions-drafts)
  --port <n>         port 0-65535, 0 picks a free one (default 4400)`;

const DEFAULT_DRAFTS = 'private/questions-drafts';
const DEFAULT_PORT = 4400;

class UsageError extends Error {}

interface Options {
  reviewer: string;
  drafts: string;
  port: number;
}

function valueOf(argv: string[], index: number): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new UsageError();
  return value;
}

function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new UsageError();
  return port;
}

function parseArgs(argv: string[]): Options {
  let reviewer = '';
  let drafts = DEFAULT_DRAFTS;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--reviewer') reviewer = valueOf(argv, ++i).trim();
    else if (arg === '--drafts') drafts = valueOf(argv, ++i);
    else if (arg === '--port') port = parsePort(valueOf(argv, ++i));
    else throw new UsageError();
  }
  if (reviewer === '') throw new UsageError();
  return { reviewer, drafts, port };
}

async function main(argv: string[]): Promise<number | undefined> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(options.drafts) || !statSync(options.drafts).isDirectory()) {
    console.error(`review: no drafts folder at ${options.drafts}`);
    return 1;
  }
  const server = await startServer({
    drafts: resolve(options.drafts),
    reviewer: options.reviewer,
    port: options.port,
  });
  console.log(`review: ${server.url}`);
  process.once('SIGINT', () => {
    void server.close().then(() => process.exit(0));
  });
  return undefined;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`review: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
