// The rules for apps/site/headers.json (spec 035, section 7), in TypeScript. The lab's response
// headers policy enforces the same rules as plan preconditions (labs/00-site-hosting/cdn.tf); this
// copy runs on every `pnpm verify`, so a bad edit fails before the PR plan does.

/** The five headers CloudFront has a dedicated field for; the lab requires all of them. */
const REQUIRED = [
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
] as const;

const HSTS = /^max-age=[0-9]+(; *includeSubDomains)?(; *preload)?$/i;

const REFERRER_POLICIES = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
];

/** CloudFront rejects a Content-Security-Policy header value above this many characters. */
export const MAX_CSP_LENGTH = 1783;

/** The problems of a header set: one message per problem, empty when it is valid. */
export function validateSiteHeaders(headers: Record<string, string>): string[] {
  const problems: string[] = [];
  const byName = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (byName.has(lower)) {
      problems.push(`${name} appears twice with different letter case`);
    } else if (typeof value !== 'string') {
      problems.push(`${name} must have a string value`);
    } else {
      byName.set(lower, value);
    }
  }

  for (const name of REQUIRED) {
    if (!byName.has(name.toLowerCase())) problems.push(`${name} is missing`);
  }

  const hsts = byName.get('strict-transport-security');
  if (hsts !== undefined && !HSTS.test(hsts)) {
    problems.push(
      'Strict-Transport-Security must be max-age=<seconds>, optionally followed by ' +
        '"; includeSubDomains" and then "; preload"',
    );
  }
  const nosniff = byName.get('x-content-type-options');
  if (nosniff !== undefined && nosniff !== 'nosniff') {
    problems.push('X-Content-Type-Options must be nosniff');
  }
  const frame = byName.get('x-frame-options');
  if (frame !== undefined && frame !== 'DENY' && frame !== 'SAMEORIGIN') {
    problems.push('X-Frame-Options must be DENY or SAMEORIGIN');
  }
  const referrer = byName.get('referrer-policy');
  if (referrer !== undefined && !REFERRER_POLICIES.includes(referrer)) {
    problems.push(`Referrer-Policy must be one of: ${REFERRER_POLICIES.join(', ')}`);
  }
  const csp = byName.get('content-security-policy');
  if (csp !== undefined && Array.from(csp).length > MAX_CSP_LENGTH) {
    problems.push(`Content-Security-Policy is longer than ${MAX_CSP_LENGTH} characters`);
  }
  return problems;
}
