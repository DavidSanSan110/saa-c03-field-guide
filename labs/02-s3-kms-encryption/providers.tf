# Credentials come from the environment: the OIDC role in CI, the IAM Identity Center session
# (AWS_PROFILE) on a laptop. Nothing about the account is written here. The key, both buckets and the
# client role live in one region, and kms:ViaService in the client policy names that same region.
provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = module.tags.tags
  }
}
