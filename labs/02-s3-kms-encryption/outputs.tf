output "client_role_arn" {
  description = "ARN of the client role: assume it to upload to and download from the data bucket."
  value       = local.client_role_arn
}

output "data_bucket_name" {
  description = "Name of the data bucket: encrypted by default with the lab key, guarded by the bucket policy."
  value       = local.data_bucket_name
}

output "log_bucket_name" {
  description = "Name of the log bucket that receives the server access logs of the data bucket."
  value       = local.log_bucket_name
}

output "log_prefix" {
  description = "Prefix under which the server access logs land in the log bucket."
  value       = local.log_prefix
}

output "kms_key_arn" {
  description = "ARN of the customer managed KMS key. The bucket policy accepts this exact ARN, not the alias or the key ID."
  value       = aws_kms_key.data.arn
}

output "kms_key_alias" {
  description = "Alias of the KMS key. Handy in the console and the CLI, but an upload must send the key ARN."
  value       = local.key_alias
}
