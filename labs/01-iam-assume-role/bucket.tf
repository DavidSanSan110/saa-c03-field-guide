# The private bucket the diagram's last step reads. Only the reports reader can read it: its identity
# policy allows it, and in one account that is enough, so the bucket policy has no allow. Terraform
# manages no object in it: refreshing an aws_s3_object would call s3:GetObject, which the read-only
# role that plans this stack in CI is denied. A reader uploads report.txt by hand (README).
#
# Every sub-resource names the bucket by its name (a local known at plan time) and waits for the
# bucket with depends_on, so the tests can check them without any computed attribute.
resource "aws_s3_bucket" "reports" {
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage; the bucket holds one small text file a reader uploads.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough for a lab file; a KMS key adds a monthly fee and a key policy to maintain.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_18:A study bucket with one file; S3 access logging needs a second bucket to receive the logs.
  #checkov:skip=CKV_AWS_21:The reader's report.txt is disposable and the bucket is destroyed with the lab; versioning would keep deleted objects and more storage.
  #checkov:skip=CKV2_AWS_61:Nothing piles up in a bucket with one small file that the destroy empties; a lifecycle rule would be unused.
  bucket        = local.reports_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "reports" {
  bucket = local.reports_bucket_name

  rule {
    object_ownership = "BucketOwnerEnforced"
  }

  depends_on = [aws_s3_bucket.reports]
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket = local.reports_bucket_name

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [aws_s3_bucket.reports]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = local.reports_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

  depends_on = [aws_s3_bucket.reports]
}

locals {
  reports_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.reports_bucket_arn, "${local.reports_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "reports" {
  bucket = local.reports_bucket_name
  policy = jsonencode(local.reports_bucket_policy)

  # S3 can abort a policy change that races the public access block. The bucket is listed too, so
  # the order does not rest on the other resource alone.
  depends_on = [aws_s3_bucket.reports, aws_s3_bucket_public_access_block.reports]
}
