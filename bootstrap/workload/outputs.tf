output "state_bucket" {
  description = "Name of the S3 bucket that holds the Terraform state; pass it to terraform init -backend-config."
  value       = aws_s3_bucket.state.bucket
}

output "hosted_zone_id" {
  description = "ID of the public hosted zone, or null when hosted_zone_name is not set."
  value       = one(aws_route53_zone.site[*].zone_id)
}

output "name_servers" {
  description = "The four name servers to add as NS records for the zone at the parent DNS zone; empty when hosted_zone_name is not set."
  value       = flatten(aws_route53_zone.site[*].name_servers)
}
