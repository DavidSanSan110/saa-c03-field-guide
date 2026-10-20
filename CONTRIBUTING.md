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
- PRs are merged with a merge commit after rebasing on `main` (no squash). The PR's own commits must not contain merge commits; CI rejects them.
- Only `test:` commits may touch tests: they may add to test files, but only the owner-approved `tests-approved` label lets a PR edit or delete existing ones. Test configs, setup files, mocks and the `test`/`coverage`/`e2e` scripts are likewise changed only in `test:` commits.

## Local setup

Requirements: Node.js 22.12+, pnpm (via Corepack) and [gitleaks](https://github.com/gitleaks/gitleaks#installing) on your `PATH` (Windows: `winget install Gitleaks.Gitleaks`).

```sh
corepack enable
pnpm install
pnpm verify        # format check, lint, typecheck, unit tests with coverage, e2e
```

Useful scripts: `pnpm test:watch`, `pnpm format`, `pnpm lint`, `pnpm verify:fast` (no e2e), `pnpm guardrails paths --all`.

`pnpm install` also installs the git hooks ([Lefthook](lefthook.yml)): gitleaks, the guardrails, ESLint and Prettier on commit; commitlint on the message; typecheck and unit tests before a push. Pushing straight to `main` is refused.

## Terraform

Stacks live in `bootstrap/<name>`, `labs/<name>` and `modules/<name>`. For every stack that CI picks (the ones a PR touches, or all of them when a module or a shared Terraform config changes) the `terraform` workflow runs, in the stack directory: `terraform fmt -check -recursive`, `terraform init -backend=false -lockfile=readonly`, `terraform validate`, TFLint, Checkov and `terraform test`. None of it needs AWS credentials. Tool versions are pinned: Terraform in `.terraform-version`, the rest in the workflow and `.tflint.hcl`.

- **Lock files:** a stack that requires providers commits its `.terraform.lock.hcl` with hashes for CI (Linux) and for Windows. Create it with `terraform providers lock -platform=linux_amd64 -platform=windows_amd64`. CI's `-lockfile=readonly` fails when the file is missing or stale.
- **Never committed:** `*.tfvars`, `*.tfvars.json`, saved plans (`*.tfplan`), state and `.terraform/` can hold account IDs and state values; the guardrails block them. Share an example as `terraform.tfvars.example`.
- **Tags:** every stack takes its required tags from `modules/tags` (see its README) instead of writing them by hand.
- **Checkov skips** go inline, next to the resource, with a reason. There is no global skip list.

## Licence

By contributing you agree that code is licensed under [MIT](LICENSE) and written content under [CC BY-SA 4.0](LICENSE-CONTENT.md).
