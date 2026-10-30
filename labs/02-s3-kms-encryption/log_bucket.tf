# The target of the server access logs of the data bucket. A server access log target must use
# SSE-S3 (AES256), the same Region and the same account, so this bucket cannot use the lab key. It
# does not log itself: AWS advises against logging a log bucket into itself, and every delivery would
# write a log about the delivery.
#
# Delivery is best effort and can lag by a few hours. force_destroy is on because logs can land after
# the last request, and a non-empty bucket would block the destroy.
#
# Every sub-resource names the bucket by its name (a local known at plan time) and waits for the
# bucket with depends_on, as in data_bucket.tf.
resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_18:This is the log bucket. AWS advises against logging it into itself: each delivery would write a log about the delivery.
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage and needs a second Region; the logs expire after 7 days.
  #checkov:skip=CKV_AWS_145:A server access log target must use SSE-S3 (AES256); S3 cannot deliver logs to a bucket encrypted with a KMS key.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_21:The logs are disposable and expire after 7 days; versioning would keep every deleted version.
  bucket        = local.log_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = local.log_bucket_name

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [aws_s3_bucket.logs]
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = local.log_bucket_name

  rule {
    object_ownership = "BucketOwnerEnforced"
  }

  depends_on = [aws_s3_bucket.logs]
}

# SSE-S3, and no KMS key. bucket_key_enabled is set to false on purpose: the attribute is
# Optional and Computed, so it would be unknown at plan time when left out.
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = local.log_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled       = false
    blocked_encryption_types = ["SSE-C"]
  }

  depends_on = [aws_s3_bucket.logs]
}

# Logs are for looking at once. They expire after a week, and unfinished multipart uploads are
# cleaned up after a day.
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = local.log_bucket_name

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket.logs]
}

locals {
  log_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # Only the S3 logging service, only for the data bucket of this account, only under the
        # log prefix. The bucket has ACLs off, so this policy is how delivery is allowed.
        Sid       = "AllowServerAccessLogs"
        Effect    = "Allow"
        Principal = { Service = "logging.s3.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.log_bucket_arn}/${local.log_prefix}*"
        Condition = {
          ArnLike      = { "aws:SourceArn" = local.data_bucket_arn }
          StringEquals = { "aws:SourceAccount" = local.account_id }
        }
      },
      {
        # Plain HTTP is refused for people, but not for AWS services: a service-to-service call can
        # lack aws:SecureTransport, and the log delivery must never be denied.
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.log_bucket_arn, "${local.log_bucket_arn}/*"]
        Condition = {
          Bool = {
            "aws:SecureTransport"       = "false"
            "aws:PrincipalIsAWSService" = "false"
          }
        }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = local.log_bucket_name
  policy = jsonencode(local.log_bucket_policy)

  depends_on = [aws_s3_bucket.logs, aws_s3_bucket_public_access_block.logs]
}
