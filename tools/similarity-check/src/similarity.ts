// Similarity check logic (spec 021): long word runs shared between a text and a corpus.

export interface Word {
  word: string;
  line: number;
}

interface Spot {
  file: string;
  line: number;
}

export interface CorpusIndex {
  minWords: number;
  files: number;
  /** Every window of `minWords` words (joined by spaces) -> where it first occurs. */
  windows: ReadonlyMap<string, Spot>;
}

export interface Match {
  line: number;
  length: number;
  text: string;
  corpusFile: string;
  corpusLine: number;
}

/** The normalised words of a text, each with its 1-based line number. */
export function words(text: string): Word[] {
  // Format characters (soft hyphen, zero-width space, BOM...) are invisible, so they are removed.
  const normalised = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .replace(/['’]/gu, '');
  const found: Word[] = [];
  normalised.split('\n').forEach((lineText, index) => {
    for (const word of lineText.match(/[\p{L}\p{N}]+/gu) ?? []) {
      found.push({ word, line: index + 1 });
    }
  });
  return found;
}

/** The key of a window: its words joined by spaces (a flat string, cheap to keep in a Map). */
function windowAt(texts: string[], start: number, size: number): string {
  return texts.slice(start, start + size).join(' ');
}

/**
 * Prepares Markdown text for matching, keeping its line numbers: link targets `](...)` go (the
 * link text stays), apostrophe entities go like `'`, any other entity becomes a space.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/\]\([^)\n]*\)/gu, '')
    .replace(/&(?:rsquo|apos|#39|#x27|#8217|#x2019);/giu, '')
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/giu, ' ');
}

/** Indexes the runs of `minWords` consecutive words of every corpus file (name -> text). */
export function buildIndex(corpus: Record<string, string>, minWords: number): CorpusIndex {
  const windows = new Map<string, Spot>();
  const names = Object.keys(corpus);
  for (const file of names) {
    const list = words(corpus[file] as string);
    const texts = list.map((entry) => entry.word);
    for (let i = 0; i + minWords <= list.length; i++) {
      const key = windowAt(texts, i, minWords);
      if (!windows.has(key)) windows.set(key, { file, line: (list[i] as Word).line });
    }
  }
  return { minWords, files: names.length, windows };
}

/** The maximal runs of at least `index.minWords` words of `text` that one corpus file contains. */
export function findMatches(text: string, index: CorpusIndex): Match[] {
  const { minWords, windows } = index;
  const list = words(text);
  const texts = list.map((entry) => entry.word);
  const matches: Match[] = [];
  let open: { start: number; end: number; spot: Spot } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    matches.push({
      line: (list[open.start] as Word).line,
      length: open.end - open.start,
      text: texts.slice(open.start, open.end).join(' '),
      corpusFile: open.spot.file,
      corpusLine: open.spot.line,
    });
    open = undefined;
  };
  for (let i = 0; i + minWords <= list.length; i++) {
    const spot = windows.get(windowAt(texts, i, minWords));
    if (spot === undefined) {
      close();
    } else if (open !== undefined && open.end === i + minWords - 1) {
      open.end = i + minWords;
    } else {
      close();
      open = { start: i, end: i + minWords, spot };
    }
  }
  close();
  return matches;
}
