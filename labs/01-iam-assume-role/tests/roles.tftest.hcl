# Tests for labs/01-iam-assume-role (spec 040): the two roles, their trust policies, their inline
# policies and the outputs with the default inputs (AC-5, AC-6, AC-7, AC-10, AC-11, AC-15).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Policies are jsonencode() of locals, so they are asserted on jsondecode(<resource>.<policy>). Whole
# statements are compared as jsonencode() text: jsonencode sorts the keys of an object, so the
# comparison does not depend on the order the stack writes them in, and it tells a string from a list.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

# AC-5: names, path, permissions boundary and session length of both roles
run "ac5_role_basics" {
  command = plan

  assert {
    condition     = aws_iam_role.caller.name == "fg-lab01-caller"
    error_message = "the caller role name is not 'fg-lab01-caller'"
  }

  assert {
    condition     = aws_iam_role.target.name == "fg-lab01-reports-reader"
    error_message = "the target role name is not 'fg-lab01-reports-reader'"
  }

  assert {
    condition     = aws_iam_role.caller.path == "/lab/" && aws_iam_role.target.path == "/lab/"
    error_message = "both roles must have path '/lab/' (fg-workload-boundary denies other paths)"
  }

  assert {
    condition     = aws_iam_role.caller.permissions_boundary == "arn:aws:iam::111111111111:policy/fg-workload-boundary"
    error_message = "the caller role permissions boundary is not arn:aws:iam::<account_id>:policy/fg-workload-boundary"
  }

  assert {
    condition     = aws_iam_role.target.permissions_boundary == "arn:aws:iam::111111111111:policy/fg-workload-boundary"
    error_message = "the target role permissions boundary is not arn:aws:iam::<account_id>:policy/fg-workload-boundary"
  }

  assert {
    condition     = aws_iam_role.caller.max_session_duration == 3600 && aws_iam_role.target.max_session_duration == 3600
    error_message = "max_session_duration is not 3600 on both roles"
  }
}

# AC-6: the caller trusts the account root, with one plain statement and no condition
run "ac6_caller_trust_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.caller.assume_role_policy).Version == "2012-10-17"
    error_message = "the caller trust policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.caller.assume_role_policy).Statement) == 1
    error_message = "the caller trust policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Effect == "Allow" && jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Action == "sts:AssumeRole"
    error_message = "the caller trust statement must be an Allow with Action 'sts:AssumeRole' (a string)"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Principal) == jsonencode({ AWS = "arn:aws:iam::111111111111:root" })
    error_message = "the caller trust Principal must be exactly { AWS = 'arn:aws:iam::<account_id>:root' } with AWS a string"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0]), "Condition")
    error_message = "the caller trust statement must not have a Condition"
  }

  assert {
    condition     = jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Sid == "AccountPrincipals"
    error_message = "the caller trust statement Sid is not 'AccountPrincipals'"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0])) == toset(["Sid", "Effect", "Principal", "Action"])
    error_message = "the caller trust statement must have only Sid, Effect, Principal and Action"
  }
}

# AC-7: with the defaults, the target trusts the account root only, and only with the external ID
run "ac7_target_trust_policy_defaults" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.target.assume_role_policy).Version == "2012-10-17"
    error_message = "the target trust policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.target.assume_role_policy).Statement) == 1
    error_message = "the target trust policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Effect == "Allow" && jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Action == "sts:AssumeRole"
    error_message = "the target trust statement must be an Allow with Action 'sts:AssumeRole' (a string)"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Principal) == jsonencode({ AWS = ["arn:aws:iam::111111111111:root"] })
    error_message = "the target trust Principal must be exactly { AWS = ['arn:aws:iam::<account_id>:root'] } (a list)"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Condition) == jsonencode({ StringEquals = { "sts:ExternalId" = "field-guide-lab-01" } })
    error_message = "the target trust Condition must be exactly { StringEquals = { 'sts:ExternalId' = 'field-guide-lab-01' } }"
  }

  assert {
    condition     = jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Sid == "TrustedAccountsWithExternalId"
    error_message = "the target trust statement Sid is not 'TrustedAccountsWithExternalId'"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_iam_role.target.assume_role_policy).Statement[0])) == toset(["Sid", "Effect", "Principal", "Action", "Condition"])
    error_message = "the target trust statement must have only Sid, Effect, Principal, Action and Condition"
  }
}

# AC-10: the caller inline policy allows the assume call on the target and iam:CreateUser, nothing else
run "ac10_caller_inline_policy" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.caller.name == "assume-reports-reader"
    error_message = "the caller inline policy name is not 'assume-reports-reader'"
  }

  assert {
    condition     = aws_iam_role_policy.caller.role == "fg-lab01-caller"
    error_message = "the caller inline policy is not attached to the role 'fg-lab01-caller'"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.caller.policy).Version == "2012-10-17"
    error_message = "the caller inline policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.caller.policy).Statement) == 2
    error_message = "the caller inline policy must have exactly two statements"
  }

  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.caller.policy).Statement : jsonencode(s)]) == toset([
      jsonencode({
        Sid      = "AssumeReportsReader"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::111111111111:role/lab/fg-lab01-reports-reader"
      }),
      jsonencode({
        Sid      = "CreateUserDeniedByBoundary"
        Effect   = "Allow"
        Action   = "iam:CreateUser"
        Resource = "arn:aws:iam::111111111111:user/lab01-*"
      }),
    ])
    error_message = "the statements must be exactly AssumeReportsReader (Allow sts:AssumeRole on the target role ARN) and CreateUserDeniedByBoundary (Allow iam:CreateUser on arn:aws:iam::<account_id>:user/lab01-*)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.caller.policy).Statement : !strcontains(jsonencode(s.Action), "*") && !strcontains(jsonencode(s.Action), "s3:")])
    error_message = "no action of the caller inline policy may contain '*' or be an S3 action"
  }
}

# AC-11: the target inline policy lists the reports bucket and reads its objects, nothing else
run "ac11_target_inline_policy" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.target.name == "read-reports"
    error_message = "the target inline policy name is not 'read-reports'"
  }

  assert {
    condition     = aws_iam_role_policy.target.role == "fg-lab01-reports-reader"
    error_message = "the target inline policy is not attached to the role 'fg-lab01-reports-reader'"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.target.policy).Version == "2012-10-17"
    error_message = "the target inline policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.target.policy).Statement) == 2
    error_message = "the target inline policy must have exactly two statements"
  }

  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.target.policy).Statement : jsonencode(s)]) == toset([
      jsonencode({
        Sid      = "ListReports"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = "arn:aws:s3:::field-guide-lab01-reports-111111111111"
      }),
      jsonencode({
        Sid      = "ReadReports"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "arn:aws:s3:::field-guide-lab01-reports-111111111111/*"
      }),
    ])
    error_message = "the statements must be exactly ListReports (Allow s3:ListBucket on the bucket ARN) and ReadReports (Allow s3:GetObject on <bucket ARN>/*)"
  }
}

# AC-15: the outputs with the default inputs
run "ac15_outputs_defaults" {
  command = plan

  assert {
    condition     = output.caller_role_arn == "arn:aws:iam::111111111111:role/lab/fg-lab01-caller"
    error_message = "output caller_role_arn is not arn:aws:iam::<account_id>:role/lab/fg-lab01-caller"
  }

  assert {
    condition     = output.target_role_arn == "arn:aws:iam::111111111111:role/lab/fg-lab01-reports-reader"
    error_message = "output target_role_arn is not arn:aws:iam::<account_id>:role/lab/fg-lab01-reports-reader"
  }

  assert {
    condition     = output.reports_bucket_name == "field-guide-lab01-reports-111111111111"
    error_message = "output reports_bucket_name is not field-guide-lab01-reports-<account_id>"
  }

  assert {
    condition     = output.external_id == var.external_id && output.external_id == "field-guide-lab-01"
    error_message = "output external_id is not the variable (default 'field-guide-lab-01')"
  }

  assert {
    condition     = output.trusted_account_id == ""
    error_message = "output trusted_account_id must be an empty string when the variable is null"
  }
}
