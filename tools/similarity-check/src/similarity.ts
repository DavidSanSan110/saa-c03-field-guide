// Similarity check logic (spec 021): long word runs shared between a text and a corpus.

export interface Word {
  word: string;
  line: number;
}

const BOM = String.fromCodePoint(0xfeff);

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
  const normalised = (text.startsWith(BOM) ? text.slice(1) : text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/gu, '');
  const found: Word[] = [];
  normalised.split('\n').forEach((lineText, index) => {
    for (const word of lineText.match(/[\p{L}\p{N}]+/gu) ?? []) {
      found.push({ word, line: index + 1 });
    }
  });
  return found;
}

function windowAt(list: Word[], start: number, size: number): string {
  let joined = (list[start] as Word).word;
  for (let i = start + 1; i < start + size; i++) joined += ` ${(list[i] as Word).word}`;
  return joined;
}

/** Indexes the runs of `minWords` consecutive words of every corpus file (name -> text). */
export function buildIndex(corpus: Record<string, string>, minWords: number): CorpusIndex {
  const windows = new Map<string, Spot>();
  const names = Object.keys(corpus);
  for (const file of names) {
    const list = words(corpus[file] as string);
    for (let i = 0; i + minWords <= list.length; i++) {
      const key = windowAt(list, i, minWords);
      if (!windows.has(key)) windows.set(key, { file, line: (list[i] as Word).line });
    }
  }
  return { minWords, files: names.length, windows };
}

/** The maximal runs of at least `index.minWords` words of `text` that one corpus file contains. */
export function findMatches(text: string, index: CorpusIndex): Match[] {
  const { minWords, windows } = index;
  const list = words(text);
  const matches: Match[] = [];
  let open: { start: number; end: number; spot: Spot } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    matches.push({
      line: (list[open.start] as Word).line,
      length: open.end - open.start,
      text: list
        .slice(open.start, open.end)
        .map((entry) => entry.word)
        .join(' '),
      corpusFile: open.spot.file,
      corpusLine: open.spot.line,
    });
    open = undefined;
  };
  for (let i = 0; i + minWords <= list.length; i++) {
    const spot = windows.get(windowAt(list, i, minWords));
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
