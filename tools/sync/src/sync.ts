// Pure core of tools/sync: which files are backed up and what a mirror run has to change.

/** Backup-relative path -> file content. */
export type FileMap = Map<string, Buffer>;

export interface SyncPlan {
  /** New and changed files, sorted. */
  write: string[];
  /** Backup files with no source, sorted (never `.gitkeep`). */
  remove: string[];
  /** Number of files that are identical in source and backup. */
  unchanged: number;
}

const TOP_LEVEL_SOURCES = new Set(['CLAUDE.md', 'PLAN.md']);
const KEEP_FILE = '.gitkeep';

/**
 * Repo-relative source path -> backup-relative path, or null if it is excluded or not a source.
 * Sources are `CLAUDE.md`, `PLAN.md` and everything under `.claude/` except `.claude/worktrees/`
 * and any `node_modules/` directory. Both `/` and `\` separate segments.
 */
export function backupPath(sourcePath: string): string | null {
  const path = sourcePath.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  if (TOP_LEVEL_SOURCES.has(path)) return path;
  if (!path.startsWith('.claude/')) return null;
  const relative = path.slice('.claude/'.length);
  const segments = relative.split('/');
  if (relative === '' || segments[0] === 'worktrees' || segments.includes('node_modules')) {
    return null;
  }
  return relative;
}

/** What a mirror run has to write and remove so that the backup equals the source. */
export function planSync(source: FileMap, backup: FileMap): SyncPlan {
  const write: string[] = [];
  let unchanged = 0;
  for (const [path, content] of source) {
    if (backup.get(path)?.equals(content)) unchanged += 1;
    else write.push(path);
  }
  const remove = [...backup.keys()].filter(
    (path) => !source.has(path) && path.split('/').pop() !== KEEP_FILE,
  );
  return { write: write.sort(), remove: remove.sort(), unchanged };
}
