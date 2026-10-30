# Tests for labs/02-s3-kms-encryption (spec 041): the client role, its trust policy, its inline policy
# and the outputs (AC-13, AC-14, AC-15).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Policies are jsonencode() of locals, so they are asserted on jsondecode(<resource>.<policy>).
# Statements are compared as jsonencode() text: jsonencode sorts the keys of an object, so the
# comparison does not depend on the order the stack writes them in, and it tells a string from a
# list. The order of the statements themselves is part of the contract (a list comparison). The key
# ARN is overridden during plan.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

override_resource {
  target          = aws_kms_key.data
  override_during = plan
  values = {
    arn    = "arn:aws:kms:eu-west-1:111111111111:key/11111111-2222-3333-4444-555555555555"
    key_id = "11111111-2222-3333-4444-555555555555"
  }
}

# AC-13: name, path, permissions boundary and session length of the client role
run "ac13_role_basics" {
  command = plan

  assert {
    condition     = aws_iam_role.client.name == "fg-lab02-client"
    error_message = "the client role name is not 'fg-lab02-client'"
  }

  assert {
    condition     = aws_iam_role.client.path == "/lab/"
    error_message = "the client role path is not '/lab/' (fg-workload-boundary denies other paths)"
  }

  assert {
    condition     = aws_iam_role.client.permissions_boundary == "arn:aws:iam::111111111111:policy/fg-workload-boundary"
    error_message = "the client role permissions boundary is not arn:aws:iam::<account_id>:policy/fg-workload-boundary"
  }

  assert {
    condition     = aws_iam_role.client.max_session_duration == 3600
    error_message = "max_session_duration is not 3600"
  }
}

# AC-13: the client trusts the account root, with one plain statement and no condition
run "ac13_client_trust_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role.client.assume_role_policy).Version == "2012-10-17"
    error_message = "the client trust policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.client.assume_role_policy).Statement) == 1
    error_message = "the client trust policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role.client.assume_role_policy).Statement[0].Effect == "Allow" && jsondecode(aws_iam_role.client.assume_role_policy).Statement[0].Action == "sts:AssumeRole"
    error_message = "the client trust statement must be an Allow with Action 'sts:AssumeRole' (a string)"
  }

  assert {
    condition     = jsondecode(aws_iam_role.client.assume_role_policy).Statement[0].Principal.AWS == "arn:aws:iam::111111111111:root"
    error_message = "the client trust Principal.AWS must be the string arn:aws:iam::<account_id>:root"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role.client.assume_role_policy).Statement[0]), "Condition")
    error_message = "the client trust statement must not have a Condition"
  }

  assert {
    condition     = jsondecode(aws_iam_role.client.assume_role_policy).Statement[0].Sid == "AccountPrincipals"
    error_message = "the client trust statement Sid is not 'AccountPrincipals'"
  }
}

# AC-14: the client inline policy: name, role and shape
run "ac14_client_policy_shape" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.client.name == "use-data-bucket"
    error_message = "the client inline policy name is not 'use-data-bucket'"
  }

  assert {
    condition     = aws_iam_role_policy.client.role == "fg-lab02-client"
    error_message = "the client inline policy is not attached to the role 'fg-lab02-client'"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.client.policy).Version == "2012-10-17"
    error_message = "the client inline policy Version is not '2012-10-17'"
  }

  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.client.policy).Statement : s.Sid] == ["ListDataBucket", "ReadWriteObjects", "UseDataKeyThroughS3"]
    error_message = "the statement Sids must be ListDataBucket, ReadWriteObjects, UseDataKeyThroughS3, in this order"
  }
}

# AC-14: the three statements, exactly
run "ac14_client_policy_statements" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.client.policy).Statement[0]) == jsonencode({
      Sid      = "ListDataBucket"
      Effect   = "Allow"
      Action   = "s3:ListBucket"
      Resource = "arn:aws:s3:::field-guide-lab02-data-111111111111"
    })
    error_message = "statement 1 must be exactly ListDataBucket: Allow s3:ListBucket on the data bucket ARN"
  }

  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.client.policy).Statement[1]) == jsonencode({
      Sid      = "ReadWriteObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "arn:aws:s3:::field-guide-lab02-data-111111111111/*"
    })
    error_message = "statement 2 must be exactly ReadWriteObjects: Allow ['s3:GetObject', 's3:PutObject'] on <data bucket ARN>/*"
  }

  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.client.policy).Statement[2]) == jsonencode({
      Sid       = "UseDataKeyThroughS3"
      Effect    = "Allow"
      Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
      Resource  = "arn:aws:kms:eu-west-1:111111111111:key/11111111-2222-3333-4444-555555555555"
      Condition = { StringEquals = { "kms:ViaService" = "s3.eu-west-1.amazonaws.com" } }
    })
    error_message = "statement 3 must be exactly UseDataKeyThroughS3: Allow ['kms:Decrypt', 'kms:GenerateDataKey'] on the key ARN when kms:ViaService is s3.eu-west-1.amazonaws.com"
  }
}

# AC-14: no wildcard in any action of the client policy
run "ac14_client_policy_no_wildcard_actions" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.client.policy).Statement : !strcontains(jsonencode(s.Action), "*")])
    error_message = "no action of the client inline policy may contain '*'"
  }
}

# AC-15: the outputs
run "ac15_outputs" {
  command = plan

  assert {
    condition     = output.client_role_arn == "arn:aws:iam::111111111111:role/lab/fg-lab02-client"
    error_message = "output client_role_arn is not arn:aws:iam::<account_id>:role/lab/fg-lab02-client"
  }

  assert {
    condition     = output.data_bucket_name == "field-guide-lab02-data-111111111111"
    error_message = "output data_bucket_name is not field-guide-lab02-data-<account_id>"
  }

  assert {
    condition     = output.log_bucket_name == "field-guide-lab02-logs-111111111111"
    error_message = "output log_bucket_name is not field-guide-lab02-logs-<account_id>"
  }

  assert {
    condition     = output.log_prefix == "s3-access/"
    error_message = "output log_prefix is not 's3-access/'"
  }

  assert {
    condition     = output.kms_key_arn == "arn:aws:kms:eu-west-1:111111111111:key/11111111-2222-3333-4444-555555555555"
    error_message = "output kms_key_arn is not the ARN of the lab key"
  }

  assert {
    condition     = output.kms_key_alias == "alias/fg-lab02-data"
    error_message = "output kms_key_alias is not 'alias/fg-lab02-data'"
  }
}
