output "site_bucket_name" {
  description = "Name of the S3 bucket that holds the built site; deploy.yml syncs into it."
  value       = aws_s3_bucket.site.bucket
}

output "log_bucket_name" {
  description = "Name of the S3 bucket that receives the CloudFront standard logs."
  value       = aws_s3_bucket.logs.bucket
}

output "distribution_id" {
  description = "ID of the CloudFront distribution; deploy.yml invalidates its cache."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain_name" {
  description = "The cloudfront.net name of the distribution."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_url" {
  description = "Where the site is served: https:// plus the custom domain if there is one, else the cloudfront.net name."
  value       = local.has_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "deploy_role_arn" {
  description = "ARN of the role that deploy.yml assumes (from the production environment)."
  value       = aws_iam_role.deploy.arn
}
