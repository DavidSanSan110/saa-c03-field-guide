# The two roles of the iam-cross-account-assume-role diagram, built in one account as if they were
# two. The caller may assume the reports reader; the reports reader trusts the account root and
# demands an external ID. A call works only when both sides allow it.
#
# Both roles need path /lab/ and the fg-workload-boundary permissions boundary: the boundary denies
# every role write, PassRole and AssumeRole outside arn:aws:iam::<account>:role/lab/*, and refuses
# to create a role without itself. The same denies are on the role that applies this stack.
locals {
  # Trusts the account root, not one named role: the choice of who may assume is delegated to the
  # identity policies of this account (the caller's inline policy below). No condition.
  caller_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountPrincipals"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = "sts:AssumeRole"
      },
    ]
  }

  # This account's root, plus the root of trusted_account_id when it is set.
  target_principals = var.trusted_account_id == null ? [local.account_root_arn] : [
    local.account_root_arn,
    "arn:aws:iam::${var.trusted_account_id}:root",
  ]

  # Same shape as the caller trust, plus the external ID. A caller that does not send the right
  # sts:ExternalId is denied even when its own policy allows the call.
  target_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "TrustedAccountsWithExternalId"
        Effect    = "Allow"
        Principal = { AWS = local.target_principals }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "sts:ExternalId" = var.external_id }
        }
      },
    ]
  }

  # The caller's own side of the handshake: it may assume the reports reader, and it has an
  # iam:CreateUser allow on purpose. The boundary denies CreateUser, and a deny always wins, so the
  # effective permission is a deny. It has no S3 action: it cannot read the bucket.
  caller_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AssumeReportsReader"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = local.target_role_arn
      },
      {
        Sid      = "CreateUserDeniedByBoundary"
        Effect   = "Allow"
        Action   = "iam:CreateUser"
        Resource = "arn:aws:iam::${local.account_id}:user/lab01-*"
      },
    ]
  }

  target_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListReports"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.reports_bucket_arn
      },
      {
        Sid      = "ReadReports"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${local.reports_bucket_arn}/*"
      },
    ]
  }
}

resource "aws_iam_role" "caller" {
  #checkov:skip=CKV_AWS_61:The trust policy names this account's root on purpose, to show that trusting a root delegates the choice to the account's identity policies. The caller's inline policy decides who may assume it; the policy has no condition because none is needed within one account.
  name        = "fg-lab01-caller"
  path        = "/lab/"
  description = "Lab 01: may assume the reports reader and nothing else; its CreateUser allow is cancelled by the permissions boundary."

  assume_role_policy   = jsonencode(local.caller_trust)
  permissions_boundary = local.boundary_arn

  # IAM's minimum, and the limit for a chained session (a role assumed by another role).
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "caller" {
  #checkov:skip=CKV_AWS_289:iam:CreateUser is allowed on purpose, only on user/lab01-*, to show the permissions boundary cancelling it. fg-workload-boundary denies iam:CreateUser everywhere, so the user can never be created.
  #checkov:skip=CKV_AWS_290:iam:CreateUser is a write action allowed on purpose, only on user/lab01-*; the permissions boundary denies it, so nothing can be written.
  #checkov:skip=CKV_AWS_355:No statement uses a wildcard resource; the only wildcard is the lab01- prefix in the user ARN.
  name   = "assume-reports-reader"
  role   = aws_iam_role.caller.name
  policy = jsonencode(local.caller_policy)
}

resource "aws_iam_role" "target" {
  name        = "fg-lab01-reports-reader"
  path        = "/lab/"
  description = "Lab 01: trusts the account root with an external ID and reads the private reports bucket."

  assume_role_policy   = jsonencode(local.target_trust)
  permissions_boundary = local.boundary_arn

  # IAM's minimum, and the limit for a chained session (the caller assumes this role).
  max_session_duration = 3600

  lifecycle {
    precondition {
      condition     = var.trusted_account_id != local.account_id
      error_message = "trusted_account_id must be another account: this account is already trusted."
    }
  }
}

resource "aws_iam_role_policy" "target" {
  name   = "read-reports"
  role   = aws_iam_role.target.name
  policy = jsonencode(local.target_policy)
}
