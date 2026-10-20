# Tests for bootstrap/workload (spec 032): variables and tags.
# All runs use command = plan with a mock provider, so nothing touches AWS.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
}

variables {
  github_sub_prefix = "repo:example-owner@1000/example-repo@2000"
}

# AC-12: hosted_zone_name "Example.com" fails validation
run "ac12_hosted_zone_name_uppercase_is_rejected" {
  command = plan

  variables {
    hosted_zone_name = "Example.com"
  }

  expect_failures = [var.hosted_zone_name]
}

# AC-12: hosted_zone_name "example.com." fails validation
run "ac12_hosted_zone_name_trailing_dot_is_rejected" {
  command = plan

  variables {
    hosted_zone_name = "example.com."
  }

  expect_failures = [var.hosted_zone_name]
}

# AC-12: hosted_zone_name "*.example.com" fails validation
run "ac12_hosted_zone_name_wildcard_is_rejected" {
  command = plan

  variables {
    hosted_zone_name = "*.example.com"
  }

  expect_failures = [var.hosted_zone_name]
}

# AC-12: hosted_zone_name "localhost" fails validation
run "ac12_hosted_zone_name_single_label_is_rejected" {
  command = plan

  variables {
    hosted_zone_name = "localhost"
  }

  expect_failures = [var.hosted_zone_name]
}

# AC-12: hosted_zone_name "" fails validation
run "ac12_hosted_zone_name_empty_is_rejected" {
  command = plan

  variables {
    hosted_zone_name = ""
  }

  expect_failures = [var.hosted_zone_name]
}

# AC-12: github_sub_prefix "repo:owner/*" fails validation
run "ac12_github_sub_prefix_wildcard_repo_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner/*"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-12: github_sub_prefix "repo:owner/repo:ref:refs/heads/main" fails validation
run "ac12_github_sub_prefix_ref_suffix_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner/repo:ref:refs/heads/main"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-12: github_sub_prefix "owner/repo" fails validation
run "ac12_github_sub_prefix_no_repo_scheme_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "owner/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-12: github_sub_prefix "repo:/repo" fails validation
run "ac12_github_sub_prefix_empty_owner_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-12: github_sub_prefix "repo:owner@x1/repo" fails validation
run "ac12_github_sub_prefix_non_numeric_id_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = "repo:owner@x1/repo"
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-12: github_sub_prefix "" fails validation
run "ac12_github_sub_prefix_empty_is_rejected" {
  command = plan

  variables {
    github_sub_prefix = ""
  }

  expect_failures = [var.github_sub_prefix]
}

# AC-12: github_sub_prefix "repo:your-user/saa-c03-field-guide" passes validation
run "ac12_github_sub_prefix_classic_is_accepted" {
  command = plan

  variables {
    github_sub_prefix = "repo:your-user/saa-c03-field-guide"
  }

  assert {
    condition     = var.github_sub_prefix == "repo:your-user/saa-c03-field-guide"
    error_message = "github_sub_prefix = 'repo:your-user/saa-c03-field-guide' should pass validation and be kept as is"
  }
}

# AC-12: github_sub_prefix "repo:example-owner@1000/example-repo@2000" passes validation
run "ac12_github_sub_prefix_immutable_is_accepted" {
  command = plan

  variables {
    github_sub_prefix = "repo:example-owner@1000/example-repo@2000"
  }

  assert {
    condition     = var.github_sub_prefix == "repo:example-owner@1000/example-repo@2000"
    error_message = "github_sub_prefix = 'repo:example-owner@1000/example-repo@2000' should pass validation and be kept as is"
  }
}

# AC-12: a lowercase DNS name with two labels passes validation
run "ac12_hosted_zone_name_valid_is_accepted" {
  command = plan

  variables {
    hosted_zone_name = "saa-c03.example.org"
  }

  assert {
    condition     = var.hosted_zone_name == "saa-c03.example.org"
    error_message = "hosted_zone_name = 'saa-c03.example.org' should pass validation and be kept as is"
  }
}

# AC-24: the module tags are exactly the project and lab tags
run "ac24_tags_are_project_and_lab" {
  command = plan

  assert {
    condition     = module.tags.tags == { project = "saa-c03-field-guide", lab = "bootstrap-workload" }
    error_message = "module.tags.tags is not exactly { project = 'saa-c03-field-guide', lab = 'bootstrap-workload' }"
  }
}
