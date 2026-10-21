# Tests for labs/00-site-hosting (spec 035): the stack with a custom domain (AC-30, AC-36, AC-40).
# All runs use command = plan with mock providers, so nothing touches AWS.
#
# The certificate is overridden with override_during = plan: the validation records are keyed by
# the validation options, which must be known at plan time. The certificate ARN and the
# distribution values are overridden during plan so that they can be compared.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

override_resource {
  target          = aws_acm_certificate.site
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:111111111111:certificate/11111111-1111-1111-1111-111111111111"
    domain_validation_options = [
      {
        domain_name           = "site.example.com"
        resource_record_name  = "_abc.site.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_def.acm-validations.aws."
      }
    ]
  }
}

override_resource {
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    arn            = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE12345"
    domain_name    = "d111111abcdef8.cloudfront.net"
    hosted_zone_id = "Z0123456789EXAMPLE"
    id             = "E2EXAMPLE12345"
  }
}

variables {
  github_sub_prefix = "repo:your-user/saa-c03-field-guide"
  domain_name       = "site.example.com"
  hosted_zone_id    = "Z0123456789EXAMPLE"
}

# AC-36: one DNS-validated certificate for the domain
run "ac36_certificate" {
  command = plan

  assert {
    condition     = length(aws_acm_certificate.site) == 1
    error_message = "there must be exactly one aws_acm_certificate.site with a domain"
  }

  assert {
    condition     = aws_acm_certificate.site[0].domain_name == "site.example.com"
    error_message = "the certificate domain_name is not the domain"
  }

  assert {
    condition     = aws_acm_certificate.site[0].validation_method == "DNS"
    error_message = "the certificate validation_method is not 'DNS'"
  }
}

# AC-36: one validation record per validation option, in the hosted zone
run "ac36_validation_records" {
  command = plan

  assert {
    condition     = length(aws_route53_record.cert_validation) == 1
    error_message = "there must be one validation record"
  }

  assert {
    condition     = toset(keys(aws_route53_record.cert_validation)) == toset(["site.example.com"])
    error_message = "the validation records must be keyed by the validation option domain_name"
  }

  assert {
    condition     = aws_route53_record.cert_validation["site.example.com"].zone_id == "Z0123456789EXAMPLE"
    error_message = "the validation record must be in var.hosted_zone_id"
  }

  assert {
    condition     = aws_route53_record.cert_validation["site.example.com"].ttl == 60
    error_message = "the validation record ttl is not 60"
  }

  assert {
    condition     = aws_route53_record.cert_validation["site.example.com"].allow_overwrite == true
    error_message = "the validation record must have allow_overwrite = true"
  }

  assert {
    condition     = aws_route53_record.cert_validation["site.example.com"].name == "_abc.site.example.com." && aws_route53_record.cert_validation["site.example.com"].type == "CNAME" && toset(aws_route53_record.cert_validation["site.example.com"].records) == toset(["_def.acm-validations.aws."])
    error_message = "the validation record must carry the name, type and value of the validation option"
  }
}

# AC-36: the validation resource waits for the certificate
run "ac36_certificate_validation" {
  command = plan

  assert {
    condition     = length(aws_acm_certificate_validation.site) == 1
    error_message = "there must be exactly one aws_acm_certificate_validation.site with a domain"
  }

  assert {
    condition     = aws_acm_certificate_validation.site[0].certificate_arn == aws_acm_certificate.site[0].arn
    error_message = "the validation must be for the certificate"
  }
}

# AC-36: the distribution answers to the domain with the validated certificate
run "ac36_distribution_alias_and_certificate" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.site.aliases == toset(["site.example.com"])
    error_message = "aliases must be exactly [site.example.com]"
  }

  assert {
    condition     = [for v in aws_cloudfront_distribution.site.viewer_certificate : v.acm_certificate_arn] == ["arn:aws:acm:us-east-1:111111111111:certificate/11111111-1111-1111-1111-111111111111"]
    error_message = "the viewer certificate must use the validated certificate ARN"
  }

  assert {
    condition     = [for v in aws_cloudfront_distribution.site.viewer_certificate : v.ssl_support_method] == ["sni-only"]
    error_message = "ssl_support_method is not 'sni-only'"
  }

  assert {
    condition     = [for v in aws_cloudfront_distribution.site.viewer_certificate : v.minimum_protocol_version] == ["TLSv1.2_2021"]
    error_message = "minimum_protocol_version is not 'TLSv1.2_2021'"
  }

  assert {
    condition     = [for v in aws_cloudfront_distribution.site.viewer_certificate : v.cloudfront_default_certificate != true] == [true]
    error_message = "the default CloudFront certificate must not be used with a domain"
  }
}

# AC-36: A record, alias to the distribution, no health evaluation
run "ac36_a_record" {
  command = plan

  assert {
    condition     = length(aws_route53_record.site_a) == 1
    error_message = "there must be exactly one A record"
  }

  assert {
    condition     = aws_route53_record.site_a[0].name == "site.example.com" && aws_route53_record.site_a[0].type == "A" && aws_route53_record.site_a[0].zone_id == "Z0123456789EXAMPLE"
    error_message = "the A record must be named after the domain, of type A, in var.hosted_zone_id"
  }

  assert {
    condition     = [for a in aws_route53_record.site_a[0].alias : a.name] == ["d111111abcdef8.cloudfront.net"]
    error_message = "the A alias must point at the distribution domain name"
  }

  assert {
    condition     = [for a in aws_route53_record.site_a[0].alias : a.zone_id] == ["Z0123456789EXAMPLE"]
    error_message = "the A alias must use the distribution hosted zone ID"
  }

  assert {
    condition     = [for a in aws_route53_record.site_a[0].alias : a.evaluate_target_health] == [false]
    error_message = "the A alias must not evaluate target health"
  }
}

# AC-36: AAAA record, alias to the distribution, no health evaluation
run "ac36_aaaa_record" {
  command = plan

  assert {
    condition     = length(aws_route53_record.site_aaaa) == 1
    error_message = "there must be exactly one AAAA record"
  }

  assert {
    condition     = aws_route53_record.site_aaaa[0].name == "site.example.com" && aws_route53_record.site_aaaa[0].type == "AAAA" && aws_route53_record.site_aaaa[0].zone_id == "Z0123456789EXAMPLE"
    error_message = "the AAAA record must be named after the domain, of type AAAA, in var.hosted_zone_id"
  }

  assert {
    condition     = [for a in aws_route53_record.site_aaaa[0].alias : a.name] == ["d111111abcdef8.cloudfront.net"]
    error_message = "the AAAA alias must point at the distribution domain name"
  }

  assert {
    condition     = [for a in aws_route53_record.site_aaaa[0].alias : a.zone_id] == ["Z0123456789EXAMPLE"]
    error_message = "the AAAA alias must use the distribution hosted zone ID"
  }

  assert {
    condition     = [for a in aws_route53_record.site_aaaa[0].alias : a.evaluate_target_health] == [false]
    error_message = "the AAAA alias must not evaluate target health"
  }
}

# AC-30: with a domain the function redirects *.cloudfront.net to the canonical host
run "ac30_function_with_a_domain" {
  command = plan

  assert {
    condition     = !strcontains(aws_cloudfront_function.viewer_request.code, "__CANONICAL_HOST__")
    error_message = "the function code still contains the __CANONICAL_HOST__ placeholder"
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.viewer_request.code, "var canonicalHost = 'site.example.com';")
    error_message = "with a domain the function code must contain \"var canonicalHost = 'site.example.com';\""
  }
}

# AC-36, AC-40: site_url is https:// plus the domain
run "ac36_site_url_output" {
  command = plan

  assert {
    condition     = output.site_url == "https://site.example.com"
    error_message = "output site_url must be https://site.example.com with a domain"
  }
}
