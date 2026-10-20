# Credentials come from the environment (AWS_PROFILE set to the IAM Identity Center profile of the
# management account). Nothing about the account is written here.
provider "aws" {
  region = local.region

  default_tags {
    tags = module.tags.tags
  }
}
