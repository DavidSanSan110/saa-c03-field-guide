// Sidecar (check file) splicing: sets one top-level key of a draft's private check file as text,
// leaving the other lines alone. No file system access: tools/questions/src/cli.ts does the I/O.
import { isMap, isNode, isScalar, parseAllDocuments, parseDocument, stringify } from 'yaml';

/** The offset just after the line that holds `at` (or `at` itself when it starts a line). */
function endOfLine(text: string, at: number): number {
  if (at > 0 && text[at - 1] === '\n') return at;
  const newline = text.indexOf('\n', at);
  return newline === -1 ? text.length : newline + 1;
}

/**
 * New sidecar text: `existing` (or nothing) with the top-level `key` set to `value`, written in
 * block style. Only the lines of that key change (a new key goes last), so the comments and the
 * text of the other keys stay as they are; line endings become LF. Throws on invalid YAML, a
 * non-mapping, or when the result would not hold exactly the input mapping with only `key`
 * replaced.
 */
export function withSidecarKey(existing: string | undefined, key: string, value: unknown): string {
  const { text, expected } = splice(existing, key, value);
  if (!holdsExactly(text, expected)) {
    throw new Error('cannot update this sidecar safely; fix it by hand');
  }
  return text;
}

/** Structural equality of parsed YAML values, including the order of the keys. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const x = Object.entries(a);
    const y = Object.entries(b);
    return (
      Object.getPrototypeOf(a) === Object.prototype &&
      Object.getPrototypeOf(b) === Object.prototype &&
      x.length === y.length &&
      x.every(([key, value], index) => key === y[index]?.[0] && sameValue(value, y[index]?.[1]))
    );
  }
  return Object.is(a, b);
}

/** True when `text` is one YAML document, without errors, whose value is `expected`. */
function holdsExactly(text: string, expected: unknown): boolean {
  const documents = parseAllDocuments(text);
  const [only] = documents;
  if (documents.length !== 1 || only === undefined || only.errors.length > 0) return false;
  try {
    return sameValue(only.toJS(), expected);
  } catch {
    // For instance an alias whose anchor is gone.
    return false;
  }
}

/**
 * The new text, and the value it must parse to: the old mapping with `key` replaced in place, or
 * added last.
 */
function splice(
  existing: string | undefined,
  key: string,
  value: unknown,
): { text: string; expected: Record<string, unknown> } {
  const text = (existing ?? '').replace(/\r\n?/g, '\n');
  const doc = parseDocument(text);
  const [problem] = doc.errors;
  if (problem !== undefined) throw new Error(`invalid YAML: ${problem.message}`);
  const { contents } = doc;
  // An empty file, only comments, or only a document marker count as an empty mapping.
  const isEmpty =
    contents === null ||
    (isScalar(contents) && contents.value === null && contents.range?.[0] === contents.range?.[1]);
  // A top-level { ... } has no lines to replace, so only a block mapping is accepted.
  if (!isEmpty && !(isMap(contents) && contents.flow !== true)) {
    throw new Error('the YAML top level must be a block mapping');
  }

  const old = (isMap(contents) ? doc.toJS() : {}) as Record<string, unknown>;
  const expected = { ...old, [key]: value };
  const block = stringify({ [key]: value }, { lineWidth: 0 });
  const pair = isMap(contents)
    ? contents.items.find((item) => isScalar(item.key) && item.key.value === key)
    : undefined;
  const keyStart = isNode(pair?.key) ? pair.key.range?.[0] : undefined;
  if (pair === undefined || keyStart === undefined) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    return { text: `${text}${separator}${block}`, expected };
  }
  const valueEnd = isNode(pair.value) ? pair.value.range?.[1] : undefined;
  const start = text.lastIndexOf('\n', keyStart - 1) + 1;
  const end = endOfLine(text, valueEnd ?? keyStart);
  return { text: `${text.slice(0, start)}${block}${text.slice(end)}`, expected };
}
