import { readFileSync } from 'node:fs';

type Sha256Hash = `sha256-${string}`;

const HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

function invalid(path: string, reason: string): Error {
  return new Error(`${path}: ${reason}`);
}

/** Reads and validates `csp-inline-hashes.json`; throws an Error naming `path` when it is not valid. */
export function loadInlineHashes(path: string): Sha256Hash[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw invalid(path, `cannot read it as JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(path, 'expected an object');
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'scriptHashes') {
    throw invalid(path, 'expected only the key "scriptHashes"');
  }
  const hashes = (parsed as { scriptHashes: unknown }).scriptHashes;
  if (!Array.isArray(hashes)) throw invalid(path, '"scriptHashes" must be an array');
  const entries: unknown[] = hashes;
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== 'string' || !HASH_PATTERN.test(entry)) {
      throw invalid(path, `entry ${String(index)} is not a sha256-<base64> hash`);
    }
    const previous = entries[index - 1];
    if (typeof previous === 'string' && previous >= entry) {
      throw invalid(path, `entry ${String(index)} is duplicated or out of order`);
    }
  }
  return entries as Sha256Hash[];
}
