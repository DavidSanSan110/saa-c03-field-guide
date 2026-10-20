# Tests for bootstrap/management (spec 031): the Terraform state bucket and the Organization.
# All runs use command = plan with a mock provider, so nothing touches AWS.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }

  override_resource {
    target          = aws_organizations_organization.this
    override_during = plan
    values = {
      id = "o-exampleorg1"
      non_master_accounts = [
        {
          arn    = "arn:aws:organizations::111111111111:account/o-exampleorg1/222222222222"
          email  = "workload@example.com"
          id     = "222222222222"
          name   = "field-guide"
          status = "ACTIVE"
        },
        {
          arn    = "arn:aws:organizations::111111111111:account/o-exampleorg1/333333333333"
          email  = "other@example.com"
          id     = "333333333333"
          name   = "other"
          status = "ACTIVE"
        },
      ]
    }
  }
}

variables {
  alert_email = "alerts@example.com"
}

# AC-1: the state bucket is named after the management account and is not force-destroyable
run "ac1_state_bucket_name_and_no_force_destroy" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "field-guide-tfstate-111111111111"
    error_message = "aws_s3_bucket.state.bucket is not 'field-guide-tfstate-111111111111'"
  }

  assert {
    condition     = aws_s3_bucket.state.force_destroy != true
    error_message = "aws_s3_bucket.state.force_destroy must be false (or unset)"
  }
}

# AC-1: versioning is Enabled on the state bucket
run "ac1_state_bucket_versioning_enabled" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "aws_s3_bucket_versioning.state status is not 'Enabled'"
  }
}

# AC-1: the state bucket is encrypted with SSE-S3 (AES256)
run "ac1_state_bucket_sse_aes256" {
  command = plan

  assert {
    condition = (
      length(aws_s3_bucket_server_side_encryption_configuration.state.rule) > 0 &&
      alltrue([
        for r in aws_s3_bucket_server_side_encryption_configuration.state.rule :
        alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])
      ])
    )
    error_message = "aws_s3_bucket_server_side_encryption_configuration.state does not use AES256"
  }
}

# AC-1: Block Public Access is fully on for the state bucket
run "ac1_state_bucket_block_public_access" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls == true
    error_message = "state bucket: block_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_policy == true
    error_message = "state bucket: block_public_policy must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.ignore_public_acls == true
    error_message = "state bucket: ignore_public_acls must be true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.state.restrict_public_buckets == true
    error_message = "state bucket: restrict_public_buckets must be true"
  }
}

# AC-1: the state bucket enforces bucket-owner ownership (ACLs disabled)
run "ac1_state_bucket_owner_enforced" {
  command = plan

  assert {
    condition     = aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "aws_s3_bucket_ownership_controls.state object_ownership is not 'BucketOwnerEnforced'"
  }
}

# AC-2: the state bucket policy has exactly one statement and it is a Deny
run "ac2_state_policy_single_deny_statement" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.state.policy).Statement) == 1
    error_message = "the state bucket policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Effect == "Deny"
    error_message = "the state bucket policy statement must be a Deny"
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Principal == "*"
    error_message = "the state bucket policy statement must apply to Principal '*'"
  }
}

# AC-2: the Deny covers s3:* on the bucket ARN and on every object
run "ac2_state_policy_denies_s3_on_bucket_and_objects" {
  command = plan

  assert {
    condition     = toset(flatten([jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Action])) == toset(["s3:*"])
    error_message = "the state bucket policy statement must deny exactly s3:*"
  }

  assert {
    condition = toset(flatten([jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Resource])) == toset([
      "arn:aws:s3:::field-guide-tfstate-111111111111",
      "arn:aws:s3:::field-guide-tfstate-111111111111/*",
    ])
    error_message = "the state bucket policy resources must be exactly the bucket ARN and '<bucket ARN>/*'"
  }
}

# AC-2: the Deny applies when the request is not sent over TLS
run "ac2_state_policy_requires_tls" {
  command = plan

  assert {
    condition     = tostring(jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:SecureTransport"]) == "false"
    error_message = "the state bucket policy condition must be Bool aws:SecureTransport = 'false'"
  }
}

# AC-3: the Organization has all features and the SCP policy type enabled
run "ac3_organization_feature_set_and_policy_types" {
  command = plan

  assert {
    condition     = aws_organizations_organization.this.feature_set == "ALL"
    error_message = "aws_organizations_organization.this.feature_set is not 'ALL'"
  }

  assert {
    condition     = contains(aws_organizations_organization.this.enabled_policy_types, "SERVICE_CONTROL_POLICY")
    error_message = "enabled_policy_types must contain 'SERVICE_CONTROL_POLICY'"
  }
}

# AC-3: trusted access is exactly cloudtrail, iam and sso (removing iam or sso would break them)
run "ac3_organization_service_access_principals_exact" {
  command = plan

  assert {
    condition = toset(aws_organizations_organization.this.aws_service_access_principals) == toset([
      "cloudtrail.amazonaws.com",
      "iam.amazonaws.com",
      "sso.amazonaws.com",
    ])
    error_message = "aws_service_access_principals must be exactly {cloudtrail, iam, sso}.amazonaws.com"
  }
}
