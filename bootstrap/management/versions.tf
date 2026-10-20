terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # Partial configuration: the bucket is given at init time so no account ID is committed:
  #   terraform init -backend-config="bucket=field-guide-tfstate-<ACCOUNT_ID>"
  backend "s3" {
    key          = "bootstrap/management.tfstate"
    region       = "eu-west-1"
    use_lockfile = true
    encrypt      = true
  }
}
