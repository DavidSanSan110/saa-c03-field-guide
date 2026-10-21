# The custom domain, only when domain_name (and hosted_zone_id) are set: a DNS-validated ACM
# certificate in us-east-1 (where CloudFront reads it) and the alias records in the hosted zone.
resource "aws_acm_certificate" "site" {
  provider = aws.us_east_1
  count    = local.has_domain ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# One record per validation option, keyed by its domain name so the keys are known at plan time.
resource "aws_route53_record" "cert_validation" {
  for_each = local.has_domain ? {
    for option in aws_acm_certificate.site[0].domain_validation_options : option.domain_name => option
  } : {}

  zone_id         = var.hosted_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

# Waits until ACM has seen the records and issued the certificate.
resource "aws_acm_certificate_validation" "site" {
  provider = aws.us_east_1
  count    = local.has_domain ? 1 : 0

  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

resource "aws_route53_record" "site_a" {
  count = local.has_domain ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  count = local.has_domain ? 1 : 0

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
