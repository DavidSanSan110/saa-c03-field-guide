# Tests for labs/02-s3-kms-encryption (spec 041): the data bucket, its default encryption, its access
# logging and its bucket policy (AC-6, AC-7, AC-8, AC-9).
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Names and ARNs are built from the account ID, so they are known at plan time. The key ARN is
# overridden during plan. The bucket policy is a jsonencode() of a local; statements are compared as
# jsonencode() text: jsonencode sorts the keys of an object, so the comparison does not depend on the
# order the stack writes them in, and it tells a string from a list. The order of the statements
# themselves is part of the contract (a list comparison). The rule of the encryption configuration is
# a set in the provider schema, hence one(...) and tolist(...).

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

# AC-6: the data bucket
run "ac6_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket.data.bucket == "field-guide-lab02-data-111111111111"
    error_message = "the data bucket name is not field-guide-lab02-data-<account_id>"
  }

  assert {
    condition     = aws_s3_bucket.data.force_destroy == true
    error_message = "force_destroy must be true: the verify probe object must not block destroy"
  }
}

# AC-6: every sub-resource points at the data bucket by name
run "ac6_sub_resources_name_the_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.data.bucket == "field-guide-lab02-data-111111111111"
    error_message = "the public access block does not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.data.bucket == "field-guide-lab02-data-111111111111"
    error_message = "the ownership controls do not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.data.bucket == "field-guide-lab02-data-111111111111"
    error_message = "the encryption configuration does not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_logging.data.bucket == "field-guide-lab02-data-111111111111"
    error_message = "the logging configuration does not name the data bucket"
  }

  assert {
    condition     = aws_s3_bucket_policy.data.bucket == "field-guide-lab02-data-111111111111"
    error_message = "the bucket policy does not name the data bucket"
  }
}

# AC-6: all four public access settings are on and ACLs are off
run "ac6_public_access_block_and_ownership" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.data.block_public_acls == true
    error_message = "block_public_acls is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.data.ignore_public_acls == true
    error_message = "ignore_public_acls is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.data.block_public_policy == true
    error_message = "block_public_policy is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.data.restrict_public_buckets == true
    error_message = "restrict_public_buckets is not true"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.data.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "object_ownership is not 'BucketOwnerEnforced'"
  }
}

# AC-7: default encryption is SSE-KMS with the lab key and a Bucket Key, and SSE-C is blocked
run "ac7_default_encryption" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket_server_side_encryption_configuration.data.rule) == 1
    error_message = "the encryption configuration must have exactly one rule"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.data.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
    error_message = "the rule sse_algorithm is not 'aws:kms'"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.data.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == "arn:aws:kms:eu-west-1:111111111111:key/11111111-2222-3333-4444-555555555555"
    error_message = "the rule kms_master_key_id is not the ARN of the lab key"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.data.rule).bucket_key_enabled == true
    error_message = "bucket_key_enabled is not true"
  }

  assert {
    condition     = tolist(one(aws_s3_bucket_server_side_encryption_configuration.data.rule).blocked_encryption_types) == tolist(["SSE-C"])
    error_message = "blocked_encryption_types is not exactly ['SSE-C']"
  }
}

# AC-8: server access logs go to the log bucket under s3-access/, with no grants
run "ac8_access_logging" {
  command = plan

  assert {
    condition     = aws_s3_bucket_logging.data.target_bucket == "field-guide-lab02-logs-111111111111"
    error_message = "the logging target_bucket is not field-guide-lab02-logs-<account_id>"
  }

  assert {
    condition     = aws_s3_bucket_logging.data.target_prefix == "s3-access/"
    error_message = "the logging target_prefix is not 's3-access/'"
  }

  assert {
    condition     = length(aws_s3_bucket_logging.data.target_grant) == 0
    error_message = "the logging configuration must have no target_grant (bucket owner enforced)"
  }
}

# AC-9: the bucket policy has the four statements of the spec, in this order, and no allow
run "ac9_bucket_policy_shape" {
  command = plan

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.data.policy).Version == "2012-10-17"
    error_message = "the bucket policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.data.policy).Statement) == 4
    error_message = "the bucket policy must have exactly four statements"
  }

  assert {
    condition     = [for s in jsondecode(aws_s3_bucket_policy.data.policy).Statement : s.Sid] == ["DenyInsecureTransport", "DenyOtherEncryption", "DenyOtherKmsKey", "DenyKmsWithoutKeyId"]
    error_message = "the statement Sids must be DenyInsecureTransport, DenyOtherEncryption, DenyOtherKmsKey, DenyKmsWithoutKeyId, in this order"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.data.policy).Statement : s.Effect == "Deny"])
    error_message = "every statement of the bucket policy must be a Deny (no allow: the identity policy is enough in one account)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.data.policy).Statement : s.Principal == "*"])
    error_message = "every statement of the bucket policy must have Principal '*' (a string)"
  }
}

# AC-9: DenyInsecureTransport refuses every request that is not TLS, on the bucket and its objects
run "ac9_deny_insecure_transport" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.data.policy).Statement[0]) == jsonencode({
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::field-guide-lab02-data-111111111111", "arn:aws:s3:::field-guide-lab02-data-111111111111/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    })
    error_message = "statement 1 must be exactly DenyInsecureTransport: Deny '*' s3:* on the bucket ARN and <bucket ARN>/* when aws:SecureTransport is false"
  }
}

# AC-9: DenyOtherEncryption refuses a header that asks for anything but aws:kms (and lets no header through to default encryption)
run "ac9_deny_other_encryption" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.data.policy).Statement[1]) == jsonencode({
      Sid       = "DenyOtherEncryption"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::field-guide-lab02-data-111111111111/*"
      Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
    })
    error_message = "statement 2 must be exactly DenyOtherEncryption: Deny '*' s3:PutObject on <bucket ARN>/* with StringNotEqualsIfExists s3:x-amz-server-side-encryption = aws:kms"
  }
}

# AC-9: DenyOtherKmsKey refuses a key-ID header that is not the lab key ARN
run "ac9_deny_other_kms_key" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.data.policy).Statement[2]) == jsonencode({
      Sid       = "DenyOtherKmsKey"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::field-guide-lab02-data-111111111111/*"
      Condition = { ArnNotEqualsIfExists = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "arn:aws:kms:eu-west-1:111111111111:key/11111111-2222-3333-4444-555555555555" } }
    })
    error_message = "statement 3 must be exactly DenyOtherKmsKey: Deny '*' s3:PutObject on <bucket ARN>/* with ArnNotEqualsIfExists s3:x-amz-server-side-encryption-aws-kms-key-id = the key ARN"
  }
}

# AC-9: DenyKmsWithoutKeyId refuses aws:kms without a key-ID header (S3 would pick aws/s3)
run "ac9_deny_kms_without_key_id" {
  command = plan

  assert {
    condition = jsonencode(jsondecode(aws_s3_bucket_policy.data.policy).Statement[3]) == jsonencode({
      Sid       = "DenyKmsWithoutKeyId"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::field-guide-lab02-data-111111111111/*"
      Condition = {
        StringEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
        Null         = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "true" }
      }
    })
    error_message = "statement 4 must be exactly DenyKmsWithoutKeyId: Deny '*' s3:PutObject on <bucket ARN>/* with StringEquals s3:x-amz-server-side-encryption = aws:kms and Null s3:x-amz-server-side-encryption-aws-kms-key-id = true"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_s3_bucket_policy.data.policy).Statement[3].Condition)) == toset(["StringEquals", "Null"])
    error_message = "statement 4 must have exactly the condition operators StringEquals and Null"
  }
}
