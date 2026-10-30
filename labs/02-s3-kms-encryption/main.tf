module "tags" {
  source = "../../modules/tags"

  lab = "02-s3-kms-encryption"
}

# The account ID is read at plan time and never typed anywhere. Only account_id is used.
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Everything below is built from the account ID alone, so every name, ARN and policy is known at
  # plan time (the policies are jsonencode() of these locals). The only computed value the stack
  # uses is the ARN of the KMS key.
  account_root_arn = "arn:aws:iam::${local.account_id}:root"

  # Created by bootstrap/workload: the boundary every lab role must carry. The lab can only attach
  # it, never create or change it.
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/fg-workload-boundary"

  # Under /lab/, the only path the boundary lets a lab role use or assume.
  client_role_arn = "arn:aws:iam::${local.account_id}:role/lab/fg-lab02-client"

  data_bucket_name = "field-guide-lab02-data-${local.account_id}"
  data_bucket_arn  = "arn:aws:s3:::${local.data_bucket_name}"
  log_bucket_name  = "field-guide-lab02-logs-${local.account_id}"
  log_bucket_arn   = "arn:aws:s3:::${local.log_bucket_name}"

  # Where the server access logs land in the log bucket.
  log_prefix = "s3-access/"

  # The service name KMS reports as kms:ViaService when S3 calls it for a request in this region.
  s3_via_service = "s3.eu-west-1.amazonaws.com"

  key_alias = "alias/fg-lab02-data"
}
