// Shared helpers of the spec-022 CLI tests: spawn the CLI (tsx) in temp directories, write and read
// files, and snapshot a folder. The older CLI test files keep their own copies (they are locked).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { questionYaml } from './fixtures.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

export const DRAFTS = 'private/questions-drafts';
export const BANK = 'questions';
export const NOTES = 'private/notes-import';

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for assertions that do not depend on the stream. */
  output: string;
}

/** Environment without the GIT_* variables that a hook would leak into the temp directories. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return { ...env, ...extra };
}

/** Runs `tsx cli.ts <args>` in `cwd`; `env` adds variables (for instance NODE_OPTIONS). */
export function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd,
    env: cleanEnv(env),
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
  };
}

const tempDirs: string[] = [];

/** For `afterEach(cleanTempDirs)`. */
export function cleanTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brief-'));
  tempDirs.push(dir);
  return dir;
}

export function write(dir: string, path: string, content: string | Buffer): void {
  const full = join(dir, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function read(dir: string, path: string): Buffer {
  return readFileSync(join(dir, ...path.split('/')));
}

export function readText(dir: string, path: string): string {
  return read(dir, path).toString('utf8');
}

export function exists(dir: string, path: string): boolean {
  return existsSync(join(dir, ...path.split('/')));
}

/** A YAML file read back as a plain value. */
export function readYaml(dir: string, path: string): unknown {
  return parse(readText(dir, path));
}

/** Every file (as hex bytes) and folder under `dir`, to prove that nothing was written or deleted. */
export function snapshot(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        tree[`${path}/`] = '<dir>';
        walk(path);
      } else {
        tree[path] = readFileSync(join(dir, path)).toString('hex');
      }
    }
  };
  walk('');
  return tree;
}

/** Non-blank lines, without CR. */
export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A schema-valid question file at its correct path inside `folder` (status reviewed unless
 * overridden). Returns the path inside the folder.
 */
export function put(
  dir: string,
  folder: string,
  id: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): string {
  const parts = /^d(\d)-(\d\.\d)-/.exec(id);
  const path = `d${parts?.[1] ?? '1'}/${parts?.[2] ?? '1.3'}/${slug}.yaml`;
  write(dir, `${folder}/${path}`, questionYaml({ id, ...overrides }));
  return path;
}

/** The sidecar path of a question path: d1/1.3/x.yaml becomes d1/1.3/x.check.yaml. */
export function sidecarOf(path: string): string {
  return path.replace(/\.yaml$/, '.check.yaml');
}

/** The text between the heading line `heading` and the next `## ` heading (or the end). */
export function sectionOf(markdown: string, heading: string): string {
  const all = markdown.split(/\r?\n/);
  const start = all.indexOf(heading);
  if (start < 0) return '';
  let end = start + 1;
  while (end < all.length && !/^## /.test(all[end] as string)) end++;
  return all.slice(start + 1, end).join('\n');
}

/** Everything after the heading line `heading` up to the end (for the last section, whose text may hold `## ` lines). */
export function tailAfter(markdown: string, heading: string): string {
  const all = markdown.split(/\r?\n/);
  const start = all.indexOf(heading);
  return start < 0 ? '' : all.slice(start + 1).join('\n');
}
