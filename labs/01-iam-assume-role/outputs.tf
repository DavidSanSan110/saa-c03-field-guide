output "caller_role_arn" {
  description = "ARN of the caller role: the identity that is allowed to assume the reports reader."
  value       = local.caller_role_arn
}

output "target_role_arn" {
  description = "ARN of the reports reader role: it trusts the account root and demands the external ID."
  value       = local.target_role_arn
}

output "reports_bucket_name" {
  description = "Name of the private bucket only the reports reader can read. Upload report.txt to it yourself."
  value       = local.reports_bucket_name
}

output "external_id" {
  description = "The external ID the reports reader requires. Not a secret."
  value       = var.external_id
}

output "trusted_account_id" {
  description = "The second trusted account ID, or an empty string when only this account is trusted."
  value       = var.trusted_account_id == null ? "" : var.trusted_account_id
}
