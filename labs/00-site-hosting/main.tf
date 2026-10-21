module "tags" {
  source = "../../modules/tags"

  lab = "00-site-hosting"
}

# The account ID is read at plan time and never typed anywhere. Only account_id is used.
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  has_domain = var.domain_name != null

  # Names and ARNs are built from known values, not from computed attributes, so the bucket
  # policies and the deploy role policies are known at plan time. The one exception is the
  # distribution ARN, which only exists after creation.
  site_bucket_name = "field-guide-site-${local.account_id}"
  site_bucket_arn  = "arn:aws:s3:::${local.site_bucket_name}"
  log_bucket_name  = "field-guide-site-logs-${local.account_id}"
  log_bucket_arn   = "arn:aws:s3:::${local.log_bucket_name}"

  # Created by bootstrap/workload: the GitHub OIDC provider and the boundary every lab role needs.
  oidc_host         = "token.actions.githubusercontent.com"
  oidc_provider_arn = "arn:aws:iam::${local.account_id}:oidc-provider/${local.oidc_host}"
  boundary_arn      = "arn:aws:iam::${local.account_id}:policy/fg-workload-boundary"

  # Managed CachingOptimized cache policy (the ID is the same in every account).
  caching_optimized_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

  # What the viewer-request function redirects *.cloudfront.net visitors to; empty = no redirect.
  canonical_host = local.has_domain ? var.domain_name : ""
}
