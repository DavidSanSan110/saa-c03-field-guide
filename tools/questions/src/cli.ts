// Questions CLI: argument parsing, file I/O and exit codes only; the logic is in bank.ts.
// Interface stub only: the behaviour comes after the locked tests (spec 019).

/** Runs the CLI and resolves to the process exit code (0 ok, 1 problems, 2 usage error). */
export function main(argv: string[]): Promise<number> {
  void argv;
  throw new Error('not implemented');
}

process.exitCode = await main(process.argv.slice(2));
