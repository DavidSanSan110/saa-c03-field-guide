// Guardrail rules: pure path, content, question, commit-message and push checks, one table entry per rule.
import { validateQuestion } from '@field-guide/schema';
import { parse } from 'yaml';

export interface Violation {
  file: string;
  rule: string;
  message: string;
}

interface PathRule {
  id: string;
  message: string;
  /**
   * Receives the lower-cased path (path rules are case-insensitive, as Windows and macOS file
   * systems are) with '/' separators and no leading './', split into segments.
   */
  blocks: (path: string, segments: string[], name: string) => boolean;
}

interface ContentRule {
  id: string;
  message: string;
  pattern: RegExp;
}

/** Normalises separators so that every path rule sees the same shape. */
function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
}

const SOURCE_EXTENSIONS = /\.(pdf|pptx?|key|srt|vtt)$/i;
const KEY_EXTENSIONS = /\.(pem|p12|pfx)$/i;
const STATE_FILES = /\.tfstate(\..*)?$/i;

const PATH_RULES: PathRule[] = [
  {
    id: 'private-path',
    message: 'private/ is a separate private repository and must never be committed here',
    blocks: (_path, segments) => segments[0] === 'private',
  },
  {
    id: 'local-only',
    message: 'CLAUDE.md, PLAN.md and .claude/ are local-only files',
    blocks: (path, segments) =>
      path === 'claude.md' ||
      path === 'plan.md' ||
      (segments.length > 1 && segments[0] === '.claude'),
  },
  {
    id: 'source-material',
    message:
      'course or source material (slides, subtitles, course code, quizzes) must stay private',
    blocks: (_path, segments, name) =>
      SOURCE_EXTENSIONS.test(name) ||
      name === 'quiz.md' ||
      segments.some((segment) => /^code_v\d/.test(segment)),
  },
  {
    id: 'secret-file',
    message: 'keys, .env files and Terraform state may contain secrets',
    blocks: (_path, _segments, name) =>
      KEY_EXTENSIONS.test(name) ||
      name === '.env' ||
      (name.startsWith('.env.') && name !== '.env.example') ||
      STATE_FILES.test(name),
  },
];

// Blocked names are assembled from parts so that this file does not contain them (AC-16).
const CONTENT_RULES: ContentRule[] = [
  {
    id: 'client-reference',
    message: 'client, employer or local machine reference',
    pattern: new RegExp(
      [['kraken', 'legrand'].join(''), 'telef[oó]nica', 'c:(\\\\+|/+)users(\\\\+|/+)'].join('|'),
      'i',
    ),
  },
];

const COMMIT_RULES: ContentRule[] = [
  {
    id: 'ai-attribution',
    message: 'AI attribution is not allowed in commit messages',
    pattern: /^\s*co-authored-by:.*(\bclaude\b|anthropic\.com)|generated with \[?claude code/i,
  },
];

/** `path` is relative to the repo root; '/' and '\' separators are both accepted. */
export function checkPath(path: string): Violation[] {
  const normalised = normalisePath(path).toLowerCase();
  const segments = normalised.split('/');
  const name = segments.at(-1) ?? '';
  return PATH_RULES.filter((rule) => rule.blocks(normalised, segments, name)).map((rule) => ({
    file: path,
    rule: rule.id,
    message: rule.message,
  }));
}

export function checkContent(path: string, text: string): Violation[] {
  if (text.includes('\u0000')) return [];
  return CONTENT_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => ({
    file: path,
    rule: rule.id,
    message: rule.message,
  }));
}

/** True for the files that the question rules apply to. */
export function isQuestionFile(path: string): boolean {
  return /^questions\/.+\.ya?ml$/i.test(normalisePath(path));
}

export function checkQuestionFile(path: string, yamlText: string): Violation[] {
  const fail = (message: string): Violation => ({ file: path, rule: 'question-schema', message });

  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (error) {
    return [fail(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`)];
  }

  const result = validateQuestion(data, { publicOnly: true });
  if (!result.ok) return result.errors.map(fail);

  const { domain, task } = result.question;
  const folder = `questions/d${domain}/${task}/`;
  if (!normalisePath(path).startsWith(folder)) {
    return [fail(`a question with domain ${domain} and task ${task} must live under ${folder}`)];
  }
  return [];
}

/** Violations use `COMMIT_EDITMSG` as their `file`. */
export function checkCommitMessage(message: string): Violation[] {
  const lines = message.split(/\r?\n/);
  return COMMIT_RULES.filter((rule) => lines.some((line) => rule.pattern.test(line))).map(
    (rule) => ({ file: 'COMMIT_EDITMSG', rule: rule.id, message: rule.message }),
  );
}

/** `prePushStdin` holds git pre-push lines: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function checkPushRefs(prePushStdin: string): Violation[] {
  const violations: Violation[] = [];
  for (const line of prePushStdin.split(/\r?\n/)) {
    const [localRef, , remoteRef] = line.trim().split(/\s+/);
    if (remoteRef === 'refs/heads/main') {
      violations.push({
        file: 'pre-push',
        rule: 'push-main',
        message: `direct push of ${localRef ?? '?'} to main is not allowed; open a pull request`,
      });
    }
  }
  return violations;
}
