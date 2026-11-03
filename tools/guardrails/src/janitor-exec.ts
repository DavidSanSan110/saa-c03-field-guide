// Real aws and gh calls for the lab janitor (spec 043, AC-39).
// Runs with plain Node (`node --experimental-strip-types`): node: imports and erasable syntax only.
// Calls the program without a shell. It always resolves: a failed call is only an exit code here,
// because its output can hold an ARN or an account ID, so nothing of it is kept or written.
import { execFile } from 'node:child_process';
import type { Exec } from './janitor.ts';

// Tagging output can be large.
const MAX_BUFFER = 64 * 1024 * 1024;

export const runProgram: Exec = (file, args, input) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        file,
        args,
        { encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true },
        (error, stdout) => {
          // The child's stderr is the callback's third argument, and it is dropped on purpose.
          if (error === null) {
            resolve({ code: 0, stdout });
            return;
          }
          resolve({
            code: typeof error.code === 'number' && error.code !== 0 ? error.code : 1,
            stdout,
          });
        },
      );
      // A child that exits before reading its input would raise an unhandled EPIPE here.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    } catch {
      // A synchronous throw, such as an argument holding a NUL.
      resolve({ code: 1, stdout: '' });
    }
  });
