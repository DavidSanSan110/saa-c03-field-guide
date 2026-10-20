# bootstrap/management

The Terraform stack for the **management account** of the field-guide AWS Organization. It owns the
few things that live above the workload account:

- the S3 bucket that holds this stack's own Terraform state;
- the Organization's trusted access (`cloudtrail`, `iam`, `sso`) and an organization trail with its
  log bucket;
- the monthly budget and the cost anomaly alerts;
- the `field-guide-guardrails` service control policy (SCP) attached to the workload account.

It is applied **locally by the owner**, with an IAM Identity Center session, and never by CI: CI only
runs `fmt`, `validate`, `tflint`, `checkov` and `terraform test` on it (mock providers, no AWS access).
No access keys exist anywhere; the account ID is read at plan time and never written in a file.

## Prerequisites

1. Terraform `>= 1.14.0` (the version in `.terraform-version` at the repository root).
2. An SSO session for the management account:

   ```bash
   aws sso login --sso-session field-guide
   export AWS_PROFILE=fg-mgmt-admin          # PowerShell: $env:AWS_PROFILE = "fg-mgmt-admin"
   aws sts get-caller-identity               # read-only: the Account must be the management account
   ```

3. A `terraform.tfvars` (git-ignored) made from the example, with your own address:

   ```bash
   cp terraform.tfvars.example terraform.tfvars   # then edit alert_email
   ```

   Use the address that the existing budget already notifies, so the imported budget shows no
   notification diff.

## First apply

The state bucket is created by this same stack, so the first apply runs with **local state** and the
state is migrated into the bucket at the end. Three existing resources are imported first.

Run everything from `bootstrap/management/`.

1. Use a local backend for now. `backend_override.tf` is git-ignored (`*_override.tf`):

   ```bash
   printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
   ```

2. Initialise:

   ```bash
   terraform init
   ```

3. Import the three existing resources. Each ID comes from a read-only command:

   ```bash
   # Organization: <ORG_ID> looks like o-xxxxxxxxxx
   aws organizations describe-organization --query Organization.Id --output text
   terraform import aws_organizations_organization.this <ORG_ID>

   # Budget: the ID is <ACCOUNT_ID>:field-guide-monthly
   aws sts get-caller-identity --query Account --output text
   terraform import aws_budgets_budget.monthly <ACCOUNT_ID>:field-guide-monthly

   # Anomaly monitor: <MONITOR_ARN> is the ARN of Default-Services-Monitor
   aws ce get-anomaly-monitors --query "AnomalyMonitors[?MonitorName=='Default-Services-Monitor'].MonitorArn" --output text
   terraform import aws_ce_anomaly_monitor.services <MONITOR_ARN>
   ```

4. Plan and read it before applying:

   ```bash
   terraform plan -out=first.tfplan
   ```

   Expected: the Organization gets `cloudtrail.amazonaws.com` added to its trusted access (and the
   default tags); the budget and the monitor get the default tags as an in-place change; everything
   else is created (two buckets and their settings, the trail, the new anomaly subscription, the SCP
   and its attachment). Nothing is destroyed. Stop and investigate if the plan shows anything else on
   an imported resource, in particular a changed budget limit, filter, or subscriber.

5. Apply the saved plan:

   ```bash
   terraform apply first.tfplan
   ```

6. Move the state into the bucket. Delete the override first, then migrate (answer `yes` to copy the
   state):

   ```bash
   rm backend_override.tf
   terraform init -migrate-state -backend-config="bucket=$(terraform output -raw state_bucket)"
   terraform plan        # expected: No changes
   ```

   Afterwards delete the leftover local `terraform.tfstate` and `terraform.tfstate.backup` (they are
   git-ignored, but they hold account details).

Later runs only need `terraform init -backend-config="bucket=field-guide-tfstate-<ACCOUNT_ID>"`, then
`plan` and `apply`. The state is locked with an S3 lock file (`use_lockfile`), no DynamoDB table.

## What the SCP blocks

`field-guide-guardrails` is attached to the account named by `workload_account_name` (default
`field-guide`), found by name among the member accounts. The plan fails with a clear message when no
account, or more than one, has that name. It only adds `Deny` statements; `FullAWSAccess` stays
attached. SCPs never apply to the management account itself.

| Statement                   | Blocks                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DenyOutsideAllowedRegions` | every action outside `eu-west-1` and `us-east-1`, except global services (IAM, Organizations, STS, Route 53, CloudFront, Budgets, Cost Explorer, Support, and so on) |
| `DenyIamUsersAndKeys`       | `iam:CreateUser`, `iam:CreateAccessKey`, `iam:CreateLoginProfile`, `iam:UpdateLoginProfile`                                                                          |
| `DenyCloudTrailChanges`     | `cloudtrail:StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`, `PutInsightSelectors`                                                                   |
| `DenyLeavingOrganization`   | `organizations:LeaveOrganization`                                                                                                                                    |

To test it, use a session in the **workload account** (not the management account). Every call below
must fail with an explicit deny in a service control policy:

```bash
aws ec2 describe-vpcs --region eu-central-1                 # outside the allowed Regions
aws cloudtrail stop-logging --name field-guide-org-trail    # CloudTrail tampering
aws iam create-user --user-name scp-test                    # IAM users are blocked
```

If the SCP is not attached yet, the last command would really create a user: delete it with
`aws iam delete-user --user-name scp-test`. Do not test `leave-organization`: if the SCP were
missing, it would work.

## Cost

**Hand estimate, not an infracost run** (infracost needs an API key and has no pricing for most of
these resources). Prices are the public AWS prices at the time of writing; check the pricing pages
before relying on them.

| Item                                                                                  | Monthly cost                                                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| CloudTrail: one organization trail with management events                             | $0 (the first copy of management events in each Region is free; data events and Insights are not enabled) |
| AWS Budgets: one budget                                                               | $0 (within the free allowance)                                                                            |
| Cost Anomaly Detection: one monitor, two subscriptions                                | $0 (no charge for the service)                                                                            |
| Organizations, SCP, trusted access                                                    | $0                                                                                                        |
| S3: state bucket (a few KB) and log bucket (a few MB of logs, expired after 365 days) | cents or less: storage at about $0.023 per GB-month plus the request charges of CloudTrail log delivery   |
| **Total**                                                                             | **well under $0.10 per month**                                                                            |

Nothing here costs money while idle apart from those S3 cents. No NAT gateway, EIP, load balancer or
database. The one way to spend more: a second trail, or a trail in a member account, that records
management events would be a **second copy** (about $2.00 per 100,000 events). Keep a single trail.

## Destroy

This stack is **not meant to be destroyed**: it holds the Organization settings and the alerts.
If you must:

1. Never destroy the Organization. Remove it from the state first:

   ```bash
   terraform state rm aws_organizations_organization.this
   ```

2. Decide whether to keep the imported budget and monitor (`terraform state rm aws_budgets_budget.monthly`
   and `terraform state rm aws_ce_anomaly_monitor.services` keep them in AWS) or let Terraform delete
   them.
3. Empty the log bucket, including all object versions and delete markers (versioning is on and
   `force_destroy` is off).
4. The state bucket has `prevent_destroy = true`. Migrate the state back to local first (delete the
   `backend "s3"` block or add `backend_override.tf` with a local backend, then
   `terraform init -migrate-state`), remove `prevent_destroy` from the state bucket in
   `state.tf`, empty the bucket, and only then run `terraform destroy`.
5. `terraform destroy` then detaches and deletes the SCP and deletes the trail and the buckets. The
   Organization is no longer in the state, so its trusted access (including `cloudtrail`) stays on.

## Files

| File                      | What                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| `versions.tf`             | Terraform and provider versions; the partial S3 backend            |
| `providers.tf`, `main.tf` | the provider with default tags; account ID, names and ARNs         |
| `state.tf`                | the state bucket                                                   |
| `org.tf`                  | the Organization and its trusted access                            |
| `trail.tf`                | the organization trail and its log bucket                          |
| `costs.tf`                | the budget, the anomaly monitor and the new anomaly subscription   |
| `scp.tf`                  | the SCP and its attachment                                         |
| `tests/`                  | `terraform test` runs with mock providers (no AWS access, no cost) |
