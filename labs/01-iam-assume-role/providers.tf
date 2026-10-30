# Credentials come from the environment: the OIDC role in CI, the IAM Identity Center session
# (AWS_PROFILE) on a laptop. Nothing about the account is written here. IAM and STS are global, so
# one region is enough; the bucket lives in the same one.
provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = module.tags.tags
  }
}
