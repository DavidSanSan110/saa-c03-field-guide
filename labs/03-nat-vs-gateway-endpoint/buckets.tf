# The two buckets of the lab. Terraform manages no object in them: refreshing an aws_s3_object would
# call s3:GetObject, which the read-only role that plans this stack in CI is denied. You upload the
# objects yourself (README).
#
# - The data bucket is the one the endpoint policy lets through. Objects under endpoint-only/ can be
#   read only through the endpoint (the bucket policy below).
# - The other bucket is the one the endpoint policy refuses. The role of the instance may read it
#   (instance.tf), and the bucket has no policy of its own.
#
# Every sub-resource names its bucket by its name (a local known at plan time) and waits for the
# bucket with depends_on, so the tests can check them without any computed attribute.
resource "aws_s3_bucket" "data" {
  #checkov:skip=CKV_AWS_18:The lab proves the path another way (aws:SourceVpce), and S3 access logs arrive hours late while the NAT gateway bills.
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage and needs a second Region; the bucket holds a few probe objects.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough for probe objects; a KMS key adds a monthly fee and a key policy to maintain.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_21:The probe objects are disposable and the bucket is destroyed with the lab; versioning would keep every overwritten version and its storage.
  #checkov:skip=CKV2_AWS_61:Nothing piles up in a bucket with a few small probe objects that the destroy empties; a lifecycle rule would be unused.
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

# SSE-S3, no KMS key: the lab is about the path, not the key. blocked_encryption_types is set on
# purpose: when it is left out, the provider sends nothing and S3 may reset the setting to NONE, which
# would let SSE-C back in.
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = local.data_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled       = false
    blocked_encryption_types = ["SSE-C"]
  }

  depends_on = [aws_s3_bucket.data]
}

locals {
  # Two denies and no allow: in one account the identity policy is enough to allow.
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
        # A read of an object under endpoint-only/ from anywhere but the endpoint. There is no Null
        # condition on purpose, because the key being missing is the case to refuse. A request that
        # does not come through a VPC endpoint carries no aws:SourceVpce key at all, and a negated
        # operator (StringNotEquals) is true when the key is missing. That is exactly the deny wanted
        # here (the opposite of lab 02, where the same behaviour had to be switched off).
        #
        # Only s3:GetObject under this prefix is denied, so uploads, Terraform, the read-only CI role
        # and force_destroy are not affected.
        Sid       = "DenyReadOutsideEndpoint"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${local.data_bucket_arn}/${local.endpoint_only_prefix}*"
        Condition = {
          StringNotEquals = { "aws:SourceVpce" = aws_vpc_endpoint.s3.id }
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

resource "aws_s3_bucket" "other" {
  #checkov:skip=CKV_AWS_18:The lab proves the path another way (aws:SourceVpce), and S3 access logs arrive hours late while the NAT gateway bills.
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage and needs a second Region; the bucket holds a probe object.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough for a probe object; a KMS key adds a monthly fee and a key policy to maintain.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  #checkov:skip=CKV_AWS_21:The probe object is disposable and the bucket is destroyed with the lab; versioning would keep every overwritten version and its storage.
  #checkov:skip=CKV2_AWS_61:Nothing piles up in a bucket with one small probe object that the destroy empties; a lifecycle rule would be unused.
  bucket        = local.other_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "other" {
  bucket = local.other_bucket_name

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  depends_on = [aws_s3_bucket.other]
}

resource "aws_s3_bucket_ownership_controls" "other" {
  bucket = local.other_bucket_name

  rule {
    object_ownership = "BucketOwnerEnforced"
  }

  depends_on = [aws_s3_bucket.other]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "other" {
  bucket = local.other_bucket_name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled       = false
    blocked_encryption_types = ["SSE-C"]
  }

  depends_on = [aws_s3_bucket.other]
}
