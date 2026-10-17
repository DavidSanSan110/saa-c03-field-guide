// The `docker run` invocation that runs the Playwright e2e tests in the pinned container.

const EXCLUDED = [
  'node_modules',
  '.git',
  'private',
  'test-results',
  'playwright-report',
  'dist',
  '.astro',
];

/** Single-quotes `value` for bash, so it reaches the command literally. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The bash script the container runs: copy the repo, install, build, `pnpm e2e`, copy results back. */
export function containerScript(playwrightArgs: string[]): string {
  const excludes = EXCLUDED.map((name) => `--exclude=${name}`).join(' ');
  const e2e = ['pnpm', 'e2e', ...playwrightArgs.map(shellQuote)].join(' ');
  return [
    'set -euo pipefail',
    'mkdir -p /work',
    `tar -C /src ${excludes} -cf - . | tar -C /work -xf -`,
    'cd /work',
    'corepack enable',
    'pnpm install --frozen-lockfile',
    'pnpm build',
    'status=0',
    `${e2e} || status=$?`,
    // Results come back even when Playwright failed.
    `find e2e -type d -name '*-snapshots' -prune | while IFS= read -r dir; do`,
    '  mkdir -p "/src/$dir"',
    '  cp -R "$dir/." "/src/$dir/"',
    'done',
    'for dir in test-results playwright-report; do',
    '  if [ -d "$dir" ]; then',
    '    mkdir -p "/src/$dir"',
    '    cp -R "$dir/." "/src/$dir/"',
    '  fi',
    'done',
    'exit "$status"',
  ].join('\n');
}

/** The arguments of `docker` (without the program name) for one containerised e2e run. */
export function dockerRunArgs(opts: {
  repoDir: string;
  image: string;
  playwrightArgs: string[];
}): string[] {
  return [
    'run',
    '--rm',
    '--ipc=host',
    '-e',
    'FIELD_GUIDE_VISUAL=1',
    '-v',
    `${opts.repoDir}:/src`,
    opts.image,
    'bash',
    '-c',
    containerScript(opts.playwrightArgs),
  ];
}
