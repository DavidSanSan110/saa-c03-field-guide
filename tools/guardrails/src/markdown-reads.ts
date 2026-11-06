// Guardrail (spec 047): no lab or module reads a Markdown file or a whole folder. Pure, no I/O.

/** The problems in one `.tf` file's text, one message per problem, `[]` when there is none. */
export function markdownReads(text: string): string[] {
  void text;
  throw new Error('not implemented');
}
