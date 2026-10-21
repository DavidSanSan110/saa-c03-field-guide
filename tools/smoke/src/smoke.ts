// Interface stub (spec 036). The implementation replaces the bodies.
import type { SmokeOptions } from './args.ts';
import type { tlsProbe } from './tls.ts';

export interface CheckResult {
  id: string;
  status: 'ok' | 'fail' | 'skip';
  detail?: string;
}

export interface SmokeDeps {
  fetch?: typeof fetch;
  tlsProbe?: typeof tlsProbe;
  random?: () => string;
  timeoutMs?: number;
}

export function runSmoke(
  options: SmokeOptions & { headers: Record<string, string> },
  deps?: SmokeDeps,
): Promise<CheckResult[]> {
  void options;
  void deps;
  throw new Error('not implemented');
}

export function formatResults(results: CheckResult[]): { text: string; exitCode: 0 | 1 } {
  void results;
  throw new Error('not implemented');
}
