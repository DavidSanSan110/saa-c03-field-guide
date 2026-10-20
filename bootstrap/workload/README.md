# bootstrap/workload

The Terraform stack for the **workload account** of the field-guide AWS Organization: everything CI
needs before it can run, and the guardrails CI must not be able to turn off.

- the S3 bucket that holds the Terraform state of this stack and of every lab;
- account-level guardrails: S3 Block Public Access for the whole account, an IAM Access Analyzer
  (external access) and EBS encryption by default in `eu-west-1`;
- an optional public Route 53 hosted zone for the site;
- the GitHub OIDC identity provider and two CI roles, `fg-tf-plan` and `fg-tf-apply`;
- the `fg-workload-boundary` permissions boundary that every role created by a lab must carry.

It is applied **locally by the owner**, with an IAM Identity Center session, and never by CI: CI only
runs `fmt`, `validate`, `tflint`, `checkov` and `terraform test` on it (mock providers, no AWS access).
That is the point: CI cannot change its own roles, the OIDC provider, the permissions boundary or the
account guardrails (the exact list is in [Using the CI roles](#using-the-ci-roles)). No access keys
exist anywhere; the account ID is read at plan time and never written in a file.

## Prerequisites

1. Terraform `>= 1.14.0` (the version in `.terraform-version` at the repository root).
2. The management stack is applied first: [`bootstrap/management`](../management/README.md). Its
   service control policy limits the account to `eu-west-1` and `us-east-1`, which this stack assumes.
3. An SSO session for the **workload account**, not the management account:

   ```bash
   aws sso login --sso-session field-guide
   export AWS_PROFILE=fg-admin               # PowerShell: $env:AWS_PROFILE = "fg-admin"
   aws sts get-caller-identity               # read-only: the Account must be the workload account
   ```

   Use the profile name you gave the workload account's administrator permission set.

4. The OIDC subject prefix of your repository. GitHub puts it at the start of the `sub` claim of every
   token, and the trust policies of the CI roles match it exactly. Read it (you need admin rights on
   the repository):

   ```bash
   gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix
   ```

   - Repositories with **immutable subject claims** print `repo:<owner>@<owner id>/<repo>@<repo id>`,
     with the numeric IDs. Use that value.
   - For older repositories the command prints nothing or `null`: the prefix is `repo:<owner>/<repo>`.
   - If the repository customizes its OIDC claim keys (`use_default: false`), tokens do not carry
     `<prefix>:<event>` subjects such as `<prefix>:pull_request`, and the trust policies of this stack
     will not match them. Switch the repository back to the default claims.

5. A `terraform.tfvars` (git-ignored) made from the example:

   ```bash
   cp terraform.tfvars.example terraform.tfvars   # then edit both values
   ```

   - `github_sub_prefix`: the prefix from the previous step. The example uses
     `repo:your-user/saa-c03-field-guide`. Wildcards, a `:ref:...` suffix or an empty part are
     rejected.
   - `hosted_zone_name`: a subdomain of a domain you control, such as `field-guide.example.com`. The
     zone is created only when this is set; delete the line for none.

## First apply

The state bucket is created by this same stack, so the first apply runs with **local state** and the
state is migrated into the bucket at the end.

**Only one GitHub OIDC provider can exist per account.** If the account already has one for
`token.actions.githubusercontent.com`, creating this one fails. Either delete the old one (when
nothing uses it) or import it before the plan, after `terraform init`:

```bash
terraform import aws_iam_openid_connect_provider.github arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

Run everything from `bootstrap/workload/`.

1. Use a local backend for now. `backend_override.tf` is git-ignored (`*_override.tf`):

   ```bash
   printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
   ```

   PowerShell (do not use `>` here: Windows PowerShell 5.1 would write UTF-16, which Terraform
   cannot read):

   ```powershell
   Set-Content backend_override.tf "terraform {`n  backend `"local`" {}`n}" -Encoding ascii
   ```

2. Initialise:

   ```bash
   terraform init
   ```

3. Plan and read it before applying:

   ```bash
   terraform plan -out=first.tfplan
   ```

   PowerShell splits an unquoted `-out=first.tfplan` at the dot ("Too many command line arguments"),
   so quote it:

   ```powershell
   terraform plan "-out=first.tfplan"
   ```

   Expected: everything is created and nothing is imported or destroyed (19 resources, 18 when
   `hosted_zone_name` is unset). If you imported an existing OIDC provider, it shows only a change of
   tags. Stop and investigate if the plan shows anything else.

4. Apply the saved plan:

   ```bash
   terraform apply first.tfplan
   ```

5. Move the state into the bucket. Read the bucket name **before** deleting the override: once the
   override is gone, Terraform no longer reads the local state, so `terraform output` would fail.
   Then delete the override and migrate (answer `yes` to copy the state).

   Bash:

   ```bash
   BUCKET=$(terraform output -raw state_bucket)
   rm backend_override.tf
   terraform init -migrate-state -backend-config="bucket=$BUCKET"
   terraform plan        # expected: No changes
   ```

   PowerShell:

   ```powershell
   $bucket = terraform output -raw state_bucket
   Remove-Item backend_override.tf
   terraform init -migrate-state "-backend-config=bucket=$bucket"
   terraform plan        # expected: No changes
   ```

   Never use `-reconfigure` here: it would start an empty remote state and strand the real state in
   the local file.

   Afterwards delete `first.tfplan` and the leftover local `terraform.tfstate` and
   `terraform.tfstate.backup`. They are git-ignored, but they hold state values and account IDs.

Later runs on the same machine only need `plan` and `apply`: `.terraform/` remembers the bucket. On a
new machine or a fresh clone, run `terraform init -backend-config="bucket=field-guide-tfstate-<ACCOUNT_ID>"`
first (PowerShell: `terraform init "-backend-config=bucket=field-guide-tfstate-<ACCOUNT_ID>"`). The
state is locked with an S3 lock file (`use_lockfile`), no DynamoDB table.

## DNS delegation

Skip this section when `hosted_zone_name` is unset.

Route 53 now serves the zone, but nobody asks it until the **parent** zone points at it. Print the four
name servers:

```bash
terraform output name_servers
```

At the DNS provider of your parent zone (for `field-guide.example.com`, the provider of
`example.com`), add four **NS records** named after the subdomain (`field-guide`), one per value.
If the provider can proxy records, set them to DNS-only: NS records cannot be proxied. Some providers
want the trailing dot on each value, some reject it.

Check the delegation (it can take up to the TTL of the parent zone):

```bash
dig NS field-guide.example.com +short
```

```powershell
Resolve-DnsName -Name field-guide.example.com -Type NS
```

You should see the same four `awsdns` names. The hosted zone has `prevent_destroy`: the values are
typed into the parent by hand, and a recreated zone gets different name servers.

## Using the CI roles

`terraform output` prints the ARNs the CI workflow needs: `oidc_provider_arn`, `tf_plan_role_arn`,
`tf_apply_role_arn` and `boundary_policy_arn` (the boundary every lab role must set as its
`permissions_boundary`). None of them is a secret.

| Role          | Assumed by                                                     | Can                                                                                                                                                                                                               | Cannot                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fg-tf-plan`  | jobs on pull requests and on the main branch of the repository | read the configuration of resources (`ReadOnlyAccess`); read lab state under `labs/`                                                                                                                              | write or delete any object in the state bucket, lock files included; read state outside `labs/`; read secret values (`secretsmanager:GetSecretValue`); read the account's own SSM parameters; read objects in other buckets                                                                                                                                                                                                                                       |
| `fg-tf-apply` | jobs that run in the `infra` GitHub environment                | create, change and delete almost anything (`AdministratorAccess`); change the hosted zone and its records; read and write lab state under `labs/`; create roles under `/lab/` and change their trust and policies | change the CI roles, `OrganizationAccountAccessRole`, the boundary or the OIDC provider; write to any role outside the `/lab/` path; create or change a role without the boundary; create IAM users, access keys or login profiles; turn off account Block Public Access or EBS default encryption, change the default EBS key, delete the analyzer or hide its findings; change the state bucket's settings; touch `bootstrap/` state or any key outside `labs/` |

**`fg-tf-apply` is only as safe as the `infra` environment.** The trust policy accepts any job of the
repository that runs in an environment named `infra`, so the environment must allow deployments from
the `main` branch only and have a required reviewer. Set both up with the CI workflow; without them,
anyone who can push a branch can run Terraform as an administrator.

**The `/lab/` path rule.** Every role CI creates must set `path = "/lab/"` and
`permissions_boundary = <boundary ARN>` (output `boundary_policy_arn`; the path is the output
`lab_role_path`). `fg-tf-apply` and the boundary deny role writes (create, delete, update, tag, trust
policy, attached policies, boundary, `iam:PassRole`, `sts:AssumeRole`) on every role outside
`role/lab/*`, so a role made by hand later cannot be re-trusted and used to get around the denies.
Roles under `/lab/` stay capped by the boundary, but `fg-tf-apply` can still change their trust
policies. Services can still create their service-linked roles, but passing one is denied, so leave
arguments such as `service_linked_role_arn` unset. A few AWS services do not accept a role path, and
`sts:AssumeRole` into another account is denied too; such labs cannot run under CI. Never attach a
privileged role outside `/lab/` to compute in this account (a Lambda function, an instance, a build
project): `fg-tf-apply` could change that code and act as the role without passing it.

Lab state lives at `labs/<lab id>.tfstate` in the same bucket. Labs use the **default Terraform
workspace**: other workspaces store their state under `env:/<workspace>/...` keys, which the bucket
policy denies to the CI roles.

**CI plans must use `-lock=false`.** With `use_lockfile`, Terraform locks by writing
`<key>.tflock` into the bucket, and `fg-tf-plan` is denied every write. A plan with `-lock=false`
only reads state. `fg-tf-apply` writes the lock normally.

**Trade-off of the plan role's read denies.** `ReadOnlyAccess` can read object contents, secret values
and parameters; `fg-tf-plan` denies the ones that matter, so a pull request cannot turn a plan into a
data read of the kinds it denies. The price: a lab that manages S3 objects, secrets or SSM parameters in the account cannot be
planned by `fg-tf-plan` (the read fails with an explicit deny). Plan such a lab locally instead, or
keep the data out of Terraform. AWS public parameters (such as AMI IDs under `/aws/service/`) still
resolve. `ReadOnlyAccess` can still read some data that is not denied (DynamoDB items, CloudWatch Logs
events, Lambda environment variables), so do not keep secrets there.

Policy documents are built with `jsonencode` from plan-time values (names, the account ID and the
Region), never from computed attributes, so the plan shows the exact JSON and a role can be named in
a policy before it exists.

## Cost

`infracost breakdown --path bootstrap/workload --terraform-var hosted_zone_name=field-guide.example.com --terraform-var github_sub_prefix=repo:your-user/saa-c03-field-guide`
(infracost v0.10.46, 2026-10-20): **$0.50 per month** with the hosted zone, **$0.00** without it. Of 19
resources, 17 are free and 2 are priced:

| Resource                | Price (infracost)                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `aws_route53_zone.site` | $0.50 per month for the hosted zone                                                 |
| `aws_s3_bucket.state`   | usage only: storage $0.023 per GB-month, PUT/LIST $0.005 per 1k, GET $0.0004 per 1k |

What that means in practice (public AWS prices at the time of writing; check the pricing pages before
relying on them):

| Item                                                               | Monthly cost                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Route 53 hosted zone                                               | $0.50, plus about $0.40 per million queries: cents for a study site                 |
| S3 state bucket (a few KB per stack, 90 days of old versions)      | cents or less                                                                       |
| OIDC provider, IAM roles and policies, account Block Public Access | $0                                                                                  |
| Access Analyzer, external access (`ACCOUNT` type)                  | $0 (the unused-access analyzer is billed per resource and is not used here)         |
| EBS encryption by default                                          | $0 (it creates nothing; it encrypts volumes created later with the AWS-managed key) |
| **Total**                                                          | **about $0.50 per month with the zone, well under $0.10 without it**                |

The only thing that costs money while idle is the hosted zone. No NAT gateway, EIP, load balancer or
database.

## Destroy

This stack is **not meant to be destroyed**: the labs' state, the CI roles and the guardrails depend on
it. If you must, in this order:

1. Destroy every lab first (their state lives in this bucket under `labs/`), so nothing is left that
   `fg-tf-apply` created.
2. Delete the records in the hosted zone that were not created by this stack (lab records such as
   certificate validation or the site alias). Terraform does not set `force_destroy` on the zone, so it
   cannot delete a zone that still has records other than `NS` and `SOA`.
3. Migrate the state back to local (add a `backend_override.tf` with a local backend, then
   `terraform init -migrate-state`), so the bucket can be emptied and deleted safely.
4. Remove `prevent_destroy` from the state bucket in `state.tf` and from the hosted zone in `dns.tf`.
5. Empty the state bucket, including **all object versions and delete markers** (versioning is on and
   `force_destroy` is off).
6. Delete the four `NS` records at the parent zone **before** destroying the hosted zone: a delegation
   that points at name servers nobody owns any more can be taken over by someone who creates a zone
   that happens to get them.
7. `terraform destroy`. This removes the CI roles, the boundary and the OIDC provider, and puts the
   account back to having no account-level Block Public Access, no analyzer and no EBS default
   encryption.

## Files

| File                       | What                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `versions.tf`              | Terraform and provider versions; the partial S3 backend               |
| `providers.tf`, `main.tf`  | the provider with default tags; account ID, names and ARNs            |
| `variables.tf`             | `github_sub_prefix` and `hosted_zone_name`, with their validation     |
| `state.tf`                 | the state bucket and its policy                                       |
| `guardrails.tf`            | account Block Public Access, Access Analyzer, EBS default encryption  |
| `dns.tf`                   | the optional public hosted zone                                       |
| `oidc.tf`                  | the GitHub OIDC provider                                              |
| `boundary.tf`              | the `fg-workload-boundary` permissions boundary and the shared denies |
| `ci_roles.tf`              | the `fg-tf-plan` and `fg-tf-apply` roles                              |
| `terraform.tfvars.example` | copy to `terraform.tfvars` and fill in                                |
| `tests/`                   | `terraform test` runs with mock providers (no AWS access, no cost)    |
