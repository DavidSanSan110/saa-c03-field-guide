# The data bucket of the s3-sse-kms-upload diagram: encrypted by default with the lab key and a
# Bucket Key, with a bucket policy that refuses plain HTTP and uploads that ask for a weaker
# encryption or another key. Terraform manages no object in it: refreshing an aws_s3_object would
# call s3:GetObject, which the read-only role that plans this stack in CI is denied. The client role
# uploads the objects (README).
#
# Every sub-resource names the bucket by its name (a local known at plan time) and waits for the
# bucket with depends_on, so the tests can check them without any computed attribute.
resource "aws_s3_bucket" "data" {
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage and needs a second Region; the bucket holds a probe object the lab recreates.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_21:The probe objects are disposable and the bucket is destroyed with the lab; versioning would keep every overwritten version and its storage.
  #checkov:skip=CKV2_AWS_61:Nothing piles up in a bucket with one small probe object that the destroy empties; a lifecycle rule would be unused.
  bucket        = local.data_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket = local.data_bucket_name

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [aws_s3_bucket.data]
}

resource "aws_s3_bucket_ownership_controls" "data" {
  bucket = local.data_bucket_name

  rule {
    object_ownership = "BucketOwnerEnforced"
  }

  depends_on = [aws_s3_bucket.data]
}

# Default encryption: an upload that sends no encryption header is encrypted with the lab key, and
# the Bucket Key makes S3 fetch one bucket-level key from KMS instead of one data key per object.
# blocked_encryption_types is set on purpose: when it is left out, the provider sends nothing and
# S3 may reset the setting to NONE, which would let SSE-C back in.
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = local.data_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }

    bucket_key_enabled       = true
    blocked_encryption_types = ["SSE-C"]
  }

  depends_on = [aws_s3_bucket.data]
}

# Server access logs, delivered to the log bucket under s3-access/. The log bucket policy must grant
# the logging service first, so the data bucket waits for it. There are no target grants: the log
# bucket has ACLs off (bucket owner enforced) and the grant lives in its bucket policy.
resource "aws_s3_bucket_logging" "data" {
  bucket = local.data_bucket_name

  target_bucket = local.log_bucket_name
  target_prefix = local.log_prefix

  depends_on = [aws_s3_bucket.data, aws_s3_bucket_policy.logs]
}

locals {
  # Four denies and no allow: in one account the client's identity policy is enough to allow.
  #
  # An upload that sends no encryption header is allowed and gets the bucket default (the lab key
  # and the Bucket Key). The classic exam pattern, "deny when x-amz-server-side-encryption is
  # missing", would refuse that upload too and is redundant next to default encryption.
  #
  # The IfExists operators make a deny apply only when the header is sent. A multipart upload sends
  # its headers on CreateMultipartUpload only, and UploadPart is authorized as s3:PutObject without
  # them, so a deny that fired on a missing header would break every multipart upload.
  data_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # Every request over plain HTTP, on the bucket and on its objects.
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.data_bucket_arn, "${local.data_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        # A header that asks for anything but aws:kms: SSE-S3 (AES256) or DSSE-KMS (aws:kms:dsse).
        Sid       = "DenyOtherEncryption"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.data_bucket_arn}/*"
        Condition = {
          StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "aws:kms" }
        }
      },
      {
        # A key-ID header that is not the lab key. The value is compared as it is sent, so only
        # the key ARN passes: an alias or a bare key ID is refused too.
        Sid       = "DenyOtherKmsKey"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.data_bucket_arn}/*"
        Condition = {
          ArnNotEqualsIfExists = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.data.arn }
        }
      },
      {
        # aws:kms with no key ID would use the AWS managed key aws/s3, not the lab key.
        Sid       = "DenyKmsWithoutKeyId"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${local.data_bucket_arn}/*"
        Condition = {
          StringEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
          Null         = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "true" }
        }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "data" {
  bucket = local.data_bucket_name
  policy = jsonencode(local.data_bucket_policy)

  # S3 can abort a policy change that races the public access block. The bucket is listed too, so
  # the order does not rest on the other resource alone.
  depends_on = [aws_s3_bucket.data, aws_s3_bucket_public_access_block.data]
}
