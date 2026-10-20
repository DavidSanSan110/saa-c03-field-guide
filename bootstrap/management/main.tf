module "tags" {
  source = "../../modules/tags"

  lab = "bootstrap-management"
}

# The management account ID is read at plan time and never typed anywhere.
data "aws_caller_identity" "current" {}

locals {
  region     = "eu-west-1"
  account_id = data.aws_caller_identity.current.account_id

  # Names and ARNs are built from known values, not from computed attributes, so the policy
  # documents below are known at plan time.
  state_bucket_name = "field-guide-tfstate-${local.account_id}"
  state_bucket_arn  = "arn:aws:s3:::${local.state_bucket_name}"

  trail_name        = "field-guide-org-trail"
  trail_arn         = "arn:aws:cloudtrail:${local.region}:${local.account_id}:trail/${local.trail_name}"
  trail_bucket_name = "field-guide-org-trail-${local.account_id}"
  trail_bucket_arn  = "arn:aws:s3:::${local.trail_bucket_name}"
}
