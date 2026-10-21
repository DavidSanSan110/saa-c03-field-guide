// Interface stub (spec 036). The implementation replaces the body.

export interface SmokeOptions {
  url: URL;
  cloudfrontDomain?: string;
}

export type ParseResult = { ok: true; options: SmokeOptions } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  void argv;
  throw new Error('not implemented');
}
