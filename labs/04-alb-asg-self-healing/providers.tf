# Credentials come from the environment: the OIDC role in CI, the IAM Identity Center session
# (AWS_PROFILE) on a laptop. Nothing about the account is written here. The whole lab lives in
# eu-west-1, the Region of the alb-asg-az-failure diagram and of the state bucket.
provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = module.tags.tags
  }
}
