# labs/99-ci-smoke

A $0 pipeline check for `.github/workflows/infra.yml`. It creates **no AWS resources**: the only resource is a built-in `terraform_data` that stores a message in the state, so the one thing that exists in AWS is the state object `labs/99-ci-smoke.tfstate` in the workload account's state bucket.

It proves the whole path before lab 00 depends on it: OIDC login, state access, plan, change-set digest, approval in the `infra` environment, apply, verify and destroy.

**Temporary.** After the pipeline has been proven and the stack destroyed (below), a follow-up PR removes this directory.

## Run it

- A PR that touches this directory gets a read-only plan as a PR comment.
- Merging to `main` plans again, waits for your approval in the `infra` environment, re-plans with the apply role and applies only if the change set is the one shown. `verify.sh` then runs with the read-only role.
- Actions → Infra → Run workflow also deploys it on demand: `action` `apply`, `stack` `labs/99-ci-smoke`.

## Destroy it

Actions → Infra → Run workflow (branch `main`):

- `action`: `destroy`
- `stack`: `labs/99-ci-smoke`
- `confirm`: `destroy labs/99-ci-smoke`

Approve the run in the `infra` environment. Destroy the stack **before** deleting this directory: CI does not plan a stack whose directory is gone.

## Files

| File           | Purpose                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `versions.tf`  | Terraform version and the S3 backend (bucket and key are passed by CI)         |
| `main.tf`      | The `terraform_data.smoke` resource                                            |
| `variables.tf` | `message`, defaulting to `infra.yml smoke test`                                |
| `outputs.tf`   | `message`, the value stored in the state                                       |
| `verify.sh`    | Read-only post-apply check: `terraform output -raw message` equals the default |
| `tests/`       | `terraform test` checks, run offline by the `terraform` workflow               |
