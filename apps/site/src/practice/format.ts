// Pure formatting helpers for the practice-test island (spec 027).

/** Milliseconds as `H:MM:SS`: floors to whole seconds, never negative, hours are not padded. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** The letter shown at a display position: 0 is "A". */
export function letterAt(position: number): string {
  return String.fromCharCode(65 + position);
}

/**
 * The letters a visitor sees for option `keys` when the options are shown in `optionOrder`:
 * the key at position 0 is "A", at position 1 "B"… Returned sorted. Keys that are not in
 * `optionOrder` are ignored.
 */
export function displayLetters(optionOrder: readonly string[], keys: readonly string[]): string[] {
  return optionOrder
    .flatMap((key, position) => (keys.includes(key) ? [letterAt(position)] : []))
    .sort();
}
