# CloudFront standard logs (v2): a delivery source (the distribution), a delivery destination (the
# log bucket) and the delivery that links them. CloudFront requires the CloudWatch delivery APIs to
# be called in us-east-1 even when the bucket is in another Region. With no prefix, the logs land
# under AWSLogs/<account id>/CloudFront/ in the bucket, which is what the bucket policy allows.
resource "aws_cloudwatch_log_delivery_source" "site" {
  provider = aws.us_east_1

  name         = "fg-site-access-logs"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
}

resource "aws_cloudwatch_log_delivery_destination" "site" {
  provider = aws.us_east_1

  name          = "fg-site-access-logs-s3"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_s3_bucket.logs.arn
  }
}

resource "aws_cloudwatch_log_delivery" "site" {
  provider = aws.us_east_1

  delivery_source_name     = aws_cloudwatch_log_delivery_source.site.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.site.arn

  # The delivery service checks the bucket policy when the delivery is created.
  depends_on = [aws_s3_bucket_policy.logs]
}
