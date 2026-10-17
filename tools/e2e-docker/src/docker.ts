// The `docker run` invocation that runs the Playwright e2e tests in the pinned container.

/** The bash script the container runs: copy the repo, install, build, `pnpm e2e`, copy results back. */
export function containerScript(playwrightArgs: string[]): string {
  void playwrightArgs;
  throw new Error('not implemented');
}

/** The arguments of `docker` (without the program name) for one containerised e2e run. */
export function dockerRunArgs(opts: {
  repoDir: string;
  image: string;
  playwrightArgs: string[];
}): string[] {
  void opts;
  throw new Error('not implemented');
}
