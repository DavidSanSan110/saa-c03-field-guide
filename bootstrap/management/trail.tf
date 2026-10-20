# Organization trail: management events from every account and Region, delivered to one bucket.
# The first copy of management events is free; no data events, Insights, KMS, CloudWatch Logs or SNS.
resource "aws_cloudtrail" "org" {
  #checkov:skip=CKV_AWS_35:No KMS key on the trail: SSE-S3 on the log bucket is enough and a key costs a monthly fee.
  #checkov:skip=CKV_AWS_252:No SNS topic: nothing consumes delivery notifications, and a topic adds cost and a policy.
  #checkov:skip=CKV2_AWS_10:No CloudWatch Logs integration: ingestion and storage are billed per GB; S3 logs are enough here.
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.trail_logs.bucket
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = true

  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  # The bucket policy must exist before CloudTrail validates the bucket, and trusted access for
  # cloudtrail.amazonaws.com must be on before an organization trail can be created.
  depends_on = [
    aws_s3_bucket_policy.trail_logs,
    aws_organizations_organization.this,
  ]
}

resource "aws_s3_bucket" "trail_logs" {
  #checkov:skip=CKV_AWS_18:Access logging needs a second bucket to log into; cost and scope for a one-person log bucket.
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage and needs a second bucket; logs expire after a year anyway.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough here; a KMS key adds a monthly fee and a key policy CloudTrail must be granted.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  bucket = local.trail_bucket_name
}

resource "aws_s3_bucket_versioning" "trail_logs" {
  bucket = aws_s3_bucket.trail_logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail_logs" {
  bucket = aws_s3_bucket.trail_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "trail_logs" {
  bucket = aws_s3_bucket.trail_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "trail_logs" {
  bucket = aws_s3_bucket.trail_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "trail_logs" {
  bucket = aws_s3_bucket.trail_logs.id

  rule {
    id     = "expire-trail-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 365
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # The noncurrent version rule needs versioning to be on first.
  depends_on = [aws_s3_bucket_versioning.trail_logs]
}

# AWS's documented bucket policy for an organization trail, scoped to this trail with aws:SourceArn.
resource "aws_s3_bucket_policy" "trail_logs" {
  bucket = aws_s3_bucket.trail_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.trail_bucket_arn
        Condition = {
          StringEquals = { "aws:SourceArn" = local.trail_arn }
        }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.trail_bucket_arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = local.trail_arn
          }
        }
      },
      {
        Sid       = "AWSCloudTrailOrganizationWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.trail_bucket_arn}/AWSLogs/${aws_organizations_organization.this.id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = local.trail_arn
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.trail_bucket_arn, "${local.trail_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  })

  # S3 rejects concurrent changes to the public access block and the policy.
  depends_on = [aws_s3_bucket_public_access_block.trail_logs]
}
