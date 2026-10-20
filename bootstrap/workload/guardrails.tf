# Account-level guardrails. They have no account_id argument: they apply to the provider's account.

# No bucket in the account can be made public, whatever a bucket policy or ACL says.
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# External access findings (resources shared outside the account). Free; the unused-access analyzer
# is billed per resource, so it is not used.
resource "aws_accessanalyzer_analyzer" "account" {
  analyzer_name = local.analyzer_name
  type          = "ACCOUNT"
}

# New EBS volumes and snapshot copies in eu-west-1 are encrypted with the default AWS-managed key.
resource "aws_ebs_encryption_by_default" "this" {
  enabled = true
}
