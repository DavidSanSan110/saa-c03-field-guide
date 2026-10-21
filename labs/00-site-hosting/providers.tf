# Credentials come from the environment: the OIDC role in CI, the IAM Identity Center session
# (AWS_PROFILE) on a laptop. Nothing about the account is written here.
provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = module.tags.tags
  }
}

# CloudFront reads its ACM certificate from us-east-1 and, to enable standard logging, the
# CloudWatch delivery APIs must be called in us-east-1 too, even when the log bucket is elsewhere.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = module.tags.tags
  }
}
