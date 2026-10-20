output "state_bucket" {
  description = "Name of the S3 bucket that holds this stack's Terraform state; pass it to terraform init -backend-config."
  value       = aws_s3_bucket.state.bucket
}

output "trail_arn" {
  description = "ARN of the organization trail."
  value       = aws_cloudtrail.org.arn
}

output "trail_log_bucket" {
  description = "Name of the S3 bucket that receives the organization trail logs."
  value       = aws_s3_bucket.trail_logs.bucket
}

output "guardrails_policy_id" {
  description = "ID of the field-guide-guardrails service control policy."
  value       = aws_organizations_policy.guardrails.id
}
