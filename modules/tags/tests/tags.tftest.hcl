# Tests for modules/tags (spec 030). All runs use command = plan: the module has no resources.

# AC-18: a lab id gives exactly the project and lab tags
run "ac18_lab_tags_exactly" {
  command = plan

  variables {
    lab = "00-site-hosting"
  }

  assert {
    condition     = output.tags == { project = "saa-c03-field-guide", lab = "00-site-hosting" }
    error_message = "output.tags is not exactly { project = 'saa-c03-field-guide', lab = '00-site-hosting' }"
  }
}

# AC-18: bootstrap-management is a valid lab value
run "ac18_bootstrap_management_is_accepted" {
  command = plan

  variables {
    lab = "bootstrap-management"
  }

  assert {
    condition     = output.tags == { project = "saa-c03-field-guide", lab = "bootstrap-management" }
    error_message = "output.tags is not exactly { project = 'saa-c03-field-guide', lab = 'bootstrap-management' }"
  }
}

# AC-18: bootstrap-workload is a valid lab value
run "ac18_bootstrap_workload_is_accepted" {
  command = plan

  variables {
    lab = "bootstrap-workload"
  }

  assert {
    condition     = output.tags == { project = "saa-c03-field-guide", lab = "bootstrap-workload" }
    error_message = "output.tags is not exactly { project = 'saa-c03-field-guide', lab = 'bootstrap-workload' }"
  }
}

# AC-18: a lab id with several name segments is valid
run "ac18_multi_segment_lab_is_accepted" {
  command = plan

  variables {
    lab = "12-vpc-peering-demo"
  }

  assert {
    condition     = output.tags == { project = "saa-c03-field-guide", lab = "12-vpc-peering-demo" }
    error_message = "output.tags is not exactly { project = 'saa-c03-field-guide', lab = '12-vpc-peering-demo' }"
  }
}

# AC-19: lab "" fails validation
run "ac19_lab_empty_is_rejected" {
  command = plan

  variables {
    lab = ""
  }

  expect_failures = [var.lab]
}

# AC-19: lab "00" fails validation
run "ac19_lab_two_digits_only_is_rejected" {
  command = plan

  variables {
    lab = "00"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "0-x" fails validation
run "ac19_lab_one_digit_is_rejected" {
  command = plan

  variables {
    lab = "0-x"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "000-x" fails validation
run "ac19_lab_three_digits_is_rejected" {
  command = plan

  variables {
    lab = "000-x"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "00_site" fails validation
run "ac19_lab_underscore_is_rejected" {
  command = plan

  variables {
    lab = "00_site"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "00-Site" fails validation
run "ac19_lab_uppercase_is_rejected" {
  command = plan

  variables {
    lab = "00-Site"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "00-site-" fails validation
run "ac19_lab_trailing_dash_is_rejected" {
  command = plan

  variables {
    lab = "00-site-"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "00--site" fails validation
run "ac19_lab_double_dash_is_rejected" {
  command = plan

  variables {
    lab = "00--site"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "lab00" fails validation
run "ac19_lab_no_dash_is_rejected" {
  command = plan

  variables {
    lab = "lab00"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "bootstrap" fails validation
run "ac19_lab_bootstrap_alone_is_rejected" {
  command = plan

  variables {
    lab = "bootstrap"
  }

  expect_failures = [var.lab]
}

# AC-19: lab "bootstrap-other" fails validation
run "ac19_lab_bootstrap_other_is_rejected" {
  command = plan

  variables {
    lab = "bootstrap-other"
  }

  expect_failures = [var.lab]
}

# AC-20: extra tags are merged with the required ones
run "ac20_extra_tags_are_merged" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { owner = "x" }
  }

  assert {
    condition     = output.tags == { owner = "x", project = "saa-c03-field-guide", lab = "00-site-hosting" }
    error_message = "output.tags is not exactly { owner = 'x', project = 'saa-c03-field-guide', lab = '00-site-hosting' }"
  }
}

# AC-20: extra key "project" fails validation
run "ac20_extra_key_project_is_rejected" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { "project" = "x" }
  }

  expect_failures = [var.extra]
}

# AC-20: extra key "Project" fails validation
run "ac20_extra_key_project_capitalised_is_rejected" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { "Project" = "x" }
  }

  expect_failures = [var.extra]
}

# AC-20: extra key "lab" fails validation
run "ac20_extra_key_lab_is_rejected" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { "lab" = "x" }
  }

  expect_failures = [var.extra]
}

# AC-20: extra key "LAB" fails validation
run "ac20_extra_key_lab_uppercase_is_rejected" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { "LAB" = "x" }
  }

  expect_failures = [var.extra]
}

# AC-20: extra key "aws:foo" fails validation
run "ac20_extra_key_aws_prefix_is_rejected" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { "aws:foo" = "x" }
  }

  expect_failures = [var.extra]
}

# AC-20: extra key "AWS:x" fails validation
run "ac20_extra_key_aws_prefix_uppercase_is_rejected" {
  command = plan

  variables {
    lab   = "00-site-hosting"
    extra = { "AWS:x" = "x" }
  }

  expect_failures = [var.extra]
}
