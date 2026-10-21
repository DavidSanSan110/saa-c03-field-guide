# Tests for labs/00-site-hosting (spec 035): the response headers policy built from headers.json
# (AC-27, AC-28, AC-29). All runs use command = plan with mock providers, so nothing touches AWS.
#
# Header samples are inline headers_json strings (no fixture files). A bad sample must fail through
# a precondition of aws_cloudfront_response_headers_policy.site, not through an evaluation error
# earlier in the locals: expect_failures only accepts failures of that resource.

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

variables {
  github_sub_prefix = "repo:your-user/saa-c03-field-guide"
}

# AC-27: the policy maps the current apps/site/headers.json (values are read from the file)
run "ac27_security_headers_from_the_file" {
  command = plan

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.strict_transport_security : h.access_control_max_age_sec]] == [[31536000]]
    error_message = "HSTS max-age must be 31536000"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.strict_transport_security : h.include_subdomains != true && h.preload != true]] == [[true]]
    error_message = "HSTS must have neither includeSubDomains nor preload"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.strict_transport_security : h.override]] == [[true]]
    error_message = "HSTS override must be true"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.content_security_policy : h.content_security_policy]] == [[jsondecode(file("${path.module}/../../apps/site/headers.json"))["Content-Security-Policy"]]]
    error_message = "the CSP must equal the value in apps/site/headers.json"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.content_security_policy : h.override]] == [[true]]
    error_message = "CSP override must be true"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.content_type_options : h.override]] == [[true]]
    error_message = "content_type_options (nosniff) must be present with override true"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.frame_options : h.frame_option]] == [["DENY"]]
    error_message = "the frame option must be DENY"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.frame_options : h.override]] == [[true]]
    error_message = "frame_options override must be true"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.referrer_policy : h.referrer_policy]] == [[jsondecode(file("${path.module}/../../apps/site/headers.json"))["Referrer-Policy"]]]
    error_message = "the referrer policy must equal the value in apps/site/headers.json"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.referrer_policy : h.override]] == [[true]]
    error_message = "referrer_policy override must be true"
  }
}

# AC-27: every other header of the file is a custom header, with the file's value and override on
run "ac27_custom_headers_from_the_file" {
  command = plan

  assert {
    condition     = { for i in aws_cloudfront_response_headers_policy.site.custom_headers_config[0].items : i.header => i.value } == { for k in ["Permissions-Policy", "Cross-Origin-Opener-Policy"] : k => jsondecode(file("${path.module}/../../apps/site/headers.json"))[k] }
    error_message = "the custom headers must be exactly Permissions-Policy and Cross-Origin-Opener-Policy with the values of apps/site/headers.json"
  }

  assert {
    condition     = alltrue([for i in aws_cloudfront_response_headers_policy.site.custom_headers_config[0].items : i.override])
    error_message = "every custom header must have override = true"
  }
}

# AC-28: lower-case names are matched, HSTS tokens are read, other keys are custom headers
run "ac28_inline_headers_lower_case_names" {
  command = plan

  variables {
    headers_json = jsonencode({
      "strict-transport-security" = "max-age=600; includeSubDomains; preload"
      "content-security-policy"   = "default-src 'self'"
      "x-content-type-options"    = "nosniff"
      "x-frame-options"           = "SAMEORIGIN"
      "referrer-policy"           = "no-referrer"
      "X-Test-Header"             = "yes"
    })
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.strict_transport_security : h.access_control_max_age_sec]] == [[600]]
    error_message = "HSTS max-age must be 600"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.strict_transport_security : h.include_subdomains && h.preload && h.override]] == [[true]]
    error_message = "HSTS must have includeSubDomains, preload and override on"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.frame_options : h.frame_option]] == [["SAMEORIGIN"]]
    error_message = "the frame option must be SAMEORIGIN"
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.referrer_policy : h.referrer_policy]] == [["no-referrer"]]
    error_message = "the referrer policy must be no-referrer"
  }

  assert {
    condition     = { for i in aws_cloudfront_response_headers_policy.site.custom_headers_config[0].items : i.header => i.value } == { "X-Test-Header" = "yes" }
    error_message = "the only custom header must be X-Test-Header = yes (with its original name)"
  }

  assert {
    condition     = alltrue([for i in aws_cloudfront_response_headers_policy.site.custom_headers_config[0].items : i.override])
    error_message = "the custom header must have override = true"
  }
}

# AC-29: a CSP of exactly 1783 characters passes
run "ac29_csp_of_1783_characters_passes" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "${join("", [for i in range(891) : "ab"])}a"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  assert {
    condition     = [for s in aws_cloudfront_response_headers_policy.site.security_headers_config : [for h in s.content_security_policy : length(h.content_security_policy)]] == [[1783]]
    error_message = "a CSP of exactly 1783 characters must be accepted as it is"
  }
}

# AC-29: a CSP of 1784 characters fails the policy precondition
run "ac29_csp_of_1784_characters_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = join("", [for i in range(892) : "ab"])
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# AC-29: HSTS with a max-age that is not a number
run "ac29_hsts_max_age_abc_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=abc"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# AC-29: HSTS with an unknown token
run "ac29_hsts_unknown_token_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=1; includeSubDomains; foo"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# AC-29: X-Content-Type-Options other than nosniff
run "ac29_content_type_options_sniff_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "sniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# AC-29: X-Frame-Options in lower case is not DENY or SAMEORIGIN
run "ac29_frame_options_lower_case_deny_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "deny"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# AC-29: a Referrer-Policy outside the allowed list
run "ac29_referrer_policy_always_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "always"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# AC-29: no Content-Security-Policy
run "ac29_missing_csp_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

# Spec 035 section 7: each of the other four security headers is required too
run "ac29_missing_hsts_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Content-Security-Policy" = "default-src 'self'"
      "X-Content-Type-Options"  = "nosniff"
      "X-Frame-Options"         = "DENY"
      "Referrer-Policy"         = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

run "ac29_missing_content_type_options_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Frame-Options"           = "DENY"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

run "ac29_missing_frame_options_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "nosniff"
      "Referrer-Policy"           = "no-referrer"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}

run "ac29_missing_referrer_policy_fails" {
  command = plan

  variables {
    headers_json = jsonencode({
      "Strict-Transport-Security" = "max-age=600"
      "Content-Security-Policy"   = "default-src 'self'"
      "X-Content-Type-Options"    = "nosniff"
      "X-Frame-Options"           = "DENY"
    })
  }

  expect_failures = [aws_cloudfront_response_headers_policy.site]
}
