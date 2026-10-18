// Interface stub (spec 022): the implementation comes after the tests.

/**
 * New sidecar text: `existing` (or nothing) with the top-level `key` set to `value`, written in
 * block style. Only the lines of that key change; a new key goes last. Throws on invalid YAML, a
 * non-mapping, or when the result would not hold exactly the input mapping with only `key` replaced.
 */
export function withSidecarKey(existing: string | undefined, key: string, value: unknown): string {
  void [existing, key, value];
  throw new Error('not implemented');
}
