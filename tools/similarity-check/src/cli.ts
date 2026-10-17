// Similarity check CLI: arguments, file I/O, output and exit codes only; the logic is in similarity.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { buildIndex, findMatches } from './similarity.ts';

const DEFAULT_CORPUS = 'private/similarity-corpus';
const DEFAULT_TARGETS = ['apps/site/src/content/docs', 'questions'];
const DEFAULT_MIN_WORDS = 8;
const MIN_ALLOWED_WORDS = 3;

const USAGE = `Usage:
  similarity-check [options] [<path>...]

Reports runs of words that a file shares with the local corpus.
Paths are files or folders (recursive); default: ${DEFAULT_TARGETS.join(', ')}.
Only .md, .mdx, .yaml, .yml and .txt files are read.

Options:
  --corpus <dir>          corpus folder of .txt and .md files (default ${DEFAULT_CORPUS})
  --min-words <n>         shortest shared run to report, an integer >= ${MIN_ALLOWED_WORDS} (default ${DEFAULT_MIN_WORDS})
  --skip-without-corpus   exit 0 instead of 1 when there is no corpus`;

class UsageError extends Error {}

/** A target that cannot be read: exit 2 with the message only, no usage text. */
class TargetError extends Error {}

interface Options {
  corpus: string;
  minWords: number;
  skipWithoutCorpus: boolean;
  paths: string[];
}

/** No trailing separator, so that printed paths do not show `dir//file`. */
function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '') || path;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    corpus: DEFAULT_CORPUS,
    minWords: DEFAULT_MIN_WORDS,
    skipWithoutCorpus: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--corpus' || arg === '--min-words') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError();
      if (arg === '--corpus') {
        options.corpus = trimSeparators(value);
      } else {
        const count = /^\d+$/.test(value) ? Number(value) : 0;
        if (count < MIN_ALLOWED_WORDS) throw new UsageError();
        options.minWords = count;
      }
    } else if (arg === '--skip-without-corpus') {
      options.skipWithoutCorpus = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError();
    } else {
      options.paths.push(trimSeparators(arg));
    }
  }
  return options;
}

/** The files below `dir` whose name matches `wanted`, as sorted POSIX paths relative to `dir`. */
function listFiles(dir: string, wanted: RegExp): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    const here = relative === '' ? dir : `${dir}/${relative}`;
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && wanted.test(entry.name)) found.push(path);
    }
  };
  walk('');
  return found.sort();
}

const CORPUS_FILE = /\.(txt|md)$/i;
const TARGET_FILE = /\.(md|mdx|ya?ml|txt)$/i;

/** The corpus as `relative path -> text`; empty when the folder is missing or has no file. */
function readCorpus(dir: string): Record<string, string> {
  const corpus: Record<string, string> = {};
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return corpus;
  for (const path of listFiles(dir, CORPUS_FILE)) {
    corpus[path] = readFileSync(`${dir}/${path}`, 'utf8');
  }
  return corpus;
}

/** The checkable files of the given paths (files, or folders read recursively), without repeats. */
function collectTargets(paths: string[]): string[] {
  const targets = new Set<string>();
  const explicit = paths.length > 0;
  for (const path of explicit ? paths : DEFAULT_TARGETS) {
    if (!existsSync(path)) {
      if (explicit) throw new TargetError(`similarity-check: no such file or folder: ${path}`);
      continue;
    }
    if (statSync(path).isDirectory()) {
      for (const file of listFiles(path, TARGET_FILE)) targets.add(`${path}/${file}`);
    } else if (TARGET_FILE.test(path)) {
      targets.add(path);
    }
  }
  return [...targets];
}

function run(options: Options): number {
  const corpus = readCorpus(options.corpus);
  const corpusFiles = Object.keys(corpus).length;
  if (corpusFiles === 0) {
    if (options.skipWithoutCorpus) {
      console.log(`no corpus at ${options.corpus}, similarity check skipped`);
      return 0;
    }
    console.error(`no corpus at ${options.corpus}`);
    return 1;
  }
  const targets = collectTargets(options.paths);
  const index = buildIndex(corpus, options.minWords);
  let total = 0;
  for (const target of targets) {
    for (const match of findMatches(readFileSync(target, 'utf8'), index)) {
      console.log(
        `${target}:${match.line}: ${match.length} words shared with ${match.corpusFile}:${match.corpusLine}: "${match.text}"`,
      );
      total++;
    }
  }
  console.log(
    `checked ${targets.length} files against ${corpusFiles} corpus files (min ${options.minWords} words): ${total} matches`,
  );
  return total > 0 ? 1 : 0;
}

/** Runs the CLI and resolves to the process exit code (0 ok, 1 match or no corpus, 2 usage). */
export function main(argv: string[]): Promise<number> {
  try {
    return Promise.resolve(run(parseArgs(argv)));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(USAGE);
      return Promise.resolve(2);
    }
    if (error instanceof TargetError) {
      console.error(error.message);
      return Promise.resolve(2);
    }
    console.error(`similarity-check: ${error instanceof Error ? error.message : String(error)}`);
    return Promise.resolve(1);
  }
}

process.exitCode = await main(process.argv.slice(2));
