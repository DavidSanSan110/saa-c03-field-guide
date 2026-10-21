// Cache-Control values of the deployed site (spec 036). The deploy workflow uploads with them and
// the smoke test checks the live responses against them.

/** Pages, bank.json and everything outside /_astro/: revalidated at the edge once a day. */
export const HTML_CACHE_CONTROL = 'max-age=0, s-maxage=86400, must-revalidate';

/** Hashed build assets under /_astro/: cached for a year. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
