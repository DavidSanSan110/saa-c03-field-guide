// Real aws and gh calls for the lab janitor (spec 043, AC-39): interface stub, not written yet.
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.
import type { Exec } from './janitor.ts';

export const runProgram: Exec = () => {
  throw new Error('not implemented');
};
