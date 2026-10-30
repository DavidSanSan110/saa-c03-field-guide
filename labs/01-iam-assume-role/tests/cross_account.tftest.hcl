# Tests for labs/01-iam-assume-role (spec 040): a second trusted account (AC-8, AC-9) and the
# trusted_account_id output (AC-15). All runs use command = plan with a mock provider, so nothing
# touches AWS. The caller identity (the "current account") is 111111111111.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

# AC-8: with a trusted account the target trusts both roots with the given external ID; the caller
# trust does not change
run "ac8_trusted_account_in_target_trust" {
  command = plan

  variables {
    trusted_account_id = "222222222222"
    external_id        = "acme-42"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Principal) == jsonencode({ AWS = ["arn:aws:iam::111111111111:root", "arn:aws:iam::222222222222:root"] })
    error_message = "the target trust Principal.AWS must be exactly [own account root, trusted account root], in this order"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.target.assume_role_policy).Statement) == 1
    error_message = "the target trust policy must still have exactly one statement"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.target.assume_role_policy).Statement[0].Condition) == jsonencode({ StringEquals = { "sts:ExternalId" = "acme-42" } })
    error_message = "the target trust Condition must be exactly { StringEquals = { 'sts:ExternalId' = 'acme-42' } }"
  }
}

# AC-8: the caller trust is the one of AC-6 whatever the inputs
run "ac8_caller_trust_is_unchanged" {
  command = plan

  variables {
    trusted_account_id = "222222222222"
    external_id        = "acme-42"
  }

  assert {
    condition     = jsondecode(aws_iam_role.caller.assume_role_policy).Version == "2012-10-17" && length(jsondecode(aws_iam_role.caller.assume_role_policy).Statement) == 1
    error_message = "the caller trust policy must still be one statement with Version '2012-10-17'"
  }

  assert {
    condition     = jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Effect == "Allow" && jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Action == "sts:AssumeRole"
    error_message = "the caller trust statement must still be an Allow with Action 'sts:AssumeRole'"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0].Principal) == jsonencode({ AWS = "arn:aws:iam::111111111111:root" })
    error_message = "the caller trust Principal must still be exactly { AWS = 'arn:aws:iam::<account_id>:root' }"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role.caller.assume_role_policy).Statement[0]), "Condition")
    error_message = "the caller trust statement must still have no Condition"
  }
}

# AC-9: a trusted account that is the current account is an error on the target role
run "ac9_trusted_account_equal_to_current_account_is_rejected" {
  command = plan

  variables {
    trusted_account_id = "111111111111"
  }

  expect_failures = [aws_iam_role.target]
}

# AC-15: trusted_account_id is the variable when it is set
run "ac15_trusted_account_id_output_when_set" {
  command = plan

  variables {
    trusted_account_id = "222222222222"
    external_id        = "acme-42"
  }

  assert {
    condition     = output.trusted_account_id == "222222222222"
    error_message = "output trusted_account_id is not the variable when it is set"
  }

  assert {
    condition     = output.external_id == "acme-42"
    error_message = "output external_id is not the variable"
  }
}
