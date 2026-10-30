# Break lab 01 on purpose

Four experiments, one for each way the `iam-cross-account-assume-role` diagram fails. Each one
breaks a single piece of the lab so you see why it is there. Run them only in **your own stack**
(see the [quick start](README.md#quick-start-in-your-own-account)), never on a shared one. Use
Git Bash on Windows, from `labs/01-iam-assume-role/`.

They use the shell variables and the `as_caller` helper of [Observe](README.md#observe), steps 1 and 2. Set them up first. A caller session lasts 1 hour: run step 2 again if it expires.

**Never remove or change the permissions boundary of a lab role.** It is the guardrail that keeps
lab roles inside the path `/lab/` and away from IAM users and access keys. To see what a missing
boundary would do, read check 9 of `verify.sh`: the policy simulator swaps the boundary for you and
changes nothing in the account.

Each break is drift: `terraform plan` shows it and `terraform apply` undoes it.

## The trust policy doesn't allow

### What to do

Replace the reports reader's trust policy with one that trusts only `ec2.amazonaws.com`. The
caller's own policy still allows `sts:AssumeRole`. Save this as `trust-ec2.json` in the lab
directory (delete it afterwards and never commit it):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Apply it with your admin session, then try to assume the role as the caller:

```bash
aws iam update-assume-role-policy --role-name fg-lab01-reports-reader --policy-document file://trust-ec2.json
as_caller aws sts assume-role --role-arn "$TARGET_ARN" --role-session-name lab01-reader --external-id "$EXTERNAL_ID"
```

### What you see

`AccessDenied`: the caller "is not authorized to perform: sts:AssumeRole" on the reports reader. IAM
may need a few seconds to apply the change.

### Why

An allow on the caller's side is not enough. The role's trust policy is a resource policy, and it is
the other side: no statement of it names the caller or its account, so nothing allows the call. Across
accounts both sides must allow it. A denied cross-account `AssumeRole` shows up in CloudTrail in the
caller's account, which is where you look to debug it.

### Put it back

```bash
rm trust-ec2.json
terraform apply
```

In a stack that CI manages, dispatch `infra.yml` with the action `apply` instead.

## The caller lacks sts:AssumeRole

### What to do

Remove the `AssumeReportsReader` statement from the caller's inline policy, so only the
`iam:CreateRole` statement stays. Save this as `caller-without-assume.json` (delete it afterwards
and never commit it):

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
cat > caller-without-assume.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CreateRoleDeniedByBoundary",
      "Effect": "Allow",
      "Action": "iam:CreateRole",
      "Resource": "arn:aws:iam::$ACCOUNT:role/lab01-*"
    }
  ]
}
EOF
```

Apply it with your admin session, wait a few seconds, and try again with the same caller session:

```bash
aws iam put-role-policy --role-name fg-lab01-caller --policy-name assume-reports-reader --policy-document file://caller-without-assume.json
as_caller aws sts assume-role --role-arn "$TARGET_ARN" --role-session-name lab01-reader --external-id "$EXTERNAL_ID"
```

### What you see

`AccessDenied` again, with the right external ID. The trust policy is unchanged and would allow the
call.

### Why

The trust policy names the account root, which delegates the choice to the account's identity
policies: trusting the root does not let everyone in, it lets the account decide. Here the account's
policy for the caller has no `sts:AssumeRole` on that role, and the default is deny. The caller always
needs its own allow, and an existing session loses it as soon as the policy changes. This is why
trusting a whole account is still safe.

### Put it back

```bash
rm caller-without-assume.json
terraform apply
```

In a stack that CI manages, dispatch `infra.yml` with the action `apply` instead.

## Wrong external ID

### What to do

Change nothing. Call `AssumeRole` with another ID, and with none:

```bash
as_caller aws sts assume-role --role-arn "$TARGET_ARN" --role-session-name lab01-reader --external-id not-the-right-one
as_caller aws sts assume-role --role-arn "$TARGET_ARN" --role-session-name lab01-reader
```

### What you see

`AccessDenied` both times, although the caller is trusted and has its own allow.

### Why

The trust policy has a `StringEquals` condition on `sts:ExternalId`. A vendor that serves many
customers could be tricked into using one customer's role ARN for another customer's request: the
confused deputy problem. The external ID makes the vendor send the ID of the customer it works for,
and the role accepts only its own. The external ID is **not a secret** and not a password: it
authenticates nobody and appears in the plan, in this repository and in the log. The third party
generates it, you do not invent it.

### Put it back

Nothing to put back: you changed nothing.

## The boundary caps the caller

### What to do

The caller's inline policy allows `iam:CreateRole` on `role/lab01-*`, a role in the default path
`/`, outside `/lab/`. Try it with a minimal trust policy for EC2:

```bash
as_caller aws iam create-role --role-name lab01-probe \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

### What you see

`AccessDenied`, "with an explicit deny in a permissions boundary". `verify.sh` shows the same with
the policy simulator: `explicitDeny` for the caller, and `allowed` once the boundary is replaced.

### Why

Effective permissions are the **intersection** of the identity policy and the permissions boundary.
A boundary caps; it never grants. An explicit deny in the boundary wins over any allow, so the
caller's allow counts for nothing. The boundary here denies every role write outside `/lab/` and
denies creating a role without the boundary itself, so a lab role cannot mint a new role with more
power than its own. That is the classic use of a boundary: delegating role creation without
privilege escalation.

### Put it back

Nothing to put back: you changed nothing. If the role was ever created (so the boundary is broken),
delete it with your admin session: `aws iam delete-role --role-name lab01-probe`. Then find out why
the boundary did not apply.
