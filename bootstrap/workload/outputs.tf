output "state_bucket" {
  description = "Name of the S3 bucket that holds the Terraform state; pass it to terraform init -backend-config."
  value       = aws_s3_bucket.state.bucket
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC identity provider."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "tf_plan_role_arn" {
  description = "ARN of the read-only role that CI assumes to run terraform plan."
  value       = aws_iam_role.tf_plan.arn
}

output "tf_apply_role_arn" {
  description = "ARN of the role that CI assumes, from the infra environment, to run terraform apply."
  value       = aws_iam_role.tf_apply.arn
}

output "boundary_policy_arn" {
  description = "ARN of the fg-workload-boundary permissions boundary, to set on every role a lab creates."
  value       = aws_iam_policy.boundary.arn
}

output "lab_role_path" {
  description = "IAM path that every role created by a lab must use (path = \"/lab/\"); CI cannot write to roles outside it."
  value       = local.lab_role_path
}

output "hosted_zone_id" {
  description = "ID of the public hosted zone, or null when hosted_zone_name is not set."
  value       = one(aws_route53_zone.site[*].zone_id)
}

output "name_servers" {
  description = "The four name servers to add as NS records for the zone at the parent DNS zone; empty when hosted_zone_name is not set."
  value       = flatten(aws_route53_zone.site[*].name_servers)
}
