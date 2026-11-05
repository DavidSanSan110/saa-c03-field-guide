terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }

    # Only zips src/handler.py on the machine that runs Terraform: no AWS call.
    archive = {
      source  = "hashicorp/archive"
      version = "2.8.1"
    }
  }

  # Partial configuration: infra.yml gives the bucket and the key at init time (the key is
  # labs/05-sqs-lambda-dlq.tfstate), so no account ID is committed. The Region here is the Region of
  # the state bucket, which is also the Region of the lab (eu-west-1, see providers.tf).
  # For a local run, see the README.
  backend "s3" {
    region       = "eu-west-1"
    use_lockfile = true
  }
}
