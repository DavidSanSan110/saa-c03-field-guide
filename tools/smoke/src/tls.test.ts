import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { tlsProbe } from './tls.ts';

// Spec 036, AC-35: tlsProbe against a local TLS server. The certificate is throwaway: openssl
// makes it at test time in a temp dir, nothing is committed.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

/** `openssl` from PATH, else the copies that Git for Windows ships. */
function findOpenssl(): string | undefined {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ];
  for (const candidate of candidates) {
    if (candidate !== 'openssl' && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

let tempDir = '';
let certPem = '';
let keyPem = '';
let skipNotice: string | undefined;
let server: tls.Server | undefined;
let port = 0;

function listen(instance: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, 'localhost', () => {
      resolve((instance.address() as AddressInfo).port);
    });
  });
}

function close(instance: net.Server): Promise<void> {
  return new Promise((resolve) => {
    instance.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  const openssl = findOpenssl();
  if (openssl === undefined) {
    const ci = process.env['CI'];
    if (ci !== undefined && ci !== '') {
      throw new Error('openssl is required on CI to make the throwaway test certificate');
    }
    skipNotice = 'openssl not found: the tlsProbe tests against a local server are skipped';
    console.warn(`NOTICE: ${skipNotice}`);
    return;
  }
  tempDir = mkdtempSync(join(tmpdir(), 'smoke-tls-'));
  const keyPath = join(tempDir, 'key.pem');
  const certPath = join(tempDir, 'cert.pem');
  const made = spawnSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (made.status !== 0) {
    throw new Error(`openssl could not make the test certificate: ${made.stderr}`);
  }
  certPem = readFileSync(certPath, 'utf8');
  keyPem = readFileSync(keyPath, 'utf8');
  server = tls.createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2' }, (socket) => {
    socket.on('error', () => undefined);
    socket.end();
  });
  server.on('tlsClientError', () => undefined);
  port = await listen(server);
});

afterAll(async () => {
  if (server !== undefined) await close(server);
  if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
});

/** Skips the test (with the notice) when openssl was missing outside CI. */
function needCertificate(context: TestContext): void {
  if (skipNotice !== undefined) context.skip(skipNotice);
}

describe('tlsProbe against a local TLS server', () => {
  test('AC-35: a TLS 1.2 probe with the certificate as CA is ok, with the protocol and validTo', async (context) => {
    needCertificate(context);
    const result = await tlsProbe('localhost', 'TLSv1.2', 5000, { port, ca: certPem });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.protocol).toBe('TLSv1.2');
    expect(result.validTo).toBeInstanceOf(Date);
    expect(result.validTo.getTime()).toBe(new Date(new X509Certificate(certPem).validTo).getTime());
  });

  test('AC-35: the same probe without the CA fails verification, and that is not a server refusal', async (context) => {
    needCertificate(context);
    const result = await tlsProbe('localhost', 'TLSv1.2', 5000, { port });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.serverRefused).toBe(false);
    expect(result.code.length).toBeGreaterThan(0);
  });

  test('AC-35: a TLS 1.0 probe is refused by the server', async (context) => {
    needCertificate(context);
    const result = await tlsProbe('localhost', 'TLSv1', 5000, { port, ca: certPem });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.serverRefused).toBe(true);
    expect(result.code).toMatch(/^ERR_SSL_(TLSV1|SSLV3)_ALERT_/);
  });

  test('AC-35: a TLS 1.1 probe is refused by the server', async (context) => {
    needCertificate(context);
    const result = await tlsProbe('localhost', 'TLSv1.1', 5000, { port, ca: certPem });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.serverRefused).toBe(true);
  });

  test('AC-35: a probe to a closed port fails and is not a server refusal', async (context) => {
    needCertificate(context);
    const idle = net.createServer();
    const closedPort = await listen(idle);
    await close(idle);
    const result = await tlsProbe('localhost', 'TLSv1.2', 5000, { port: closedPort, ca: certPem });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.serverRefused).toBe(false);
  });

  test('AC-35: a server that accepts the connection and then says nothing ends at the timeout', async (context) => {
    needCertificate(context);
    const sockets: net.Socket[] = [];
    const silent = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
    });
    const silentPort = await listen(silent);
    try {
      const result = await tlsProbe('localhost', 'TLSv1.2', 300, { port: silentPort, ca: certPem });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.serverRefused).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await close(silent);
    }
  });
});
