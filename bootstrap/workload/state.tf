# The bucket that holds the Terraform state of this stack (key bootstrap/workload.tfstate) and of
# every lab (keys labs/<lab id>.tfstate, plus the matching .tflock). See the README for the first apply.
resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_18:Access logging needs a second bucket to log into; cost and scope for a one-person state bucket.
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage and needs a second bucket; versioning is the recovery path.
  #checkov:skip=CKV_AWS_145:SSE-S3 (AES256) is enough here; a KMS key adds a monthly fee and a key policy to maintain.
  #checkov:skip=CKV2_AWS_61:The lifecycle rule is on purpose: old state versions are kept for 90 days so a bad state can be rolled back.
  #checkov:skip=CKV2_AWS_62:No consumer for bucket events exists; event notifications would be unused.
  bucket = local.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# One rule for the whole bucket. Current objects (the live state) never expire; only the history does.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # The noncurrent version rule needs versioning to be on first.
  depends_on = [aws_s3_bucket_versioning.state]
}

# Deny-only policy: access is granted by IAM (the SSO admin role and the CI roles), the bucket policy
# only narrows it. Conditions use aws:PrincipalArn, not Principal.AWS, so the policy does not depend on
# the CI roles existing first.
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        # Only IAM Identity Center roles read or write the state of the bootstrap stacks.
        Sid       = "DenyBootstrapStateOutsideSso"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = "${local.state_bucket_arn}/bootstrap/*"
        Condition = {
          ArnNotLike = { "aws:PrincipalArn" = local.sso_role_arn_pattern }
        }
      },
      {
        # The CI roles only touch the lab state keys.
        Sid         = "DenyCiRolesOutsideLabs"
        Effect      = "Deny"
        Principal   = "*"
        Action      = ["s3:GetObject*", "s3:PutObject*", "s3:DeleteObject*", "s3:RestoreObject"]
        NotResource = "${local.state_bucket_arn}/labs/*"
        Condition = {
          ArnEquals = { "aws:PrincipalArn" = [local.tf_plan_role_arn, local.tf_apply_role_arn] }
        }
      },
      {
        # tf-plan cannot write a .tflock either: CI plans run with -lock=false.
        Sid       = "DenyPlanRoleWrites"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject*", "s3:DeleteObject*"]
        Resource  = "${local.state_bucket_arn}/*"
        Condition = {
          ArnEquals = { "aws:PrincipalArn" = local.tf_plan_role_arn }
        }
      },
    ]
  })

  # S3 rejects concurrent changes to the public access block and the policy.
  depends_on = [aws_s3_bucket_public_access_block.state]
}
