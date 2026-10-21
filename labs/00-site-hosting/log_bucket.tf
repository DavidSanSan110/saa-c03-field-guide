# The bucket for CloudFront standard logs (logs.tf). It lives in eu-west-1 with the rest of the lab;
# only the CloudWatch delivery APIs are called in us-east-1. Logs are written once and expire.
resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage; the logs are a study aid and expire after 30 days.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough for access logs; a KMS key adds a monthly fee and a key policy to maintain.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_18:A log bucket does not log itself; that would need a third bucket, and so on.
  #checkov:skip=CKV_AWS_21:Log objects are written once and expire after 30 days, so there is no history to keep.
  bucket        = local.log_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

locals {
  # The CloudWatch Logs delivery service writes the logs. Both conditions pin it to this account's
  # delivery sources (any name, in us-east-1), so no other account's delivery can write here.
  log_delivery_account = [local.account_id]
  log_delivery_sources = ["arn:aws:logs:us-east-1:${local.account_id}:delivery-source:*"]

  log_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # The first two statements are the ones AWS documents for logs sent to S3 (CloudWatch Logs
        # guide, "Logs sent to Amazon S3", V2). AWS adds them to a bucket policy that lacks them,
        # which would show up as a change on every plan, so they are written out here.
        Sid       = "AWSLogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.log_bucket_arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"      = "bucket-owner-full-control"
            "aws:SourceAccount" = local.log_delivery_account
          }
          ArnLike = { "aws:SourceArn" = local.log_delivery_sources }
        }
      },
      {
        # Without this one, the delivery service's bucket check shows up as AccessDenied in CloudTrail.
        Sid       = "AWSLogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = ["s3:GetBucketAcl", "s3:ListBucket"]
        Resource  = local.log_bucket_arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.log_delivery_account }
          ArnLike      = { "aws:SourceArn" = local.log_delivery_sources }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.log_bucket_arn, "${local.log_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode(local.log_bucket_policy)

  # S3 can abort a policy change that races the public access block.
  depends_on = [aws_s3_bucket_public_access_block.logs]
}
