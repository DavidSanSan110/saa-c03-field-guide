# Contributing

Thanks for your interest! Until the launch (November 2026) the project is built by one person while studying for the exam, so **issues are very welcome, pull requests less so for now**: the structure is still moving.

## Reporting a problem

- **A practice question is wrong or unclear:** open a [question report](../../issues/new?template=question-report.yml) with the question ID.
- **Bug or idea:** use the matching [issue template](../../issues/new/choose).

## Content rules (non-negotiable)

Everything published here must be **original**:

- Written in the author's own words from their understanding and the **AWS documentation**, organised by the official exam guide.
- **Never** course material (slides, transcripts, course quizzes, instructor code, slide-by-slide paraphrase).
- **Never** real exam questions or "dump" content of any kind. Sharing real exam content breaks the AWS Certification Program Agreement.
- **Never** secrets or credentials. The labs use GitHub OIDC and AWS IAM Identity Center; no access keys exist.
- Only questions with `status: reviewed` (read and approved by a human) live in `questions/`.

Pre-commit hooks and CI enforce most of these automatically.

## Development workflow

- Every change starts as an issue, lives on a branch (`feat/12-short-slug`) and lands through a pull request.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(diagrams): add step-back control`).
- Behaviour is specified first, tests are written from the spec, then the code makes them pass. Every feature ships with unit and end-to-end tests.
- PRs are merged with a merge commit after rebasing on `main` (no squash).

## Local setup

Requirements: Node.js 22.12+ and pnpm (via Corepack).

```sh
corepack enable
pnpm install
pnpm verify        # format check, lint, typecheck, unit tests with coverage, e2e
```

Useful scripts: `pnpm test:watch`, `pnpm format`, `pnpm lint`, `pnpm verify:fast` (no e2e).

## Licence

By contributing you agree that code is licensed under [MIT](LICENSE) and written content under [CC BY-SA 4.0](LICENSE-CONTENT.md).
