import { validateQuestion } from '@field-guide/schema';
import { describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import {
  checkCommitMessage,
  checkContent,
  checkPath,
  checkPushRefs,
  checkQuestionFile,
} from './rules.ts';
import type { Violation } from './rules.ts';

// AC-16: blocked strings are never written literally; they are assembled at runtime.
const CLIENT = 'Kraken' + 'Legrand';
const OPERATOR_ACCENTED = 'Telef' + 'ónica';
const OPERATOR_PLAIN = 'Telef' + 'onica';
const WINDOWS_USER_PATH = ['c:', 'users', 'bob', 'x'].join('\\');
const TRAILER = 'Co-Authored-By' + ': ';
const AI_NAME = 'Clau' + 'de';
const AI_DOMAIN = 'anthro' + 'pic.com';
const GENERATED = 'Generated' + ' with ';

/** Distinct rule ids of a result, sorted. */
function ruleIds(violations: Violation[]): string[] {
  return [...new Set(violations.map((violation) => violation.rule))].sort();
}

describe('checkPath: private-path', () => {
  test.each(['private/notes.md', 'private\\x\\y.md', 'private/a/b/c/d.md'])(
    'AC-1: flags %s as private-path',
    (path) => {
      expect(ruleIds(checkPath(path))).toEqual(['private-path']);
    },
  );

  test.each(['docs/private-notes.md', 'apps/private.ts', 'docs/private/notes.md'])(
    'AC-1: does not flag %s (only the first segment counts)',
    (path) => {
      expect(checkPath(path)).toEqual([]);
    },
  );

  test('AC-1: a violation carries the checked path, the rule id and a message', () => {
    const [violation, ...rest] = checkPath('private/notes.md');
    expect(rest).toEqual([]);
    expect(violation).toMatchObject({ file: 'private/notes.md', rule: 'private-path' });
    expect(violation?.message).not.toBe('');
  });
});

describe('checkPath: local-only', () => {
  test.each(['CLAUDE.md', 'PLAN.md', '.claude/settings.json', '.claude\\worktrees\\a\\b.txt'])(
    'AC-2: flags %s as local-only',
    (path) => {
      expect(ruleIds(checkPath(path))).toEqual(['local-only']);
    },
  );

  test.each(['docs/PLAN.md.example', 'apps/site/CLAUDE.mdx'])('AC-2: does not flag %s', (path) => {
    expect(checkPath(path)).toEqual([]);
  });

  test('AC-2: CLAUDE.md and PLAN.md are only local-only at the root', () => {
    expect(checkPath('packages/schema/PLAN.md')).toEqual([]);
    expect(checkPath('docs/CLAUDE.md')).toEqual([]);
  });
});

describe('checkPath: source-material', () => {
  test.each([
    'slides/SAA.PDF',
    'a.pptx',
    'deck.ppt',
    'talk.key',
    'lecture.srt',
    't.vtt',
    'tools/code_v2025-10-27/x.js',
    'code_v1/readme.txt',
    '12-s3/quiz.md',
    'quiz.md',
  ])('AC-3: flags %s as source-material', (path) => {
    expect(ruleIds(checkPath(path))).toEqual(['source-material']);
  });

  test.each(['code_viewer.ts', 'docs/quizzes.md', 'key.ts', 'docs/pdf-notes.md'])(
    'AC-3: does not flag %s',
    (path) => {
      expect(checkPath(path)).toEqual([]);
    },
  );
});

describe('checkPath: secret-file', () => {
  test.each([
    'id.pem',
    'cert.p12',
    'bundle.pfx',
    '.env',
    'apps/site/.env.local',
    '.env.production',
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'labs/01/terraform.tfstate',
  ])('AC-4: flags %s as secret-file', (path) => {
    expect(ruleIds(checkPath(path))).toEqual(['secret-file']);
  });

  test.each(['.env.example', 'apps/site/.env.example'])('AC-4: does not flag %s', (path) => {
    expect(checkPath(path)).toEqual([]);
  });
});

describe('checkPath: ordinary files', () => {
  test.each([
    'README.md',
    'packages/schema/src/exam.ts',
    'questions/d1/1.3/a.yaml',
    '.github/workflows/ci.yml',
  ])('AC-5: returns no violation for %s', (path) => {
    expect(checkPath(path)).toEqual([]);
  });
});

describe('checkContent', () => {
  test.each([
    ['the client name', `Notes copied from the ${CLIENT} workspace.`],
    [
      'the operator name with an accent in lower case',
      `${OPERATOR_ACCENTED.toLowerCase()} project`,
    ],
    ['the operator name in upper case without accent', OPERATOR_PLAIN.toUpperCase()],
    ['the operator name in title case without accent', `Ask ${OPERATOR_PLAIN} about it`],
    ['a Windows user path in lower case', `open ${WINDOWS_USER_PATH} now`],
    ['a Windows user path in upper case', `open ${WINDOWS_USER_PATH.toUpperCase()} now`],
  ])('AC-6: flags text containing %s as client-reference', (_label, text) => {
    expect(ruleIds(checkContent('docs/notes.md', text))).toEqual(['client-reference']);
  });

  test('AC-6: a violation carries the checked path and the rule id', () => {
    const [violation] = checkContent('docs/notes.md', CLIENT);
    expect(violation).toMatchObject({ file: 'docs/notes.md', rule: 'client-reference' });
  });

  test('AC-6: returns [] for normal text', () => {
    const text = 'S3 supports SSE-S3, SSE-KMS and SSE-C.\nSee https://docs.aws.amazon.com/.\n';
    expect(checkContent('docs/notes.md', text)).toEqual([]);
  });

  test('AC-6: returns [] for an empty file', () => {
    expect(checkContent('docs/empty.md', '')).toEqual([]);
  });

  test('AC-6: returns [] for binary-looking text, even if it contains a blocked string', () => {
    expect(checkContent('assets/blob.bin', `\u0000\u0001 ${CLIENT} \u0000`)).toEqual([]);
    expect(checkContent('assets/blob.bin', 'plain\u0000text')).toEqual([]);
  });
});

/** A question that is valid under spec 002 with status reviewed (task 1.3 belongs to domain 1). */
function reviewedQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'd1-1.3-0007',
    domain: 1,
    task: '1.3',
    services: ['s3', 'kms'],
    difficulty: 'medium',
    type: 'single',
    stem:
      'A company must encrypt objects in Amazon S3 at rest. Its security policy says ' +
      'encryption keys must be kept on-premises. Which option meets these requirements?',
    options: [
      { key: 'A', text: 'SSE-S3', correct: false, why: 'AWS creates and stores the keys.' },
      { key: 'B', text: 'SSE-KMS', correct: false, why: 'The KMS key is stored in AWS.' },
      { key: 'C', text: 'SSE-C', correct: true, why: 'The key is supplied with each request.' },
      { key: 'D', text: 'Client-side', correct: false, why: 'Encryption happens before upload.' },
    ],
    references: [
      'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerSideEncryptionCustomerKeys.html',
    ],
    status: 'reviewed',
    provenance: { generated_by: 'model-a', verified_by: 'model-b', reviewed_by: 'owner' },
    ...overrides,
  };
}

const QUESTION_PATH = 'questions/d1/1.3/x.yaml';

describe('checkQuestionFile', () => {
  test('AC-7: the fixture is a valid reviewed question (sanity check of the test data)', () => {
    expect(validateQuestion(reviewedQuestion(), { publicOnly: true }).ok).toBe(true);
  });

  test('AC-7: returns [] for a valid reviewed question at questions/d1/1.3/x.yaml', () => {
    expect(checkQuestionFile(QUESTION_PATH, stringify(reviewedQuestion()))).toEqual([]);
  });

  test('AC-7: a valid question in a subfolder of its own domain/task folder is accepted', () => {
    expect(
      checkQuestionFile('questions/d1/1.3/extra/x.yml', stringify(reviewedQuestion())),
    ).toEqual([]);
  });

  test('AC-7: backslash separators are accepted for a correctly placed question', () => {
    expect(checkQuestionFile('questions\\d1\\1.3\\x.yaml', stringify(reviewedQuestion()))).toEqual(
      [],
    );
  });

  test('AC-7: flags invalid YAML as question-schema', () => {
    const violations = checkQuestionFile(QUESTION_PATH, 'id: [unclosed\nstem: "oops\n  : : :');
    expect(violations.length).toBeGreaterThan(0);
    expect(ruleIds(violations)).toEqual(['question-schema']);
    expect(violations.every((violation) => violation.file === QUESTION_PATH)).toBe(true);
  });

  test('AC-7: flags an empty document as question-schema', () => {
    expect(ruleIds(checkQuestionFile(QUESTION_PATH, ''))).toEqual(['question-schema']);
  });

  test('AC-7: flags a draft question as question-schema', () => {
    const draft = reviewedQuestion({ status: 'draft', provenance: { generated_by: 'model-a' } });
    expect(ruleIds(checkQuestionFile(QUESTION_PATH, stringify(draft)))).toEqual([
      'question-schema',
    ]);
  });

  test('AC-7: flags a schema error as question-schema', () => {
    const broken = reviewedQuestion({ difficulty: 'impossible' });
    expect(ruleIds(checkQuestionFile(QUESTION_PATH, stringify(broken)))).toEqual([
      'question-schema',
    ]);
  });

  test('AC-7: reports one violation per schema error', () => {
    const broken = reviewedQuestion({ difficulty: 'impossible', services: [] });
    const result = validateQuestion(broken, { publicOnly: true });
    if (result.ok) throw new Error('fixture should be invalid');
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const violations = checkQuestionFile(QUESTION_PATH, stringify(broken));
    expect(violations).toHaveLength(result.errors.length);
    expect(ruleIds(violations)).toEqual(['question-schema']);
  });

  test('AC-7: flags a valid question stored under the wrong domain folder', () => {
    const violations = checkQuestionFile('questions/d2/1.3/x.yaml', stringify(reviewedQuestion()));
    expect(violations).toHaveLength(1);
    expect(ruleIds(violations)).toEqual(['question-schema']);
  });

  test('AC-7: flags a valid question stored under the wrong task folder', () => {
    const violations = checkQuestionFile('questions/d1/1.2/x.yaml', stringify(reviewedQuestion()));
    expect(violations).toHaveLength(1);
    expect(ruleIds(violations)).toEqual(['question-schema']);
  });
});

describe('checkCommitMessage', () => {
  const aiTrailer = `${TRAILER}${AI_NAME} Opus 5.5 <noreply@${AI_DOMAIN}>`;

  test('AC-8: flags a Co-Authored-By trailer naming the AI assistant', () => {
    const violations = checkCommitMessage(`feat(x): add y\n\n${aiTrailer}\n`);
    expect(ruleIds(violations)).toEqual(['ai-attribution']);
    expect(violations.every((violation) => violation.file === 'COMMIT_EDITMSG')).toBe(true);
  });

  test('AC-8: flags a lower-case trailer with an assistant e-mail domain', () => {
    const message = `fix: z\n\n${TRAILER.toLowerCase()}Someone <x@${AI_DOMAIN}>\n`;
    expect(ruleIds(checkCommitMessage(message))).toEqual(['ai-attribution']);
  });

  test('AC-8: flags a trailer that only names the assistant, not its e-mail', () => {
    const message = `fix: z\n\n${TRAILER}${AI_NAME} <someone@example.com>\n`;
    expect(ruleIds(checkCommitMessage(message))).toEqual(['ai-attribution']);
  });

  test('AC-8: flags the generated-with line with a link', () => {
    const message = `docs: y\n\n🤖 ${GENERATED}[${AI_NAME} Code](https://claude.com/claude-code)\n`;
    expect(ruleIds(checkCommitMessage(message))).toEqual(['ai-attribution']);
  });

  test('AC-8: flags the generated-with line without a link, ignoring case', () => {
    const plain = `docs: y\n\n${GENERATED}${AI_NAME} Code\n`;
    const shouting = `docs: y\n\n${(GENERATED + AI_NAME + ' Code').toUpperCase()}\n`;
    expect(ruleIds(checkCommitMessage(plain))).toEqual(['ai-attribution']);
    expect(ruleIds(checkCommitMessage(shouting))).toEqual(['ai-attribution']);
  });

  test('AC-8: allows a Co-Authored-By trailer for a person', () => {
    expect(checkCommitMessage(`feat: y\n\n${TRAILER}Jane <jane@example.com>\n`)).toEqual([]);
  });

  test('AC-8: allows a plain conventional message', () => {
    expect(checkCommitMessage('feat(guardrails): add the path rules\n\nExplain why.\n')).toEqual(
      [],
    );
  });

  test('AC-8: allows a message that merely mentions the assistant in prose', () => {
    expect(checkCommitMessage(`docs: stop mentioning ${AI_NAME} in the guide\n`)).toEqual([]);
  });

  test('AC-8: allows an empty message', () => {
    expect(checkCommitMessage('')).toEqual([]);
  });
});

describe('checkPushRefs', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const ZERO = '0'.repeat(40);

  test('AC-9: flags a line pushing to refs/heads/main', () => {
    const violations = checkPushRefs(`refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`);
    expect(ruleIds(violations)).toEqual(['push-main']);
  });

  test('AC-9: flags a feature branch pushed to the remote main', () => {
    const line = `refs/heads/feat/2-guardrails ${SHA_A} refs/heads/main ${SHA_B}\n`;
    expect(ruleIds(checkPushRefs(line))).toEqual(['push-main']);
  });

  test('AC-9: flags the deletion of the remote main', () => {
    const line = `(delete) ${ZERO} refs/heads/main ${SHA_B}\n`;
    expect(ruleIds(checkPushRefs(line))).toEqual(['push-main']);
  });

  test('AC-9: flags main when it is one line among several, ignoring blank lines', () => {
    const stdin = [
      `refs/heads/feat/a ${SHA_A} refs/heads/feat/a ${ZERO}`,
      '',
      `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}`,
      '',
    ].join('\n');
    expect(ruleIds(checkPushRefs(stdin))).toEqual(['push-main']);
  });

  test('AC-9: allows refs/heads/feat/2-guardrails', () => {
    const line = `refs/heads/feat/2-guardrails ${SHA_A} refs/heads/feat/2-guardrails ${ZERO}\n`;
    expect(checkPushRefs(line)).toEqual([]);
  });

  test('AC-9: only an exact remote ref of refs/heads/main counts', () => {
    const stdin = [
      `refs/heads/main ${SHA_A} refs/heads/main-backup ${ZERO}`,
      `refs/heads/feat/m ${SHA_A} refs/heads/mainline ${ZERO}`,
    ].join('\n');
    expect(checkPushRefs(stdin)).toEqual([]);
  });

  test('AC-9: allows empty input and blank lines', () => {
    expect(checkPushRefs('')).toEqual([]);
    expect(checkPushRefs('\n\n')).toEqual([]);
  });
});

describe('checkPath: case-insensitive on Windows', () => {
  test.each([
    ['Private/x.md', 'private-path'],
    ['PRIVATE/x', 'private-path'],
    ['Private\\Notes\\a.md', 'private-path'],
    ['.Claude/settings.json', 'local-only'],
    ['claude.md', 'local-only'],
    ['Plan.md', 'local-only'],
    ['QUIZ.md', 'source-material'],
    ['12-S3/Quiz.MD', 'source-material'],
    ['.ENV', 'secret-file'],
    ['ID.PEM', 'secret-file'],
    ['Terraform.TFSTATE', 'secret-file'],
  ])('AC-17: flags %s as %s, like its lower-case form', (path, rule) => {
    expect(ruleIds(checkPath(path))).toEqual([rule]);
  });

  test.each(['.ENV.EXAMPLE', 'Apps/Site/.Env.Example'])(
    'AC-17: still allows the example file %s',
    (path) => {
      expect(checkPath(path)).toEqual([]);
    },
  );

  test.each(['docs/Private/notes.md', 'packages/schema/Plan.md', 'docs/Claude.md'])(
    'AC-17: keeps the root-only scope for %s',
    (path) => {
      expect(checkPath(path)).toEqual([]);
    },
  );
});

describe('checkPath: the bare private path', () => {
  test.each(['private', 'Private', 'PRIVATE'])(
    'AC-18: flags the bare path %s (the nested repo as a gitlink) as private-path',
    (path) => {
      expect(ruleIds(checkPath(path))).toEqual(['private-path']);
    },
  );

  test.each(['privateer', 'docs/private', 'private-notes'])(
    'AC-18: does not flag the similar path %s',
    (path) => {
      expect(checkPath(path)).toEqual([]);
    },
  );
});

describe('checkContent: Windows user paths in other notations', () => {
  const ESCAPED = 'C:' + '\\\\' + 'Users' + '\\\\' + 'bob' + '\\\\' + 'notes';
  const FORWARD = 'C:' + '/' + 'Users' + '/bob/notes';
  const FILE_URL = 'file:///' + 'C:' + '/' + 'Users' + '/bob/notes';

  test.each([
    ['the JSON-escaped form', `{"path": "${ESCAPED}"}`],
    ['the JSON-escaped form in lower case', ESCAPED.toLowerCase()],
    ['the JSON-escaped form in upper case', ESCAPED.toUpperCase()],
    ['the forward-slash form', `open ${FORWARD} now`],
    ['the forward-slash form in lower case', FORWARD.toLowerCase()],
    ['the forward-slash form in upper case', FORWARD.toUpperCase()],
    ['a file URL', `see ${FILE_URL}`],
    ['a file URL in upper case', FILE_URL.toUpperCase()],
  ])('AC-19: flags text containing %s as client-reference', (_label, text) => {
    expect(ruleIds(checkContent('docs/notes.md', text))).toEqual(['client-reference']);
  });

  test.each([
    ['a %USERPROFILE% path', '%USERPROFILE%' + '\\Documents\\notes'],
    ['a %USERPROFILE% path with forward slashes', '%USERPROFILE%' + '/Documents/notes'],
    ['a Unix-style /Users/ path', 'open ' + '/' + 'Users' + '/bob/notes'],
    ['a macOS home in prose', 'the ' + '/' + 'Users' + '/ folder on macOS'],
  ])('AC-19: does not flag %s', (_label, text) => {
    expect(checkContent('docs/notes.md', text)).toEqual([]);
  });
});

describe('checkCommitMessage: whole-word assistant name', () => {
  const person = `Co-authored-by: ${AI_NAME}tte Dupont <c@example.com>`;

  test('AC-21: allows a Co-authored-by trailer for a person whose name starts with the assistant name', () => {
    expect(checkCommitMessage(`feat: y\n\n${person}\n`)).toEqual([]);
  });

  test('AC-21: allows a person whose name merely contains the assistant name', () => {
    const message = `feat: y\n\n${TRAILER}Mc${AI_NAME}son <m@example.com>\n`;
    expect(checkCommitMessage(message)).toEqual([]);
  });

  test('AC-21: still flags the assistant name as a whole word after a first name', () => {
    const message = `feat: y\n\n${TRAILER}Jane ${AI_NAME} <j@example.com>\n`;
    expect(ruleIds(checkCommitMessage(message))).toEqual(['ai-attribution']);
  });

  test('AC-21: still flags the assistant name followed by punctuation', () => {
    const message = `feat: y\n\n${TRAILER}${AI_NAME}, Opus <j@example.com>\n`;
    expect(ruleIds(checkCommitMessage(message))).toEqual(['ai-attribution']);
  });
});

describe('checkContent: the drive letter must sit at a word boundary', () => {
  test.each([
    ['a grpc URL', 'grpc:' + '//' + 'users/list'],
    ['a custom scheme URL', 'svc:' + '//' + 'Users/v1'],
    ['a multi-letter prefix', 'abc' + ':/' + 'Users/'],
  ])('AC-25: does not flag %s', (_label, text) => {
    expect(checkContent('docs/notes.md', `call ${text} now`)).toEqual([]);
  });

  test.each([
    ['a drive letter at the start of the text', 'C:' + '/Users' + '/x'],
    ['a drive letter after a space', 'open ' + 'C:' + '/Users' + '/x'],
    ['a drive letter after a quote', ['"C:', 'Users', 'x"'].join('\\')],
  ])('AC-25: still flags %s', (_label, text) => {
    expect(ruleIds(checkContent('docs/notes.md', text))).toEqual(['client-reference']);
  });
});

describe('checkContent: Git Bash and WSL forms of a Windows user path', () => {
  test.each([
    ['the Git Bash form', 'open ' + '/c/' + 'Users/x'],
    ['the Git Bash form with another drive letter', 'open ' + '/d/' + 'Users/x'],
    ['the Git Bash form in upper case', ('/c/' + 'Users/x').toUpperCase()],
    ['the WSL form', 'open ' + '/mnt/c/' + 'Users/x'],
    ['the WSL form with another drive letter', 'open ' + '/mnt/e/' + 'Users/x'],
    ['the WSL form in upper case', ('/mnt/c/' + 'Users/x').toUpperCase()],
    ['the WSL form in lower case', ('/mnt/c/' + 'Users/x').toLowerCase()],
  ])('AC-26: flags %s as client-reference', (_label, text) => {
    expect(ruleIds(checkContent('docs/notes.md', text))).toEqual(['client-reference']);
  });

  test.each([
    ['a bare macOS home path', 'open ' + '/' + 'Users' + '/x'],
    ['an unrelated path with the same segments', 'open ' + '/usr/c/' + 'users'],
  ])('AC-26: does not flag %s', (_label, text) => {
    expect(checkContent('docs/notes.md', text)).toEqual([]);
  });
});

// ---- Spec 030: the terraform-local path rule --------------------------------------------------

describe('checkPath: terraform-local', () => {
  test.each([
    'terraform.tfvars',
    'labs/00-site-hosting/prod.tfvars',
    'a.auto.tfvars',
    'x.tfvars.json',
    'PROD.TFVARS',
    'plan.tfplan',
    'labs/00/.terraform/providers/x',
    '.terraform/terraform.tfstate',
    'modules/tags/.Terraform/x',
  ])('AC-16: reports terraform-local for %s', (path) => {
    expect(ruleIds(checkPath(path))).toContain('terraform-local');
  });

  test('AC-16: a state file inside .terraform/ is also a secret-file', () => {
    const ids = ruleIds(checkPath('.terraform/terraform.tfstate'));
    expect(ids).toContain('terraform-local');
    expect(ids).toContain('secret-file');
  });

  test('AC-16: the violation carries the explanatory message', () => {
    const violation = checkPath('labs/00-site-hosting/prod.tfvars').find(
      (found) => found.rule === 'terraform-local',
    );
    expect(violation?.message).toContain('Terraform variable files, saved plans and .terraform/');
  });

  test.each([
    '.terraform.lock.hcl',
    'labs/00/.terraform.lock.hcl',
    'terraform.tfvars.example',
    'labs/00/main.tf',
    'labs/00/tests/main.tftest.hcl',
    'docs/terraform.md',
  ])('AC-16: reports nothing for %s', (path) => {
    expect(checkPath(path)).toEqual([]);
  });
});
