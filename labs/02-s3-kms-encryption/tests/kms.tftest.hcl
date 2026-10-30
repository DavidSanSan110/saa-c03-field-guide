# Tests for labs/02-s3-kms-encryption (spec 041): the customer managed KMS key and its alias (AC-5).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# The key ARN and key ID only exist after creation, so they are overridden during plan (a
# command = apply run with this override fails with "inconsistent final plan", so there is none).
# The key policy is a jsonencode() of a local, so it is asserted on jsondecode(<resource>.policy).

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

# AC-5: the key is a symmetric, single-Region key that rotates and waits the shortest time to delete
run "ac5_key_settings" {
  command = plan

  assert {
    condition     = strcontains(aws_kms_key.data.description, "lab 02")
    error_message = "the key description does not mention 'lab 02'"
  }

  assert {
    condition     = aws_kms_key.data.enable_key_rotation == true
    error_message = "enable_key_rotation is not true"
  }

  assert {
    condition     = aws_kms_key.data.deletion_window_in_days == 7
    error_message = "deletion_window_in_days is not 7"
  }

  assert {
    condition     = aws_kms_key.data.key_usage == "ENCRYPT_DECRYPT"
    error_message = "key_usage is not 'ENCRYPT_DECRYPT'"
  }

  assert {
    condition     = aws_kms_key.data.customer_master_key_spec == "SYMMETRIC_DEFAULT"
    error_message = "customer_master_key_spec is not 'SYMMETRIC_DEFAULT'"
  }

  assert {
    condition     = aws_kms_key.data.multi_region == false
    error_message = "multi_region is not false"
  }
}

# AC-5: the key policy is the default one: the account root, kms:*, so IAM policies decide who may use it
run "ac5_key_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_kms_key.data.policy).Version == "2012-10-17"
    error_message = "the key policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_kms_key.data.policy).Statement) == 1
    error_message = "the key policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_kms_key.data.policy).Statement[0].Sid == "EnableIamPolicies"
    error_message = "the key policy statement Sid is not 'EnableIamPolicies'"
  }

  assert {
    condition     = jsondecode(aws_kms_key.data.policy).Statement[0].Effect == "Allow"
    error_message = "the key policy statement Effect is not 'Allow'"
  }

  assert {
    condition     = jsondecode(aws_kms_key.data.policy).Statement[0].Principal.AWS == "arn:aws:iam::111111111111:root"
    error_message = "the key policy Principal.AWS is not arn:aws:iam::<account_id>:root (a string)"
  }

  assert {
    condition     = jsondecode(aws_kms_key.data.policy).Statement[0].Action == "kms:*"
    error_message = "the key policy Action is not 'kms:*' (a string)"
  }

  assert {
    condition     = jsondecode(aws_kms_key.data.policy).Statement[0].Resource == "*"
    error_message = "the key policy Resource is not '*'"
  }
}

# AC-5: the alias names the key by its key ID
run "ac5_alias" {
  command = plan

  assert {
    condition     = aws_kms_alias.data.name == "alias/fg-lab02-data"
    error_message = "the alias name is not 'alias/fg-lab02-data'"
  }

  assert {
    condition     = aws_kms_alias.data.target_key_id == "11111111-2222-3333-4444-555555555555"
    error_message = "the alias does not target the key_id of the data key"
  }
}
