// Guardrail (spec 047): no lab or module reads a Markdown file or a whole folder. Pure, no I/O.

const WHOLE_FOLDER = /\bfileset\s*\(|\bsource_dir\s*=/;
const FILE_READ =
  /\b(?:file|filebase64|filemd5|filesha1|filesha256|filesha512|filebase64sha256|filebase64sha512|fileexists|templatefile)\s*\(|\bsource_file\b/;
const MARKDOWN_NAME = /\.md(?:\W|$)/i;

/** The problems in one `.tf` file's text, one message per problem, `[]` when there is none. */
export function markdownReads(text: string): string[] {
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `line ${index + 1}`;
    if (WHOLE_FOLDER.test(line)) problems.push(`${where}: reads a whole folder`);
    if (FILE_READ.test(line) && MARKDOWN_NAME.test(line)) {
      problems.push(`${where}: reads a Markdown file`);
    }
  });
  return problems;
}
