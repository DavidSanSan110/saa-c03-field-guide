# The security headers of the site live in apps/site/headers.json (one file for the dev server, the
# tests and this stack). A change to it plans and applies this lab (tools/guardrails stack-inputs).
# Parsing is written so that bad input reaches the preconditions of the headers policy below,
# instead of failing earlier with an evaluation error.
locals {
  headers_text = var.headers_json != null ? var.headers_json : file("${path.module}/../../apps/site/headers.json")

  # null when the text is not JSON; an object (or something else) otherwise.
  headers_decoded = try(jsondecode(local.headers_text), null)

  # A JSON object whose values are all strings (a JSON string encodes with a leading quote) and
  # whose names stay unique when the case is ignored.
  headers_ok = try(alltrue([
    for value in values(local.headers_decoded) : startswith(jsonencode(value), "\"")
  ]) && length(local.headers_decoded) == length(distinct([for name in keys(local.headers_decoded) : lower(name)])), false)

  # Header names are matched case-insensitively: lower-case name => value.
  headers = local.headers_ok ? { for name, value in local.headers_decoded : lower(name) => tostring(value) } : {}

  security_header_names = [
    "strict-transport-security",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
  ]

  hsts_value     = lookup(local.headers, "strict-transport-security", null)
  csp_value      = lookup(local.headers, "content-security-policy", null)
  nosniff_value  = lookup(local.headers, "x-content-type-options", null)
  frame_value    = lookup(local.headers, "x-frame-options", null)
  referrer_value = lookup(local.headers, "referrer-policy", null)

  hsts_pattern = "(?i)^max-age=[0-9]+(; *includeSubDomains)?(; *preload)?$"

  referrer_policies = [
    "no-referrer",
    "no-referrer-when-downgrade",
    "origin",
    "origin-when-cross-origin",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
  ]

  # CloudFront rejects a Content-Security-Policy value longer than this.
  csp_max_length = 1783

  missing_headers = [for name in local.security_header_names : name if !contains(keys(local.headers), name)]

  # What the policy is built from. The fallbacks only keep the plan going until the preconditions
  # of the policy, where a missing or bad value fails it with a message.
  hsts_max_age       = try(tonumber(regex("(?i)^max-age=([0-9]+)", local.hsts_value)[0]), 0)
  hsts_subdomains    = can(regex("(?i); *includeSubDomains", local.hsts_value))
  hsts_preload       = can(regex("(?i); *preload", local.hsts_value))
  csp_header_value   = local.csp_value != null ? local.csp_value : ""
  frame_header_value = local.frame_value != null ? local.frame_value : "DENY"
  referrer_header    = local.referrer_value != null ? local.referrer_value : "no-referrer"

  # Every header without a field of its own, with its original name.
  custom_headers = local.headers_ok ? {
    for name, value in local.headers_decoded : name => tostring(value) if !contains(local.security_header_names, lower(name))
  } : {}
}

resource "aws_cloudfront_response_headers_policy" "site" {
  #checkov:skip=CKV_AWS_259:HSTS comes from apps/site/headers.json and has no includeSubDomains on purpose: the domain is provisional (decision D25 Q7).
  name    = "fg-site-headers"
  comment = "Security headers of the site, from apps/site/headers.json"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age
      include_subdomains         = local.hsts_subdomains
      preload                    = local.hsts_preload
      override                   = true
    }

    content_security_policy {
      content_security_policy = local.csp_header_value
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = local.frame_header_value
      override     = true
    }

    referrer_policy {
      referrer_policy = local.referrer_header
      override        = true
    }
  }

  dynamic "custom_headers_config" {
    for_each = length(local.custom_headers) > 0 ? [1] : []

    content {
      dynamic "items" {
        for_each = local.custom_headers

        content {
          header   = items.key
          value    = items.value
          override = true
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = local.headers_ok
      error_message = "apps/site/headers.json must be a JSON object whose values are all strings, with header names that differ by more than letter case."
    }

    precondition {
      condition     = length(local.missing_headers) == 0
      error_message = "apps/site/headers.json must have these security headers (any letter case): ${join(", ", local.missing_headers)}."
    }

    precondition {
      condition     = local.hsts_value == null || can(regex(local.hsts_pattern, local.hsts_value))
      error_message = "Strict-Transport-Security in apps/site/headers.json must be max-age=<seconds>, optionally followed by \"; includeSubDomains\" and then \"; preload\"."
    }

    precondition {
      condition     = local.nosniff_value == null || local.nosniff_value == "nosniff"
      error_message = "X-Content-Type-Options in apps/site/headers.json must be nosniff."
    }

    precondition {
      condition     = local.frame_value == null || contains(["DENY", "SAMEORIGIN"], local.frame_value)
      error_message = "X-Frame-Options in apps/site/headers.json must be DENY or SAMEORIGIN."
    }

    precondition {
      condition     = local.referrer_value == null || contains(local.referrer_policies, local.referrer_value)
      error_message = "Referrer-Policy in apps/site/headers.json must be one of: ${join(", ", local.referrer_policies)}."
    }

    # CloudFront rejects a longer value; failing here gives the reason before the API call does.
    precondition {
      condition     = local.csp_value == null || length(local.csp_value) <= local.csp_max_length
      error_message = "Content-Security-Policy in apps/site/headers.json is longer than ${local.csp_max_length} characters, the most CloudFront accepts."
    }
  }
}

# The site bucket is private; CloudFront signs every request to it with SigV4 (origin access
# control, the successor of the origin access identity).
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "fg-site"
  description                       = "Signs the requests of the field guide site distribution to its bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The conservative script subset in functions/viewer-request.js runs here and in the tests. The
# placeholder is replaced by the domain, or by an empty string when the lab has no domain.
resource "aws_cloudfront_function" "viewer_request" {
  name    = "fg-site-viewer-request"
  comment = "Directory index rewrite, trailing slash redirect and redirect to the custom domain"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = replace(file("${path.module}/functions/viewer-request.js"), "__CANONICAL_HOST__", local.canonical_host)
}

resource "aws_cloudfront_distribution" "site" {
  #checkov:skip=CKV_AWS_68:No WAF for now: a static study site, and a web ACL adds a monthly fee (decision D25 Q3).
  #checkov:skip=CKV2_AWS_47:No WAF for now (decision D25 Q3), so there is no Log4j rule to attach either.
  #checkov:skip=CKV_AWS_310:One origin: the site bucket has no replica to fail over to.
  #checkov:skip=CKV_AWS_374:A public site for readers everywhere, so no geo restriction.
  #checkov:skip=CKV_AWS_86:Logs go through standard logs v2 (CloudWatch log delivery in logs.tf), not the legacy logging_config this check looks for.
  #checkov:skip=CKV_AWS_174:Without a domain the distribution must use the default cloudfront.net certificate, which CloudFront forces to TLSv1; with a domain it is TLSv1.2_2021 (terraform test asserts it).
  #checkov:skip=CKV2_AWS_42:Without a domain the distribution must use the default cloudfront.net certificate; with a domain it uses an ACM certificate.
  comment             = "SAA-C03 Field Guide site"
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = "PriceClass_100"
  default_root_object = "index.html"
  aliases             = local.has_domain ? [var.domain_name] : []

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.viewer_request.arn
    }
  }

  # A missing key answers 403 (the bucket policy has no s3:ListBucket), so both codes show the 404 page.
  dynamic "custom_error_response" {
    for_each = [403, 404]

    content {
      error_code            = custom_error_response.value
      response_page_path    = "/404.html"
      response_code         = 404
      error_caching_min_ttl = 60
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # With a domain: the validated ACM certificate. Without: the default certificate of cloudfront.net.
  viewer_certificate {
    acm_certificate_arn            = local.has_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.has_domain ? "sni-only" : null
    cloudfront_default_certificate = local.has_domain ? null : true
    minimum_protocol_version       = local.has_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}
