# Tests for labs/01-iam-assume-role (spec 040, AC-12): the reports bucket and its four sub-resources.
# All runs use command = plan with a mock provider, so nothing touches AWS.
#
# Every sub-resource names the bucket by its (known at plan) name, so these assertions hold without
# overriding any computed attribute. The bucket policy is a jsonencode() of a local.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

# AC-12: the bucket
run "ac12_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket.reports.bucket == "field-guide-lab01-reports-111111111111"
    error_message = "the bucket name is not field-guide-lab01-reports-<account_id>"
  }

  assert {
    condition     = aws_s3_bucket.reports.force_destroy == true
    error_message = "force_destroy must be true: a reader's uploaded report.txt must not block destroy"
  }
}

# AC-12: every sub-resource points at the bucket by name
run "ac12_sub_resources_name_the_bucket" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.reports.bucket == "field-guide-lab01-reports-111111111111"
    error_message = "the public access block does not name the reports bucket"
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.reports.bucket == "field-guide-lab01-reports-111111111111"
    error_message = "the ownership controls do not name the reports bucket"
  }

  assert {
    condition     = aws_s3_bucket_server_side_encryption_configuration.reports.bucket == "field-guide-lab01-reports-111111111111"
    error_message = "the encryption configuration does not name the reports bucket"
  }

  assert {
    condition     = aws_s3_bucket_policy.reports.bucket == "field-guide-lab01-reports-111111111111"
    error_message = "the bucket policy does not name the reports bucket"
  }
}

# AC-12: all four public access settings are on
run "ac12_public_access_block" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.reports.block_public_acls == true
    error_message = "block_public_acls is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.reports.ignore_public_acls == true
    error_message = "ignore_public_acls is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.reports.block_public_policy == true
    error_message = "block_public_policy is not true"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.reports.restrict_public_buckets == true
    error_message = "restrict_public_buckets is not true"
  }
}

# AC-12: ACLs are off and the objects are encrypted with S3-managed keys
run "ac12_ownership_and_encryption" {
  command = plan

  assert {
    condition     = aws_s3_bucket_ownership_controls.reports.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "object_ownership is not 'BucketOwnerEnforced'"
  }

  assert {
    condition     = [for r in aws_s3_bucket_server_side_encryption_configuration.reports.rule : r.apply_server_side_encryption_by_default[0].sse_algorithm] == ["AES256"]
    error_message = "the encryption configuration must have exactly one rule with sse_algorithm 'AES256'"
  }
}

# AC-12: the bucket policy is one deny of insecure transport, and nothing else
run "ac12_bucket_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.reports.policy).Version == "2012-10-17"
    error_message = "the bucket policy Version is not '2012-10-17'"
  }

  assert {
    condition     = length(jsondecode(aws_s3_bucket_policy.reports.policy).Statement) == 1
    error_message = "the bucket policy must have exactly one statement (no allow: the identity policy is enough in one account)"
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0].Sid == "DenyInsecureTransport"
    error_message = "the bucket policy statement Sid is not 'DenyInsecureTransport'"
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0].Effect == "Deny"
    error_message = "the bucket policy statement Effect is not 'Deny'"
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0].Principal == "*" && jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0].Action == "s3:*"
    error_message = "the bucket policy statement must have Principal '*' and Action 's3:*' (strings)"
  }

  assert {
    condition     = toset(flatten([jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0].Resource])) == toset(["arn:aws:s3:::field-guide-lab01-reports-111111111111", "arn:aws:s3:::field-guide-lab01-reports-111111111111/*"])
    error_message = "the bucket policy Resource must be the bucket ARN and <bucket ARN>/*"
  }

  assert {
    condition     = jsonencode(jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0].Condition) == jsonencode({ Bool = { "aws:SecureTransport" = "false" } })
    error_message = "the bucket policy Condition must be exactly { Bool = { 'aws:SecureTransport' = 'false' } }"
  }

  assert {
    condition     = toset(keys(jsondecode(aws_s3_bucket_policy.reports.policy).Statement[0])) == toset(["Sid", "Effect", "Principal", "Action", "Resource", "Condition"])
    error_message = "the bucket policy statement must have only Sid, Effect, Principal, Action, Resource and Condition"
  }
}
