// Exam planning helpers for the practice-test island (spec 027).

/** The time limit of an exam of `size` questions: 2 minutes per question, in milliseconds. */
export function examDurationMs(size: number): number {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`size must be a positive integer, got ${size}`);
  }
  return size * 120_000;
}
