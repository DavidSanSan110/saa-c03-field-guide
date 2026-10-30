# The client of the s3-sse-kms-upload diagram: the identity that uploads to and downloads from the
# data bucket. In one account its identity policy is enough to allow the bucket and the key, and the
# bucket policy only denies.
#
# The role needs path /lab/ and the fg-workload-boundary permissions boundary: the boundary denies
# every role write, PassRole and AssumeRole outside arn:aws:iam::<account>:role/lab/*, and refuses to
# create a role without itself. The same denies are on the role that applies this stack. Neither
# the boundary nor the service control policy of the organization names a kms: action or an S3
# action on these buckets, so every deny the lab shows comes from the bucket policy, this identity
# policy or KMS.
locals {
  # Trusts the account root, not one named principal: who may assume the role is delegated to the
  # identity policies of this account. No condition.
  client_trust = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountPrincipals"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = "sts:AssumeRole"
      },
    ]
  }

  client_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListDataBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.data_bucket_arn
      },
      {
        Sid      = "ReadWriteObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${local.data_bucket_arn}/*"
      },
      {
        # The key permission of the diagram: GenerateDataKey to upload, Decrypt to download. It
        # works only when S3 makes the call for the client (kms:ViaService), not for a direct
        # call to KMS. Delete this statement to see the "Missing KMS permission" scenario.
        Sid      = "UseDataKeyThroughS3"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.data.arn
        Condition = {
          StringEquals = { "kms:ViaService" = local.s3_via_service }
        }
      },
    ]
  }
}

resource "aws_iam_role" "client" {
  #checkov:skip=CKV_AWS_61:The trust policy names this account's root on purpose: it delegates who may assume the role to the identity policies of the account, and the policy has no condition because none is needed within one account.
  name        = "fg-lab02-client"
  path        = "/lab/"
  description = "Lab 02: uploads to and downloads from the data bucket, through S3 only for the KMS key."

  assume_role_policy   = jsonencode(local.client_trust)
  permissions_boundary = local.boundary_arn

  # IAM's minimum.
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "client" {
  name   = "use-data-bucket"
  role   = aws_iam_role.client.name
  policy = jsonencode(local.client_policy)
}
