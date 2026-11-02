# Credentials come from the environment: the OIDC role in CI, the IAM Identity Center session
# (AWS_PROFILE) on a laptop. Nothing about the account is written here. The whole lab lives in
# us-east-1, the Region of the vpc-nat-vs-gateway-endpoint diagram and its prices. The Terraform state
# stays in eu-west-1 (see versions.tf).
provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = module.tags.tags
  }
}
