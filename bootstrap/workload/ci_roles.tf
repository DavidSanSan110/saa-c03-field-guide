# The two roles GitHub Actions assumes through the OIDC provider (oidc.tf). Both trust policies use
# exact subject strings: the prefix of the repository plus one event. The condition keys are written
# out (not built from local.oidc_host) so that static analysers can read them.
locals {
  # tf-plan: pull requests and the main branch, so a plan can run before and after a merge.
  tf_plan_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "GitHubActionsPlan"
        Effect    = "Allow"
        Principal = { Federated = local.oidc_provider_arn }
        Action    = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = [
              "${var.github_sub_prefix}:pull_request",
              "${var.github_sub_prefix}:ref:refs/heads/main",
            ]
          }
        }
      },
    ]
  }

  # tf-apply: only jobs that run in the infra GitHub environment.
  tf_apply_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "GitHubActionsApply"
        Effect    = "Allow"
        Principal = { Federated = local.oidc_provider_arn }
        Action    = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = "${var.github_sub_prefix}:environment:infra"
          }
        }
      },
    ]
  }
}

# ---- tf-plan: read-only -----------------------------------------------------------------------------

resource "aws_iam_role" "tf_plan" {
  name               = local.tf_plan_role_name
  description        = "GitHub Actions: terraform plan on pull requests and main. Read-only, cannot read data."
  assume_role_policy = jsonencode(local.tf_plan_trust)

  # IAM rejects a trust policy whose federated principal does not exist yet.
  depends_on = [aws_iam_openid_connect_provider.github]
}

resource "aws_iam_role_policy_attachment" "tf_plan_read_only" {
  role       = aws_iam_role.tf_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# ReadOnlyAccess can read object contents, secret values and parameters. These denies keep a plan from
# turning into a data read, at the price that a lab which manages S3 objects, secrets or parameters
# cannot be planned by tf-plan (see the README).
resource "aws_iam_role_policy" "tf_plan_deny" {
  name = "deny-data-reads"
  role = aws_iam_role.tf_plan.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Lab state is readable (a plan needs it); bootstrap state and every other object is not.
        Sid         = "DenyObjectReadsOutsideLabState"
        Effect      = "Deny"
        Action      = ["s3:GetObject", "s3:GetObjectVersion"]
        NotResource = "${local.state_bucket_arn}/labs/*"
      },
      {
        Sid      = "DenySecretReads"
        Effect   = "Deny"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:aws:secretsmanager:*:${local.account_id}:secret:*"
      },
      {
        # The account's own parameters only: AWS public parameters (AMI IDs under /aws/service/)
        # live in another account and still resolve.
        Sid      = "DenyParameterReads"
        Effect   = "Deny"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
        Resource = "arn:aws:ssm:*:${local.account_id}:parameter/*"
      },
    ]
  })
}

# ---- tf-apply: administrator, minus the ways to escalate ---------------------------------------------

resource "aws_iam_role" "tf_apply" {
  name               = local.tf_apply_role_name
  description        = "GitHub Actions: terraform apply for the labs, from the infra environment. Administrator with explicit denies on IAM escalation, guardrails and state bucket settings."
  assume_role_policy = jsonencode(local.tf_apply_trust)

  # IAM rejects a trust policy whose federated principal does not exist yet.
  depends_on = [aws_iam_openid_connect_provider.github]
}

resource "aws_iam_role_policy_attachment" "tf_apply_admin" {
  #checkov:skip=CKV_AWS_274:Labs create arbitrary services, so tf-apply needs broad rights; the inline deny policy and the bucket policy close the escalation paths.
  role       = aws_iam_role.tf_apply.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# The boundary's escalation denies, plus bucket-level protection of the state bucket (policy,
# versioning, lifecycle, encryption, public access block, deletion). Object access is limited by the
# bucket policy to labs/*. This role does not carry the boundary itself: the boundary denies all state
# access, which tf-apply needs for the labs/* keys.
resource "aws_iam_role_policy" "tf_apply_deny" {
  name = "deny-escalation"
  role = aws_iam_role.tf_apply.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      local.escalation_denies,
      [
        {
          Sid       = "DenyStateBucketSettings"
          Effect    = "Deny"
          NotAction = ["s3:Get*", "s3:List*"]
          Resource  = local.state_bucket_arn
        },
      ],
    )
  })
}
