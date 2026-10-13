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

/** Repo-relative source path -> backup-relative path, or null if it is excluded or not a source. */
export function backupPath(sourcePath: string): string | null {
  void sourcePath;
  throw new Error('not implemented');
}

export function planSync(source: FileMap, backup: FileMap): SyncPlan {
  void source;
  void backup;
  throw new Error('not implemented');
}
