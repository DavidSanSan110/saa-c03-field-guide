// Diagram files loader (spec 013). Interface stub: the implementation comes after the tests.

/** Max caption length for diagram files (the schema allows 300; files keep captions short for narrow screens). */
export const MAX_FILE_CAPTION_LENGTH = 140;

/** Reads and parses `<dir>/<id>.yaml`; throws an Error whose message names the problem. */
export function readDiagramFile(dir: string, id: string): unknown {
  void [dir, id];
  throw new Error('not implemented');
}

/** Every problem in a diagrams folder, as human-readable lines; [] when all is well. */
export function checkDiagramFiles(
  dir: string,
  opts: { iconExists: (publicPath: string) => boolean },
): Promise<string[]> {
  void [dir, opts];
  return Promise.reject(new Error('not implemented'));
}
