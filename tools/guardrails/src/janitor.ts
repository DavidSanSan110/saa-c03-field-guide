// Lab janitor (spec 043): interface stub. The behaviour is not written yet; every function throws.
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.
/* eslint-disable @typescript-eslint/no-unused-vars -- a stub: the parameters are used by the real code */

export const REGIONS = ['eu-west-1', 'us-east-1'];
export const ISSUE_TITLE = 'Forgotten lab resources';
export const DEFAULT_MAX_AGE_HOURS = 12;

export class JanitorError extends Error {}

export type ExecResult = { code: number; stdout: string };
export type Exec = (file: 'aws' | 'gh', args: string[], input?: string) => Promise<ExecResult>;
export type Deps = {
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
};
export type Finding = { lab: string; region: string; type: string; ageHours: number | null };

export function parseMaxAgeHours(_value: string | undefined): number {
  throw new Error('not implemented');
}

export function resourceType(_arn: string): string {
  throw new Error('not implemented');
}

export function resourceName(_arn: string): string {
  throw new Error('not implemented');
}

/** The fourth `:`-separated field of the ARN; '' when it has none. */
export function arnRegion(_arn: string): string {
  throw new Error('not implemented');
}

export function labLabel(_value: string): string {
  throw new Error('not implemented');
}

export function formatAge(_ageHours: number | null): string {
  throw new Error('not implemented');
}

/** UTC, `2026-11-02 07:00 UTC`. */
export function formatTime(_date: Date): string {
  throw new Error('not implemented');
}

export function reportBody(_findings: Finding[], _maxAgeHours: number, _now: Date): string {
  throw new Error('not implemented');
}

export function scan(_deps: Deps, _maxAgeHours: number): Promise<Finding[]> {
  throw new Error('not implemented');
}

export function syncIssue(
  _deps: Deps,
  _body: string | null,
  _closeComment: string,
): Promise<'created' | 'updated' | 'closed' | 'none'> {
  throw new Error('not implemented');
}

export function runJanitor(_deps: Deps): Promise<number> {
  throw new Error('not implemented');
}
