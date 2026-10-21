# The bucket that holds the built site. Private: only this lab's CloudFront distribution reads it
# (origin access control) and only the deploy role writes it. force_destroy lets the destroy
# dispatch empty it, since the content is rebuilt from the repository by deploy.yml.
resource "aws_s3_bucket" "site" {
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage; the site is rebuilt from the repository and versioning covers a bad deploy.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough for public content; a KMS key adds a monthly fee and a key policy to maintain.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_18:Reads go through CloudFront, whose standard logs (logs.tf) already record every request; S3 access logging would only repeat them.
  bucket        = local.site_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id

  versioning_configuration {
    status = "Enabled"
  }
}

# One rule for the whole bucket. Current objects never expire (they are the site); only the history
# does, so a bad deploy can be rolled back for a month and old versions do not pile up.
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  # The rule acts on versions, so versioning comes first.
  depends_on = [aws_s3_bucket_versioning.site]
}

locals {
  site_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # CloudFront signs its requests (OAC) and the policy names the one distribution. There is
        # no s3:ListBucket on purpose: a missing key answers 403, which the distribution maps to
        # the 404 page. The condition key is spelled AWS:SourceArn as in the CloudFront OAC docs.
        Sid       = "AllowCloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${local.site_bucket_arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.site_bucket_arn, "${local.site_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode(local.site_bucket_policy)

  # S3 can abort a policy change that races the public access block.
  depends_on = [aws_s3_bucket_public_access_block.site]
}
