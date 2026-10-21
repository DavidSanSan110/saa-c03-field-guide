# terraform_data is built into Terraform: no provider, no AWS resource, nothing to pay for.
resource "terraform_data" "smoke" {
  input = var.message
}
