// Whether the e2e fixture route is injected (spec 012).

/** True when `FIELD_GUIDE_FIXTURES=1` or in the dev server; production builds never inject it. */
export function shouldInjectFixtures(
  env: Record<string, string | undefined>,
  command: string,
): boolean {
  return env['FIELD_GUIDE_FIXTURES'] === '1' || command === 'dev';
}
