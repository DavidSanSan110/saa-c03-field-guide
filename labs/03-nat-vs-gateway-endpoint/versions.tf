terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # Partial configuration: infra.yml gives the bucket and the key at init time (the key is
  # labs/03-nat-vs-gateway-endpoint.tfstate), so no account ID is committed. The Region here is the
  # Region of the state bucket (eu-west-1), not the Region of the lab (us-east-1, see providers.tf).
  # For a local run, see the README.
  backend "s3" {
    region       = "eu-west-1"
    use_lockfile = true
  }
}
