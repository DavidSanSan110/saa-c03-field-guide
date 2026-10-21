# Tests for labs/00-site-hosting (spec 035): CloudFront: the origin access control, the distribution
# without a domain, the error pages and the viewer-request function (AC-24, AC-25, AC-26, AC-30).
# All runs use command = plan with mock providers, so nothing touches AWS.
#
# Values that only exist after creation are overridden during plan so that they can be compared.

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
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    arn            = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE12345"
    domain_name    = "d111111abcdef8.cloudfront.net"
    hosted_zone_id = "Z0123456789EXAMPLE"
    id             = "E2EXAMPLE12345"
  }
}

override_resource {
  target          = aws_cloudfront_origin_access_control.site
  override_during = plan
  values = {
    id = "E2OACEXAMPLE1"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.site
  override_during = plan
  values = {
    id = "22222222-2222-2222-2222-222222222222"
  }
}

override_resource {
  target          = aws_cloudfront_function.viewer_request
  override_during = plan
  values = {
    arn = "arn:aws:cloudfront::111111111111:function/fg-site-viewer-request"
  }
}

override_resource {
  target          = aws_s3_bucket.site
  override_during = plan
  values = {
    arn                         = "arn:aws:s3:::field-guide-site-111111111111"
    bucket_regional_domain_name = "field-guide-site-111111111111.s3.eu-west-1.amazonaws.com"
  }
}

variables {
  github_sub_prefix = "repo:your-user/saa-c03-field-guide"
}

# AC-24: the origin access control signs every request to S3 with SigV4
run "ac24_origin_access_control" {
  command = plan

  assert {
    condition     = aws_cloudfront_origin_access_control.site.name == "fg-site"
    error_message = "the origin access control name is not 'fg-site'"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.site.origin_access_control_origin_type == "s3"
    error_message = "origin_access_control_origin_type is not 's3'"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.site.signing_behavior == "always"
    error_message = "signing_behavior is not 'always'"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.site.signing_protocol == "sigv4"
    error_message = "signing_protocol is not 'sigv4'"
  }
}

# AC-24: the only origin is the site bucket, reached through the OAC, with no OAI
run "ac24_distribution_origin" {
  command = plan

  assert {
    condition     = length(aws_cloudfront_distribution.site.origin) == 1
    error_message = "the distribution must have exactly one origin"
  }

  assert {
    condition     = [for o in aws_cloudfront_distribution.site.origin : o.origin_id] == ["site"]
    error_message = "the origin_id must be 'site'"
  }

  assert {
    condition     = [for o in aws_cloudfront_distribution.site.origin : o.domain_name] == ["field-guide-site-111111111111.s3.eu-west-1.amazonaws.com"]
    error_message = "the origin must use the site bucket regional domain name"
  }

  assert {
    condition     = [for o in aws_cloudfront_distribution.site.origin : o.origin_access_control_id] == [aws_cloudfront_origin_access_control.site.id]
    error_message = "the origin must use the origin access control"
  }

  assert {
    condition     = [for o in aws_cloudfront_distribution.site.origin : length(o.s3_origin_config)] == [0]
    error_message = "the origin must not have an s3_origin_config (no origin access identity)"
  }

  assert {
    condition     = [for o in aws_cloudfront_distribution.site.origin : length(o.custom_origin_config)] == [0]
    error_message = "the origin must not have a custom_origin_config"
  }
}

# AC-25: the distribution settings
run "ac25_distribution_settings" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.site.comment == "SAA-C03 Field Guide site"
    error_message = "the distribution comment is not 'SAA-C03 Field Guide site'"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.enabled == true
    error_message = "the distribution must be enabled"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.is_ipv6_enabled == true
    error_message = "IPv6 must be enabled"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.http_version == "http2and3"
    error_message = "http_version is not 'http2and3'"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.price_class == "PriceClass_100"
    error_message = "price_class is not 'PriceClass_100'"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.default_root_object == "index.html"
    error_message = "default_root_object is not 'index.html'"
  }

  assert {
    condition     = [for r in aws_cloudfront_distribution.site.restrictions : [for g in r.geo_restriction : g.restriction_type]] == [["none"]]
    error_message = "the geo restriction must be 'none'"
  }

  assert {
    condition     = length(aws_cloudfront_distribution.site.logging_config) == 0
    error_message = "the distribution must not use the legacy logging_config (standard logs v2 are used)"
  }
}

# AC-25: the default cache behaviour
run "ac25_default_cache_behavior" {
  command = plan

  assert {
    condition     = length(aws_cloudfront_distribution.site.default_cache_behavior) == 1
    error_message = "the distribution must have exactly one default_cache_behavior"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : b.viewer_protocol_policy] == ["redirect-to-https"]
    error_message = "viewer_protocol_policy is not 'redirect-to-https'"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : toset(b.allowed_methods)] == [toset(["GET", "HEAD"])]
    error_message = "allowed_methods must be exactly GET and HEAD"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : toset(b.cached_methods)] == [toset(["GET", "HEAD"])]
    error_message = "cached_methods must be exactly GET and HEAD"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : b.compress] == [true]
    error_message = "compress must be true"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : b.cache_policy_id] == ["658327ea-f89d-4fab-a63d-7e88639e58f6"]
    error_message = "cache_policy_id is not the managed CachingOptimized policy"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : b.target_origin_id] == ["site"]
    error_message = "target_origin_id is not 'site'"
  }
}

# AC-25: the headers policy and exactly one viewer-request function
run "ac25_headers_policy_and_function_association" {
  command = plan

  assert {
    condition     = aws_cloudfront_response_headers_policy.site.name == "fg-site-headers"
    error_message = "the response headers policy name is not 'fg-site-headers'"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : b.response_headers_policy_id] == [aws_cloudfront_response_headers_policy.site.id]
    error_message = "the default cache behaviour must use the response headers policy"
  }

  assert {
    condition     = aws_cloudfront_function.viewer_request.name == "fg-site-viewer-request"
    error_message = "the function name is not 'fg-site-viewer-request'"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : length(b.function_association)] == [1]
    error_message = "the default cache behaviour must have exactly one function_association"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : [for f in b.function_association : f.event_type]] == [["viewer-request"]]
    error_message = "the function association must be on viewer-request"
  }

  assert {
    condition     = [for b in aws_cloudfront_distribution.site.default_cache_behavior : [for f in b.function_association : f.function_arn]] == [[aws_cloudfront_function.viewer_request.arn]]
    error_message = "the function association must use the viewer-request function ARN"
  }
}

# AC-26: 403 and 404 both show the 404 page, with response code 404, cached for 60 seconds
run "ac26_custom_error_responses" {
  command = plan

  assert {
    condition     = length(aws_cloudfront_distribution.site.custom_error_response) == 2
    error_message = "there must be exactly two custom_error_response blocks"
  }

  assert {
    condition     = toset([for r in aws_cloudfront_distribution.site.custom_error_response : tostring(r.error_code)]) == toset(["403", "404"])
    error_message = "the custom error responses must be for exactly 403 and 404"
  }

  assert {
    condition     = alltrue([for r in aws_cloudfront_distribution.site.custom_error_response : r.response_page_path == "/404.html"])
    error_message = "every custom error response must use response_page_path '/404.html'"
  }

  assert {
    condition     = alltrue([for r in aws_cloudfront_distribution.site.custom_error_response : tostring(r.response_code) == "404"])
    error_message = "every custom error response must use response_code 404"
  }

  assert {
    condition     = alltrue([for r in aws_cloudfront_distribution.site.custom_error_response : tostring(r.error_caching_min_ttl) == "60"])
    error_message = "every custom error response must use error_caching_min_ttl 60"
  }
}

# AC-30: the function runtime, publication and, without a domain, an empty canonical host
run "ac30_function_without_a_domain" {
  command = plan

  assert {
    condition     = aws_cloudfront_function.viewer_request.runtime == "cloudfront-js-2.0"
    error_message = "the function runtime is not 'cloudfront-js-2.0'"
  }

  assert {
    condition     = aws_cloudfront_function.viewer_request.publish == true
    error_message = "the function must be published"
  }

  assert {
    condition     = !strcontains(aws_cloudfront_function.viewer_request.code, "__CANONICAL_HOST__")
    error_message = "the function code still contains the __CANONICAL_HOST__ placeholder"
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.viewer_request.code, "var canonicalHost = '';")
    error_message = "without a domain the function code must contain \"var canonicalHost = '';\""
  }
}
