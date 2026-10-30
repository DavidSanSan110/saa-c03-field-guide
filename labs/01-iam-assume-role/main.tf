module "tags" {
  source = "../../modules/tags"

  lab = "01-iam-assume-role"
}

# The account ID is read at plan time and never typed anywhere. Only account_id is used.
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Everything below is built from the account ID alone, so every name, ARN and policy is known at
  # plan time (the policies are jsonencode() of these locals, not of computed attributes).
  account_root_arn = "arn:aws:iam::${local.account_id}:root"

  # Created by bootstrap/workload: the boundary every lab role must carry. The lab can only attach
  # it, never create or change it.
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/fg-workload-boundary"

  # Both roles live under /lab/, the only path the boundary lets a lab role use or assume.
  caller_role_arn = "arn:aws:iam::${local.account_id}:role/lab/fg-lab01-caller"
  target_role_arn = "arn:aws:iam::${local.account_id}:role/lab/fg-lab01-reports-reader"

  reports_bucket_name = "field-guide-lab01-reports-${local.account_id}"
  reports_bucket_arn  = "arn:aws:s3:::${local.reports_bucket_name}"
}
