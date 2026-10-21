// Interface stub (spec 036). The implementation replaces the bodies.

export type TlsVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';

export type TlsResult =
  | { ok: true; protocol: string; validTo: Date }
  | { ok: false; code: string; serverRefused: boolean };

export function isServerRefusal(code: string): boolean {
  void code;
  throw new Error('not implemented');
}

export function tlsProbe(
  host: string,
  version: TlsVersion,
  timeoutMs: number,
  testOptions?: { port?: number; ca?: string },
): Promise<TlsResult> {
  void host;
  void version;
  void timeoutMs;
  void testOptions;
  throw new Error('not implemented');
}
