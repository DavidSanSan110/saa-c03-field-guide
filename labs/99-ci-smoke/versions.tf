terraform {
  required_version = ">= 1.14.0"

  # Partial configuration: infra.yml passes the bucket (built from the account ID at run time)
  # and the key (labs/<lab id>.tfstate) with -backend-config, so no account ID is committed.
  backend "s3" {
    region       = "eu-west-1"
    use_lockfile = true
    encrypt      = true
  }
}
