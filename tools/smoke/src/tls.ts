// TLS probe of the smoke test (spec 036): one handshake offering exactly one protocol version.
import tls from 'node:tls';

export type TlsVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';

export type TlsResult =
  | { ok: true; protocol: string; validTo: Date }
  | { ok: false; code: string; serverRefused: boolean };

/** True for the alert codes a server sends back when it refuses the offered protocol version. */
export function isServerRefusal(code: string): boolean {
  return code.startsWith('ERR_SSL_TLSV1_ALERT_') || code.startsWith('ERR_SSL_SSLV3_ALERT_');
}

/**
 * Connects to `host` offering only `version`. Verification (chain and host name) is always on, so a
 * failure that is not a server alert (a bad certificate, a timeout, a client that cannot offer the
 * version) is never reported as a refusal. `testOptions` exist for the tests' local server.
 */
export function tlsProbe(
  host: string,
  version: TlsVersion,
  timeoutMs: number,
  testOptions: { port?: number; ca?: string } = {},
): Promise<TlsResult> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      servername: host,
      port: testOptions.port ?? 443,
      minVersion: version,
      maxVersion: version,
      ciphers: 'DEFAULT@SECLEVEL=0',
      rejectUnauthorized: true,
      ...(testOptions.ca === undefined ? {} : { ca: testOptions.ca }),
    });
    const finish = (result: TlsResult): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'ETIMEDOUT', serverRefused: false });
    }, timeoutMs);
    socket.once('secureConnect', () => {
      finish({
        ok: true,
        protocol: socket.getProtocol() ?? version,
        validTo: new Date(socket.getPeerCertificate().valid_to),
      });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'UNKNOWN';
      finish({ ok: false, code, serverRefused: isServerRefusal(code) });
    });
  });
}
