// The Playwright container image of the e2e job of ci.yml: the one source of the pinned image.

/**
 * The image of `jobs.e2e.container` (a string, or an object with `image`) in the text of ci.yml.
 * Throws a message naming `jobs.e2e.container` when the job, the container or the image is missing.
 */
export function ciPlaywrightImage(ciYaml: string): string {
  void ciYaml;
  throw new Error('not implemented');
}
