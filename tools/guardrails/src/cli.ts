// Guardrails CLI: interface stub for private spec 003 (tests first, implementation follows).

/** Runs one CLI command and resolves to the process exit code (0 ok, 1 violations, 2 usage). */
export function main(argv: string[]): Promise<number> {
  void argv;
  return Promise.reject(new Error('not implemented'));
}

process.exitCode = await main(process.argv.slice(2));
