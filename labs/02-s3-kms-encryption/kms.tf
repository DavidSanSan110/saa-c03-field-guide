# The customer managed key of the s3-sse-kms-upload diagram: it encrypts the data keys of every
# object in the data bucket. A customer managed key costs $1.00 a month, prorated hourly.
locals {
  # The default key policy: the account root may do everything with the key, which turns on IAM
  # policies for it. Who may use the key is then decided by identity policies (the client role's),
  # not by this document. It also keeps the key from being locked out and lets the read-only role
  # that plans this stack in CI refresh it.
  key_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableIamPolicies"
        Effect    = "Allow"
        Principal = { AWS = local.account_root_arn }
        Action    = "kms:*"
        Resource  = "*"
      },
    ]
  }
}

resource "aws_kms_key" "data" {
  description = "Key of lab 02: encrypts the objects of the data bucket (SSE-KMS with a Bucket Key)"

  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  multi_region             = false

  # Rotates the key material every year (365 days by default). A lab never lives that long, so
  # the rotation fee never starts.
  enable_key_rotation = true

  # The shortest wait KMS allows. A key pending deletion costs nothing.
  deletion_window_in_days = 7

  policy = jsonencode(local.key_policy)
}

resource "aws_kms_alias" "data" {
  name          = local.key_alias
  target_key_id = aws_kms_key.data.key_id
}
