# Tests for labs/02-s3-kms-encryption (spec 041): the log bucket, its SSE-S3 encryption, its lifecycle
# rule and its bucket policy (AC-10, AC-11, AC-12).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Names and ARNs are built from the account ID, so they are known at plan time. The bucket policy is a
# jsonencode() of a local; statements are compared as jsonencode() text (keys sorted, strings told from
# lists). The rule of the encryption configuration is a set in the provider schema, hence one(...) and
# tolist(...). The key ARN is overridden during plan so the stack resolves as a whole.

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

# AC-10: the log bucket
run "ac10_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket.logs.bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the log bucket name is not field-guide-lab02-logs-<account_id>"
  }

  assert {
    condition     = aws_s3_bucket.logs.force_destroy == true
    error_message = "force_destroy must be true: access logs can land hours after the last request"
  }
}

# AC-10: every sub-resource points at the log bucket by name
run "ac10_sub_resources_name_the_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the public access block does not name the log bucket"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.logs.bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the ownership controls do not name the log bucket"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.logs.bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the encryption configuration does not name the log bucket"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.logs.bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the lifecycle configuration does not name the log bucket"
  }

  assert {
    condition     = aws_s3_bucket_policy.logs.bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the bucket policy does not name the log bucket"
  }
}

# AC-10: all four public access settings are on and ACLs are off
run "ac10_public_access_block_and_ownership" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.block_public_acls == true
    error_message = "block_public_acls is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.ignore_public_acls == true
    error_message = "ignore_public_acls is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.block_public_policy == true
    error_message = "block_public_policy is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.restrict_public_buckets == true
    error_message = "restrict_public_buckets is not true"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.logs.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "object_ownership is not 'BucketOwnerEnforced'"
  }
}

# AC-10: the log bucket uses S3-managed keys (a server access log target cannot use KMS). That the
# stack sets no kms_master_key_id is checked on the file text (kms_master_key_id is Optional+Computed,
# so it is unknown at plan when omitted and cannot be asserted here).
run "ac10_encryption" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_server_side_encryption_configuration.logs.rule) == 1
    error_message = "the encryption configuration must have exactly one rule"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.logs.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "the rule sse_algorithm is not 'AES256'"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.logs.rule).bucket_key_enabled == false
    error_message = "bucket_key_enabled is not false (it must be set explicitly)"
  }

  assert {
    condition     = tolist(one(aws_s3_bucket_server_side_encryption_configuration.logs.rule).blocked_encryption_types) == tolist(["SSE-C"])
    error_message = "blocked_encryption_types is not exactly ['SSE-C']"
  }
}

# AC-11: access logs expire after 7 days and unfinished multipart uploads are cleaned after 1 day
run "ac11_lifecycle" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.logs.rule) == 1
    error_message = "the lifecycle configuration must have exactly one rule"
  }

  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.logs.rule).id == "expire-access-logs"
    error_message = "the lifecycle rule id is not 'expire-access-logs'"
  }

  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.logs.rule).status == "Enabled"
    error_message = "the lifecycle rule status is not 'Enabled'"
  }

  assert {
    condition     = one(one(aws_s3_bucket_lifecycle_configuration.logs.rule).expiration).days == 7
    error_message = "the lifecycle rule must expire objects after 7 days"
  }

  assert {
    condition     = one(one(aws_s3_bucket_lifecycle_configuration.logs.rule).abort_incomplete_multipart_upload).days_after_initiation == 1
    error_message = "the lifecycle rule must abort incomplete multipart uploads after 1 day"
  }
}

# AC-12: the log bucket policy has two statements, in this order: the delivery grant, then the TLS deny
run "ac12_policy_shape" {
  command = plan

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.logs.policy).Version == "2012-10-17"
    error_message = "the log bucket policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.logs.policy).Statement) == 2
    error_message = "the log bucket policy must have exactly two statements"
  }

  assert {
    condition     = [for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Sid] == ["AllowServerAccessLogs", "DenyInsecureTransport"]
    error_message = "the statement Sids must be AllowServerAccessLogs, DenyInsecureTransport, in this order"
  }
}

# AC-12: only the logging service, for the data bucket and this account, may write under s3-access/
run "ac12_allow_server_access_logs" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.logs.policy).Statement[0]) == jsonencode({
      Sid       = "AllowServerAccessLogs"
      Effect    = "Allow"
      Principal = { Service = "logging.s3.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::field-guide-lab02-logs-111111111111/s3-access/*"
      Condition = {
        ArnLike      = { "aws:SourceArn" = "arn:aws:s3:::field-guide-lab02-data-111111111111" }
        StringEquals = { "aws:SourceAccount" = "111111111111" }
      }
    })
    error_message = "statement 1 must be exactly AllowServerAccessLogs: Allow logging.s3.amazonaws.com s3:PutObject on <log ARN>/s3-access/* with ArnLike aws:SourceArn = the data bucket ARN and StringEquals aws:SourceAccount = the account ID"
  }
}

# AC-12: plain HTTP is refused, except for AWS services (log delivery can lack aws:SecureTransport)
run "ac12_deny_insecure_transport" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.logs.policy).Statement[1]) == jsonencode({
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::field-guide-lab02-logs-111111111111", "arn:aws:s3:::field-guide-lab02-logs-111111111111/*"]
      Condition = {
        Bool = {
          "aws:SecureTransport"       = "false"
          "aws:PrincipalIsAWSService" = "false"
        }
      }
    })
    error_message = "statement 2 must be exactly DenyInsecureTransport: Deny '*' s3:* on the log bucket ARN and <log ARN>/* with Bool aws:SecureTransport = false and aws:PrincipalIsAWSService = false"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_s3_bucket_policy.logs.policy).Statement[1].Condition.Bool)) == toset(["aws:SecureTransport", "aws:PrincipalIsAWSService"])
    error_message = "the Bool condition must have exactly aws:SecureTransport and aws:PrincipalIsAWSService"
  }
}
