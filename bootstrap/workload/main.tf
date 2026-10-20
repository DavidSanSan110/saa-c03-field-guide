module "tags" {
  source = "../../modules/tags"

  lab = "bootstrap-workload"
}

# The workload account ID is read at plan time and never typed anywhere.
data "aws_caller_identity" "current" {}

locals {
  region     = "eu-west-1"
  account_id = data.aws_caller_identity.current.account_id

  # Names and ARNs are built from known values, not from computed attributes, so every policy
  # document in this stack is known at plan time (and IAM can be told about a role before it exists).
  state_bucket_name = "field-guide-tfstate-${local.account_id}"
  state_bucket_arn  = "arn:aws:s3:::${local.state_bucket_name}"

  # The IAM Identity Center roles of the account live under this path.
  sso_role_arn_pattern = "arn:aws:iam::${local.account_id}:role/aws-reserved/sso.amazonaws.com/*"

  oidc_host         = "token.actions.githubusercontent.com"
  oidc_provider_arn = "arn:aws:iam::${local.account_id}:oidc-provider/${local.oidc_host}"

  tf_plan_role_name  = "fg-tf-plan"
  tf_plan_role_arn   = "arn:aws:iam::${local.account_id}:role/${local.tf_plan_role_name}"
  tf_apply_role_name = "fg-tf-apply"
  tf_apply_role_arn  = "arn:aws:iam::${local.account_id}:role/${local.tf_apply_role_name}"

  # Created by AWS Organizations; the management account assumes it. CI must never touch it.
  org_access_role_arn = "arn:aws:iam::${local.account_id}:role/OrganizationAccountAccessRole"

  boundary_name = "fg-workload-boundary"
  boundary_arn  = "arn:aws:iam::${local.account_id}:policy/${local.boundary_name}"

  analyzer_name = "field-guide-account"
  analyzer_arn  = "arn:aws:access-analyzer:${local.region}:${local.account_id}:analyzer/${local.analyzer_name}"
}
