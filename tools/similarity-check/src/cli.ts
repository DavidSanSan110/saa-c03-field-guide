// Similarity check CLI (spec 021). Interface stub: the implementation comes after the tests.

/** Runs the CLI and resolves to the process exit code (0 ok, 1 match or no corpus, 2 usage). */
export function main(argv: string[]): Promise<number> {
  void argv;
  throw new Error('not implemented');
}

process.exitCode = await main(process.argv.slice(2));
