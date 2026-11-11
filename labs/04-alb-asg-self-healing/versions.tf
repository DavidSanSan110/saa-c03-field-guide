terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # Partial configuration: infra.yml gives the bucket and the key at init time (the key is
  # labs/04-alb-asg-self-healing.tfstate), so no account ID is committed. The state bucket and the lab
  # are both in eu-west-1. For a local run, see the README.
  backend "s3" {
    region       = "eu-west-1"
    use_lockfile = true
  }
}
