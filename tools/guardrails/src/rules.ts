// Guardrail rules: interface stubs for private spec 003 (tests first, implementation follows).

export interface Violation {
  file: string;
  rule: string;
  message: string;
}

/** `path` is relative to the repo root; '/' and '\' separators are both accepted. */
export function checkPath(path: string): Violation[] {
  void path;
  throw new Error('not implemented');
}

export function checkContent(path: string, text: string): Violation[] {
  void path;
  void text;
  throw new Error('not implemented');
}

export function checkQuestionFile(path: string, yamlText: string): Violation[] {
  void path;
  void yamlText;
  throw new Error('not implemented');
}

/** Violations use `COMMIT_EDITMSG` as their `file`. */
export function checkCommitMessage(message: string): Violation[] {
  void message;
  throw new Error('not implemented');
}

/** `prePushStdin` holds git pre-push lines: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function checkPushRefs(prePushStdin: string): Violation[] {
  void prePushStdin;
  throw new Error('not implemented');
}
