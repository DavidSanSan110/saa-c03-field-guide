// The Playwright container image of the e2e job of ci.yml: the one source of the pinned image.
import { parse } from 'yaml';

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The image of `jobs.e2e.container` (a string, or an object with `image`) in the text of ci.yml.
 * Throws a message naming `jobs.e2e.container` when the job, the container or the image is missing.
 */
export function ciPlaywrightImage(ciYaml: string): string {
  const doc: unknown = parse(ciYaml);
  const jobs = isDict(doc) ? doc['jobs'] : undefined;
  const job = isDict(jobs) ? jobs['e2e'] : undefined;
  const container = isDict(job) ? job['container'] : undefined;
  const image = isDict(container) ? container['image'] : container;
  if (typeof image !== 'string' || image === '') {
    throw new Error('ci.yml has no image at jobs.e2e.container');
  }
  return image;
}
