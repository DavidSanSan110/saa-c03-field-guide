# Tests for labs/00-site-hosting (spec 035, AC-14): variable validation.
# All runs use command = plan with mock providers, so nothing touches AWS.
#
# Every run that sets domain_name also gets the certificate override below with
# override_during = plan: the validation records are keyed by the validation options, which must
# be known at plan time. The hosted_zone_id rule is checked on var.hosted_zone_id in both
# directions (spec 035 section 3 lists the "if and only if" rule under hosted_zone_id).

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

variables {
  github_sub_prefix = "repo:your-user/saa-c03-field-guide"
}

# ---- github_sub_prefix -----------------------------------------------------------------------------

# AC-14: github_sub_prefix is required: a null value is an error
run "ac14_github_sub_prefix_null_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = null
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: an empty github_sub_prefix is rejected
run "ac14_github_sub_prefix_empty_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = ""
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: a wildcard repository is rejected
run "ac14_github_sub_prefix_wildcard_repo_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner/*"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: a wildcard owner is rejected
run "ac14_github_sub_prefix_wildcard_owner_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:*/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: a :environment:x suffix is rejected
run "ac14_github_sub_prefix_environment_suffix_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner/repo:environment:x"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: an empty owner is rejected
run "ac14_github_sub_prefix_empty_owner_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: an empty repository is rejected
run "ac14_github_sub_prefix_empty_repo_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner/"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: a value without the repo: scheme is rejected
run "ac14_github_sub_prefix_no_repo_scheme_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "owner/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: a non-numeric immutable ID is rejected
run "ac14_github_sub_prefix_non_numeric_id_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner@x1/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-14: the classic form passes
run "ac14_github_sub_prefix_classic_is_accepted" {
  command = plan

  variables {
    github_sub_prefix = "repo:your-user/saa-c03-field-guide"
  }

  assert {
    condition     = var.github_sub_prefix == "repo:your-user/saa-c03-field-guide"
    error_message = "github_sub_prefix = 'repo:your-user/saa-c03-field-guide' should pass validation"
  }
}

# AC-14: the immutable-ID form passes
run "ac14_github_sub_prefix_immutable_is_accepted" {
  command = plan

  variables {
    github_sub_prefix = "repo:example-owner@1000/example-repo@2000"
  }

  assert {
    condition     = var.github_sub_prefix == "repo:example-owner@1000/example-repo@2000"
    error_message = "github_sub_prefix = 'repo:example-owner@1000/example-repo@2000' should pass validation"
  }
}

# ---- domain_name (with a valid hosted_zone_id, so only the name rule can fail) --------------------

# AC-14: an upper-case letter in domain_name is rejected
run "ac14_domain_name_uppercase_is_rejected" {
  command = plan

  variables {
    domain_name    = "Site.example.com"
    hosted_zone_id = "Z0123456789EXAMPLE"
  }

  expect_failures = [var.domain_name]
}

# AC-14: a trailing dot in domain_name is rejected
run "ac14_domain_name_trailing_dot_is_rejected" {
  command = plan

  variables {
    domain_name    = "site.example.com."
    hosted_zone_id = "Z0123456789EXAMPLE"
  }

  expect_failures = [var.domain_name]
}

# AC-14: a wildcard in domain_name is rejected
run "ac14_domain_name_wildcard_is_rejected" {
  command = plan

  variables {
    domain_name    = "*.example.com"
    hosted_zone_id = "Z0123456789EXAMPLE"
  }

  expect_failures = [var.domain_name]
}

# AC-14: a single label in domain_name is rejected
run "ac14_domain_name_single_label_is_rejected" {
  command = plan

  variables {
    domain_name    = "localhost"
    hosted_zone_id = "Z0123456789EXAMPLE"
  }

  expect_failures = [var.domain_name]
}

# AC-14: a lowercase DNS name with a zone passes
run "ac14_domain_name_valid_is_accepted" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "Z0123456789EXAMPLE"
  }

  assert {
    condition     = var.domain_name == "site.example.com" && var.hosted_zone_id == "Z0123456789EXAMPLE"
    error_message = "domain_name = 'site.example.com' with hosted_zone_id = 'Z0123456789EXAMPLE' should pass validation"
  }
}

# AC-14: both null (the defaults) pass
run "ac14_no_domain_no_zone_is_accepted" {
  command = plan

  assert {
    condition     = var.domain_name == null && var.hosted_zone_id == null
    error_message = "domain_name and hosted_zone_id should default to null and pass validation"
  }
}

# ---- hosted_zone_id (with a domain, so only the zone rule can fail) --------------------------------

# AC-14: a lower-case zone ID is rejected
run "ac14_hosted_zone_id_lowercase_is_rejected" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "z0123456789example"
  }

  expect_failures = [var.hosted_zone_id]
}

# AC-14: a bare Z (no characters after it) is rejected
run "ac14_hosted_zone_id_bare_z_is_rejected" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "Z"
  }

  expect_failures = [var.hosted_zone_id]
}

# AC-14: a zone ID that does not start with Z is rejected
run "ac14_hosted_zone_id_no_z_prefix_is_rejected" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "0123456789"
  }

  expect_failures = [var.hosted_zone_id]
}

# AC-14: a zone ID with a dash is rejected
run "ac14_hosted_zone_id_dash_is_rejected" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "Z-123"
  }

  expect_failures = [var.hosted_zone_id]
}

# AC-14: Z plus 32 characters is too long
run "ac14_hosted_zone_id_too_long_is_rejected" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "Z${join("", [for i in range(32) : "A"])}"
  }

  expect_failures = [var.hosted_zone_id]
}

# AC-14: Z plus 31 characters is the longest zone ID that passes
run "ac14_hosted_zone_id_longest_is_accepted" {
  command = plan

  variables {
    domain_name    = "site.example.com"
    hosted_zone_id = "Z${join("", [for i in range(31) : "A"])}"
  }

  assert {
    condition     = length(var.hosted_zone_id) == 32
    error_message = "a zone ID of Z plus 31 characters should pass validation"
  }
}

# ---- domain_name and hosted_zone_id go together ----------------------------------------------------

# AC-14: domain_name without hosted_zone_id is rejected
run "ac14_domain_name_without_zone_is_rejected" {
  command = plan

  variables {
    domain_name = "site.example.com"
  }

  expect_failures = [var.hosted_zone_id]
}

# AC-14: hosted_zone_id without domain_name is rejected
run "ac14_zone_without_domain_name_is_rejected" {
  command = plan

  variables {
    hosted_zone_id = "Z0123456789EXAMPLE"
  }

  expect_failures = [var.hosted_zone_id]
}
