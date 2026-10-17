// Similarity check logic (spec 021). Interface stub: the implementation comes after the tests.

export interface Word {
  word: string;
  line: number;
}

export interface CorpusIndex {
  minWords: number;
  files: number;
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
  void text;
  throw new Error('not implemented');
}

/** Indexes the runs of `minWords` consecutive words of every corpus file (name -> text). */
export function buildIndex(corpus: Record<string, string>, minWords: number): CorpusIndex {
  void corpus;
  void minWords;
  throw new Error('not implemented');
}

/** The maximal runs of at least `index.minWords` words of `text` that one corpus file contains. */
export function findMatches(text: string, index: CorpusIndex): Match[] {
  void text;
  void index;
  throw new Error('not implemented');
}
